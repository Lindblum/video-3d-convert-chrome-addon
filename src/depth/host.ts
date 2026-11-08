// Runs inside a hidden chrome-extension:// iframe so the depth model loads under the
// extension's CSP instead of the host page's. Talks to the content script over a MessagePort.
import * as ort from 'onnxruntime-web/webgpu';
import type { FromHost, HostTokenMessage, ToHost } from '../shared/protocol';
import type { DepthModel } from '../shared/settings';

/** How each ML model is loaded, fed and read. */
interface ModelSpec {
  name: string;
  /** Model file URL for a precision (fp16 is only tried where the model has one). */
  file: (precision: 'fp16' | 'fp32') => string;
  hasFp16: boolean;
  /** Weights stored in a separate file, referenced from the model as 'model.onnx_data'. */
  externalData?: string;
  /** Input has an extra views dimension: [batch, views, 3, H, W]. */
  multiView: boolean;
  /** Output is distance (far = large) rather than inverse distance (near = large). */
  outputIsDistance: boolean;
}

// Models are downloaded on first use rather than bundled (they're ~320 MB together).
const DA2 = 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx';
const DA3 = 'https://huggingface.co/onnx-community/depth-anything-v3-small/resolve/main/onnx';
const MIDAS = 'https://huggingface.co/InDepthDesigns/midas_v21_small_256/resolve/main';
/** Cache Storage bucket for downloaded models; bump the version to force a re-download. */
const MODEL_CACHE = 'sbs3d-models-v1';

const MODELS: Record<DepthModel, ModelSpec> = {
  da2: {
    name: 'Depth Anything V2',
    file: (p) => (p === 'fp16' ? `${DA2}/model_fp16.onnx` : `${DA2}/model.onnx`),
    hasFp16: true,
    multiView: false,
    outputIsDistance: false,
  },
  da3: {
    name: 'Depth Anything V3',
    file: () => `${DA3}/model.onnx`,
    hasFp16: false,
    externalData: `${DA3}/model.onnx_data`,
    multiView: true,
    outputIsDistance: true,
  },
  midas: {
    name: 'MiDaS',
    file: () => `${MIDAS}/midas_v21_small_256.onnx`,
    hasFp16: false,
    multiView: false,
    outputIsDistance: false,
  },
};
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// Override only the .wasm URL: a string prefix would make ORT import its JS glue separately
// instead of using the copy embedded in this bundle.
ort.env.wasm.wasmPaths = { wasm: chrome.runtime.getURL('ort/ort-wasm-simd-threaded.asyncify.wasm') };
ort.env.wasm.numThreads = 1; // extension iframes aren't cross-origin isolated, so no SharedArrayBuffer
ort.env.wasm.proxy = false;

let port: MessagePort | null = null;
let session: ort.InferenceSession | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

function send(msg: FromHost, transfer: Transferable[] = []) {
  port?.postMessage(msg, transfer);
}

let provider = '';
let loadedModel: DepthModel | null = null;
/** The inference in progress, if any; a model switch waits for it before releasing. */
let running: Promise<unknown> | null = null;
/** Bumped per init request, so a slow load that was superseded doesn't report. */
let loadSeq = 0;

/**
 * Returns the files' bytes, downloading any that aren't cached yet and caching them for next
 * time. Reports download progress to the content script; cache hits report nothing.
 */
async function loadFiles(urls: string[]): Promise<Uint8Array[]> {
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  const hits = await Promise.all(urls.map((u) => cache?.match(u)));
  const out: Array<Uint8Array | null> = await Promise.all(
    hits.map(async (r) => (r ? new Uint8Array(await r.arrayBuffer()) : null)),
  );
  const missing = urls.flatMap((u, i) => (out[i] ? [] : [i]));
  if (!missing.length) return out as Uint8Array[];

  // Keep the browser from evicting the models under storage pressure.
  navigator.storage?.persist?.().catch(() => {});
  const responses = await Promise.all(
    missing.map(async (i) => {
      const res = await fetch(urls[i]);
      if (!res.ok || !res.body) throw new Error(`model download failed (HTTP ${res.status})`);
      return res;
    }),
  );
  const sizes = responses.map((r) => Number(r.headers.get('content-length')) || 0);
  const total = sizes.reduce((a, b) => a + b, 0);
  let loaded = 0;
  let lastPct = -1;
  for (const [k, i] of missing.entries()) {
    const reader = responses[k].body!.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      loaded += value.length;
      const pct = total ? Math.floor((loaded / total) * 100) : -1;
      if (pct !== lastPct) {
        lastPct = pct;
        send({ type: 'progress', loaded, total });
      }
    }
    if (sizes[k] && received !== sizes[k]) throw new Error('model download was cut off');
    const bytes = new Uint8Array(received);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    out[i] = bytes;
    // A full disk shouldn't stop this session from using the model it just downloaded.
    await cache?.put(urls[i], new Response(bytes)).catch((e) => console.warn('[2D-3D] could not cache model:', e));
  }
  return out as Uint8Array[];
}

async function createSession(spec: ModelSpec, precision: 'fp16' | 'fp32') {
  const [model, data] = await loadFiles(
    spec.externalData ? [spec.file(precision), spec.externalData] : [spec.file(precision)],
  );
  return ort.InferenceSession.create(model, {
    executionProviders: ['webgpu'],
    graphOptimizationLevel: 'all',
    ...(data ? { externalData: [{ path: 'model.onnx_data', data }] } : {}),
  });
}

async function init(model: DepthModel) {
  if (session && loadedModel === model) return send({ type: 'ready', provider });
  const seq = ++loadSeq;
  const old = session;
  session = null; // new frames are refused from here on
  loadedModel = null;
  await running?.catch(() => {});
  await old?.release().catch(() => {});
  try {
    const gpu = (navigator as any).gpu;
    if (!gpu) throw new Error('WebGPU is not available in this browser');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter (GPU blocklisted or WebGPU disabled)');
    const spec = MODELS[model];
    let precision: 'fp16' | 'fp32' = spec.hasFp16 && adapter.features.has('shader-f16') ? 'fp16' : 'fp32';
    let s: ort.InferenceSession;
    try {
      s = await createSession(spec, precision);
    } catch (e) {
      if (precision === 'fp32') throw e;
      console.warn('[2D-3D] fp16 model failed, retrying with fp32:', e);
      precision = 'fp32';
      s = await createSession(spec, precision);
    }
    if (seq !== loadSeq) return void s.release(); // another model was requested meanwhile
    session = s;
    loadedModel = model;
    const info = adapter.info ?? {};
    provider = `${spec.name} · WebGPU ${precision}${info.vendor ? ` · ${info.vendor}` : ''}`;
    send({ type: 'ready', provider });
  } catch (e) {
    if (seq !== loadSeq) return;
    send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

function toTensor(bitmap: ImageBitmap): ort.Tensor {
  const { width: w, height: h } = bitmap;
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const px = ctx!.getImageData(0, 0, w, h).data;
  const n = w * h;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = (px[i * 4] / 255 - MEAN[0]) / STD[0];
    out[n + i] = (px[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
    out[2 * n + i] = (px[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
  }
  return new ort.Tensor('float32', out, MODELS[loadedModel!].multiView ? [1, 1, 3, h, w] : [1, 3, h, w]);
}

/**
 * 2nd and 98th percentiles of the depth output (from a subsample). Unlike min/max, a few
 * extreme pixels (a light, the sky, black bars) can't make the whole scene's depth pump.
 */
function percentileRange(data: Float32Array): [number, number] {
  const stride = Math.max(1, Math.floor(data.length / 8192));
  const sample = new Float32Array(Math.ceil(data.length / stride));
  for (let i = 0, j = 0; i < data.length; i += stride) sample[j++] = data[i];
  sample.sort();
  const at = (q: number) => sample[Math.min(sample.length - 1, Math.floor(q * sample.length))];
  return [at(0.02), at(0.98)];
}

async function runFrame(id: number, bitmap: ImageBitmap) {
  const s = session;
  if (!s || !loadedModel) {
    bitmap.close();
    return send({ type: 'frame-error', id, message: 'model not loaded' });
  }
  try {
    const t0 = performance.now();
    const spec = MODELS[loadedModel];
    const input = toTensor(bitmap);
    // Only fetch the depth output (Depth Anything V3 also has confidence and camera outputs).
    const run = s.run({ [s.inputNames[0]]: input }, [s.outputNames[0]]);
    running = run;
    const result = await run.finally(() => {
      if (running === run) running = null;
    });
    const out = result[s.outputNames[0]];
    const data = new Float32Array(out.data as Float32Array); // copy so we own a transferable buffer
    const dims = out.dims as number[];
    const [height, width] = dims.slice(-2);
    input.dispose();
    out.dispose();
    // The pipeline expects near = large (inverse distance, like disparity).
    if (spec.outputIsDistance) {
      for (let i = 0; i < data.length; i++) data[i] = 1 / Math.max(data[i], 1e-6);
    }
    const [min, max] = percentileRange(data);
    send(
      { type: 'depth', id, data, width, height, min, max, ms: performance.now() - t0 },
      [data.buffer],
    );
  } catch (e) {
    send({ type: 'frame-error', id, message: e instanceof Error ? e.message : String(e) });
  }
}

/** Set while a connection's token is being checked, so only one is ever accepted. */
let connecting = false;

window.addEventListener('message', async (e) => {
  const { type, token } = e.data ?? {};
  if (port || connecting || type !== 'sbs3d-connect' || typeof token !== 'string' || !e.ports[0]) return;
  // Any page can frame this one; only 2D-3D's own content script knows a registered token.
  connecting = true;
  const check: HostTokenMessage = { type: 'host-token-check', token };
  const ok = await chrome.runtime.sendMessage(check).catch(() => false);
  connecting = false;
  if (!ok) return;
  port = e.ports[0];
  port.onmessage = (ev: MessageEvent<ToHost>) => {
    const msg = ev.data;
    if (msg.type === 'init') init(msg.model);
    else if (msg.type === 'frame') runFrame(msg.id, msg.bitmap);
  };
});

// Runs inside a hidden chrome-extension:// iframe so the depth model loads under the
// extension's CSP instead of the host page's. Talks to the content script over a MessagePort.
import * as ort from 'onnxruntime-web/webgpu';
import type { FromHost, ToHost } from '../shared/protocol';

const MODEL_URL = (precision: 'fp16' | 'fp32') =>
  chrome.runtime.getURL(`models/depth-anything-v2-small-${precision}.onnx`);
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

function createSession(precision: 'fp16' | 'fp32') {
  return ort.InferenceSession.create(MODEL_URL(precision), {
    executionProviders: ['webgpu'],
    graphOptimizationLevel: 'all',
  });
}

async function init() {
  if (session) return send({ type: 'ready', provider });
  try {
    const gpu = (navigator as any).gpu;
    if (!gpu) throw new Error('WebGPU is not available in this browser');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter (GPU blocklisted or WebGPU disabled)');
    let precision: 'fp16' | 'fp32' = adapter.features.has('shader-f16') ? 'fp16' : 'fp32';
    try {
      session = await createSession(precision);
    } catch (e) {
      if (precision === 'fp32') throw e;
      console.warn('[2D-3D] fp16 model failed, retrying with fp32:', e);
      precision = 'fp32';
      session = await createSession(precision);
    }
    const info = adapter.info ?? {};
    provider = `WebGPU ${precision}${info.vendor ? ` · ${info.vendor}` : ''}`;
    send({ type: 'ready', provider });
  } catch (e) {
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
  return new ort.Tensor('float32', out, [1, 3, h, w]);
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
  if (!session) {
    bitmap.close();
    return send({ type: 'frame-error', id, message: 'model not loaded' });
  }
  try {
    const t0 = performance.now();
    const input = toTensor(bitmap);
    const result = await session.run({ [session.inputNames[0]]: input });
    const out = result[session.outputNames[0]];
    const data = new Float32Array(out.data as Float32Array); // copy so we own a transferable buffer
    const [, height, width] = out.dims as number[];
    input.dispose();
    out.dispose();
    const [min, max] = percentileRange(data);
    send(
      { type: 'depth', id, data, width, height, min, max, ms: performance.now() - t0 },
      [data.buffer],
    );
  } catch (e) {
    send({ type: 'frame-error', id, message: e instanceof Error ? e.message : String(e) });
  }
}

window.addEventListener('message', (e) => {
  if (port || e.data?.type !== 'sbs3d-connect' || !e.ports[0]) return;
  port = e.ports[0];
  port.onmessage = (ev: MessageEvent<ToHost>) => {
    const msg = ev.data;
    if (msg.type === 'init') init();
    else if (msg.type === 'frame') runFrame(msg.id, msg.bitmap);
  };
});

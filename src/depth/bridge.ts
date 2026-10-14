// Content-script side of the depth model: owns the hidden host iframe and keeps at most
// one frame in flight so inference never queues up behind playback.
import type { FromHost, ToHost } from '../shared/protocol';

export interface DepthResult {
  data: Float32Array;
  width: number;
  height: number;
  min: number;
  max: number;
  ms: number;
}

type State = 'idle' | 'loading' | 'ready' | 'failed';

const LOAD_TIMEOUT_MS = 60_000;

class DepthBridge {
  state: State = 'idle';
  error = '';
  provider = '';
  busy = false;
  private port: MessagePort | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private nextId = 1;
  private pending = new Map<number, (r: DepthResult | null) => void>();
  private readyWaiters: Array<(ok: boolean) => void> = [];

  /** Starts loading the model (once). Resolves true when ML depth is usable. */
  ensureLoaded(): Promise<boolean> {
    if (this.state === 'ready') return Promise.resolve(true);
    if (this.state === 'failed') return Promise.resolve(false);
    const p = new Promise<boolean>((r) => this.readyWaiters.push(r));
    if (this.state === 'idle') this.start();
    return p;
  }

  private start() {
    this.state = 'loading';
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('depth/host.html');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText =
      'position:fixed!important;left:-10px!important;top:-10px!important;width:1px!important;' +
      'height:1px!important;opacity:0!important;pointer-events:none!important;border:0!important;';
    const timer = setTimeout(() => this.fail('timed out loading depth model'), LOAD_TIMEOUT_MS);
    iframe.addEventListener('load', () => {
      const channel = new MessageChannel();
      this.port = channel.port1;
      this.port.onmessage = (e: MessageEvent<FromHost>) => {
        if (e.data.type === 'ready' || e.data.type === 'error') clearTimeout(timer);
        this.onMessage(e.data);
      };
      const origin = new URL(chrome.runtime.getURL('')).origin;
      iframe.contentWindow!.postMessage({ type: 'sbs3d-connect' }, origin, [channel.port2]);
      this.post({ type: 'init' });
    });
    (document.body ?? document.documentElement).appendChild(iframe);
    this.iframe = iframe;
  }

  private fail(message: string) {
    if (this.state === 'ready' || this.state === 'failed') return;
    this.state = 'failed';
    this.error = message;
    this.iframe?.remove();
    this.readyWaiters.splice(0).forEach((r) => r(false));
  }

  private post(msg: ToHost, transfer: Transferable[] = []) {
    this.port?.postMessage(msg, transfer);
  }

  private onMessage(msg: FromHost) {
    switch (msg.type) {
      case 'ready':
        this.provider = msg.provider;
        this.state = 'ready';
        this.readyWaiters.splice(0).forEach((r) => r(true));
        break;
      case 'error':
        this.fail(msg.message);
        break;
      case 'depth':
        this.resolve(msg.id, msg);
        break;
      case 'frame-error':
        console.warn('[2D-3D] depth inference failed:', msg.message);
        this.resolve(msg.id, null);
        break;
    }
  }

  private resolve(id: number, r: DepthResult | null) {
    const cb = this.pending.get(id);
    this.pending.delete(id);
    this.busy = false;
    cb?.(r);
  }

  /** Sends a frame for inference. Resolves null if busy, not ready, or inference failed. */
  infer(bitmap: ImageBitmap): Promise<DepthResult | null> {
    if (this.state !== 'ready' || this.busy) {
      bitmap.close();
      return Promise.resolve(null);
    }
    this.busy = true;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.post({ type: 'frame', id, bitmap }, [bitmap]);
    });
  }
}

export const depthBridge = new DepthBridge();

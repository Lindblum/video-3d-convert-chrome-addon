// Content-script side of the depth model: owns the hidden host iframe and keeps at most
// one frame in flight so inference never queues up behind playback.
import type { FromHost, ToHost } from '../shared/protocol';
import type { DepthModel } from '../shared/settings';

export interface DepthResult {
  data: Float32Array;
  width: number;
  height: number;
  min: number;
  max: number;
  ms: number;
}

type State = 'idle' | 'loading' | 'ready' | 'failed';

/** Give up if the host page sends nothing for this long (a model download keeps it alive). */
const LOAD_TIMEOUT_MS = 60_000;

class DepthBridge {
  state: State = 'idle';
  error = '';
  provider = '';
  /** The model loaded, or being loaded. */
  model: DepthModel | null = null;
  busy = false;
  private port: MessagePort | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private nextId = 1;
  private pending = new Map<number, (r: DepthResult | null) => void>();
  private readyWaiters: Array<(ok: boolean) => void> = [];
  private loadTimer = 0;
  /** Called with the fraction downloaded while a model is fetched for the first time. */
  onProgress: ((fraction: number) => void) | null = null;

  isReady(model: DepthModel): boolean {
    return this.state === 'ready' && this.model === model;
  }

  /** Loads this model (switching from another if needed). Resolves true when it's usable. */
  ensureLoaded(model: DepthModel): Promise<boolean> {
    if (this.model === model) {
      if (this.state === 'ready') return Promise.resolve(true);
      if (this.state === 'failed') return Promise.resolve(false);
    }
    const p = new Promise<boolean>((r) => this.readyWaiters.push(r));
    if (this.model !== model || this.state === 'idle') {
      // Anyone still waiting for a previous model gets a 'no'.
      const superseded = this.readyWaiters.splice(0, this.readyWaiters.length - 1);
      superseded.forEach((r) => r(false));
      this.model = model;
      this.error = '';
      if (!this.iframe) {
        this.start();
      } else {
        this.state = 'loading';
        this.post({ type: 'init', model });
      }
    }
    return p;
  }

  /** Removes the host iframe; anything still waiting gets null / false. */
  dispose() {
    clearTimeout(this.loadTimer);
    this.port?.close();
    this.iframe?.remove();
    this.port = null;
    this.iframe = null;
    this.state = 'idle';
    this.pending.forEach((r) => r(null));
    this.pending.clear();
    this.readyWaiters.splice(0).forEach((r) => r(false));
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
    this.armLoadTimer();
    iframe.addEventListener('load', () => {
      const channel = new MessageChannel();
      this.port = channel.port1;
      this.port.onmessage = (e: MessageEvent<FromHost>) => {
        if (e.data.type === 'ready' || e.data.type === 'error') clearTimeout(this.loadTimer);
        else if (e.data.type === 'progress') this.armLoadTimer();
        this.onMessage(e.data);
      };
      const origin = new URL(chrome.runtime.getURL('')).origin;
      iframe.contentWindow!.postMessage({ type: 'sbs3d-connect' }, origin, [channel.port2]);
      this.post({ type: 'init', model: this.model! });
    });
    (document.body ?? document.documentElement).appendChild(iframe);
    this.iframe = iframe;
  }

  private armLoadTimer() {
    clearTimeout(this.loadTimer);
    this.loadTimer = window.setTimeout(() => this.fail('timed out loading depth model', true), LOAD_TIMEOUT_MS);
  }

  /** A model failed to load. fatal: the host page itself didn't come up, so drop it. */
  private fail(message: string, fatal = false) {
    if (this.state === 'ready' || this.state === 'failed') return;
    this.state = 'failed';
    this.error = message;
    if (fatal) {
      this.iframe?.remove();
      this.iframe = null;
      this.port = null;
    }
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
      case 'progress':
        if (msg.total) this.onProgress?.(msg.loaded / msg.total);
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

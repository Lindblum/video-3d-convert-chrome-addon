// Messages exchanged over the MessagePort between the content script and the depth host iframe.

export type ToHost =
  | { type: 'init' }
  | { type: 'frame'; id: number; bitmap: ImageBitmap };

export type FromHost =
  | { type: 'ready'; provider: string }
  | { type: 'error'; message: string }
  | { type: 'frame-error'; id: number; message: string }
  | {
      type: 'depth';
      id: number;
      data: Float32Array;
      width: number;
      height: number;
      min: number;
      max: number;
      ms: number;
    };

// Messages from the popup to content scripts.
export type PopupRequest = { type: 'toggle' } | { type: 'status' };

export interface PopupStatus {
  videos: number;
  active: number;
  mode: string;
  /** Build of the content script that answered; missing in builds before this field existed. */
  buildId?: string;
}

declare global {
  /** Injected by build.mjs; unique per build. */
  const __BUILD_ID__: string;
}

// Messages exchanged over the MessagePort between the content script and the depth host iframe.
import type { DepthModel } from './settings';

export type ToHost =
  | { type: 'init'; model: DepthModel }
  | { type: 'frame'; id: number; bitmap: ImageBitmap };

export type FromHost =
  | { type: 'ready'; provider: string }
  /** Bytes of the model downloaded so far (first use only; cached afterwards). */
  | { type: 'progress'; loaded: number; total: number }
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

/**
 * Extension messages to the background script that guard the host connection: the content script
 * registers a one-time token, and the host page checks the token a connection brings.
 */
export type HostTokenMessage = { type: 'host-token'; token: string } | { type: 'host-token-check'; token: string };

// Messages from the popup to content scripts.
export type PopupRequest = { type: 'toggle' } | { type: 'status' };

export interface PopupStatus {
  videos: number;
  active: number;
  mode: string;
  /** Why 3D last failed to start or stopped on its own, if it did. */
  error?: string;
  /** Build of the content script that answered; missing in builds before this field existed. */
  buildId?: string;
}

declare global {
  /** Injected by build.mjs; unique per build. */
  const __BUILD_ID__: string;
}

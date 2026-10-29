// Detects hard cuts between shots by comparing tiny luma thumbnails of consecutive frames,
// so depth from the previous shot doesn't bleed into the new one.

const W = 32;
const H = 18;
/** Thumbnails are drawn at 4x and box-averaged down: a direct 1280 -> 32 px draw skips most
 * pixels, so fine texture (grass, leaves) flickers between frames and looks like a cut. */
const SS = 4;
const MIN_INTERVAL_MS = 33;
/** Mean absolute luma change (0..1) a frame must exceed to count as a cut... */
const MIN_CUT = 0.03;
/**
 * ...and how many times bigger than the largest change in the previous few frames it must
 * be. In continuous motion consecutive frames change by similar amounts; a cut jumps. (A
 * slow running average as the baseline missed clear cuts in action scenes: tested on the
 * Sintel trailer, 8 of 11 hard cuts found vs 6, no false cuts in calm footage.)
 */
const CUT_RATIO = 3;
const HISTORY = 3;
/** Floor for the baseline, so near-static frames don't make noise look like a cut. */
const MIN_BASELINE = 0.004;
/**
 * A longer gap between checked frames (paused, scrolled off-screen, background tab) means
 * they aren't consecutive, so comparing them says nothing about cuts: start over instead.
 */
const MAX_GAP_MS = 250;
/**
 * Likewise if more than this much video passed between checks (the browser stalled and
 * frames were skipped): several frames' worth of motion would look like a cut.
 */
const MAX_MEDIA_GAP_S = 0.1;
/** A thumbnail cell changed if its luma moved by more than this (0..1). */
const CELL_CHANGE = 0.08;

/** Tiny luma thumbnails (W x H, 0..1) of frames, for comparing them. */
export class Thumbnailer {
  private canvas = new OffscreenCanvas(W * SS, H * SS);
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;

  constructor() {
    this.ctx.imageSmoothingQuality = 'high';
  }

  /** null if the picture can't be read. */
  take(source: CanvasImageSource): Float32Array | null {
    let px: Uint8ClampedArray;
    try {
      this.ctx.drawImage(source, 0, 0, W * SS, H * SS);
      px = this.ctx.getImageData(0, 0, W * SS, H * SS).data;
    } catch {
      return null;
    }
    const luma = new Float32Array(W * H);
    const rowLen = W * SS;
    for (let y = 0; y < H * SS; y++) {
      for (let x = 0; x < rowLen; x++) {
        const i = (y * rowLen + x) * 4;
        luma[((y / SS) | 0) * W + ((x / SS) | 0)] += px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
      }
    }
    for (let i = 0; i < luma.length; i++) luma[i] /= 255 * SS * SS;
    return luma;
  }
}

/**
 * Share (0..1) of two thumbnails' cells that changed a lot. A cut changes most of the
 * picture; motion within a shot, even someone passing right in front of the camera, mostly
 * changes part of it.
 */
export function changedShare(a: Float32Array, b: Float32Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > CELL_CHANGE) n++;
  return n / a.length;
}

export class SceneCutDetector {
  private thumbs = new Thumbnailer();
  private prev: Float32Array | null = null;
  /** Frame-to-frame changes of the last few checks. */
  private recent: number[] = [];
  private last = 0;
  private lastMediaTime = -1;

  /** Call on new video frames; returns true if this frame starts a new shot. source: where to read the picture (default: the video). */
  check(video: HTMLVideoElement, now: number, source: CanvasImageSource = video): boolean {
    if (now - this.last < MIN_INTERVAL_MS) return false;
    const mediaGap = video.currentTime - this.lastMediaTime;
    if (now - this.last > MAX_GAP_MS || mediaGap < 0 || mediaGap > MAX_MEDIA_GAP_S) this.reset();
    this.last = now;
    this.lastMediaTime = video.currentTime;
    const luma = this.thumbs.take(source);
    if (!luma) return false;
    const prev = this.prev;
    this.prev = luma;
    if (!prev) return false;
    let diff = 0;
    for (let i = 0; i < luma.length; i++) diff += Math.abs(luma[i] - prev[i]);
    diff /= luma.length;
    const baseline = Math.max(MIN_BASELINE, ...this.recent);
    const cut = this.recent.length > 0 && diff > MIN_CUT && diff > baseline * CUT_RATIO;
    this.recent.push(diff);
    if (this.recent.length > HISTORY) this.recent.shift();
    return cut;
  }

  reset() {
    this.prev = null;
    this.recent = [];
  }
}

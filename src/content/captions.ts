// Re-draws a video's captions into an off-screen layer that the renderer composites into
// each eye, so they survive the per-eye squeeze of SBS/TOB. Sources: YouTube's caption DOM
// (which is then hidden) and standard <track> text tracks.

/** One caption box, in coordinates normalized to the video picture (0..1, top-left). */
interface Box {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Font size as a fraction of picture height. */
  size: number;
  font: string;
  color: string;
  background: string;
  /** Left padding as a fraction of picture height. */
  pad: number;
}

const HIDE_CLASS = 'sbs3d-hide-captions';
const POLL_MS = 100;
const TRACK_FONT = 0.05;

let styleInjected = false;
function injectHideStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = `.${HIDE_CLASS} .ytp-caption-window-container { visibility: hidden !important; }`;
  (document.head ?? document.documentElement).appendChild(style);
}

export class Captions {
  /** Layer drawn at eye resolution; transparent where there are no captions. */
  readonly canvas = new OffscreenCanvas(2, 2);
  private ctx = this.canvas.getContext('2d')!;
  private lastPoll = 0;
  private signature = '';
  private player: Element | null;
  hasContent = false;

  constructor(private video: HTMLVideoElement) {
    this.player = video.closest('.html5-video-player');
  }

  /** Hides the site's own caption overlay while we draw captions into the 3D picture. */
  setSiteCaptionsHidden(hidden: boolean) {
    if (!this.player) return;
    if (hidden) injectHideStyle();
    this.player.classList.toggle(HIDE_CLASS, hidden);
  }

  /**
   * Re-reads captions (throttled) and redraws the layer if anything changed.
   * eyeW/eyeH: layer size in pixels; squeezeX/Y: how much the layout squeezes each eye.
   * Returns true if the layer was redrawn.
   */
  update(now: number, eyeW: number, eyeH: number, squeezeX: number, squeezeY: number): boolean {
    const sizeKey = `${eyeW}x${eyeH}/${squeezeX}/${squeezeY}`;
    if (now - this.lastPoll < POLL_MS && sizeKey === this.signature.split('|')[0]) return false;
    this.lastPoll = now;
    const boxes = this.player ? this.readYouTube() : this.readTracks();
    const sig = `${sizeKey}|${JSON.stringify(boxes)}`;
    if (sig === this.signature) return false;
    this.signature = sig;
    this.draw(boxes, eyeW, eyeH, squeezeX, squeezeY);
    return true;
  }

  dispose() {
    this.setSiteCaptionsHidden(false);
  }

  /** Picture rect of the video in viewport px (honors object-fit letterboxing). */
  private pictureRect() {
    const v = this.video;
    const r = v.getBoundingClientRect();
    const fit = getComputedStyle(v).objectFit;
    if (fit === 'fill' || !v.videoWidth) return r;
    const scale = fit === 'cover'
      ? Math.max(r.width / v.videoWidth, r.height / v.videoHeight)
      : Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * scale;
    const h = v.videoHeight * scale;
    return new DOMRect(r.left + (r.width - w) / 2, r.top + (r.height - h) / 2, w, h);
  }

  private readYouTube(): Box[] {
    const segments = this.player!.querySelectorAll<HTMLElement>('.ytp-caption-window-container .ytp-caption-segment');
    if (!segments.length) return [];
    const pic = this.pictureRect();
    const boxes: Box[] = [];
    for (const seg of segments) {
      const text = seg.textContent ?? '';
      if (!text.trim()) continue;
      const r = seg.getBoundingClientRect();
      const cs = getComputedStyle(seg);
      boxes.push({
        text,
        x: (r.left - pic.left) / pic.width,
        y: (r.top - pic.top) / pic.height,
        w: r.width / pic.width,
        h: r.height / pic.height,
        size: parseFloat(cs.fontSize) / pic.height,
        font: `${cs.fontStyle} ${cs.fontWeight} {SIZE}px ${cs.fontFamily}`,
        color: cs.color,
        background: cs.backgroundColor,
        pad: parseFloat(cs.paddingLeft) / pic.height,
      });
    }
    return boxes.map(round);
  }

  /** Standard text tracks the user turned on; drawn bottom-centered, one box per line. */
  private readTracks(): Box[] {
    const lines: string[] = [];
    for (const track of this.video.textTracks) {
      if (track.mode !== 'showing' || (track.kind !== 'subtitles' && track.kind !== 'captions')) continue;
      for (const cue of track.activeCues ?? []) {
        const text = (cue as VTTCue).text ?? '';
        lines.push(...text.replace(/<[^>]+>/g, '').split('\n').filter((l) => l.trim()));
      }
    }
    const lineH = TRACK_FONT * 1.35;
    return lines.map((text, i) => ({
      text,
      x: 0.5, // centered; width is measured at draw time
      y: 0.92 - (lines.length - i) * lineH,
      w: -1,
      h: lineH,
      size: TRACK_FONT,
      font: `normal 500 {SIZE}px system-ui, sans-serif`,
      color: '#fff',
      background: 'rgba(8, 8, 8, 0.75)',
      pad: TRACK_FONT * 0.3,
    }));
  }

  private draw(boxes: Box[], eyeW: number, eyeH: number, squeezeX: number, squeezeY: number) {
    const c = this.canvas;
    if (c.width !== eyeW || c.height !== eyeH) {
      c.width = eyeW;
      c.height = eyeH;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, eyeW, eyeH);
    this.hasContent = boxes.length > 0;
    if (!this.hasContent) return;
    // Draw in un-squeezed pixels so text has natural proportions after the TV stretches it.
    const W = eyeW * squeezeX;
    const H = eyeH * squeezeY;
    ctx.setTransform(1 / squeezeX, 0, 0, 1 / squeezeY, 0, 0);
    ctx.textBaseline = 'middle';
    for (const b of boxes) {
      ctx.font = b.font.replace('{SIZE}', (b.size * H).toFixed(1));
      const pad = b.pad * H;
      let x = b.x * W;
      let w = b.w * W;
      if (b.w < 0) {
        w = ctx.measureText(b.text).width + pad * 2;
        x -= w / 2;
      }
      const y = b.y * H;
      const h = b.h * H;
      ctx.fillStyle = b.background;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = b.color;
      ctx.fillText(b.text, x + pad, y + h / 2);
    }
  }
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
function round(b: Box): Box {
  return { ...b, x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h), size: r4(b.size), pad: r4(b.pad) };
}

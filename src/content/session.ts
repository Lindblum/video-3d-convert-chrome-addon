// One active 2D→3D conversion: an overlay canvas over a <video>, its render loop and its
// share of the depth model.
import { depthBridge, type DepthResult } from '../depth/bridge';
import { Renderer, TaintedVideoError, taintedVideoMessage } from '../render/renderer';
import { mlModel, type Algorithm, type Settings, type ShaderDepth } from '../shared/settings';
import { Captions } from './captions';
import { DepthChangeDetector } from './depthchange';
import { changedShare, SceneCutDetector, Thumbnailer } from './scenecut';
import type { Overlay } from './ui';

const SHADER_LABELS: Record<ShaderDepth, string> = {
  heuristic: 'Heuristic depth',
  scene: 'Scene cues depth',
  ground: 'Ground plane depth',
  motion: 'Motion parallax depth',
};

/** Auto mode gives up on ML depth if inference is slower than this (ms, averaged). */
const AUTO_MAX_INFER_MS = 150;
/**
 * Other extensions whose output for a video can be this one's picture, last pipeline stage
 * first: 2D-3D always comes last, converting whatever the others made of the picture. Each
 * stage, while it's on, sets data-<stage>="<canvas id>" on the video and fires "<stage>:change"
 * when that turns on or off and "<stage>:frame" after every new frame. Its canvas holds the
 * whole picture (no letterbox; CSS object-fit letterboxes it like the video), and is readable
 * from other WebGL contexts (preserveDrawingBuffer). Video Filters reads Video Moutheyes.
 */
const PIPELINE: Array<{ stage: string; key: string; overlay: string }> = [
  { stage: 'video-filters', key: 'videoFilters', overlay: 'vfx-canvas' },
  { stage: 'moutheyes', key: 'moutheyes', overlay: 'moutheyes-canvas' },
];

/** Stop redrawing a paused video after this many frames without changes. */
const IDLE_FRAMES = 90;
const ML_WARMUP_RUNS = 3;
const ML_MAX_LONG_SIDE = 518;
const PATCH = 14; // Depth Anything works on 14px patches
/**
 * Change between consecutive ML depth maps (0..1) big enough to snap to the new depth
 * instead of blending into it, if the picture changed like a cut too (DEPTH_JUMP_SHARE).
 * Measured: at most 0.021 in calm footage; 0.07-0.44 at cuts; up to 0.37 in fast action.
 */
const DEPTH_JUMP = 0.06;
/**
 * Share of the picture (changedShare) that must have changed between the frames of two depth
 * maps for a depth jump to snap. Mid-shot, the model is unsteady enough that depth alone
 * can't tell: on four trailers (Carrie, Mad Max, John Wick 4, test/media/cuts.mp4) depth jumps
 * more than 1 s from any cut measured a median 0.12 (90th percentile 0.32), as big as at cuts.
 * The picture tells them apart: median share 0.61 at cuts (90% above 0.42), 0.13 mid-shot.
 * 0.25 keeps the same-scene cuts in cuts.mp4 (0.26, 0.29) and stops 82% of mid-shot snaps,
 * which in dark handheld scenes (Carrie's party) came several times a second.
 */
const DEPTH_JUMP_SHARE = 0.25;
/**
 * How fast the depth normalization range follows each new depth map when not snapping.
 * Measured within shots: median 1-2% change per update. Slow adaptation (0.15) made any
 * missed cut settle over about a second, which looked like the depth warping.
 */
const RANGE_FOLLOW = 0.4;

export class Session {
  readonly canvas = document.createElement('canvas');
  private renderer: Renderer;
  private captions: Captions;
  private cuts = new SceneCutDetector();
  private depthChange = new DepthChangeDetector();
  /** Thumbnails of the frames sent to the depth model, and of the newest one with depth. */
  private thumbs = new Thumbnailer();
  private depthThumb: Float32Array | null = null;
  /** Bumped on every seek or scene cut; depth computed from older frames is discarded. */
  private shot = 0;
  private raf = 0;
  private newFrame = true;
  private idle = 0;
  private lastBox = '';
  private capturing = false;
  private resetOnNextDepth = false;
  private mlRange: [number, number] | null = null;
  /** Interpolation between depth maps: the previous map's range, when the newest arrived,
   * and the typical time between arrivals. */
  private mlRangePrev: [number, number] = [0, 1];
  private mlArrival = -Infinity;
  private mlInterval = 80;
  /** Depth is held as it was when the video paused (Freeze depth when paused). */
  private frozen = false;
  /** depthBlend() at the moment of freezing. */
  private frozenBlend = 1;
  private started = false;
  private mlActive = false;
  /** The depth map is older than the current video frame. */
  private mlStale = false;
  private mlMsAvg = 0;
  private mlCount = 0;
  private mlFailed = '';
  /** Stopped because the browser won't let us read the video's pixels. */
  unreadable = false;
  private statsEl: HTMLDivElement | null = null;
  private renderFrames = 0;
  private depthFrames = 0;
  /** Size of the last frame sent to the ML model. */
  private mlInput = '';
  /** The video's dropped-frame count at the last stats update. */
  private lastDropped = 0;
  private statsTimer = 0;
  private listeners: Array<() => void> = [];

  constructor(
    readonly video: HTMLVideoElement,
    private settings: Settings,
    private overlay: Overlay,
    private onEnd: (s: Session) => void,
  ) {
    this.renderer = new Renderer(this.canvas);
    this.captions = new Captions(video);
  }

  start() {
    if (this.video.mediaKeys) throw new TaintedVideoError('encrypted media');
    this.canvas.className = 'sbs3d-canvas';
    this.canvas.style.cssText = 'position:absolute;pointer-events:none;display:block;background:#000;margin:0;padding:0;border:0;';
    const z = getComputedStyle(this.video).zIndex;
    if (z !== 'auto') this.canvas.style.zIndex = z;
    this.placeCanvas();

    this.on(this.video, 'seeked', () => this.onDiscontinuity());
    this.on(this.video, 'pause', () => {
      if (this.settings.freezeOnPause) this.freeze();
    });
    this.on(this.video, 'play', () => this.unfreeze());
    for (const { stage } of PIPELINE) {
      // Another extension turned on or off for this video: switch picture source.
      this.on(this.video, `${stage}:change`, () => {
        this.placeCanvas();
        this.newFrame = true;
        this.idle = 0;
      });
      this.on(this.video, `${stage}:frame`, () => {
        if (this.source !== this.video) this.newFrame = true;
      });
    }
    this.on(this.video, 'emptied', () => {
      this.cuts.reset();
      this.onDiscontinuity();
    });
    this.on(document, 'fullscreenchange', () => (this.idle = 0));
    this.watchFrames();
    this.applySettings(this.settings);
    this.statsTimer = window.setInterval(() => this.updateStats(), 1000);
    this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.statsTimer);
    this.listeners.forEach((off) => off());
    this.renderer.dispose();
    this.captions.dispose();
    this.canvas.remove();
    this.statsEl?.remove();
    this.onEnd(this);
  }

  applySettings(s: Settings) {
    const modeChanged = s.algorithm !== this.settings.algorithm || !this.started;
    const wasFreezing = this.settings.freezeOnPause;
    this.settings = s;
    this.idle = 0;
    if (!s.freezeOnPause || modeChanged) this.unfreeze();
    else if (!wasFreezing && this.video.paused) this.freeze();
    if (modeChanged) {
      this.mlActive = false;
      this.mlFailed = '';
      this.mlCount = 0;
      this.mlRange = null;
      // Shader algorithms keep a different history (motion parallax's accumulator), so start fresh.
      this.renderer.resetHistory();
      const algorithm = s.algorithm;
      const model = mlModel(algorithm);
      if (model && depthBridge.isReady(model)) {
        this.mlActive = true;
        this.mlStale = true;
      } else if (model) {
        depthBridge.ensureLoaded(model).then((ok) => {
          if (this.settings.algorithm !== algorithm) return;
          if (ok) {
            this.mlActive = true;
            this.mlStale = true;
          } else {
            this.mlFailed = depthBridge.error;
            if (algorithm !== 'auto') this.overlay.toast(`ML depth unavailable (${depthBridge.error}). Using heuristic depth.`, 6000);
          }
        });
      }
    }
    this.started = true;
    this.captions.setSiteCaptionsHidden(this.captionsOn);
    if (s.showStats && !this.statsEl) this.statsEl = this.overlay.createStats();
    if (!s.showStats && this.statsEl) {
      this.statsEl.remove();
      this.statsEl = null;
    }
  }

  /** Captions are redrawn inside the 3D picture for the stereo layouts. */
  private get captionsOn(): boolean {
    return this.settings.captions && this.settings.layout !== 'depth' && this.settings.layout !== 'rgbd';
  }

  get modeLabel(): string {
    if (this.mlActive) return `ML depth (${depthBridge.provider})`;
    if (mlModel(this.settings.algorithm) && depthBridge.state === 'loading') return 'Heuristic (loading ML model…)';
    return SHADER_LABELS[this.shaderDepth];
  }

  /** The shader algorithm in use whenever ML depth isn't (ML algorithms fall back to heuristic). */
  private get shaderDepth(): ShaderDepth {
    const a: Algorithm = this.settings.algorithm;
    return a === 'scene' || a === 'ground' || a === 'motion' ? a : 'heuristic';
  }

  private on(target: EventTarget, type: string, fn: EventListener) {
    target.addEventListener(type, fn);
    this.listeners.push(() => target.removeEventListener(type, fn));
  }

  /** Where the picture comes from: the last PIPELINE stage that's on for this video, else the video. */
  private get source(): HTMLVideoElement | HTMLCanvasElement {
    for (const { key } of PIPELINE) {
      const id = this.video.dataset[key];
      const el = id ? document.getElementById(id) : null;
      if (el instanceof HTMLCanvasElement && el.isConnected && el.width > 2) return el;
    }
    return this.video;
  }

  /**
   * Keeps the 3D canvas above the picture source and every other stage's overlay after it
   * (same z-index, so the later sibling is on top): 3D always shows last.
   */
  private placeCanvas() {
    let after: Element = this.source;
    const overlays = PIPELINE.map((p) => p.overlay);
    for (let el = after.nextElementSibling; el; el = el.nextElementSibling) {
      if (el !== this.canvas && overlays.some((c) => el.classList.contains(c))) after = el;
    }
    if (after.nextElementSibling !== this.canvas) after.insertAdjacentElement('afterend', this.canvas);
  }

  private watchFrames() {
    const v = this.video;
    if (!('requestVideoFrameCallback' in v)) return; // fall back to uploading every tick
    let handle = 0;
    const cb = () => {
      // Another stage's output announces its own frames, a little after the video's.
      if (this.source === v) this.newFrame = true;
      handle = v.requestVideoFrameCallback(cb);
    };
    handle = v.requestVideoFrameCallback(cb);
    this.listeners.push(() => v.cancelVideoFrameCallback(handle));
  }

  /** Seek or scene cut: the previous depth no longer matches the picture. */
  private onDiscontinuity() {
    this.unfreeze();
    this.newFrame = true;
    this.idle = 0;
    this.shot++;
    if (this.mlActive) {
      // ML depth for the new shot is ~1 inference away; snap to it the moment it arrives.
      // (Going flat in between and fading back in read as warping, especially in montages
      // with several cuts a second.)
      this.resetOnNextDepth = true;
      this.mlStale = true;
    } else {
      this.renderer.resetHistory();
    }
  }

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    const v = this.video;
    if (!v.isConnected) return this.stop();
    if (v.readyState < 2 || !v.videoWidth) return;

    this.placeCanvas(); // another stage may have put its overlay on top since
    const boxChanged = this.layout();
    const src = this.source;
    const hasRvfc = 'requestVideoFrameCallback' in v;
    const frameChanged = this.newFrame || (!hasRvfc && src === v);
    if (frameChanged) {
      try {
        this.renderer.uploadVideo(src);
      } catch (e) {
        if (e instanceof TaintedVideoError) {
          this.overlay.toast(taintedVideoMessage(this.video), 7000);
          this.unreadable = true;
          return this.stop();
        }
        throw e;
      }
      this.newFrame = false;
      this.idle = 0;
      this.mlStale = true;
      if (this.cuts.check(v, performance.now(), src)) {
        this.canvas.dataset.cuts = String(Number(this.canvas.dataset.cuts ?? 0) + 1);
        this.logShotEvent('cut');
        this.onDiscontinuity();
      }
    }
    if (this.mlActive && this.mlStale && !this.frozen) this.captureForMl();
    if (boxChanged) this.idle = 0;
    const s = this.settings;
    const content = this.contentRect();
    if (this.captionsOn) {
      const sx = s.layout === 'hsbs' ? 2 : 1;
      const sy = s.layout === 'htab' ? 2 : 1;
      const eyeW = Math.max(2, Math.min(4096, Math.round((this.canvas.width / sx) * content[2])));
      const eyeH = Math.max(2, Math.min(4096, Math.round((this.canvas.height / sy) * content[3])));
      if (this.captions.update(performance.now(), eyeW, eyeH, sx, sy)) {
        this.renderer.uploadCaptions(this.captions.canvas);
        this.idle = 0;
      }
    }
    if (!this.frozen && this.depthBlend() < 1) this.idle = 0;
    if (this.idle++ > IDLE_FRAMES) return;

    this.renderer.render({
      mode: this.mlActive ? 'ml' : this.shaderDepth,
      newFrame: frameChanged,
      freezeDepth: this.frozen,
      layout: s.layout,
      strength: s.strength,
      convergence: s.convergence,
      swapEyes: s.swapEyes,
      alpha: 1 - s.smoothing,
      mlRange: this.mlRange ?? [0, 1],
      mlRangePrev: this.mlRangePrev,
      mlBlend: this.depthBlend(),
      content,
      captions: this.captionsOn && this.captions.hasContent,
      ...this.cleanupParams(),
    });
    this.renderFrames++;
  };

  /**
   * How far to crossfade from the previous ML depth map to the newest (0..1). Depth maps
   * arrive only ~12 times a second; interpolating over the time until the next one turns
   * those steps into continuous change, at the cost of about one more interval of lag.
   */
  private depthBlend(): number {
    if (this.frozen) return this.frozenBlend;
    if (!this.settings.interpolateDepth) return 1;
    return Math.min(1, Math.max(0, (performance.now() - this.mlArrival) / this.mlInterval));
  }

  /** Holds depth as it is now; settings changes still redraw from it. */
  private freeze() {
    if (this.frozen) return;
    this.frozenBlend = this.depthBlend();
    this.frozen = true;
  }

  private unfreeze() {
    if (!this.frozen) return;
    this.frozen = false;
    this.mlStale = true; // results that finished while frozen were dropped
    this.idle = 0;
  }

  /** Artifact cleanup settings for the renderer, or all of them off if the section is off. */
  private cleanupParams() {
    const s = this.settings;
    if (!s.cleanup) {
      return {
        edgeSnap: 0,
        edgeDilation: 0,
        holeFill: 'off' as const,
      };
    }
    return {
      edgeSnap: s.edgeSnap,
      edgeDilation: s.edgeDilation,
      holeFill: s.holeFill,
    };
  }

  /** Positions and sizes the canvas over the video. Returns true if anything changed. */
  private layout(): boolean {
    const v = this.video;
    const c = this.canvas;
    const w = v.offsetWidth;
    const h = v.offsetHeight;
    c.style.left = `${v.offsetLeft}px`;
    c.style.top = `${v.offsetTop}px`;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.min(3840, Math.max(2, Math.round(w * dpr)));
    const bh = Math.min(2160, Math.max(2, Math.round(h * dpr)));
    const key = `${bw}x${bh}:${v.offsetLeft},${v.offsetTop}`;
    if (c.width !== bw || c.height !== bh) {
      c.width = bw;
      c.height = bh;
    }
    if (key === this.lastBox) return false;
    this.lastBox = key;
    return true;
  }

  /** Where the video picture sits inside the canvas (per eye), honoring object-fit. */
  private contentRect(): [number, number, number, number] {
    const v = this.video;
    const bw = this.canvas.width;
    const bh = this.canvas.height;
    const fit = getComputedStyle(v).objectFit;
    if (fit === 'fill') return [0, 0, 1, 1];
    const scale = fit === 'cover'
      ? Math.max(bw / v.videoWidth, bh / v.videoHeight)
      : Math.min(bw / v.videoWidth, bh / v.videoHeight);
    const w = (v.videoWidth * scale) / bw;
    const h = (v.videoHeight * scale) / bh;
    return [(1 - w) / 2, (1 - h) / 2, w, h];
  }

  private captureForMl() {
    if (this.capturing || depthBridge.busy) return;
    const v = this.video;
    // MiDaS takes a fixed 256x256 square (the picture is squeezed to fit); the Depth Anything
    // models take any size in 14 px patches.
    if (mlModel(this.settings.algorithm) === 'midas') return this.inferMl(256, 256);
    const aspect = v.videoWidth / v.videoHeight;
    const short = this.settings.mlResolution;
    let w = aspect >= 1 ? short * aspect : short;
    let h = aspect >= 1 ? short : short / aspect;
    const k = Math.min(1, ML_MAX_LONG_SIDE / Math.max(w, h));
    w = Math.max(PATCH, Math.round((w * k) / PATCH) * PATCH);
    h = Math.max(PATCH, Math.round((h * k) / PATCH) * PATCH);
    this.inferMl(w, h);
  }

  /** Captures the current frame at w x h and runs it through the ML model. */
  private async inferMl(w: number, h: number) {
    this.mlInput = `${w}×${h}`;
    this.capturing = true;
    this.mlStale = false;
    this.renderer.markMlCapture(); // copied when this tick renders, the same frame as the bitmap
    const shot = this.shot;
    let result: DepthResult | null = null;
    let thumb: Float32Array | null = null;
    try {
      const bitmap = await createImageBitmap(this.source, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
      thumb = this.thumbs.take(bitmap); // before infer() hands the bitmap over
      result = await depthBridge.infer(bitmap);
    } catch (e) {
      console.warn('[2D-3D] frame capture failed:', e);
    } finally {
      this.capturing = false;
    }
    if (!result || !this.mlActive) return;
    if (shot !== this.shot) return; // captured before a cut/seek: stale
    if (this.frozen) return; // finished after the pause: would move the frozen depth
    this.onDepth(result, thumb);
  }

  /** thumb: a thumbnail of the frame the depth was computed from. */
  private onDepth(r: DepthResult, thumb: Float32Array | null) {
    this.renderer.uploadMlDepth(r.data, r.width, r.height);
    const now = performance.now();
    const since = now - this.mlArrival;
    if (since < 500) this.mlInterval = Math.min(250, Math.max(30, this.mlInterval * 0.8 + since * 0.2));
    this.mlArrival = now;
    this.mlRangePrev = this.mlRange ?? [r.min, r.max];
    // A drastic change in the depth layout where most of the picture changed too: a cut the
    // color detector missed. Snap to the new depth instead of blending into it. (A depth jump
    // alone is mostly motion or an unsteady model, where snapping reads as the depth jerking.)
    const depthChange = this.depthChange.measure(r.data, r.min, r.max);
    const share = this.depthThumb && thumb ? changedShare(this.depthThumb, thumb) : 1;
    const depthJumped = depthChange > DEPTH_JUMP;
    if (depthJumped) {
      // For tuning DEPTH_JUMP_SHARE: "videoTime:depthChange:share:colorCutPending" per jump.
      const log = (this.canvas.dataset.jumpLog ?? '').split(' ').filter(Boolean);
      log.push(`${this.video.currentTime.toFixed(2)}:${depthChange.toFixed(3)}:${share.toFixed(2)}:${this.resetOnNextDepth ? 1 : 0}`);
      this.canvas.dataset.jumpLog = log.slice(-400).join(' ');
    }
    const pictureChanged = share > DEPTH_JUMP_SHARE;
    this.depthThumb = thumb;
    const jumped = depthJumped && pictureChanged;
    if (jumped) {
      this.canvas.dataset.depthJumps = String(Number(this.canvas.dataset.depthJumps ?? 0) + 1);
      this.logShotEvent('depth');
    } else if (depthJumped) {
      this.logShotEvent('held');
    }
    const reset = this.resetOnNextDepth || jumped || !this.mlRange;
    if (reset && this.resetOnNextDepth) this.logShotEvent('snap');
    if (reset) {
      this.mlRange = [r.min, r.max];
      this.renderer.resetHistory();
      this.resetOnNextDepth = false;
      this.mlArrival = -Infinity; // show the new shot's depth at once, no crossfade from the old
    } else {
      // Smooth the normalization range a little so global depth doesn't jitter.
      const a = RANGE_FOLLOW;
      this.mlRange = [this.mlRange![0] + (r.min - this.mlRange![0]) * a, this.mlRange![1] + (r.max - this.mlRange![1]) * a];
    }
    this.idle = 0;
    this.depthFrames++;
    this.mlCount++;
    // The first runs include WebGPU shader compilation, so keep them out of the average.
    if (this.mlCount <= ML_WARMUP_RUNS) return;
    const n = this.mlCount - ML_WARMUP_RUNS;
    this.mlMsAvg = n === 1 ? r.ms : this.mlMsAvg * 0.8 + r.ms * 0.2;
    if (this.settings.algorithm === 'auto' && n >= 5 && this.mlMsAvg > AUTO_MAX_INFER_MS) {
      this.mlActive = false;
      this.mlFailed = `too slow (${Math.round(this.mlMsAvg)} ms/frame)`;
      this.overlay.toast(`ML depth is too slow on this GPU (${Math.round(this.mlMsAvg)} ms). Switched to heuristic depth.`, 6000);
    }
  }

  /**
   * Recent shot-change detections ("kind@videoTime"), exposed for debugging and tests. held: a
   * depth jump that didn't snap, because the picture didn't change like a cut.
   */
  private logShotEvent(kind: 'cut' | 'depth' | 'held' | 'snap') {
    const log = (this.canvas.dataset.shotLog ?? '').split(' ').filter(Boolean);
    log.push(`${kind}@${this.video.currentTime.toFixed(2)}`);
    this.canvas.dataset.shotLog = log.slice(-300).join(" ");
  }

  private updateStats() {
    // Exposed on the canvas for debugging and the e2e test.
    this.canvas.dataset.mode = this.mlActive ? 'ml' : this.shaderDepth;
    this.canvas.dataset.renderFps = String(this.renderFrames);
    this.canvas.dataset.depthFps = String(this.depthFrames);
    this.canvas.dataset.depthMs = String(Math.round(this.mlMsAvg));
    if (this.mlFailed) this.canvas.dataset.mlError = this.mlFailed;
    if (!this.statsEl) {
      this.renderFrames = 0;
      this.depthFrames = 0;
      return;
    }
    const r = this.video.getBoundingClientRect();
    this.statsEl.style.left = `${Math.max(4, r.right - 330)}px`;
    this.statsEl.style.top = `${Math.max(4, r.top + 12)}px`;
    const v = this.video;
    const c = this.canvas;
    const dropped = v.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0;
    let text = `${this.modeLabel}\nrender ${this.renderFrames} fps · dropped ${Math.max(0, dropped - this.lastDropped)}/s`;
    this.lastDropped = dropped;
    if (this.mlActive) text += `\ndepth ${this.depthFrames} fps · ${Math.round(this.mlMsAvg)} ms · ${this.mlInput}`;
    text += `\nvideo ${v.videoWidth}×${v.videoHeight} → ${c.width}×${c.height}`;
    if (this.mlFailed) text += `\nML off: ${this.mlFailed}`;
    this.statsEl.textContent = text;
    this.renderFrames = 0;
    this.depthFrames = 0;
  }
}

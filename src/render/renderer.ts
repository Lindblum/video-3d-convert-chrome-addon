import { DEPTH_FS, DILATE_FS, FULLSCREEN_VS, REFINE_FS, STEREO_FS } from './shaders';
import type { HoleFill, Layout, ShaderDepth } from '../shared/settings';

export interface FrameParams {
  /** Where depth comes from: the uploaded ML depth map, or one of the shader algorithms. */
  mode: 'ml' | ShaderDepth;
  /** The video frame changed since the last render (motion parallax only measures then). */
  newFrame: boolean;
  layout: Layout;
  /** Percent of eye width. */
  strength: number;
  convergence: number;
  swapEyes: boolean;
  /** Weight of the new depth estimate this frame (1 = no smoothing). */
  alpha: number;
  mlRange: [number, number];
  /** Range of the depth map before the newest one, and how far to blend from it (0..1). */
  mlRangePrev: [number, number];
  mlBlend: number;
  /** Video content rect inside one eye view, normalized, top-left origin. */
  content: [number, number, number, number];
  /** Composite the caption layer (see uploadCaptions). */
  captions: boolean;
  /** 0..1: how strongly depth edges snap to color edges (0 = plain bilinear upsample). */
  edgeSnap: number;
  /** Pixels (at refined depth resolution) to grow near depth outward. */
  edgeDilation: number;
  holeFill: HoleFill;
}

const HOLE_FILL_INDEX: Record<HoleFill, number> = { off: 0, sharp: 1, soft: 2, mirror: 3 };

// Matches uMode in DEPTH_FS.
const MODE_INDEX: Record<FrameParams['mode'], number> = { heuristic: 0, ml: 1, scene: 2, ground: 3, motion: 4 };

const LAYOUT_INDEX: Record<Layout, number> = { hsbs: 0, htab: 1, depth: 2, anaglyph: 3, interlaced: 4, rgbd: 5 };
/** Width of the depth state buffers; height follows the video aspect ratio. */
const DEPTH_STATE_WIDTH = 384;
/** Max width of the edge-refined depth map the stereo pass reads. */
const REFINED_MAX_WIDTH = 1280;

type Uniforms = Record<string, WebGLUniformLocation | null>;

export class TaintedVideoError extends Error {}

export class Renderer {
  private gl: WebGL2RenderingContext;
  private depthProg: WebGLProgram;
  private refineProg: WebGLProgram;
  private dilateProg: WebGLProgram;
  private stereoProg: WebGLProgram;
  private depthU: Uniforms;
  private refineU: Uniforms;
  private dilateU: Uniforms;
  private stereoU: Uniforms;
  private videoTex: WebGLTexture;
  /** Samples videoTex through its mipmaps (scene cues); other passes keep plain bilinear. */
  private mipSampler: WebGLSampler;
  /** videoTex's mipmaps match the current frame. */
  private mipsFresh = false;
  private mlTex: WebGLTexture;
  /** The depth map before mlTex; the two swap on each upload. */
  private mlTexPrev: WebGLTexture;
  private capTex: WebGLTexture;
  private state: { tex: WebGLTexture; fbo: WebGLFramebuffer }[] = [];
  private stateIdx = 0;
  private stateSize = [0, 0];
  /** Low-res color written alongside the depth state; guides the edge-aware upsample. */
  private guideTex: WebGLTexture | null = null;
  private refined: { tex: WebGLTexture; fbo: WebGLFramebuffer } | null = null;
  private dilated: { tex: WebGLTexture; fbo: WebGLFramebuffer } | null = null;
  /** Horizontal half of the separable dilation. */
  private dilateTemp: { tex: WebGLTexture; fbo: WebGLFramebuffer } | null = null;
  private refinedSize = [0, 0];
  private floatTargets: boolean;
  private hasVideo = false;
  private hasMl = false;
  private first = true;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    this.depthProg = this.program(FULLSCREEN_VS, DEPTH_FS);
    this.refineProg = this.program(FULLSCREEN_VS, REFINE_FS);
    this.dilateProg = this.program(FULLSCREEN_VS, DILATE_FS);
    this.stereoProg = this.program(FULLSCREEN_VS, STEREO_FS);
    this.depthU = this.uniforms(this.depthProg, ['uPrev', 'uVideo', 'uMl', 'uMlPrev', 'uMode', 'uMlRange', 'uMlRangePrev', 'uMlBlend', 'uAlpha', 'uTexel', 'uReset', 'uNewFrame', 'uVideoMip']);
    this.refineU = this.uniforms(this.refineProg, ['uState', 'uGuide', 'uVideo', 'uLowSize', 'uSnap']);
    this.dilateU = this.uniforms(this.dilateProg, ['uDepth', 'uStep', 'uRadius']);
    this.stereoU = this.uniforms(this.stereoProg, ['uVideo', 'uDepth', 'uLayout', 'uStrength', 'uConv', 'uSwap', 'uContent', 'uCaptions', 'uCapOn', 'uCapDisp', 'uHeight', 'uHoleFill', 'uFillMargin', 'uDepthTexelX']);
    this.videoTex = this.texture();
    this.mipSampler = gl.createSampler()!;
    gl.samplerParameteri(this.mipSampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.samplerParameteri(this.mipSampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.mipSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.mipSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.mlTex = this.texture();
    this.mlTexPrev = this.texture();
    this.capTex = this.texture();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  /**
   * Uploads the current video frame (or a canvas holding it, such as Video Moutheyes' output).
   * Throws TaintedVideoError for cross-origin/DRM video.
   */
  uploadVideo(video: HTMLVideoElement | HTMLCanvasElement) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'SecurityError') throw new TaintedVideoError(e.message);
      throw e;
    }
    this.hasVideo = true;
    this.mipsFresh = false;
    if (video instanceof HTMLVideoElement) this.ensureTargets(video.videoWidth, video.videoHeight);
    else this.ensureTargets(video.width, video.height);
  }

  uploadMlDepth(data: Float32Array, width: number, height: number) {
    const gl = this.gl;
    [this.mlTex, this.mlTexPrev] = [this.mlTexPrev, this.mlTex];
    gl.bindTexture(gl.TEXTURE_2D, this.mlTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, width, height, 0, gl.RED, gl.FLOAT, data);
    this.hasMl = true;
  }

  /** Uploads the caption layer (straight alpha), stored premultiplied for compositing. */
  uploadCaptions(source: OffscreenCanvas) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.capTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  /** Forget temporal history, e.g. after a seek or source change. */
  resetHistory() {
    this.first = true;
  }

  render(p: FrameParams) {
    const gl = this.gl;
    if (!this.hasVideo) return;
    // Until the first ML depth map arrives, use the heuristic.
    const mode = p.mode === 'ml' && !this.hasMl ? 0 : MODE_INDEX[p.mode];

    // Pass 1: depth state ping-pong (+ low-res color guide via a second draw buffer).
    const prev = this.state[this.stateIdx];
    const next = this.state[1 - this.stateIdx];
    gl.bindFramebuffer(gl.FRAMEBUFFER, next.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, this.stateSize[0], this.stateSize[1]);
    gl.useProgram(this.depthProg);
    this.bind(0, prev.tex, this.depthU.uPrev);
    this.bind(1, this.videoTex, this.depthU.uVideo);
    this.bind(2, this.mlTex, this.depthU.uMl);
    this.bind(3, this.mlTexPrev, this.depthU.uMlPrev);
    gl.uniform1i(this.depthU.uMode, mode);
    gl.uniform2f(this.depthU.uMlRange, p.mlRange[0], p.mlRange[1]);
    gl.uniform2f(this.depthU.uMlRangePrev, p.mlRangePrev[0], p.mlRangePrev[1]);
    gl.uniform1f(this.depthU.uMlBlend, p.mlBlend);
    gl.uniform1f(this.depthU.uAlpha, this.first ? 1 : p.alpha);
    gl.uniform2f(this.depthU.uTexel, 1 / this.stateSize[0], 1 / this.stateSize[1]);
    gl.uniform1i(this.depthU.uReset, this.first ? 1 : 0);
    gl.uniform1i(this.depthU.uNewFrame, p.newFrame ? 1 : 0);
    if (mode === MODE_INDEX.scene) {
      if (!this.mipsFresh) {
        gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
        gl.generateMipmap(gl.TEXTURE_2D);
        this.mipsFresh = true;
      }
      this.bind(4, this.videoTex, this.depthU.uVideoMip);
      gl.bindSampler(4, this.mipSampler);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindSampler(4, null);
    this.stateIdx = 1 - this.stateIdx;
    this.first = false;

    // Pass 2: edge-aware upsample of the depth state.
    const refined = this.refined!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, refined.fbo);
    gl.viewport(0, 0, this.refinedSize[0], this.refinedSize[1]);
    gl.useProgram(this.refineProg);
    this.bind(0, next.tex, this.refineU.uState);
    this.bind(1, this.guideTex!, this.refineU.uGuide);
    this.bind(2, this.videoTex, this.refineU.uVideo);
    gl.uniform2f(this.refineU.uLowSize, this.stateSize[0], this.stateSize[1]);
    gl.uniform1f(this.refineU.uSnap, p.edgeSnap);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 3: grow near depth so object rims move with the object.
    let depthTex = refined.tex;
    if (p.edgeDilation > 0) {
      // Separable square max filter: horizontal into a temp target, then vertical.
      gl.useProgram(this.dilateProg);
      gl.uniform1i(this.dilateU.uRadius, Math.min(30, Math.round(p.edgeDilation)));
      const passes: [WebGLTexture, { tex: WebGLTexture; fbo: WebGLFramebuffer }, number, number][] = [
        [refined.tex, this.dilateTemp!, 1 / this.refinedSize[0], 0],
        [this.dilateTemp!.tex, this.dilated!, 0, 1 / this.refinedSize[1]],
      ];
      for (const [src, dst, sx, sy] of passes) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        this.bind(0, src, this.dilateU.uDepth);
        gl.uniform2f(this.dilateU.uStep, sx, sy);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      depthTex = this.dilated!.tex;
    }

    // Pass 4: stereo composite to the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.stereoProg);
    this.bind(0, this.videoTex, this.stereoU.uVideo);
    this.bind(1, depthTex, this.stereoU.uDepth);
    gl.uniform1i(this.stereoU.uHoleFill, HOLE_FILL_INDEX[p.holeFill]);
    gl.uniform1f(this.stereoU.uFillMargin, (p.edgeDilation + 1.5) / this.refinedSize[0]);
    gl.uniform1f(this.stereoU.uDepthTexelX, 1 / this.refinedSize[0]);
    gl.uniform1i(this.stereoU.uLayout, LAYOUT_INDEX[p.layout]);
    gl.uniform1f(this.stereoU.uStrength, p.strength / 100);
    gl.uniform1f(this.stereoU.uConv, p.convergence);
    gl.uniform1i(this.stereoU.uSwap, p.swapEyes ? 1 : 0);
    gl.uniform4f(this.stereoU.uContent, ...p.content);
    gl.uniform1f(this.stereoU.uHeight, this.canvas.height);
    this.bind(2, this.capTex, this.stereoU.uCaptions);
    gl.uniform1i(this.stereoU.uCapOn, p.captions ? 1 : 0);
    // Float captions just in front of the nearest scene depth so they never sit "inside"
    // an object; anaglyph keeps them on the screen plane so the text has no color fringes.
    const nearest = (p.strength / 100) * (1 - p.convergence);
    gl.uniform1f(this.stereoU.uCapDisp, p.layout === 'anaglyph' ? 0 : nearest * 1.1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /** (Re)creates the depth state, guide and refined targets when the video size changes. */
  private ensureTargets(videoW: number, videoH: number) {
    const aspect = videoW / Math.max(1, videoH) || 16 / 9;
    const w = DEPTH_STATE_WIDTH;
    const h = Math.max(16, Math.round(w / aspect));
    const rw = Math.max(w, Math.min(REFINED_MAX_WIDTH, videoW));
    const rh = Math.max(16, Math.round(rw / aspect));
    if (this.stateSize[0] === w && this.stateSize[1] === h && this.refinedSize[0] === rw && this.refinedSize[1] === rh) return;
    const gl = this.gl;
    for (const t of [...this.state, ...(this.refined ? [this.refined, this.dilated!, this.dilateTemp!] : [])]) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    if (this.guideTex) gl.deleteTexture(this.guideTex);

    const alloc = (tw: number, th: number, internal: number, format: number, type: number) => {
      const tex = this.texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, tw, th, 0, format, type, null);
      return tex;
    };
    const f = this.floatTargets;
    this.guideTex = alloc(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    this.state = [0, 1].map(() => {
      const tex = f ? alloc(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT) : alloc(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.guideTex, 0);
      return { tex, fbo };
    });
    const target = () => {
      const tex = f ? alloc(rw, rh, gl.R16F, gl.RED, gl.HALF_FLOAT) : alloc(rw, rh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo };
    };
    this.refined = target();
    this.dilated = target();
    this.dilateTemp = target();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.stateSize = [w, h];
    this.refinedSize = [rw, rh];
    this.first = true;
  }

  private bind(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const prog = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(sh)}`);
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(prog)}`);
    return prog;
  }

  private uniforms(prog: WebGLProgram, names: string[]): Uniforms {
    return Object.fromEntries(names.map((n) => [n, this.gl.getUniformLocation(prog, n)]));
  }
}

/**
 * How depth is estimated. auto: Depth Anything V2, falling back to heuristic if it can't
 * load or is too slow. da2/da3/midas: that ML model. The rest are GPU shaders, no model.
 */
export type Algorithm = 'auto' | 'heuristic' | 'da2' | 'da3' | 'midas' | 'scene' | 'ground' | 'motion';
/** ML depth model: Depth Anything V2 Small, Depth Anything V3 Small, MiDaS v2.1 Small. */
export type DepthModel = 'da2' | 'da3' | 'midas';
/** Depth estimated in the depth shader, without a model. */
export type ShaderDepth = 'heuristic' | 'scene' | 'ground' | 'motion';
export type HoleFill = 'off' | 'sharp' | 'soft' | 'mirror';
export type Layout = 'hsbs' | 'htab' | 'anaglyph' | 'depth' | 'rgbd';

export interface Settings {
  algorithm: Algorithm;
  layout: Layout;
  /** Maximum disparity between near and far, as a percentage of eye width. */
  strength: number;
  /** Depth (0 = far, 1 = near) that sits on the screen plane. */
  convergence: number;
  /** 0 = no temporal smoothing, close to 1 = very smooth but laggy. */
  smoothing: number;
  /** Crossfade between ML depth maps over the time until the next one, instead of stepping. */
  interpolateDepth: boolean;
  /** Keep depth exactly as it was when the video paused, instead of letting it settle. */
  freezeOnPause: boolean;
  swapEyes: boolean;
  showStats: boolean;
  /** Redraw captions inside each eye so they stay readable in SBS/TOB. */
  captions: boolean;
  /** Master switch for every Artifact cleanup option; off renders the plain conversion. */
  cleanup: boolean;
  /** 0..1: how strongly depth edges snap to color edges (0 = off). */
  edgeSnap: number;
  /** Pixels to grow near depth outward, so object rims move with the object (0..30). */
  edgeDilation: number;
  /** How disoccluded background is filled. */
  holeFill: HoleFill;
  /** Short side, in pixels, of the frame fed to the depth model. */
  mlResolution: number;
}

/** Artifact cleanup values that leave the conversion unaltered (the defaults, and Reset). */
export const NEUTRAL_CLEANUP = {
  edgeSnap: 0,
  edgeDilation: 0,
  holeFill: 'off',
} satisfies Partial<Settings>;

export const DEFAULT_SETTINGS: Settings = {
  algorithm: 'auto',
  layout: 'hsbs',
  strength: 3,
  convergence: 0.35,
  smoothing: 0.75,
  interpolateDepth: true,
  freezeOnPause: false,
  swapEyes: false,
  showStats: false,
  captions: true,
  cleanup: true,
  ...NEUTRAL_CLEANUP,
  mlResolution: 252,
};

/** The ML model an algorithm runs, or null for the shader-only ones. */
export function mlModel(a: Algorithm): DepthModel | null {
  if (a === 'auto') return 'da2';
  return a === 'da2' || a === 'da3' || a === 'midas' ? a : null;
}

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(null)) as Partial<Settings> & Record<string, unknown>;
  const settings = { ...DEFAULT_SETTINGS, ...stored } as Settings & Record<string, unknown>;
  // Settings from older versions that no longer exist.
  if (['hitmap', 'interlaced'].includes(settings.layout as string)) settings.layout = DEFAULT_SETTINGS.layout;
  // Before Algorithm, depth had a mode (auto / ml / heuristic) and a separate ML model.
  if (stored.algorithm === undefined && stored.depthMode !== undefined) {
    if (stored.depthMode === 'heuristic') settings.algorithm = 'heuristic';
    else if (stored.depthMode === 'ml') settings.algorithm = (stored.depthModel as DepthModel | undefined) ?? 'da2';
  }
  for (const key of ['depthMode', 'depthModel', 'crosstalk', 'crosstalkLeft', 'crosstalkRight', 'crosstalkPattern', 'edgeFade',
    'fillBrightness', 'fillBrightnessFg', 'fillBgLeft', 'fillBgRight', 'fillFgLeft', 'fillFgRight',
    'fillSplit', 'showFillMask', 'weightRisingLeft', 'weightRisingRight', 'weightFallingLeft',
    'weightFallingRight', 'diffThreshold', 'diffBlur', 'fillEdgeBlur', 'outlineDifferences', 'outlineRisingFill',
    'outlineFallingFill']) {
    delete settings[key];
  }
  return settings;
}

export function saveSettings(patch: Partial<Settings>): Promise<void> {
  return chrome.storage.local.set(patch);
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') loadSettings().then(cb);
  });
}

export type DepthMode = 'auto' | 'ml' | 'heuristic';
export type HoleFill = 'off' | 'sharp' | 'soft' | 'mirror';
export type Layout = 'hsbs' | 'htab' | 'interlaced' | 'anaglyph' | 'depth' | 'rgbd';

export interface Settings {
  depthMode: DepthMode;
  layout: Layout;
  /** Maximum disparity between near and far, as a percentage of eye width. */
  strength: number;
  /** Depth (0 = far, 1 = near) that sits on the screen plane. */
  convergence: number;
  /** 0 = no temporal smoothing, close to 1 = very smooth but laggy. */
  smoothing: number;
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
  depthMode: 'auto',
  layout: 'hsbs',
  strength: 3,
  convergence: 0.35,
  smoothing: 0.75,
  swapEyes: false,
  showStats: false,
  captions: true,
  cleanup: true,
  ...NEUTRAL_CLEANUP,
  mlResolution: 252,
};

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(null)) as Partial<Settings> & Record<string, unknown>;
  const settings = { ...DEFAULT_SETTINGS, ...stored } as Settings & Record<string, unknown>;
  // Settings from older versions that no longer exist.
  if ((settings.layout as string) === 'hitmap') settings.layout = DEFAULT_SETTINGS.layout;
  for (const key of ['crosstalk', 'crosstalkLeft', 'crosstalkRight', 'crosstalkPattern', 'edgeFade',
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

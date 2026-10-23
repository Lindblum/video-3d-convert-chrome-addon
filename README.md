# 2D-3D Video Converter

A Chrome/Brave extension that converts any HTML5 video (YouTube and most other sites) to
**side-by-side 3D in real time**, for 3D TVs and monitors. Depth runs locally on your GPU;
nothing leaves your machine. DRM-protected video (Netflix, Disney+, Prime) can't be converted.

## Depth algorithms

- **ML** (WebGPU via onnxruntime-web), timings on an RX 570:
  - Depth Anything V2 Small (default): ~75 ms per depth map, best balance
  - Depth Anything V3 Small: ~110 ms, smoother background gradients
  - MiDaS v2.1 Small: ~35 ms, blurrier; for slow GPUs
- **Shader** (any GPU, every frame): Heuristic (also the fallback while a model loads),
  Scene Cues, Ground Plane, Motion Parallax.
- **Auto** (default): starts with heuristic depth and switches to Depth Anything V2 once
  loaded, if the GPU keeps it under 150 ms per depth frame.

## View modes

Half side-by-side (default), top-over-bottom, interlaced (passive 3D TVs; needs fullscreen
at native resolution), anaglyph (red/cyan), depth map, and 2D + depth map side by side.
YouTube captions and `<track>` subtitles are redrawn in 3D inside each eye.

## With Video Moutheyes

If the Video Moutheyes extension is also on for a video, the 3D conversion uses its output
(mouths over the eyes) instead of the raw video, in whichever order the two were turned on.

## Build and install

```sh
npm install
npm run build   # unpacked extension in dist/
```

Open `chrome://extensions` (or `brave://extensions`), turn on **Developer mode**, click
**Load unpacked**, and pick `dist/`. Models (50–105 MB) download from Hugging Face on first
use and are cached for offline use.

## Use

1. Hover a video and click **2D-3D: Off**, or press **Alt+Shift+D**. **Alt+Shift+M** cycles view modes.
2. Use the site's fullscreen button; 3D stays on.
3. Set the TV's 3D mode to match. If depth looks inside-out, tick **Swap eyes**.

The toolbar popup holds the rest: algorithm, view mode, strength, convergence, smoothing,
depth-frame interpolation, ML resolution, captions, stats, freezing depth on pause (to
inspect an artifact), and **Artifact cleanup** (edge
dilation for halos, edge snapping, hole fill mode).

**Dual-GPU systems:** if ML depth is slow, set the browser to **High performance** in
Windows Settings → System → Display → Graphics, or launch it with `--force-high-performance-gpu`.

## Development

```sh
npm run watch       # rebuild on change, then reload the extension
npm run typecheck
npm run fetch-test-media && npm run e2e -- --headful [--high-perf] [--bench]
npm run frame -- '{"name": {"layout": "interlaced", "strength": 6}}'   # render one frame to test/frames/
```

e2e needs Brave or Chrome for Testing (branded Chrome 137+ ignores `--load-extension`).

### Layout

- `src/content/`: video discovery, overlay UI, per-video `Session`, shot-cut detection.
- `src/render/`: WebGL2 renderer: depth smoothing → color-guided bilateral upsample →
  optional dilation → per-eye parallax-occlusion stereo with disocclusion hole fill.
- `src/depth/`: the model runs in an extension-origin iframe so page CSPs can't block
  WASM/WebGPU (fp16 when the GPU supports `shader-f16`).

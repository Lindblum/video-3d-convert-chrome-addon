# 2D-3D Video Converter

A Chrome/Brave extension that converts any HTML5 video (YouTube and most other sites) to
**side-by-side 3D in real time**, for 3D TVs and monitors.

- **ML depth:** Depth Anything V2 Small runs locally on your GPU through WebGPU
  (onnxruntime-web). Nothing leaves your machine.
- **Heuristic depth:** a fast shader-only fallback for GPUs without WebGPU or that are too slow.
- **Auto mode** starts with heuristic depth, loads the model in the background, and switches
  to ML if the GPU sustains it (< 150 ms per depth frame). Video always renders at full
  frame rate; depth updates as fast as the GPU allows and is smoothed over time.
- Output: half side-by-side (default), top-over-bottom (TOB), interlaced (row-by-row, for
  passive/polarized 3D TVs), anaglyph (red/cyan glasses, Dubois matrices), the depth map, or depth map (SBS): the 2D video
  on the left and its depth map on the right, for players and displays that take 2D + depth
  (Swap eyes puts the depth on the left).
  Interlaced needs fullscreen at the TV's native resolution so canvas rows line up with
  screen rows. The top row is the left eye; use Swap eyes if your TV expects the opposite.
- 3D captions: YouTube captions and standard `<track>` subtitles are redrawn inside each
  eye, so they stay readable after the TV un-squeezes SBS/TOB. They float just in front of
  the nearest scene depth. Other sites' custom caption overlays aren't supported yet.

DRM-protected video (Netflix, Disney+, Prime, and so on) can't be converted: the browser
doesn't let extensions read its pixels. The extension shows a message when that happens.

## Build and install

```sh
npm install
npm run fetch-model   # downloads the fp16 + fp32 depth models (~150 MB) into models/
npm run build         # outputs the unpacked extension to dist/
```

Then open `chrome://extensions` (or `brave://extensions`), turn on **Developer mode**, click
**Load unpacked**, and pick the `dist/` folder.

## Use

1. Hover a video and click the **3D** button, or press **Alt+Shift+D**.
2. For a 3D TV, use the site's own fullscreen button. 3D stays on in fullscreen.
3. Set the TV's 3D mode to match the output (for example, Side-by-Side for SBS). If depth
   looks inside-out, tick **Swap eyes**.

The toolbar popup has the settings: depth mode, output layout, 3D strength, convergence,
smoothing, ML resolution, swap eyes, captions, a stats overlay, and **Artifact cleanup**.

Artifact cleanup defaults to nothing altered. **Reset** returns it to that state.
Unticking its header turns all of it off at once and keeps your settings, so ticking it
again restores them:

- **Edge dilation** (0–30 px, a separable square max filter): grows near objects' depth
  outward so their rims move with them. Raise it if you see bright or dark outlines
  (halos) around objects.
- **Edge snapping** (0–1): how strongly depth edges follow color edges. Lower it if
  textured areas wobble.
- **Hole fill** (Off / Mirror / Soft / Sharp): how background revealed beside shifted
  objects is filled. Off stretches the object's edge. Sharp repeats the background color
  just past the edge (streaks); Soft averages a few nearby samples (flat patches). Mirror
  reflects the background across the hole's far edge, so its texture continues into the
  hole; in wide holes the reflection can reach unrelated objects.

### Dual-GPU laptops and desktops

Chromium on Windows often gives WebGPU the integrated GPU. If ML depth is slow, set the
browser to **High performance** in Windows Settings → System → Display → Graphics, or start it
with `--force-high-performance-gpu`. On a Radeon RX 570 the model runs at about 70 ms per
frame (about 12 depth fps), which looks smooth because of temporal smoothing.

## Development

```sh
npm run watch         # rebuild on change, then click reload on the extension card
npm run typecheck
npm run fetch-test-media && npm run e2e -- --headful [--high-perf] [--bench]
npm run frame -- '{"name": {"layout": "interlaced", "strength": 6}}'   # render one paused frame
```

`npm run frame` renders a paused frame of the test video under each named settings object
to `test/frames/<name>.png`, for close inspection of artifacts.

`npm run e2e` loads `dist/` into Brave (or Chrome for Testing) using a throwaway profile,
opens `test/index.html`, toggles 3D, and saves screenshots to `test/out/`. Note that branded
Google Chrome 137+ ignores `--load-extension`, so use Brave or Chrome for Testing for e2e.

### How it works

```
content script (page)                      hidden extension iframe (depth/host.html)
 ├─ hover button, shortcuts, popup msgs     └─ onnxruntime-web (WebGPU) + Depth Anything V2
 ├─ overlay <canvas> after the <video>          ▲ ImageBitmap (≈252×448)   │ depth (Float32)
 └─ WebGL2: video tex → depth state → SBS ──────┘                          ▼
```

- `src/content/`: video discovery, overlay UI, one `Session` per converted video (canvas
  layout, `object-fit`, fullscreen, ML frame scheduling with one frame in flight).
- `src/render/`: the WebGL2 renderer, in three passes:
  1. **Depth:** blends the new depth estimate into a ping-pong buffer. Smoothing backs off
     per pixel where the picture is changing, so moving objects don't drag a depth ghost.
  2. **Refine:** a joint bilateral upsample from ~384 px to up to 1280 px wide, guided by
     the video's colors, so depth edges land on object edges.
  3. **Stereo:** a per-eye parallax-occlusion search so near objects occlude far ones.
     The crossing found by the coarse search is refined by bisection. Each pixel's sideways
     magnification is computed from the depth slope at its source (smooth per pixel, so no
     dithering). Mild magnification is stretch; strong magnification (one source pixel
     spread over 2–3+ output pixels) is a disocclusion hole: background the 2D frame never
     showed. Holes are filled from the background beyond the far end of the depth ramp,
     instead of stretching the foreground. Depth fades to zero at the
     left/right frame edges.

  Between refine and stereo, an optional dilation pass (a small max filter) grows near
  depth outward. Object rims mix foreground and background colors and tend to get
  background depth; without dilation they stay behind when the object shifts and show up
  as a halo.
- Shot changes: a cut is a frame whose averaged 32×18 luma thumbnail changes 3× more than
  any of the previous 3 frames (`src/content/scenecut.ts`). A running-average baseline
  missed clear cuts in action scenes. Independently, a big change between consecutive ML
  depth maps (`src/content/depthchange.ts`) snaps to the new depth instead of blending. On a
  cut or seek, depth snaps to the new shot as soon as its depth arrives (no flat phase or
  fade, which looked like warping in montages). The depth range otherwise follows each
  update quickly, so a missed cut settles within an update or two instead of about a
  second. Measured on the Sintel trailer (11 hard cuts): all 11 handled, new-shot depth on
  screen 37–133 ms after each cut (median 85 ms); no snaps in calm footage. ML depth is normalized to its 2nd–98th
  percentiles, so a few extreme pixels can't make the scene's depth pump.
- `src/depth/`: the model runs in an extension-origin iframe so page CSPs can't block
  WASM/WebGPU. It uses fp16 when the GPU supports `shader-f16`, otherwise fp32.

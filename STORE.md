# Chrome Web Store submission

`npm run package` builds the extension and writes `2d-3d-video-converter-<version>.zip` (upload
this). Bump `version` in `package.json` for each upload; the manifest takes it from there.

## Listing

- **Name:** 2D-3D Video Converter
- **Summary** (the manifest description, 132 characters at most): Converts any HTML5 video to
  side-by-side 3D in real time for 3D TVs and monitors.
- **Category:** Entertainment
- **Icon:** `src/icons/icon128.png`.
- **Description:** mention that DRM-protected video (Netflix, Disney+, Prime) can't be converted,
  and that ML depth needs WebGPU and downloads a model on first use.
- **Screenshots** (1280×800 or 640×400, up to 5): use footage you're allowed to show.
  - Blender open movies, CC-BY 3.0, credit "© Blender Foundation | mango.blender.org" in the
    description: *Tears of Steel* (`npm run fetch-test-media`, `test/media/tos-action.mp4`).
  - Not: the film trailers in `test/media/` (John Wick, Mad Max, Carrie). They're for testing only.
  - Played in a plain local page (`npm run test-page`) rather than on YouTube, so no other brand
    or someone else's video is in the shot.
  - Good views: half side-by-side, anaglyph (shows 3D on any screen), and *2D + Depth Map*, which
    shows what the depth model sees.

## Privacy tab

- **Single purpose:** Converts videos on web pages to stereoscopic 3D for 3D TVs, monitors and
  red/cyan glasses.
- **Remote code:** No. All JavaScript and the WebAssembly runtime (onnxruntime-web) are in the
  package. The depth models downloaded from Hugging Face are model weights (ONNX data run by the
  bundled runtime), not code.
- **Data use:** collects none of the listed data types. Video frames are processed locally and
  never sent anywhere; see `PRIVACY.md`.
- **Privacy policy URL:** a public link to `PRIVACY.md`, for example on GitHub.

## Permission justifications

| Permission | Why |
| --- | --- |
| `<all_urls>` host access and content script | Converts videos on any site the user visits, including videos in embedded frames, and redraws their captions in 3D. |
| `scripting` | Adds the content script to tabs that were already open when the extension was installed or updated, and lets the popup reach a tab whose script went stale. |
| `storage` | Saves the popup's settings. |
| `unlimitedStorage` | Keeps the downloaded depth models (50–105 MB each, about 320 MB for all three) in the extension's cache so they work offline and aren't downloaded again. |
| `wasm-unsafe-eval` (CSP) | Runs the bundled onnxruntime-web, which is WebAssembly, for ML depth. No JavaScript `eval`. |
| Web-accessible `depth/host.html` | The depth model runs in a hidden extension iframe so WebAssembly and WebGPU load under the extension's CSP, not the site's. It accepts connections only from the extension's own content script (a one-time token sent through extension messaging). |
| Network access to huggingface.co | Downloads the ML depth model the user picks (or Auto's default) on first use. No user data is sent. |

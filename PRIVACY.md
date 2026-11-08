# 2D-3D Video Converter privacy policy

*Last updated: 2026-11-06*

2D-3D Video Converter does all of its work inside your browser. It does not collect, send, sell or
share any personal data or browsing data, and it has no servers, accounts, analytics or ads.

## What it reads

- **Videos on the pages you visit**, once you turn 3D on for one (or it starts on its own). Frames
  are read locally on your GPU to estimate depth and draw the 3D picture. They are never stored or
  sent anywhere.
- **Captions shown with those videos**, so they can be redrawn inside each eye. They are read from
  the page and never stored or sent anywhere.

## What it downloads

The machine-learning depth models (Depth Anything V2 and V3, MiDaS) are downloaded from Hugging Face
(huggingface.co) the first time one is used, and then kept on your computer. The download is an
ordinary request for a fixed file: it carries nothing about you, your pages or your videos, but like
any download, Hugging Face sees your IP address and browser. The Heuristic, Scene Cues, Ground Plane
and Motion Parallax algorithms need no download.

## What it stores, on your computer only

- **Your settings** (the popup's options), in the extension's local storage, and which popup
  sections you left open.
- **The downloaded depth models** (50–105 MB each), in the extension's cache, so they work offline
  and aren't downloaded again. Removing the extension deletes them.

## Third parties

None receive any data from the extension. Hugging Face only serves the model files described above.

## Contact

Questions: davidrlinderman@gmail.com

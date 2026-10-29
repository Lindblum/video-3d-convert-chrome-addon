// Records the converter's output over hard stretches of real footage, for measuring depth
// flicker and depth/color edge alignment (scripts/probe_analyze.py). Plays each segment with
// the "Video | Depth Map" layout and records it with the browser's screencast; at each
// segment's middle it pauses (depth frozen) and saves stills in that layout, half SBS and
// anaglyph. Output: test/frames/probe/<label>/<video>@<start>/.
// Usage: node scripts/probe.mjs <label> '{"setting": value, ...}' [segments.json]
// Segments: [{"video": "media/x.mp4", "start": 40, "end": 46}, ...] (default: PROBE_SEGMENTS);
// "events": true on a segment only logs its cuts, depth jumps and snaps (events.json).
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const PROBE_SEGMENTS = [
  { video: 'media/johnwick4-trailer.mp4', start: 40, end: 47 }, // close-ups in sunglasses, bokeh
  { video: 'media/johnwick4-trailer.mp4', start: 92, end: 100 }, // nightclub crowd, haze, neon
  { video: 'media/johnwick4-trailer.mp4', start: 108, end: 116 }, // night stairs, fight
  { video: 'media/madmax-trailer.mp4', start: 52, end: 59 }, // gunfire, people on vehicles
  { video: 'media/madmax-trailer.mp4', start: 60, end: 67 }, // faces in the cab
  { video: 'media/madmax-trailer.mp4', start: 72, end: 80 }, // knife fight, dust
  { video: 'media/tos-action.mp4', start: 0, end: 8 }, // workshop, robot arm, hair
  { video: 'media/tos-action.mp4', start: 50, end: 58 }, // two faces, warm interior
];

const [label = 'baseline', cfgArg = '{}', segFile] = process.argv.slice(2);
const config = { algorithm: 'da2', freezeOnPause: true, showStats: false, captions: false, ...JSON.parse(cfgArg) };
const segments = segFile ? JSON.parse(await readFile(segFile, 'utf8')) : PROBE_SEGMENTS;
const BROWSER = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const W = 1920;
const H = 1080;
// Half size: encoding full-size frames at 50 fps slows the depth model.
const SCREENCAST = { format: 'jpeg', quality: 92, maxWidth: W / 2, maxHeight: H / 2, everyNthFrame: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = path.resolve('test');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/probe.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><body style="margin:0;background:#000;overflow:hidden">
      <video id="v" src="${url.searchParams.get('src')}" width="${W}" height="${H}" style="display:block" muted playsinline></video>`);
    return;
  }
  const f = path.join(root, decodeURIComponent(url.pathname));
  try {
    const size = (await stat(f)).size;
    const m = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const s = +m[1];
      const e = m[2] ? +m[2] : size - 1;
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1 });
      createReadStream(f, { start: s, end: e }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size });
      createReadStream(f).pipe(res);
    }
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));

const outRoot = path.resolve('test/frames/probe', label);
await rm(outRoot, { recursive: true, force: true });
const profile = path.resolve('test/frames/probe-profile');
await rm(profile, { recursive: true, force: true });
const ext = path.resolve('dist');
const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: true,
  userDataDir: profile,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-webgpu', '--force-high-performance-gpu', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H },
});

/** Sets extension settings through its depth host frame and gives them a moment to apply. */
async function setSettings(page, s) {
  let host;
  for (let i = 0; i < 100 && !host; i++) {
    host = page.frames().find((f) => f.url().includes('/depth/host.html'));
    if (!host) await sleep(150);
  }
  if (!host) throw new Error('depth host frame never loaded');
  await host.evaluate((c) => chrome.storage.local.set(c), s);
  await sleep(150);
}

const summary = [];
try {
  let page = null;
  let loaded = '';
  for (const seg of segments) {
    if (seg.video !== loaded) {
      await page?.close();
      page = await browser.newPage();
      await page.goto(`http://localhost:${server.address().port}/probe.html?src=${encodeURIComponent(seg.video)}`);
      await page.waitForFunction(() => document.querySelector('#v').readyState >= 2, { timeout: 30000 });
      await page.mouse.move(W / 2, H / 2);
      await sleep(300);
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await page.keyboard.press('KeyD');
      await page.keyboard.up('Shift');
      await page.keyboard.up('Alt');
      await page.waitForSelector('canvas.sbs3d-canvas', { timeout: 10000 });
      await page.mouse.move(W - 1, H - 1); // away from the hover button
      await setSettings(page, { ...config, layout: 'rgbd' });
      // Let the model load and compile before measuring anything.
      await page.evaluate(() => document.querySelector('#v').play());
      for (let i = 0; i < 40; i++) {
        await sleep(1000);
        const d = await page.$eval('canvas.sbs3d-canvas', (c) => ({ ...c.dataset }));
        if ((d.mode === 'ml' && +d.depthFps > 0) || d.mlError) break;
      }
      loaded = seg.video;
    }
    const name = `${path.basename(seg.video, '.mp4')}@${seg.start}`;
    const dir = path.join(outRoot, name);
    await mkdir(path.join(dir, 'stream'), { recursive: true });

    // Start a little early so temporal smoothing has settled by the segment's start.
    await page.evaluate(async (t) => {
      const v = document.querySelector('#v');
      v.pause();
      v.currentTime = t;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      await v.play();
    }, Math.max(0, seg.start - 1.5));
    await page.waitForFunction((t) => document.querySelector('#v').currentTime >= t, { polling: 'raf', timeout: 30000 }, seg.start);

    if (seg.events) {
      // Events only: play the segment and keep the shot log (cuts, depth jumps, snaps), no recording.
      await page.evaluate(() => { const d = document.querySelector('canvas.sbs3d-canvas').dataset; d.shotLog = ''; d.jumpLog = ''; });
      await page.waitForFunction((t) => document.querySelector('#v').currentTime >= t || document.querySelector('#v').ended,
        { polling: 1000, timeout: (seg.end - seg.start + 30) * 1000 }, seg.end);
      const stats = await page.$eval('canvas.sbs3d-canvas', (c) => ({ ...c.dataset }));
      const events = (stats.shotLog ?? '').split(' ').filter(Boolean).map((e) => {
        const [kind, t] = e.split('@');
        return { kind, t: +t };
      });
      await writeFile(path.join(dir, 'events.json'), JSON.stringify({ config, stats, events }, null, 2));
      const count = (k) => events.filter((e) => e.kind === k).length;
      const info = { segment: name, events: true, cut: count('cut'), depth: count('depth'), snap: count('snap'), depthMs: stats.depthMs };
      summary.push(info);
      console.log(info);
      continue;
    }

    const cdp = await page.createCDPSession();
    const frames = [];
    cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
      frames.push({ data, ts: metadata.timestamp });
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', SCREENCAST);
    const mid = (seg.start + seg.end) / 2;
    await page.waitForFunction((t) => document.querySelector('#v').currentTime >= t, { polling: 'raf', timeout: 30000 }, mid);
    await cdp.send('Page.stopScreencast');

    // Stills at the middle, with depth frozen: the same frame and depth in every layout.
    await page.evaluate(() => document.querySelector('#v').pause());
    await sleep(400);
    const stats = await page.$eval('canvas.sbs3d-canvas', (c) => ({ ...c.dataset }));
    const time = await page.$eval('#v', (v) => v.currentTime);
    for (const layout of ['rgbd', 'hsbs', 'anaglyph']) {
      await setSettings(page, { layout });
      await sleep(250);
      await page.screenshot({ path: path.join(dir, `still-${layout}.png`) });
    }
    await setSettings(page, { layout: 'rgbd' });
    await page.evaluate(() => document.querySelector('#v').play());
    await sleep(300);
    await cdp.send('Page.startScreencast', SCREENCAST);
    await page.waitForFunction((t) => document.querySelector('#v').currentTime >= t, { polling: 'raf', timeout: 30000 }, seg.end);
    await cdp.send('Page.stopScreencast');
    await cdp.detach();

    await Promise.all(frames.map((f, i) => writeFile(path.join(dir, 'stream', `${String(i).padStart(4, '0')}.jpg`), Buffer.from(f.data, 'base64'))));
    // Frame gaps over 0.25 s are the pause for the stills (the analysis splits there too).
    const gaps = frames.slice(1).map((f, i) => f.ts - frames[i].ts).filter((g) => g < 0.25);
    const fps = gaps.length / gaps.reduce((a, b) => a + b, 1e-6);
    const info = { segment: name, stillTime: time, frames: frames.length, recordFps: +fps.toFixed(1), mode: stats.mode, depthFps: stats.depthFps, mlMs: stats.mlMs };
    await writeFile(path.join(dir, 'info.json'), JSON.stringify({ ...info, config, stats, timestamps: frames.map((f) => f.ts) }, null, 2));
    summary.push(info);
    console.log(info);
  }
} finally {
  await browser.close();
  server.close();
}
await writeFile(path.join(outRoot, 'summary.json'), JSON.stringify({ config, segments: summary }, null, 2));

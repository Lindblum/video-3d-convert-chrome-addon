// Smoke test: loads dist/ into Brave or Chrome, opens test/index.html, toggles 3D on the first
// video and saves screenshots of the SBS output and the depth map to test/out/.
// Usage: npm run e2e [-- --headful] [-- --browser "C:\path\to\chrome.exe"]
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const headful = args.includes('--headful');
const browserArg = args.includes('--browser') ? args[args.indexOf('--browser') + 1] : null;
const CANDIDATES = [
  browserArg,
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  'C:/Program Files/Google/Chrome for Testing/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

async function findBrowser() {
  for (const p of CANDIDATES) {
    try {
      await stat(p);
      return p;
    } catch {}
  }
  throw new Error('No Brave/Chrome found; pass --browser <path>');
}

const MIME = { '.html': 'text/html', '.mp4': 'video/mp4', '.js': 'text/javascript', '.vtt': 'text/vtt' };
function serve(root) {
  const server = http.createServer(async (req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    try {
      const s = await stat(file.endsWith(path.sep) ? path.join(file, 'index.html') : file);
      const f = s.isDirectory() ? path.join(file, 'index.html') : file;
      const size = (await stat(f)).size;
      const type = MIME[path.extname(f)] ?? 'application/octet-stream';
      const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : size - 1;
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
        createReadStream(f, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
        createReadStream(f).pipe(res);
      }
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await serve(path.resolve('test'));
const url = `http://localhost:${server.address().port}/index.html`;
const ext = path.resolve('dist');
await rm('test/out', { recursive: true, force: true });
await mkdir('test/out', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: await findBrowser(),
  headless: !headful,
  userDataDir: path.resolve('test/out/profile'),
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-webgpu',
    ...(args.includes('--high-perf') ? ['--force-high-performance-gpu'] : []),
    '--window-size=1400,1000',
  ],
  defaultViewport: { width: 1300, height: 900 },
});

let failed = false;
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`[page:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#plain').readyState >= 2, { timeout: 15000 });
  await page.evaluate(() => {
    // Each loop restart is a genuine cut (last frame -> first frame); count them.
    window.__plainLoops = 0;
    document.querySelector('#plain').addEventListener('seeked', () => window.__plainLoops++);
    return document.querySelector('#plain').play();
  });

  const box = await (await page.$('#plain')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(300);
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyD');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');

  const canvas = await page.waitForSelector('canvas.sbs3d-canvas', { timeout: 5000 });
  console.log('Overlay canvas created.');

  // Give the depth model time to load and settle (first WebGPU runs compile shaders).
  let data = {};
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    data = await canvas.evaluate((c) => ({ ...c.dataset, w: c.width, h: c.height }));
    if (data.mode === 'ml' && Number(data.depthFps) > 0) break;
    if (data.mlError) break;
  }
  console.log('Canvas state:', data);
  await page.screenshot({ path: 'test/out/sbs.png' });

  const hostFrame = page.frames().find((f) => f.url().includes('/depth/host.html'));
  console.log('Depth host frame:', hostFrame ? hostFrame.url() : 'not loaded');

  // Switch to the depth debug view through the extension's storage.
  if (hostFrame) {
    const gpu = await hostFrame.evaluate(async () => {
      const a = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
      return a ? { vendor: a.info.vendor, arch: a.info.architecture, device: a.info.device, desc: a.info.description, f16: a.features.has('shader-f16') } : null;
    });
    console.log('WebGPU adapter:', gpu);
    if (args.includes('--bench')) {
      // Force ML mode and sample steady-state inference timing.
      await hostFrame.evaluate(() => chrome.storage.local.set({ algorithm: 'da2' }));
      for (let i = 0; i < 12; i++) {
        await sleep(1000);
        const d = await canvas.evaluate((c) => ({ ...c.dataset }));
        console.log(`  t=${i + 1}s mode=${d.mode} depthFps=${d.depthFps} avgMs=${d.depthMs} renderFps=${d.renderFps}`);
      }
      await page.screenshot({ path: 'test/out/sbs-ml.png' });
    }
    for (const layout of ['htab', 'interlaced', 'anaglyph', 'depth', 'rgbd', 'hsbs']) {
      await hostFrame.evaluate((l) => chrome.storage.local.set({ layout: l }), layout);
      await sleep(1500);
      if (layout !== 'hsbs') await page.screenshot({ path: `test/out/${layout}.png` });
    }

    // Same paused frame with and without sharp depth edges, for before/after comparison.
    await page.evaluate(() => document.querySelector('#plain').pause());
    await sleep(1500);
    for (const sharp of [true, false]) {
      for (const layout of ['depth', 'hsbs']) {
        const cleanup = sharp
          ? { edgeSnap: 0.7, edgeDilation: 2, holeFill: 'soft' }
          : { edgeSnap: 0, edgeDilation: 0, holeFill: 'off' };
        await hostFrame.evaluate((l, c) => chrome.storage.local.set({ layout: l, ...c }), layout, cleanup);
        await sleep(1200);
        await page.screenshot({ path: `test/out/cmp-${layout}-${sharp ? 'sharp' : 'soft'}.png` });
      }
    }
    await hostFrame.evaluate(() => chrome.storage.local.set({ layout: 'hsbs', edgeSnap: 0.7, edgeDilation: 2, holeFill: 'soft' }));
    await page.evaluate(() => document.querySelector('#plain').play());

    // Letterboxed video: the stereo pair must keep the bars, per eye.
    const lb = await page.$('#letterbox');
    await lb.scrollIntoView();
    await page.evaluate(() => document.querySelector('#letterbox').play());
    const lbBox = await lb.boundingBox();
    await page.mouse.move(lbBox.x + lbBox.width / 2, lbBox.y + lbBox.height / 2);
    await sleep(300);
    await page.keyboard.down('Alt');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyD');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Alt');
    await sleep(2000);
    const count = await page.$$eval('canvas.sbs3d-canvas', (c) => c.length);
    console.log(`Active overlay canvases: ${count} (expected 2)`);
    if (count !== 2) throw new Error('letterboxed video did not get an overlay');
    await page.screenshot({ path: 'test/out/letterbox.png' });
    // Scene cuts: each loop restart of the plain clip is one; test/media/cuts.mp4 has hard
    // cuts at 2 s and 4 s.
    if (await stat('test/media/cuts.mp4').then(() => true, () => false)) {
      const plainCuts = await page.$eval('#plain + canvas', (c) => Number(c.dataset.cuts ?? 0));
      const plainLoops = await page.evaluate(() => window.__plainLoops);
      console.log(`Cuts detected on continuous clip: ${plainCuts} (at most ${plainLoops}: loop restarts are real cuts but may also be handled as seeks)`);
      const fill = await page.$('#fill');
      // Pause the other 3D videos so this one gets the (shared, one-at-a-time) depth model.
      await page.evaluate(() => ['#plain', '#letterbox'].forEach((id) => document.querySelector(id).pause()));
      await page.evaluate(() => {
        const v = document.querySelector('#fill');
        v.loop = false;
        v.src = 'media/cuts.mp4';
        return v.play();
      });
      await fill.scrollIntoView();
      const fillBox = await fill.boundingBox();
      await page.mouse.move(fillBox.x + fillBox.width / 2, fillBox.y + fillBox.height / 2);
      await sleep(300);
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await page.keyboard.press('KeyD');
      await page.keyboard.up('Shift');
      await page.keyboard.up('Alt');
      await page.waitForFunction(() => document.querySelector('#fill').ended, { timeout: 15000 });
      const cutCount = await page.$eval('#fill + canvas', (c) => Number(c.dataset.cuts ?? 0));
      console.log(`Cuts detected on 2-cut clip: ${cutCount} (expected 2)`);
      // Depth-based shot detection is independent of the color-based one (ML mode only).
      const fillState = await page.$eval('#fill + canvas', (c) => ({ ...c.dataset }));
      if (fillState.mode === 'ml') {
        console.log(`Depth jumps on 2-cut clip: ${fillState.depthJumps ?? 0} (expected 2)`);
        if (Number(fillState.depthJumps ?? 0) !== 2) throw new Error('depth-jump shot detection mismatch');
      }
      if (plainCuts > plainLoops || cutCount !== 2) throw new Error('scene cut detection mismatch');
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await page.keyboard.press('KeyD');
      await page.keyboard.up('Shift');
      await page.keyboard.up('Alt');
    } else {
      console.log('Skipping scene-cut check (test/media/cuts.mp4 missing; needs ffmpeg).');
    }

    // Mock YouTube player: captions read from its DOM, the original overlay hidden.
    const yt = await page.$('#yt');
    await yt.scrollIntoView();
    await page.evaluate(() => document.querySelector('#yt').play());
    const ytBox = await yt.boundingBox();
    await page.mouse.move(ytBox.x + ytBox.width / 2, ytBox.y + ytBox.height / 2);
    await sleep(300);
    await page.keyboard.down('Alt');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyD');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Alt');
    await sleep(2000);
    const vis = await page.$eval('#yt ~ .ytp-caption-window-container', (e) => getComputedStyle(e).visibility);
    console.log(`Mock YouTube caption overlay visibility: ${vis} (expected hidden)`);
    if (vis !== 'hidden') throw new Error('YouTube caption overlay was not hidden');
    await page.screenshot({ path: 'test/out/yt-mock.png' });
    console.log('Saved test/out/{sbs,htab,anaglyph,depth,letterbox,yt-mock}.png');
  } else {
    console.log('Saved test/out/sbs.png');
  }
  if (data.mode !== 'ml') {
    console.log(`NOTE: ML depth not active (${data.mlError ?? 'still loading'}); heuristic depth was used.`);
  }
} catch (e) {
  failed = true;
  console.error('E2E FAILED:', e);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);

// Renders one paused frame of test video #1 under several settings, for close inspection of
// artifacts. Output: test/frames/<name>.png (just the video area).
// Usage: npm run frame -- '{"name": {settings...}, ...}' [--time 6.0]
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const configs = JSON.parse(args[0] ?? '{}');
const time = args.includes('--time') ? Number(args[args.indexOf('--time') + 1]) : 6.0;
const BROWSER = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = path.resolve('test');
const server = http.createServer(async (req, res) => {
  const f = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try {
    const size = (await stat(f)).size;
    const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.vtt') ? 'text/vtt' : 'video/mp4';
    const m = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const s = +m[1];
      const e = m[2] ? +m[2] : size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1 });
      createReadStream(f, { start: s, end: e }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size });
      createReadStream(f).pipe(res);
    }
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));

const profile = path.resolve('test/frames/profile');
await rm(profile, { recursive: true, force: true });
await mkdir('test/frames', { recursive: true });
const ext = path.resolve('dist');
const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: true,
  userDataDir: profile,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu'],
  defaultViewport: { width: 1300, height: 900 },
});
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${server.address().port}/index.html`);
  await page.waitForFunction(() => document.querySelector('#plain').readyState >= 2);
  await page.evaluate((t) => {
    const v = document.querySelector('#plain');
    v.querySelector('track')?.remove();
    v.currentTime = t;
    return v.play();
  }, time);
  const box = await (await page.$('#plain')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(300);
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyD');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
  const canvas = await page.waitForSelector('canvas.sbs3d-canvas');
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const d = await canvas.evaluate((c) => ({ ...c.dataset }));
    if ((d.mode === 'ml' && +d.depthFps > 0) || d.mlError) break;
  }
  await sleep(3000);
  await page.evaluate(() => document.querySelector('#plain').pause());
  await sleep(1500);
  const host = page.frames().find((f) => f.url().includes('/depth/host.html'));
  let first = true;
  for (const [name, cfg] of Object.entries(configs)) {
    await host.evaluate((c) => chrome.storage.local.set(c), cfg);
    // The first settings change can still be settling (depth range, temporal smoothing);
    // later captures in the same run are then directly comparable.
    await sleep(first ? 4000 : 1200);
    first = false;
    await page.screenshot({ path: `test/frames/${name}.png`, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
    console.log(`test/frames/${name}.png`);
  }
} finally {
  await browser.close();
  server.close();
}

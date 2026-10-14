// Plays a test clip with 3D on (ML depth) and prints the shot-change log: cut@t (color cut
// detector), depth@t (big depth change snapped), snap@t (new-shot depth applied after a cut).
// Usage: npm run shots -- media/sintel-trailer.mp4
import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const [src] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.resolve('test');
const server = http.createServer(async (req, res) => {
  const f = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try { const size = (await stat(f)).size; const type = f.endsWith('.html') ? 'text/html' : 'video/mp4';
    const m = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (m) { const s = +m[1], e = m[2] ? +m[2] : size - 1; res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1 }); createReadStream(f, { start: s, end: e }).pipe(res); }
    else { res.writeHead(200, { 'Content-Type': type, 'Content-Length': size }); createReadStream(f).pipe(res); }
  } catch { res.writeHead(404).end(); } });
await new Promise((r) => server.listen(0, r));
const profile = path.resolve('test/frames/shots-profile'); await rm(profile, { recursive: true, force: true });
const ext = path.resolve('dist');
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe', headless: true, userDataDir: profile,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu'], defaultViewport: { width: 1300, height: 900 } });
const page = await browser.newPage();
await page.goto(`http://localhost:${server.address().port}/index.html`);
await page.evaluate((s) => { const v = document.querySelector('#plain'); v.querySelector('track')?.remove(); v.loop = false; v.muted = true; v.src = s; }, src);
await page.waitForFunction(() => document.querySelector('#plain').readyState >= 2);
const box = await (await page.$('#plain')).boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await sleep(300);
await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyD'); await page.keyboard.up('Shift'); await page.keyboard.up('Alt');
const canvas = await page.waitForSelector('canvas.sbs3d-canvas');
for (let i = 0; i < 30; i++) { await sleep(1000); const d = await canvas.evaluate((c) => ({ ...c.dataset })); if (d.mode === 'ml' && +d.depthFps > 0) break; }
await page.evaluate(() => { const v = document.querySelector('#plain'); v.currentTime = 0; return v.play(); });
await canvas.evaluate((c) => { delete c.dataset.shotLog; delete c.dataset.calib; });
await page.waitForFunction(() => document.querySelector('#plain').ended, { timeout: 120000, polling: 1000 });
console.log(await canvas.evaluate((c) => c.dataset.shotLog ?? ''));
await browser.close(); server.close();

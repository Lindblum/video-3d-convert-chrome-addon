// Bundles the extension into ./dist. Usage: node build.mjs [--watch]
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, stat } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const MODELS = ['models/depth-anything-v2-small-fp16.onnx', 'models/depth-anything-v2-small-fp32.onnx'];
// The onnxruntime-web/webgpu bundle embeds its JS glue and only fetches this wasm file.
const ORT_WASM = ['ort-wasm-simd-threaded.asyncify.wasm'];

async function copyStatic() {
  await mkdir('dist/depth', { recursive: true });
  await mkdir('dist/popup', { recursive: true });
  await mkdir('dist/ort', { recursive: true });
  await mkdir('dist/models', { recursive: true });
  await cp('src/manifest.json', 'dist/manifest.json');
  await cp('src/depth/host.html', 'dist/depth/host.html');
  await cp('src/popup/popup.html', 'dist/popup/popup.html');
  await cp('src/popup/popup.css', 'dist/popup/popup.css');
  await cp('src/icons', 'dist/icons', { recursive: true });
  for (const f of ORT_WASM) await cp(`node_modules/onnxruntime-web/dist/${f}`, `dist/ort/${f}`);
  for (const model of MODELS) {
    try {
      await stat(model);
      await cp(model, `dist/${model}`);
    } catch {
      console.warn(`\n!! ${model} missing: run "npm run fetch-model". ML depth may fall back to heuristic.\n`);
    }
  }
}

const common = {
  bundle: true,
  target: 'chrome120',
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  legalComments: 'none',
  // Lets the popup detect a page still running a content script from an older build.
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
};

const configs = [
  { ...common, entryPoints: ['src/content/index.ts'], outfile: 'dist/content.js', format: 'iife' },
  { ...common, entryPoints: ['src/popup/popup.ts'], outfile: 'dist/popup/popup.js', format: 'iife' },
  { ...common, entryPoints: ['src/depth/host.ts'], outfile: 'dist/depth/host.js', format: 'esm' },
];

await rm('dist', { recursive: true, force: true });
await copyStatic();
if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch();
  console.log('Watching… (static files are copied once; restart to pick up html/css/manifest changes)');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}

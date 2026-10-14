// Downloads Depth Anything V2 Small ONNX models into ./models so the build can bundle them.
// fp16 is used on GPUs with WebGPU shader-f16 support, fp32 everywhere else.
import { mkdir, stat, writeFile } from 'node:fs/promises';

const BASE = 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx';
const MODELS = [
  { src: `${BASE}/model_fp16.onnx`, out: 'models/depth-anything-v2-small-fp16.onnx' },
  { src: `${BASE}/model.onnx`, out: 'models/depth-anything-v2-small-fp32.onnx' },
];

await mkdir('models', { recursive: true });
for (const { src, out } of MODELS) {
  try {
    const s = await stat(out);
    if (s.size > 1e6) {
      console.log(`${out} already present (${(s.size / 1e6).toFixed(1)} MB)`);
      continue;
    }
  } catch {}
  console.log(`Downloading ${src}`);
  const res = await fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${src}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(out, buf);
  console.log(`Saved ${out} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

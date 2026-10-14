// Downloads test media: a 10 s Big Buck Bunny clip and the Sintel trailer (both CC-BY
// Blender Foundation), and (if ffmpeg is installed) splices the clip into cuts.mp4, a 6 s
// clip with hard cuts at 2 s and 4 s.
import { execFileSync } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';

const URL_ = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4';
const OUT = 'test/media/bbb.mp4';
const CUTS = 'test/media/cuts.mp4';

const exists = (p) => stat(p).then(() => true, () => false);

await mkdir('test/media', { recursive: true });
if (await exists(OUT)) {
  console.log(`${OUT} already present`);
} else {
  const res = await fetch(URL_);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await writeFile(OUT, Buffer.from(await res.arrayBuffer()));
  console.log(`Saved ${OUT}`);
}

// Sintel trailer (CC-BY Blender Foundation): fast montage with many hard cuts, for tuning
// shot-change handling on realistic footage.
const SINTEL = 'test/media/sintel-trailer.mp4';
if (await exists(SINTEL)) {
  console.log(`${SINTEL} already present`);
} else {
  const res = await fetch('https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await writeFile(SINTEL, Buffer.from(await res.arrayBuffer()));
  console.log(`Saved ${SINTEL}`);
}

if (await exists(CUTS)) {
  console.log(`${CUTS} already present`);
} else {
  const filter =
    '[0:v]trim=0:2,setpts=PTS-STARTPTS[a];[0:v]trim=7:9,setpts=PTS-STARTPTS[b];' +
    '[0:v]trim=3:5,setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0[v]';
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', OUT, '-filter_complex', filter, '-map', '[v]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', CUTS], { stdio: 'inherit' });
    console.log(`Saved ${CUTS}`);
  } catch {
    console.warn(`ffmpeg not found: skipping ${CUTS} (the e2e scene-cut check will be skipped)`);
  }
}

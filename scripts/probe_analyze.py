"""Measures what scripts/probe.mjs recorded: depth flicker, depth lag, depth/color edge
alignment and how deep baked-in letterbox bars come out. Every frame is "Video | Depth Map"
(color in the left half, the final depth in the right half), so it measures itself.

Usage: python scripts/probe_analyze.py test/frames/probe/<label> [more labels...]
Writes per segment: overlay.png (depth edges in red over the still), heat.png (where depth
flickers), timeline.png (flicker per frame); and <label>/report.md with the numbers.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

# Pixels whose color changes less than this between frames count as static (0..1 gray, after a
# small blur, so JPEG noise and grain don't count as motion).
STATIC = 2.5 / 255
# Mean color change between frames above which the pair is a cut or flash, not motion.
CUT = 0.12
# Rows next to letterbox bars (and the frame's top and bottom) left out of the statistics, so
# the bars' own depth edge doesn't count; bar_bleed measures that separately.
MARGIN = 24
# Frame gaps above this are the pause for the stills.
GAP = 0.25
# Depth edges: the strongest DEPTH_EDGE_Q of depth gradients; color edges: COLOR_EDGE_Q.
DEPTH_EDGE_Q = 0.04
COLOR_EDGE_Q = 0.10
# How far back (in recorded frames) to look for the color frame the depth matches best.
MAX_LAG = 24


def load(path, k=1):
    im = Image.open(path).convert('RGB')
    if k > 1:
        im = im.reduce(k)
    a = np.asarray(im, dtype=np.float32) / 255
    half = a.shape[1] // 2
    color, depth = a[:, :half], a[:, half:, 0]
    gray = color @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    return color, gray, depth


def bar_rows(gray):
    """Rows of baked-in letterbox (near-black across the whole row) at the top and bottom."""
    dark = gray.max(axis=1) < 0.07
    top = int(np.argmin(dark)) if not dark.all() else 0
    bottom = int(np.argmin(dark[::-1])) if not dark.all() else 0
    return top, bottom


def gradient(img):
    # Each half is the video squeezed to half width: weight x so gradients are per source pixel.
    gx = ndimage.sobel(img, axis=1) / 2
    gy = ndimage.sobel(img, axis=0)
    return np.hypot(gx, gy)


def edges(img, mask, q):
    g = gradient(ndimage.gaussian_filter(img, 1.0))
    t = np.quantile(g[mask], 1 - q)
    return (g > max(t, 1e-3)) & mask


def edge_distance(src_edges, dst_edges, k=1):
    """Distance (source pixels) from each src edge pixel to the nearest dst edge pixel."""
    # sampling: rows are k source pixels, columns 2k (the half-width squeeze).
    dist = ndimage.distance_transform_edt(~dst_edges, sampling=(k, 2 * k))
    return dist[src_edges]


def bar_bleed(depth, top, bottom):
    """How many rows into the picture the bars' depth reaches before the picture's own."""
    h = depth.shape[0]
    out = []
    if top:
        prof = np.median(depth[top:top + 160], axis=1)
        out.append(int(np.argmax(np.abs(prof - prof[-1]) < 0.03)))
    if bottom:
        prof = np.median(depth[h - bottom - 160:h - bottom], axis=1)[::-1]
        out.append(int(np.argmax(np.abs(prof - prof[-1]) < 0.03)))
    return max(out) if out else 0


def segments_in(label_dir):
    return sorted(p for p in label_dir.iterdir() if p.is_dir() and (p / 'info.json').exists())


def analyze(seg):
    info = json.loads((seg / 'info.json').read_text())
    files = sorted((seg / 'stream').glob('*.jpg'))
    ts = info['timestamps']
    s_color, s_gray, s_depth = load(seg / 'still-rgbd.png')
    top, bottom = bar_rows(s_gray)
    h = s_gray.shape[0]
    picture = np.zeros_like(s_gray, dtype=bool)
    picture[top:h - bottom] = True
    content = np.zeros_like(picture)
    content[top + MARGIN:h - bottom - MARGIN] = True

    # Letterbox: how near the bars come out, against the picture's own depth range.
    bars = ~picture
    bar_depth = float(s_depth[bars].mean()) if bars.any() else None
    bleed = bar_bleed(s_depth, top, bottom)

    # Still: depth edges against color edges.
    d_edges = edges(s_depth, content, DEPTH_EDGE_Q)
    c_edges = edges(s_gray, content, COLOR_EDGE_Q)
    dist = edge_distance(d_edges, c_edges)

    # Overlay: the still at full width, depth edges in red.
    full = np.repeat(s_color, 2, axis=1)
    over = full.copy()
    de = np.repeat(d_edges, 2, axis=1)
    over[de] = [1, 0.1, 0.1]
    Image.fromarray((over * 255).astype(np.uint8)).save(seg / 'overlay.png')

    # Stream: flicker and lag.
    frames = [load(f) for f in files]
    # The stream is recorded smaller than the stills: k source pixels per stream pixel.
    k = h // frames[0][1].shape[0]
    content = content[::k, ::k][:frames[0][1].shape[0], :frames[0][1].shape[1]]
    heat = np.zeros_like(frames[0][1])
    heat_n = np.zeros_like(heat)
    rows = []
    for i in range(1, len(frames)):
        if ts[i] - ts[i - 1] > GAP:
            rows.append(None)  # the pause
            continue
        (_, g0, d0), (_, g1, d1) = frames[i - 1], frames[i]
        cd = ndimage.gaussian_filter(np.abs(g1 - g0), 1.5)
        if cd[content].mean() > CUT:
            rows.append({'cut': True})
            continue
        static = (cd < STATIC) & content
        if static.sum() < 0.02 * content.sum():
            rows.append({'moving': True})
            continue
        dd = (d1 - d0)[static]
        g = float(np.median(dd))
        rows.append({
            'total': float(np.abs(dd).mean()) * 255,
            'pump': abs(g) * 255,
            'local': float(np.abs(dd - g).mean()) * 255,
            'static': float(static.sum() / content.sum()),
        })
        heat += np.abs(d1 - d0) * static
        heat_n += static

    # Lag: on moving parts, which earlier color frame do the current depth edges match best?
    lag_cost = np.zeros(MAX_LAG + 1)
    lag_n = 0
    run_start = 0
    color_edges = []
    depth_edges = []
    motion = []
    for i, (_, g, d) in enumerate(frames):
        color_edges.append(edges(g, content, COLOR_EDGE_Q))
        depth_edges.append(edges(d, content, DEPTH_EDGE_Q))
        m = np.zeros_like(content)
        if i > 0:
            m = ndimage.binary_dilation(ndimage.gaussian_filter(np.abs(g - frames[i - 1][1]), 1.5) > 6 / 255, iterations=3)
        motion.append(m & content)
    dist_maps = [ndimage.distance_transform_edt(~c, sampling=(k, 2 * k)) for c in color_edges]
    for i in range(len(frames)):
        if i > 0 and (ts[i] - ts[i - 1] > GAP or rows[i - 1] and rows[i - 1].get('cut')):
            run_start = i
        if i - run_start < MAX_LAG:
            continue
        sel = depth_edges[i] & motion[i]
        if sel.sum() < 50:
            continue
        lag_cost += [np.minimum(dist_maps[i - k][sel], 30).mean() for k in range(MAX_LAG + 1)]
        lag_n += 1
    interval = np.median(np.diff(ts)[np.diff(ts) < GAP]) if len(ts) > 1 else 0
    lag_frames = int(np.argmin(lag_cost)) if lag_n else None

    # Heatmap over the dimmed still.
    hm = np.where(heat_n > 0, heat / np.maximum(heat_n, 1), 0) * 255
    hm_img = np.clip(hm / 4, 0, 1)  # 4 depth levels per frame = full red
    hm_img = np.kron(hm_img, np.ones((k, k), dtype=np.float32))[:h, :s_gray.shape[1]]
    hm_img = np.pad(hm_img, ((0, h - hm_img.shape[0]), (0, s_gray.shape[1] - hm_img.shape[1])))
    base = np.repeat(s_gray, 2, axis=1)[..., None] * 0.45
    hm2 = np.repeat(hm_img, 2, axis=1)[..., None]
    heat_rgb = base * (1 - hm2) + hm2 * np.array([1, 0.25, 0.1])
    Image.fromarray((np.clip(heat_rgb, 0, 1) * 255).astype(np.uint8)).save(seg / 'heat.png')

    # Timeline: flicker per frame pair (white total, orange pumping), cuts in blue, pause gray.
    W, H = max(200, 3 * len(rows)), 160
    tl = Image.new('RGB', (W, H), (16, 16, 16))
    dr = ImageDraw.Draw(tl)
    scale = H / 6  # 6 depth levels per frame at the top
    for x in range(0, H, int(scale)):
        dr.line([(0, H - x), (W, H - x)], fill=(40, 40, 40))
    for j, r in enumerate(rows):
        x = j * 3
        if r is None:
            dr.rectangle([x, 0, x + 2, H], fill=(70, 70, 70))
        elif r.get('cut'):
            dr.rectangle([x, 0, x + 2, H], fill=(40, 80, 200))
        elif 'total' in r:
            dr.rectangle([x, H - r['total'] * scale, x + 1, H], fill=(230, 230, 230))
            dr.rectangle([x, H - r['pump'] * scale, x + 1, H], fill=(255, 140, 0))
    tl.save(seg / 'timeline.png')

    flick = [r for r in rows if r and 'total' in r]
    tot = np.array([r['total'] for r in flick]) if flick else np.zeros(1)
    return {
        'segment': seg.name,
        'mode': info.get('mode'),
        'depthFps': info.get('depthFps'),
        'frames': len(files),
        'cuts': sum(1 for r in rows if r and r.get('cut')),
        'flicker': float(tot.mean()),
        'flicker_p95': float(np.percentile(tot, 95)),
        'pump': float(np.mean([r['pump'] for r in flick])) if flick else 0,
        'local': float(np.mean([r['local'] for r in flick])) if flick else 0,
        'edge_med': float(np.median(dist)) if dist.size else None,
        'edge_p90': float(np.percentile(dist, 90)) if dist.size else None,
        'edge_far': float((dist > 8).mean()) if dist.size else None,
        'lag_frames': lag_frames,
        'lag_ms': round(lag_frames * interval * 1000) if lag_frames is not None else None,
        'lag_curve': [round(float(c / max(lag_n, 1)), 2) for c in lag_cost],
        'bar_bleed': bleed,
        'bars_px': top + bottom,
        'bar_depth': bar_depth,
        'content_depth': float(s_depth[picture].mean()),
    }


def fmt(v, f='{:.2f}'):
    return '–' if v is None else f.format(v)


def report(label_dir):
    results = [analyze(s) for s in segments_in(label_dir)]
    cfg = json.loads((label_dir / 'summary.json').read_text())['config'] if (label_dir / 'summary.json').exists() else {}
    lines = [
        f'# Probe: {label_dir.name}',
        '',
        f'Settings: `{json.dumps(cfg)}`',
        '',
        'Flicker: mean change of depth (0-255 levels) per frame where the picture is static;',
        'pump = the whole map shifting together, local = the rest. Edge: distance from depth',
        'edges to the nearest color edge, in source pixels (far = share over 8 px). Lag: how',
        'many recorded frames the depth edges trail the color on moving parts. Bars: baked-in',
        'letterbox rows and their depth (0 far, 1 near) against the picture\'s mean depth.',
        '',
        '| segment | depth fps | flicker | p95 | pump | local | edge med | edge p90 | edge far | lag | bars | bar depth | picture depth | bleed |',
        '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ]
    for r in results:
        lag = '–' if r['lag_frames'] is None else f"{r['lag_frames']} ({r['lag_ms']} ms)"
        lines.append(
            f"| {r['segment']} | {r['depthFps']} | {fmt(r['flicker'])} | {fmt(r['flicker_p95'])} | {fmt(r['pump'])} | "
            f"{fmt(r['local'])} | {fmt(r['edge_med'], '{:.1f}')} | {fmt(r['edge_p90'], '{:.1f}')} | {fmt(r['edge_far'], '{:.0%}')} | "
            f"{lag} | {r['bars_px']} | {fmt(r['bar_depth'])} | {fmt(r['content_depth'])} | {r['bar_bleed']} |")
    keys = ['flicker', 'pump', 'local', 'edge_med', 'edge_far']
    means = {k: np.mean([r[k] for r in results if r[k] is not None]) for k in keys}
    lines.append(f"| **mean** | | {fmt(means['flicker'])} | | {fmt(means['pump'])} | {fmt(means['local'])} | "
                 f"{fmt(means['edge_med'], '{:.1f}')} | | {fmt(means['edge_far'], '{:.0%}')} | | | | | |")
    lines += ['', 'Lag cost (mean distance in px from depth edges to color edges k frames back, k = 0..):', '']
    lines += [f"- {r['segment']}: {r['lag_curve']}" for r in results]
    (label_dir / 'report.md').write_text('\n'.join(lines) + '\n')
    (label_dir / 'report.json').write_text(json.dumps(results, indent=2))
    print('\n'.join(lines))


if __name__ == '__main__':
    for arg in sys.argv[1:]:
        report(Path(arg))

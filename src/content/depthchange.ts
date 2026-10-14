// Measures how much the scene's depth layout changed between consecutive ML depth maps.
// Catches shot changes the color-based cut detector misses (similar-looking shots,
// compression noise, motion), so depth can snap to the new shot instead of morphing.

const SAMPLES = 2048;

export class DepthChangeDetector {
  private prev: Float32Array | null = null;

  /**
   * Mean absolute change (0..1) of depth normalized to each map's own percentile range,
   * on a sparse grid. Returns 0 when there's nothing comparable yet.
   */
  measure(data: Float32Array, lo: number, hi: number): number {
    const stride = Math.max(1, Math.floor(data.length / SAMPLES));
    const n = Math.floor(data.length / stride);
    const range = Math.max(hi - lo, 1e-6);
    const cur = new Float32Array(n);
    for (let i = 0; i < n; i++) cur[i] = Math.min(1, Math.max(0, (data[i * stride] - lo) / range));
    const prev = this.prev;
    this.prev = cur;
    if (!prev || prev.length !== n) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.abs(cur[i] - prev[i]);
    return sum / n;
  }

  reset() {
    this.prev = null;
  }
}

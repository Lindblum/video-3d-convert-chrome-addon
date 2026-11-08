// GLSL ES 3.00 shaders. Texture convention: every texture (video, ML depth, depth state)
// stores the image with t = 0 at the TOP row; only the final pass flips to screen space.

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Produces the next temporally-smoothed depth map (0 = far, 1 = near) from either the ML
 * output or one of the shader algorithms, blended with the previous state. Smoothing backs off
 * where the picture is changing, so moving edges don't drag a depth "ghost" behind them.
 * Also writes a low-res color image that guides the edge-aware upsample.
 */
export const DEPTH_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outState; // r = depth, g = luma (for motion detection),
                                        // b = accumulated motion (motion parallax)
layout(location = 1) out vec4 outGuide; // low-res color matching the depth texels

uniform sampler2D uPrev;
uniform sampler2D uVideo;
uniform sampler2D uMl;
uniform sampler2D uMlPrev; // the depth map before uMl, for interpolating between them
uniform sampler2D uVideoMip; // the video through its mipmaps (bound for scene cues only)
uniform int uMode;        // 0 = heuristic, 1 = ML, 2 = scene cues, 3 = ground plane, 4 = motion parallax
uniform vec2 uMlRange;    // smoothed (low, high) percentiles of raw model output
uniform vec2 uMlRangePrev; // ... for uMlPrev
uniform float uMlBlend;   // 0 = previous depth map, 1 = newest (interpolation between updates)
uniform float uAlpha;     // weight of the new estimate where the picture is still
uniform vec2 uTexel;      // 1 / depth state size
uniform bool uReset;      // history was just cleared (start, seek, scene cut)
uniform bool uNewFrame;   // the video frame changed since the last pass

const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float HORIZON = 0.38; // assumed horizon, as a fraction of the height from the top

float heuristicDepth(vec2 uv) {
  vec3 c = vec3(0.0);
  for (int i = -2; i <= 2; i++)
    for (int j = -2; j <= 2; j++)
      c += texture(uVideo, uv + vec2(float(i), float(j)) * uTexel * 1.5).rgb;
  c /= 25.0;
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  float vertical = uv.y; // lower in frame = closer (ground plane cue)
  float center = 1.0 - smoothstep(0.0, 0.75, length((uv - 0.5) * vec2(1.0, 1.3)));
  return clamp(0.5 * vertical + 0.2 * luma + 0.15 * sat + 0.25 * center - 0.05, 0.0, 1.0);
}

/** A flat floor seen from eye height: disparity grows linearly below the horizon. */
float groundPlaneDepth(vec2 uv) {
  return clamp((uv.y - HORIZON) / (1.0 - HORIZON), 0.0, 1.0);
}

/**
 * Picture-content cues only, no assumptions about layout: sharp detail (in focus),
 * saturated and warm colors come forward; bright, washed-out haze (aerial perspective)
 * and cool colors recede.
 */
float sceneCuesDepth(vec2 uv) {
  // Taps 3 texels apart, each read from the mip level whose pixels are that big, so a tap
  // averages its whole cell. Point samples would stamp the tap grid onto fine detail.
  float lod = log2(3.0 * float(textureSize(uVideoMip, 0).x) * uTexel.x);
  // Gaussian weights, so a bright speck fades in and out instead of switching on per tap.
  vec3 sum = vec3(0.0);
  float l2 = 0.0;
  float wsum = 0.0;
  for (int i = -2; i <= 2; i++)
    for (int j = -2; j <= 2; j++) {
      float w = exp(-float(i * i + j * j) / 4.0);
      vec3 s = textureLod(uVideoMip, uv + vec2(float(i), float(j)) * uTexel * 3.0, lod).rgb;
      float l = dot(s, LUMA);
      sum += w * s;
      l2 += w * l * l;
      wsum += w;
    }
  vec3 c = sum / wsum;
  float luma = dot(c, LUMA);
  float contrast = sqrt(max(l2 / wsum - luma * luma, 0.0));
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  float detail = smoothstep(0.01, 0.15, contrast);
  float warmth = clamp((c.r - c.b) * 2.0 + 0.5, 0.0, 1.0);
  float haze = smoothstep(0.5, 0.9, luma) * (1.0 - smoothstep(0.05, 0.25, sat));
  return clamp(0.3 * detail + 0.35 * smoothstep(0.0, 0.5, sat) + 0.15 * warmth + 0.2 - 0.3 * haze, 0.0, 1.0);
}

/**
 * Motion parallax: with a moving camera, nearer things sweep across the screen faster.
 * Measures normal flow (luma change over luma gradient, in texels per frame) where there is
 * enough texture to measure it, and keeps a running average in the state's b channel that
 * slowly spreads into flat areas. Returns the updated average (0 = still, 1 = fast).
 */
float motionAccum(vec2 uv, float luma, vec4 prev) {
  if (uReset) return 0.0;
  if (!uNewFrame) return prev.b;
  vec2 tx = vec2(uTexel.x, 0.0);
  vec2 ty = vec2(0.0, uTexel.y);
  // Neighbour average: motion seen on edges diffuses into the textureless areas between them.
  float acc = 0.2 * (prev.b + texture(uPrev, uv + tx).b + texture(uPrev, uv - tx).b +
                     texture(uPrev, uv + ty).b + texture(uPrev, uv - ty).b);
  vec2 grad = 0.5 * vec2(dot(texture(uVideo, uv + tx).rgb - texture(uVideo, uv - tx).rgb, LUMA),
                         dot(texture(uVideo, uv + ty).rgb - texture(uVideo, uv - ty).rgb, LUMA));
  float g = length(grad);
  float dt = max(abs(luma - prev.g) - 0.01, 0.0); // minus compression noise
  float flow = dt / max(g, 0.02);
  return mix(acc, flow / (flow + 1.0), 0.15 * smoothstep(0.02, 0.08, g));
}

/** This frame's depth estimate, before temporal smoothing (all modes but motion parallax). */
float estimate(vec2 uv) {
  if (uMode == 1) {
    float cur = clamp((texture(uMl, uv).r - uMlRange.x) / max(uMlRange.y - uMlRange.x, 1e-4), 0.0, 1.0);
    float prevMl = clamp((texture(uMlPrev, uv).r - uMlRangePrev.x) / max(uMlRangePrev.y - uMlRangePrev.x, 1e-4), 0.0, 1.0);
    return mix(prevMl, cur, uMlBlend);
  }
  if (uMode == 2) return sceneCuesDepth(uv);
  if (uMode == 3) return groundPlaneDepth(uv);
  return heuristicDepth(uv);
}

// How far smoothed depth may stray outside the new estimate's local range, so small flicker
// is still averaged out.
const float HISTORY_SLACK = 0.03;

void main() {
  vec2 uv = vUv;
  vec2 o = uTexel * 0.25;
  vec3 c = 0.25 * (texture(uVideo, uv + vec2(-o.x, -o.y)).rgb + texture(uVideo, uv + vec2(o.x, -o.y)).rgb +
                   texture(uVideo, uv + vec2(-o.x, o.y)).rgb + texture(uVideo, uv + vec2(o.x, o.y)).rgb);
  float luma = dot(c, LUMA);
  vec4 prev = texture(uPrev, uv);
  float history = prev.r;
  float motionAvg = 0.0;
  float d;
  if (uMode == 4) {
    motionAvg = motionAccum(uv, luma, prev);
    // Where nothing has moved yet (a still shot), fall back on the ground plane.
    d = clamp(0.35 * groundPlaneDepth(uv) + 1.5 * motionAvg, 0.0, 1.0);
  } else {
    d = estimate(uv);
    // Limit the smoothed history to the range the new estimate has around this pixel (as
    // temporal anti-aliasing does). Where an object has moved away, its old depth is outside
    // that range and is dropped at once instead of fading out as a trail.
    float lo = d;
    float hi = d;
    for (int i = -1; i <= 1; i++)
      for (int j = -1; j <= 1; j++) {
        if (i == 0 && j == 0) continue;
        float n = estimate(uv + vec2(float(i), float(j)) * uTexel);
        lo = min(lo, n);
        hi = max(hi, n);
      }
    history = clamp(history, lo - HISTORY_SLACK, hi + HISTORY_SLACK);
  }
  float motion = abs(luma - prev.g);
  float a = max(uAlpha, smoothstep(0.03, 0.15, motion));
  outState = vec4(mix(history, d, a), luma, motionAvg, 1.0);
  outGuide = vec4(c, 1.0);
}`;

/**
 * Joint bilateral upsample of the low-res depth state, guided by the full-res video: each
 * output pixel averages nearby depth texels weighted by distance AND by how similar their
 * color is, so depth edges snap to object edges instead of being blurry ramps.
 */
export const REFINE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uState;
uniform sampler2D uGuide;
uniform sampler2D uVideo;
uniform vec2 uLowSize;    // depth state size in texels
uniform float uSnap;      // 0 = plain bilinear, 1 = edges follow color edges strongly

void main() {
  vec2 uv = vUv;
  if (uSnap <= 0.0) {
    outColor = vec4(texture(uState, uv).r, 0.0, 0.0, 1.0);
    return;
  }
  vec3 c = texture(uVideo, uv).rgb;
  vec2 lp = uv * uLowSize - 0.5;
  vec2 base = floor(lp);
  vec2 f = lp - base;
  float sigma = mix(0.3, 0.04, uSnap); // color tolerance
  float inv2s2 = 1.0 / (2.0 * sigma * sigma);
  float dSum = 0.0;
  float wSum = 0.0;
  for (int j = -1; j <= 2; j++) {
    for (int i = -1; i <= 2; i++) {
      vec2 cell = vec2(float(i), float(j));
      vec2 tc = (base + cell + 0.5) / uLowSize;
      vec2 dxy = cell - f;
      float ws = exp(-dot(dxy, dxy) / 1.28);          // spatial, sigma = 0.8 texel
      vec3 dc = texture(uGuide, tc).rgb - c;
      float wr = exp(-dot(dc, dc) * inv2s2);
      float w = ws * (wr + 1e-3);
      dSum += w * texture(uState, tc).r;
      wSum += w;
    }
  }
  outColor = vec4(dSum / wSum, 0.0, 0.0, 1.0);
}`;

/**
 * Grows near depth outward by a few pixels (a max filter). An object's outermost pixels
 * blend its colors with the background's, so depth estimation tends to label them
 * background; left that way they stay behind when the object shifts, leaving a bright or
 * dark outline, and get smeared into disocclusion holes. Dilating makes the rim move with
 * the object and pushes hole filling out to true background.
 */
export const DILATE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uDepth;
uniform vec2 uStep;       // one texel along this pass's direction (separable: x, then y)
uniform int uRadius;      // pixels, 0..30

void main() {
  float d = texture(uDepth, vUv).r;
  for (int i = 1; i <= 30; i++) {
    if (i > uRadius) break;
    vec2 o = uStep * float(i);
    d = max(d, max(texture(uDepth, vUv + o).r, texture(uDepth, vUv - o).r));
  }
  outColor = vec4(d, 0.0, 0.0, 1.0);
}`;

/**
 * Shared by the stereo pass and the Soft hole fill's eye-view pass: what each eye sees, where
 * the disocclusion holes are, and background-only sampling of the fill pyramid.
 */
const STEREO_COMMON = /* glsl */ `
uniform sampler2D uVideo;
uniform sampler2D uDepth;
uniform float uStrength;  // max near/far disparity, in fractions of video width
uniform float uConv;      // depth placed at screen plane
uniform float uDepthTexelX; // 1 / width of the depth map

const int STEPS = 24;
// Magnification over which a pixel counts as a disocclusion hole: one source pixel spread
// across this many output pixels has no real picture behind it.
const float HOLE_LO = 1.8;
const float HOLE_HI = 3.0;

float depthAt(vec2 uv) { return texture(uDepth, uv).r; }

// Per-eye shift factor: a source pixel with disparity D appears at x + s * D in this eye.
float eyeShift(float eye) {
  return 0.5 * eye;
}

// Finds which source disparity this eye sees at uv. Walks candidate disparities from
// nearest to farthest and takes the first source pixel whose own disparity reaches the
// candidate, so foreground correctly occludes; then bisects the bracket so the result
// depends on where the depth edge actually is, not on where the coarse steps landed.
float searchHit(vec2 uv, float s) {
  float dMax = uStrength * (1.0 - uConv);
  float dMin = -uStrength * uConv;
  float lo = dMax;     // last candidate that missed (background side)
  float loDiff = -1.0;
  float hi = dMin;     // first candidate that hit
  float hiDiff = 0.0;
  bool found = false;
  for (int k = 0; k <= STEPS; k++) {
    float cand = mix(dMax, dMin, float(k) / float(STEPS));
    float diff = uStrength * (depthAt(vec2(uv.x - s * cand, uv.y)) - uConv) - cand;
    if (diff >= 0.0) {
      if (k == 0) return dMax;
      hi = cand;
      hiDiff = diff;
      found = true;
      break;
    }
    lo = cand;
    loDiff = diff;
  }
  if (!found) return dMin;
  for (int i = 0; i < 6; i++) {
    float mid = 0.5 * (lo + hi);
    float diff = uStrength * (depthAt(vec2(uv.x - s * mid, uv.y)) - uConv) - mid;
    if (diff >= 0.0) {
      hi = mid;
      hiDiff = diff;
    } else {
      lo = mid;
      loDiff = diff;
    }
  }
  return mix(lo, hi, loDiff / (loDiff - hiDiff));
}

// How much the picture is magnified sideways at a source position. A source pixel at x
// lands at x + s * D(x), so the magnification is 1 + s * D'(x): where depth rises toward
// the shift direction, neighboring output pixels pull from source positions closer together
// than they are displayed. Taken from the depth map at the source, so it's smooth per pixel
// (no dithering). Strong magnification is a disocclusion hole: background the 2D frame
// never showed.
float magnification(vec2 uv, float srcX, float s) {
  float e = 1.5 * uDepthTexelX;
  float slope = uStrength * (depthAt(vec2(srcX + e, uv.y)) - depthAt(vec2(srcX - e, uv.y))) / (2.0 * e);
  return max(1.0 + s * slope, 1e-3);
}

// Where the background starts beside a hole: walk from the source position away from the
// foreground to the far end of the depth ramp.
float rampEndX(vec2 uv, float srcX, float away) {
  float w = 2.0 * uDepthTexelX;
  float best = srcX;
  float bestD = depthAt(vec2(srcX, uv.y));
  for (int k = 1; k <= 24; k++) {
    float x = srcX + away * float(k) * w;
    float d = depthAt(vec2(x, uv.y));
    if (d < bestD - 1e-3) {
      best = x;
      bestD = d;
    }
  }
  return best;
}

// The color one eye sees at video uv before hole filling, the source position it comes from,
// and how much of a disocclusion hole that is (0..1).
vec3 eyeRaw(vec2 uv, float eye, out float srcX, out float hole) {
  float s = eyeShift(eye);
  srcX = uv.x - s * searchHit(uv, s);
  hole = smoothstep(HOLE_LO, HOLE_HI, magnification(uv, srcX, s));
  return texture(uVideo, vec2(srcX, uv.y)).rgb;
}

// Texels nearer than the farthest of their neighbors by more than this are left out of fills.
const float BG_MARGIN = 0.05;

// Bilinear sample of a fill-pyramid level (rgb, a = depth; a < 0: no data) that uses only
// the farthest of the four texels around uv (within BG_MARGIN), so a hole beside an object
// is filled from the background, never from the object. Returns a < 0 if all four are empty.
vec4 backgroundSample(sampler2D tex, vec2 uv) {
  ivec2 size = textureSize(tex, 0);
  vec2 p = uv * vec2(size) - 0.5;
  vec2 b = floor(p);
  vec2 f = p - b;
  vec4 t[4];
  float dMin = 1e9;
  for (int k = 0; k < 4; k++) {
    t[k] = texelFetch(tex, clamp(ivec2(b) + ivec2(k & 1, k >> 1), ivec2(0), size - 1), 0);
    if (t[k].a >= 0.0) dMin = min(dMin, t[k].a);
  }
  vec4 sum = vec4(0.0);
  float wSum = 0.0;
  for (int k = 0; k < 4; k++) {
    if (t[k].a < 0.0 || t[k].a > dMin + BG_MARGIN) continue;
    float w = ((k & 1) == 1 ? f.x : 1.0 - f.x) * ((k >> 1) == 1 ? f.y : 1.0 - f.y) + 1e-4;
    sum += w * t[k];
    wSum += w;
  }
  return wSum > 0.0 ? sum / wSum : vec4(0.0, 0.0, 0.0, -1.0);
}
`;

/** Renders the stereo pair (or the depth debug view) into the visible canvas. */
export const STEREO_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
${STEREO_COMMON}
uniform int uLayout;      // 0 = half SBS, 1 = half top-over-bottom, 2 = depth map, 3 = anaglyph,
                          // 5 = 2D + depth side by side (4 was row-interlaced, removed)
uniform bool uSwap;
uniform vec4 uContent;    // video content rect within an eye view (x, y, w, h), top-left origin
uniform sampler2D uCaptions; // premultiplied caption layer, same uv space as the video
uniform bool uCapOn;
uniform float uCapDisp;   // caption disparity, same units as uStrength
uniform int uHoleFill;    // 0 = off (stretch edge), 1 = sharp, 2 = soft, 3 = mirror
uniform float uFillMargin; // how far past the edge to start sampling background (uv)
uniform bool uFillTex;    // soft fill comes from the filled eye views below (FILL_PULL/PUSH_FS)
uniform sampler2D uFillL; // filled eye views (rgb, a = depth), for eye = +1 and -1
uniform sampler2D uFillR;

// The color one eye sees at video uv (before captions).
vec3 eyeColor(vec2 uv, float eye) {
  float s = eyeShift(eye);
  float srcX, hole;
  vec3 color = eyeRaw(uv, eye, srcX, hole);
  if (hole > 0.0) {
    float away = -sign(s);
    float endX = rampEndX(uv, srcX, away);
    // A little past the ramp's end, so the object's own rim pixels aren't picked up.
    float bgX = endX + away * uFillMargin;
    vec3 fill;
    if (uHoleFill == 0) {
      // Stretch: repeat the pixel where the background starts. Taking srcX would stretch
      // whatever video lies inside the depth ramp, and since the ramp sits at a slightly
      // different place relative to the color edge on every row and object, the hole would
      // be foreground in some places and background in others.
      fill = texture(uVideo, vec2(endX, uv.y)).rgb;
    } else if (uHoleFill == 3) {
      // Mirror: reflect the background across the hole's far edge. The background pixel at
      // bgX lands on screen at xFar; a hole pixel t in from there takes the background t out
      // on the other side, so the background's texture continues into the hole instead of
      // one color being smeared across it.
      float xFar = bgX + s * uStrength * (depthAt(vec2(bgX, uv.y)) - uConv);
      fill = texture(uVideo, vec2(clamp(bgX + away * abs(uv.x - xFar), 0.0, 1.0), uv.y)).rgb;
    } else if (uHoleFill == 1) {
      fill = texture(uVideo, vec2(bgX, uv.y)).rgb;
    } else if (uFillTex) {
      // Soft: the surrounding background, spread smoothly into the hole by the fill pyramid.
      vec4 bg = eye > 0.0 ? backgroundSample(uFillL, uv) : backgroundSample(uFillR, uv);
      fill = bg.a >= 0.0 ? bg.rgb : color;
    } else {
      // Without float render targets: average a few samples past the edge.
      fill = vec3(0.0);
      for (int i = 0; i < 4; i++) {
        float fi = float(i);
        fill += texture(uVideo, vec2(bgX + away * fi * 0.005, uv.y + (fi - 1.5) * 0.004)).rgb;
      }
      fill *= 0.25;
    }
    color = mix(color, fill, hole);
  }
  return color;
}

vec3 withCaptions(vec3 color, vec2 uv, float eye) {
  if (!uCapOn) return color;
  vec4 cap = texture(uCaptions, vec2(uv.x - 0.5 * eye * uCapDisp, uv.y));
  return color * (1.0 - cap.a) + cap.rgb;
}

// Dubois least-squares red/cyan matrices: less ghosting and better color than plain
// channel splitting.
vec3 anaglyph(vec3 l, vec3 r) {
  return clamp(vec3(
    dot(l, vec3(0.456, 0.500, 0.176)) + dot(r, vec3(-0.043, -0.088, -0.002)),
    dot(l, vec3(-0.040, -0.038, -0.016)) + dot(r, vec3(0.378, 0.734, -0.018)),
    dot(l, vec3(-0.015, -0.021, -0.005)) + dot(r, vec3(-0.072, -0.113, 1.226))
  ), 0.0, 1.0);
}

void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y);
  float side = 1.0; // which displayed image: +1 = left half / top
  vec2 q = p;
  if (uLayout == 0 || uLayout == 5) { side = p.x < 0.5 ? 1.0 : -1.0; q = vec2(fract(p.x * 2.0), p.y); }
  else if (uLayout == 1) { side = p.y < 0.5 ? 1.0 : -1.0; q = vec2(p.x, fract(p.y * 2.0)); }
  float eye = uSwap ? -side : side; // +1 = rendered from the left eye's viewpoint

  vec2 uv = (q - uContent.xy) / uContent.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  if (uLayout == 2) outColor = vec4(vec3(depthAt(uv)), 1.0);
  else if (uLayout == 3) {
    // Red filter = left image.
    vec3 l = withCaptions(eyeColor(uv, eye), uv, eye);
    vec3 r = withCaptions(eyeColor(uv, -eye), uv, -eye);
    outColor = vec4(anaglyph(l, r), 1.0);
  }
  else if (uLayout == 5) outColor = vec4(eye > 0.0 ? texture(uVideo, uv).rgb : vec3(depthAt(uv)), 1.0);
  else outColor = vec4(withCaptions(eyeColor(uv, eye), uv, eye), 1.0);
}`;

/*
 * Soft hole fill, a background-only push-pull: each eye's view is rendered with its holes
 * marked empty, shrunk level by level keeping only the farthest texels (pull), then grown
 * back, filling each empty texel from the next coarser level (push). Holes come out as a
 * smooth continuation of the background around them, with no streaks and no object color.
 */

/** One eye's view before hole filling: rgb, a = depth there, or -1 where it's a hole. */
export const FILL_EYE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
${STEREO_COMMON}
uniform float uEye;

void main() {
  float srcX, hole;
  vec3 color = eyeRaw(vUv, uEye, srcX, hole);
  outColor = vec4(color, hole < 0.5 ? depthAt(vec2(srcX, vUv.y)) : -1.0);
}`;

/** Pull: halves a level, averaging the farthest of each 2x2 block's non-empty texels. */
export const FILL_PULL_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uSrc;
const float BG_MARGIN = 0.05; // as in STEREO_COMMON

void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 base = ivec2(gl_FragCoord.xy) * 2;
  vec4 t[4];
  float dMin = 1e9;
  for (int k = 0; k < 4; k++) {
    t[k] = texelFetch(uSrc, min(base + ivec2(k & 1, k >> 1), size - 1), 0);
    if (t[k].a >= 0.0) dMin = min(dMin, t[k].a);
  }
  vec4 sum = vec4(0.0);
  float n = 0.0;
  for (int k = 0; k < 4; k++) {
    if (t[k].a < 0.0 || t[k].a > dMin + BG_MARGIN) continue;
    sum += t[k];
    n += 1.0;
  }
  outColor = n > 0.0 ? sum / n : vec4(0.0, 0.0, 0.0, -1.0);
}`;

/** Push: keeps a level's own texels and fills its empty ones from the coarser, filled level. */
export const FILL_PUSH_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
${STEREO_COMMON}
uniform sampler2D uLevel;
uniform sampler2D uCoarse;

void main() {
  vec4 own = texelFetch(uLevel, ivec2(gl_FragCoord.xy), 0);
  outColor = own.a >= 0.0 ? own : backgroundSample(uCoarse, gl_FragCoord.xy / vec2(textureSize(uLevel, 0)));
}`;

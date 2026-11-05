import * as T from "three/webgpu";
import * as N from "three/tsl";
import { dispatch, storage2D, storage3D, buildMips, readback, NOISE_WGSL } from "./gpu.js";
import { SUN } from "./sky.js";

// The island: one heightfield grown on the GPU at load, shaped for the camera's
// route from south (sea cliff) to north (gate clearing, mountains behind).
export const EXTENT = 4096;
export const CENTER = new T.Vector2(0, 300);
export const GATE = new T.Vector3(0, 0, 500); // y resolved after the bake
const SIZE = 2048;

const HEIGHT_WGSL = /* wgsl */ `
${NOISE_WGSL}
@group(0) @binding(0) var out: texture_storage_2d<rgba32float, write>;

const GATE_XZ = vec2f(${GATE.x}, ${GATE.z});

fn warp(p: vec2f) -> vec2f {
  return vec2f(fbm2(p * 0.0021 + vec2f(3.1, 7.7), 4), fbm2(p * 0.0021 + vec2f(11.3, 2.9), 4)) - 0.5;
}
fn ridged(p0: vec2f) -> f32 {
  var p = p0; var a = 0.5; var s = 0.0; var w = 1.0;
  for (var i = 0; i < 7; i++) {
    let n = 1.0 - abs(noised(p).x * 2.0 - 1.0);
    let c = n * n * w;
    s += a * c; w = clamp(c * 2.2, 0.0, 1.0);
    p = mat2x2f(1.6, 1.2, -1.2, 1.6) * p + vec2f(5.3, 1.7); a *= 0.52;
  }
  return s;
}
// Coast shape: 0 at sea, 1 inland. The south shore is a hard limestone wall.
fn landMask(p: vec2f) -> f32 {
  let q = p + warp(p) * 430.0;
  let e = (q - vec2f(40.0, 560.0)) / vec2f(1080.0, 1190.0);
  let d = length(e);
  return 1.0 - smoothstep(0.86, 1.03, d);
}
fn macroHeight(p: vec2f) -> f32 {
  let land = landMask(p);
  let seabed = -62.0 + fbm2(p * 0.003, 4) * 30.0;
  // Rolling plateau the camera skims.
  let roll = (fbm2(p * 0.0042 + vec2f(21.0, 4.0), 5) - 0.5) * 24.0 + (fbm2(p * 0.018, 3) - 0.5) * 2.2;
  var plateau = 66.0 + roll;
  // The land climbs towards the mountain wall in the north and along both flanks.
  let north = smoothstep(820.0, 1650.0, p.y + (fbm2(p * 0.002, 3) - 0.5) * 300.0);
  let flank = smoothstep(420.0, 1100.0, abs(p.x) + (fbm2(p * 0.0024 + 9.0, 3) - 0.5) * 240.0) * smoothstep(-200.0, 500.0, p.y);
  let peaks = ridged(p * 0.00125 + vec2f(2.7, 1.1));
  // The sun sets down a valley through the range: light reaches the whole plateau.
  let across = abs(p.x - ${SUN.x / SUN.z} * (p.y - 500.0) + (fbm2(p * 0.0034, 3) - 0.5) * 120.0);
  let notch = 1.0 - smoothstep(170.0, 640.0, across);
  plateau += (north * (peaks * 980.0 + 60.0) + flank * (peaks * 340.0 + 12.0)) * (1.0 - 0.97 * notch);
  // A shallow bowl leads the eye to the gate.
  let g = length((p - GATE_XZ) / vec2f(1.0, 1.25));
  plateau = mix(70.0 + roll * 0.12, plateau, smoothstep(50.0, 170.0, g));
  // Cliff: land mask sharpened with a stepped profile.
  let c = smoothstep(0.0, 0.2, land);
  let h = mix(seabed, plateau, c);
  // Sea stacks off the cliff, for parallax on the approach.
  let stackCells = (p + warp(p) * 26.0) * 0.0105;
  let ci = floor(stackCells);
  var stack = 0.0;
  for (var y = -1.0; y <= 1.0; y += 1.0) { for (var x = -1.0; x <= 1.0; x += 1.0) {
    let o = vec2f(x, y); let id = ci + o;
    let r = hash22(id);
    let on = step(0.74, hash12(id + 19.0));
    let d = length(stackCells - id - r);
    stack = max(stack, on * smoothstep(0.26, 0.06, d) * (28.0 + 62.0 * hash12(id + 5.0)));
  } }
  let band = smoothstep(-1120.0, -920.0, p.y) * (1.0 - smoothstep(-760.0, -660.0, p.y)) * smoothstep(90.0, 170.0, abs(p.x)) * (1.0 - smoothstep(420.0, 900.0, abs(p.x)));
  return max(h, mix(h, stack - 6.0, band * step(0.001, stack)));
}
fn gradientOf(p: vec2f) -> vec2f {
  let e = 3.0;
  return vec2f(macroHeight(p + vec2f(e, 0)) - macroHeight(p - vec2f(e, 0)), macroHeight(p + vec2f(0, e)) - macroHeight(p - vec2f(0, e))) / (2.0 * e);
}
// Clay John's gully filter: stripes aligned with the fall line at each octave.
fn gullies(p: vec2f, dir: vec2f) -> vec3f {
  let ip = floor(p); let fp = p - ip;
  var va = vec3f(0); var wt = 0.0;
  for (var j = -2; j <= 1; j++) { for (var i = -2; i <= 1; i++) {
    let o = vec2f(f32(i), f32(j));
    let h = hash22(ip - o) * 0.5;
    let pp = fp + o - h;
    let d = dot(pp, pp);
    let w = exp(-d * 2.0);
    wt += w;
    let mag = dot(pp, dir);
    va += vec3f(cos(mag * 6.2831853), -sin(mag * 6.2831853) * (pp + dir)) * w;
  } }
  return va / wt;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let uv = (vec2f(id.xy) + 0.5) / ${SIZE}.0;
  let p = (uv - 0.5) * ${EXTENT}.0 + vec2f(${CENTER.x}, ${CENTER.y});
  var h = macroHeight(p);
  var g = gradientOf(p);
  let slope = length(g);
  // Erosion carves the steep ground and leaves the meadow gentle.
  let carve = smoothstep(0.16, 0.8, slope);
  var e = vec3f(0); var a = 1.0; var f = 0.016;
  var dd = g;
  for (var i = 0; i < 6; i++) {
    // Stripes run down the fall line; direction is normalised so cliffs stay readable.
    let dir = vec2f(dd.y, -dd.x) / max(length(dd), 0.05) * min(length(dd) * 2.2, 1.0);
    let v = gullies(p * f, dir);
    e += a * v;
    dd += v.yz * 0.08 * a * f * 40.0;
    a *= 0.5; f *= 2.1;
  }
  h += e.x * carve * (2.6 + 20.0 * smoothstep(110.0, 460.0, h));
  // Limestone strata on the sea cliff: horizontal benches, slightly warped.
  let cliffy = smoothstep(0.55, 1.4, slope) * (1.0 - smoothstep(110.0, 180.0, h));
  let lay = h + (fbm2(p * 0.012, 3) - 0.5) * 8.0;
  h += (abs(fract(lay * 0.14) - 0.5) - 0.25) * 2.8 * cliffy;
  textureStore(out, vec2i(id.xy), vec4f(h, carve, cliffy, 0.0));
}
`;

const DERIVE_WGSL = /* wgsl */ `
${NOISE_WGSL}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var out: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var masks: texture_storage_2d<rgba8unorm, write>;
const CELL = ${EXTENT}.0 / ${SIZE}.0;
const SUN_DIR = vec3f(${SUN.x}, ${SUN.y}, ${SUN.z});
const GATE_XZ = vec2f(${GATE.x}, ${GATE.z});
fn h(i: vec2i) -> f32 { return textureLoad(src, clamp(i, vec2i(0), vec2i(${SIZE - 1})), 0).x; }
fn hb(u: vec2f) -> f32 {
  let f = u - 0.5; let i = floor(f); let w = f - i; let k = vec2i(i);
  return mix(mix(h(k), h(k + vec2i(1, 0)), w.x), mix(h(k + vec2i(0, 1)), h(k + vec2i(1, 1)), w.x), w.y);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = vec2i(id.xy);
  let here = h(i);
  let n = normalize(vec3f(h(i - vec2i(1, 0)) - h(i + vec2i(1, 0)), 2.0 * CELL, h(i - vec2i(0, 1)) - h(i + vec2i(0, 1))));
  // Sun visibility: soft horizon march, so ridges throw long evening shadows.
  var vis = 1.0;
  var t = CELL * 1.5;
  let start = vec3f(vec2f(i) + 0.5, here + 0.6).xzy;
  for (var s = 0; s < 72; s++) {
    let q = vec2f(f32(i.x) + 0.5, f32(i.y) + 0.5) + SUN_DIR.xz * t / CELL;
    let ray = here + 0.6 + SUN_DIR.y * t;
    vis = min(vis, clamp((ray - hb(q)) / (t * 0.035 + 0.6) + 1.0, 0.0, 1.0));
    t *= 1.075;
    t += CELL * 0.35;
    if (t > 2600.0) { break; }
  }
  // Curvature, for flow lines and dirt in hollows.
  let curv = (h(i + vec2i(3, 0)) + h(i - vec2i(3, 0)) + h(i + vec2i(0, 3)) + h(i - vec2i(0, 3)) - 4.0 * here) / (9.0 * CELL);
  let uv = (vec2f(i) + 0.5) / ${SIZE}.0;
  let p = (uv - 0.5) * ${EXTENT}.0 + vec2f(${CENTER.x}, ${CENTER.y});
  // Forest: a dense wall across the route with a gate clearing cut out of it.
  let nz = fbm2(p * 0.0065 + vec2f(40.0, 13.0), 5);
  let band = smoothstep(-40.0, 40.0, p.y + (nz - 0.5) * 160.0);
  let gd = length((p - GATE_XZ) / vec2f(1.0, 1.15));
  let clearing = smoothstep(82.0, 128.0, gd + (nz - 0.5) * 42.0);
  let sides = smoothstep(190.0, 540.0, abs(p.x) + (nz - 0.5) * 240.0) * smoothstep(-340.0, -120.0, p.y);
  var forest = max(band, sides * 0.85) * clearing;
  forest *= smoothstep(52.0, 60.0, here) * (1.0 - smoothstep(0.42, 0.72, 1.0 - n.y)) * (1.0 - smoothstep(420.0, 640.0, here));
  let wet = clamp(curv * 2.4 + 0.5, 0.0, 1.0);
  textureStore(out, i, vec4f(here, n.x, n.z, vis));
  textureStore(masks, i, vec4f(forest, wet, clearing, smoothstep(0.0, 6.0, here)));
}
`;

const WEATHER_WGSL = /* wgsl */ `
${NOISE_WGSL}
@group(0) @binding(0) var out: texture_storage_2d<rgba8unorm, write>;
fn tile(p: vec2f, per: f32) -> f32 {
  let i = floor(p); let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  let m = vec2f(per);
  let a = hash12(i % m); let b = hash12((i + vec2f(1, 0)) % m); let c = hash12((i + vec2f(0, 1)) % m); let d = hash12((i + vec2f(1, 1)) % m);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn tfbm(p: vec2f, base: f32, oct: i32) -> f32 {
  var s = 0.0; var a = 0.5; var q = p * base; var per = base;
  for (var i = 0; i < oct; i++) { s += a * tile(q, per); q = q * 2.0; per *= 2.0; a *= 0.5; }
  return s;
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let uv = (vec2f(id.xy) + 0.5) / 512.0;
  let a = tfbm(uv, 5.0, 6);
  let b = tfbm(uv + 0.37, 11.0, 5);
  textureStore(out, vec2i(id.xy), vec4f(a, b, tfbm(uv + 0.71, 3.0, 4), 1.0));
}
`;

// Tileable Perlin-Worley volume for the clouds.
const VOLUME_WGSL = /* wgsl */ `
${NOISE_WGSL}
@group(0) @binding(0) var out: texture_storage_3d<rgba8unorm, write>;
fn worley(p: vec3f, per: f32) -> f32 {
  let id = floor(p); let f = p - id;
  var m = 1.0;
  for (var z = -1.0; z <= 1.0; z += 1.0) { for (var y = -1.0; y <= 1.0; y += 1.0) { for (var x = -1.0; x <= 1.0; x += 1.0) {
    let o = vec3f(x, y, z);
    let c = hash33(((id + o) % per + per) % per + 3.0);
    let d = c + o - f;
    m = min(m, dot(d, d));
  } } }
  return 1.0 - sqrt(m);
}
fn grad(p: vec3f, per: f32) -> f32 {
  let i = floor(p); let f = p - i;
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  var acc = 0.0;
  for (var k = 0.0; k < 2.0; k += 1.0) { for (var j = 0.0; j < 2.0; j += 1.0) { for (var q = 0.0; q < 2.0; q += 1.0) {
    let o = vec3f(q, j, k);
    let g = hash33(((i + o) % per + per) % per + 11.0) * 2.0 - 1.0;
    let w = mix(1.0 - q, q, u.x) * 1.0;
    let wx = select(1.0 - u.x, u.x, q > 0.5);
    let wy = select(1.0 - u.y, u.y, j > 0.5);
    let wz = select(1.0 - u.z, u.z, k > 0.5);
    acc += dot(normalize(g + 1e-5), f - o) * wx * wy * wz + 0.0 * w;
  } } }
  return acc * 0.5 + 0.5;
}
fn wfbm(p: vec3f, per: f32) -> f32 {
  return worley(p * per, per) * 0.625 + worley(p * per * 2.0, per * 2.0) * 0.25 + worley(p * per * 4.0, per * 4.0) * 0.125;
}
fn remap(x: f32, a: f32, b: f32, c: f32, d: f32) -> f32 { return c + (x - a) / (b - a) * (d - c); }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let p = (vec3f(id) + 0.5) / 128.0;
  var perlin = 0.0; var a = 0.5; var per = 4.0;
  for (var i = 0; i < 5; i++) { perlin += a * grad(p * per, per); per *= 2.0; a *= 0.55; }
  perlin = clamp(perlin * 1.12, 0.0, 1.0);
  let w1 = wfbm(p, 4.0);
  let w2 = wfbm(p, 8.0);
  let w3 = wfbm(p, 16.0);
  let shape = clamp(remap(perlin, w1 - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);
  textureStore(out, vec3i(id), vec4f(shape, w1, w2, w3));
}
`;

export async function buildWorld(renderer) {
  const raw = storage2D(renderer, SIZE, { format: "rgba32f", wrap: false, name: "raw" });
  const field = storage2D(renderer, SIZE, { format: "rgba32f", wrap: false, name: "field" });
  const masks = storage2D(renderer, SIZE, { format: "rgba8", wrap: false, name: "masks" });
  const weather = storage2D(renderer, 512, { format: "rgba8", mips: true, name: "weather" });
  const volume = storage3D(renderer, 128, "cloud volume");

  const groups = Math.ceil(SIZE / 8);
  dispatch(renderer, HEIGHT_WGSL, [raw.gpu.createView()], [groups, groups], "island height");
  dispatch(renderer, DERIVE_WGSL, [raw.gpu.createView(), field.gpu.createView(), masks.gpu.createView()], [groups, groups], "island derive");
  dispatch(renderer, WEATHER_WGSL, [weather.gpu.createView({ baseMipLevel: 0, mipLevelCount: 1 })], [64, 64], "weather");
  buildMips(renderer, weather);
  dispatch(renderer, VOLUME_WGSL, [volume.gpu.createView()], [32, 32, 32], "cloud volume");
  const cpu = await readback(renderer, field.gpu, SIZE, 16);
  // Masks stay on the GPU for shading; placement reads a copy.
  const device = renderer.backend.device;
  const mbuf = device.createBuffer({ size: SIZE * SIZE * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: masks.gpu }, { buffer: mbuf, bytesPerRow: SIZE * 4 }, [SIZE, SIZE]);
  device.queue.submit([enc.finish()]);
  await mbuf.mapAsync(GPUMapMode.READ);
  const cpuMasks = new Uint8Array(mbuf.getMappedRange().slice(0));
  mbuf.unmap();
  mbuf.destroy();

  const uvToTexel = (x, z) => [((x - CENTER.x) / EXTENT + 0.5) * SIZE - 0.5, ((z - CENTER.y) / EXTENT + 0.5) * SIZE - 0.5];
  const heightCPU = (x, z) => {
    const [u, v] = uvToTexel(x, z);
    const i = Math.max(0, Math.min(SIZE - 2, Math.floor(u)));
    const j = Math.max(0, Math.min(SIZE - 2, Math.floor(v)));
    const a = Math.max(0, Math.min(1, u - i)), b = Math.max(0, Math.min(1, v - j));
    const at = (q, r) => cpu[(r * SIZE + q) * 4];
    return (at(i, j) * (1 - a) + at(i + 1, j) * a) * (1 - b) + (at(i, j + 1) * (1 - a) + at(i + 1, j + 1) * a) * b;
  };
  const maskCPU = (x, z, c = 0) => {
    const [u, v] = uvToTexel(x, z);
    const i = Math.max(0, Math.min(SIZE - 1, Math.round(u)));
    const j = Math.max(0, Math.min(SIZE - 1, Math.round(v)));
    return cpuMasks[(j * SIZE + i) * 4 + c] / 255;
  };
  const normalCPU = (x, z) => {
    const [u, v] = uvToTexel(x, z);
    const i = Math.max(0, Math.min(SIZE - 1, Math.round(u)));
    const j = Math.max(0, Math.min(SIZE - 1, Math.round(v)));
    const k = (j * SIZE + i) * 4;
    return [cpu[k + 1], cpu[k + 2], cpu[k + 3]];
  };
  GATE.y = heightCPU(GATE.x, GATE.z);

  const fieldNode = N.texture(field.texture);
  const maskNode = N.texture(masks.texture);
  const weatherNode = N.texture(weather.texture);
  const worldUV = (xz) => xz.sub(N.vec2(CENTER.x, CENTER.y)).div(EXTENT).add(0.5);
  const inBounds = (xz) => N.smoothstep(EXTENT * 0.5 - 2, EXTENT * 0.5 - 40, N.max(N.abs(xz.x.sub(CENTER.x)), N.abs(xz.y.sub(CENTER.y))));
  const heightAt = (xz) => N.mix(N.float(-62), fieldNode.sample(worldUV(xz)).level(0).r, inBounds(xz));
  const fieldAt = (xz) => fieldNode.sample(worldUV(xz)).level(0);
  const masksAt = (xz) => maskNode.sample(worldUV(xz)).level(0);
  const time = N.uniform(0);
  // Coverage: clouds thin into a great hole around the island, and thicken over
  // the open sea where the camera comes down through them.
  const coverage = N.Fn(([xz]) => {
    const w = weatherNode.sample(xz.div(21000).add(time.mul(0.000012))).level(0);
    const hole = N.smoothstep(1500, 2500, N.length(xz.sub(N.vec2(60, 500)).mul(N.vec2(0.85, 1))));
    // Towards the sun the sky stays open, so evening light can reach the sea.
    const toward = xz.sub(N.vec2(0, 500));
    const clearLane = N.smoothstep(0, 1500, toward.y).mul(N.float(1).sub(N.smoothstep(600, 3200, N.abs(toward.x.sub(toward.y.mul(0.16))))));
    // Over the open sea, where the camera falls from orbit, the deck is solid.
    const deck = N.float(1).sub(N.smoothstep(-3050, -2520, xz.y));
    return w.r.mul(1.7).sub(0.34).add(w.g.mul(0.7).sub(0.34)).add(hole.mul(0.34).sub(0.3)).sub(clearLane.mul(0.7)).add(deck.mul(0.34));
  });
  const cloudShadow = (xz) => N.float(1).sub(N.smoothstep(0.4, 0.82, coverage(xz)).mul(0.62));

  return {
    raw, field, masks, weather, volume,
    fieldNode, maskNode, weatherNode,
    heightAt, fieldAt, masksAt, heightCPU, maskCPU, normalCPU,
    coverage, cloudShadow, time, worldUV, gatePos: GATE,
  };
}

import * as T from "three/webgpu";
import * as N from "three/tsl";

// The sun never moves in the film, so the whole sky is one small LUT: single
// scattering (Rayleigh, Mie, ozone) integrated once at load. Water, fog, clouds
// and image-based light all sample the same table, so they always agree.

export const SUN = new T.Vector3(0.16, 0.135, 1).normalize();
const R_P = 6371e3, R_A = 6471e3, H_R = 8000, H_M = 1250;
const B_R = [5.8e-6, 13.5e-6, 33.1e-6], B_M = 13e-6, B_O = [0.65e-6, 1.881e-6, 0.085e-6];
const SUN_E = 26;

function sphere(oy, dy, r) {
  const b = oy * dy, c = oy * oy - r * r, d = b * b - c;
  if (d < 0) return -1;
  return -b + Math.sqrt(d);
}
function nearGround(oy, dy) {
  const b = oy * dy, c = oy * oy - R_P * R_P, d = b * b - c;
  if (d < 0 || b > 0) return -1;
  return -b - Math.sqrt(d);
}
function optical(px, py, pz, s, steps) {
  const len = Math.hypot(px, py, pz);
  const dyL = (px * s[0] + py * s[1] + pz * s[2]) / len;
  const tMax = sphere(len, dyL, R_A), dt = tMax / steps;
  let r = 0, m = 0, o = 0;
  for (let i = 0; i < steps; i++) {
    const q = (i + 0.5) * dt;
    const x = px + s[0] * q, y = py + s[1] * q, z = pz + s[2] * q;
    const h = Math.hypot(x, y, z) - R_P;
    if (h < 0) return null;
    r += Math.exp(-h / H_R) * dt;
    m += Math.exp(-h / H_M) * dt;
    o += Math.max(0, 1 - Math.abs(h - 25000) / 15000) * dt;
  }
  return [r, m, o];
}
function scatter(d, s) {
  const oy = R_P + 80;
  const dy = d[1];
  let tMax = sphere(oy, dy, R_A);
  const g = nearGround(oy, dy);
  if (g > 0) tMax = g;
  const steps = 20, dt = tMax / steps;
  const mu = d[0] * s[0] + d[1] * s[1] + d[2] * s[2];
  const pR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const G = 0.72;
  const pM = ((3 / (8 * Math.PI)) * ((1 - G * G) * (1 + mu * mu))) / ((2 + G * G) * Math.pow(1 + G * G - 2 * G * mu, 1.5));
  const out = [0, 0, 0];
  let oR = 0, oM = 0, oO = 0;
  for (let i = 0; i < steps; i++) {
    const q = (i + 0.5) * dt;
    const x = d[0] * q, y = oy + d[1] * q, z = d[2] * q;
    const h = Math.hypot(x, y, z) - R_P;
    const hr = Math.exp(-h / H_R) * dt, hm = Math.exp(-h / H_M) * dt;
    oR += hr;
    oM += hm;
    oO += Math.max(0, 1 - Math.abs(h - 25000) / 15000) * dt;
    const l = optical(x, y, z, s, 6);
    if (!l) continue;
    for (let c = 0; c < 3; c++) {
      const tau = B_R[c] * (oR + l[0]) + B_M * 1.1 * (oM + l[1]) + B_O[c] * (oO + l[2]);
      const at = Math.exp(-tau);
      out[c] += at * (hr * B_R[c] * pR + hm * B_M * pM);
    }
  }
  return out.map((v) => v * SUN_E);
}

export function sunTransmittance(s = [SUN.x, SUN.y, SUN.z]) {
  const l = optical(0, R_P + 80, 0, s, 24);
  return [0, 1, 2].map((c) => Math.exp(-(B_R[c] * l[0] + B_M * 1.1 * l[1] + B_O[c] * l[2])));
}

export function buildSky() {
  const W = 256, H = 144;
  const data = new Float32Array(W * H * 4);
  const s = [SUN.x, SUN.y, SUN.z];
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H;
    const sy = v * 2 - 1;
    const y = Math.sign(sy) * sy * sy;
    const cy = Math.sqrt(Math.max(0, 1 - y * y));
    for (let i = 0; i < W; i++) {
      const a = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
      // Below the horizon the LUT mirrors the upper hemisphere and darkens:
      // only reflections and fog ever read it, and both are near grazing.
      const d = [Math.cos(a) * cy, Math.max(y, 0.002), Math.sin(a) * cy];
      const L = Math.hypot(d[0], d[1], d[2]);
      const rgb = scatter([d[0] / L, d[1] / L, d[2] / L], s);
      const dark = (y < 0 ? Math.exp(y * 6) : 1) * 0.92;
      const k = (j * W + i) * 4;
      data[k] = rgb[0] * dark;
      data[k + 1] = rgb[1] * dark;
      data[k + 2] = rgb[2] * dark;
      data[k + 3] = 1;
    }
  }
  const tex = new T.DataTexture(data, W, H, T.RGBAFormat, T.FloatType);
  tex.wrapS = T.RepeatWrapping;
  tex.wrapT = T.ClampToEdgeWrapping;
  tex.magFilter = tex.minFilter = T.LinearFilter;
  tex.needsUpdate = true;
  const node = N.texture(tex);
  const sun = N.uniform(SUN.clone());
  const rawTrans = sunTransmittance();
  // A touch of grade in the light itself: warm, but never a monochrome orange.
  const trans = rawTrans.map((v, i) => v * 0.42 + [0.6, 0.38, 0.27][i]);

  const lut = N.Fn(([dir]) => {
    const u = N.atan(dir.z, dir.x).div(Math.PI * 2).add(0.5);
    const sy = N.sign(dir.y).mul(N.sqrt(N.abs(dir.y)));
    return node.sample(N.vec2(u, sy.mul(0.5).add(0.5))).level(0).rgb;
  });
  const sunColor = N.vec3(trans[0], trans[1], trans[2]);
  // Sky with a tight forward aureole and the disc itself, for primary rays.
  const sky = N.Fn(([dir]) => {
    const mu = N.max(dir.dot(sun), 0);
    const glow = N.pow(mu, 1400).mul(0.55).add(N.pow(mu, 160).mul(0.05));
    const disc = N.smoothstep(0.99994, 0.99998, mu).mul(180);
    return lut(dir).add(sunColor.mul(glow.add(disc)).mul(SUN_E * 0.25));
  });
  const average = () => {
    const out = [0, 0, 0];
    let w = 0;
    for (let j = Math.floor(H / 2); j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = (j * W + i) * 4;
        out[0] += data[k]; out[1] += data[k + 1]; out[2] += data[k + 2]; w++;
      }
    }
    return out.map((v) => v / w);
  };
  return { tex, lut, sky, sun, sunColor, trans, average };
}

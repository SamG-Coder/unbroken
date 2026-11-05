import * as T from "three/webgpu";
import { PLANET_AT, PLANET_R } from "./space.js";

// The film is a pure function of time: every value below is sampled from keys,
// so any moment can be reproduced exactly.
function hermite(keys, t, get) {
  const n = keys.length;
  if (t <= keys[0].t) return get(keys[0]);
  if (t >= keys[n - 1].t) return get(keys[n - 1]);
  let i = 0;
  while (t > keys[i + 1].t) i++;
  const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(n - 1, i + 2)];
  const dt = k2.t - k1.t, u = (t - k1.t) / dt;
  const p1 = get(k1), p2 = get(k2);
  const m1 = ((p2 - get(k0)) / (k2.t - k0.t || 1)) * dt;
  const m2 = ((get(k3) - p1) / (k3.t - k1.t || 1)) * dt;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m2;
}
const sstep = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };

export const LENGTH = 56;
export const T_WORLD = 17.4; // the instant the camera drops through the planet cloud deck

// Act table, for captions and the scrubber.
export const ACTS = [
  { t: 0.0, title: "Event Horizon", repo: "event-horizon-overdrive", note: "Lensed black hole, integrated per pixel" },
  { t: 5.2, title: "Milky Way", repo: "milky-way", note: "A million GPU stars and a raymarched disc" },
  { t: 11.6, title: "Stratum Earth", repo: "STRATUM-EARTH", note: "A whole planet in one fragment shader" },
  { t: 17.4, title: "Dynamic Gaussian", repo: "dynamic-gaussian", note: "Volumetric clouds, raymarched live" },
  { t: 21.5, title: "ClearWater", repo: "clearwater", note: "Real FFT ocean, compute shader, every frame" },
  { t: 31.0, title: "RealGrass", repo: "RealGrass", note: "2 million blades with no CPU data at all" },
  { t: 38.5, title: "Baked Voxel Lighting", repo: "BakedVoxelLighting", note: "A forest grown on load, no model files" },
  { t: 46.0, title: "Umbra: The Last Gate", repo: "Umbra-The-Last-Gate", note: "Through the gate, back to the start" },
];

// Camera in space: an orbit (focus, log10 distance, azimuth, elevation), so the shot
// can cross eight orders of magnitude without the path overshooting.
const FORWARD_EL = 0.06;
const P = [PLANET_AT.x, PLANET_AT.y, PLANET_AT.z];
const SPACE = [
  { t: 0, f: [0, 0, 0], d: Math.log10(0.46), az: 0, el: FORWARD_EL, fov: 50, e: 1.0, off: [0, 0, 0] },
  { t: 2.6, f: [0, 0, 0], d: Math.log10(0.26), az: 0.5, el: 0.1, fov: 44, e: 1.0, off: [0, 0, 0] },
  { t: 5.2, f: [0, 0, 0], d: Math.log10(0.4), az: 1.25, el: 0.32, fov: 42, e: 1.0, off: [0, 0, 0] },
  { t: 7.6, f: [0, 0, 0], d: Math.log10(14), az: 2.0, el: 0.62, fov: 46, e: 0.95, off: [0, 0, 0] },
  { t: 10.0, f: [4, 0, -3], d: Math.log10(210), az: 2.42, el: 0.72, fov: 50, e: 0.95, off: [0, 0, 0] },
  { t: 11.6, f: [16, 0, -11], d: Math.log10(170), az: 2.65, el: 0.5, fov: 48, e: 0.95, off: [0, 0, 0] },
  { t: 13.4, f: P, d: Math.log10(3.6), az: 3.05, el: 0.3, fov: 44, e: 0.9, off: [0, 0, 0] },
  { t: 15.0, f: P, d: Math.log10(PLANET_R * 4.4), az: 3.25, el: 0.26, fov: 42, e: 0.9, off: [0, 0, 0] },
  { t: 16.5, f: P, d: Math.log10(PLANET_R * 1.45), az: 3.32, el: 0.18, fov: 44, e: 0.95, off: [0.14, -0.1, 0.3] },
  { t: 17.4, f: P, d: Math.log10(PLANET_R * 1.07), az: 3.35, el: 0.15, fov: 46, e: 1, off: [0.15, -0.1, 0.36] },
];

// World shots. Keys with `a: 1` treat y as metres above smoothed ground.
const W = [
  { t: 17.4, p: [-30, 1440, -3050], l: [-10, 1120, -2100], f: 58, e: 0.92, fd: 400, b: 0 },
  { t: 19.2, p: [-24, 1020, -2640], l: [0, 480, -1500], f: 54, e: 0.92, fd: 500, b: 0 },
  { t: 21.5, p: [-12, 340, -2100], l: [10, 16, -600], f: 48, e: 0.94, fd: 500, b: 0 },
  { t: 24, p: [-2, 40, -1640], l: [8, 42, -500], f: 40, e: 0.98, fd: 400, b: 0 },
  { t: 27.4, p: [8, 16, -1120], l: [14, 56, -300], f: 37, e: 1.0, fd: 300, b: 0 },
  { t: 29.0, p: [10, 62, -820], l: [14, 74, 0], f: 38, e: 1.0, fd: 260, b: 0 },
  { t: 30.2, p: [6, 106, -660], l: [6, 92, 0], f: 42, e: 0.95, fd: 160, b: 0 },
  { t: 32.0, p: [2, 4.2, -500], a: 1, l: [0, 86, 100], f: 42, e: 0.92, fd: 18, b: 0 },
  { t: 34.5, p: [0, 1.15, -320], a: 1, l: [0, 76, 40], f: 46, e: 0.74, fd: 6, b: 1.6 },
  { t: 37.0, p: [0, 0.9, -160], a: 1, l: [0, 78, 180], f: 46, e: 0.76, fd: 5, b: 1.8 },
  { t: 39.5, p: [0, 2.3, -30], a: 1, l: [0, 82, 280], f: 44, e: 0.95, fd: 14, b: 1.2 },
  { t: 42.5, p: [1, 3.0, 135], a: 1, l: [0, 88, 430], f: 44, e: 1.05, fd: 26, b: 1 },
  { t: 45.2, p: [0, 3.0, 262], a: 1, l: [0, 92, 500], f: 42, e: 1.05, fd: 50, b: 0.7 },
  { t: 48.5, p: [0, 3.6, 368], a: 1, l: [0, 104, 500], f: 46, e: 1.05, fd: 70, b: 0 },
  { t: 52.2, p: [0, 5.8, 442], a: 1, l: [0, 108, 500], f: 50, e: 1.05, fd: 50, b: 0 },
];

export function createDirector({ camera, post, world, space, gateCenter }) {
  // Smoothed ground reference, so low shots hug the land without jitter.
  const groundAt = (x, z) => {
    let s = 0;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) s += world.heightCPU(x + i * 16, z + j * 16);
    return s / 25;
  };
  const toGate = new T.Vector3();
  const turn = new T.Quaternion();
  const worldCam = new T.Vector3();
  const worldLook = new T.Vector3();
  const spaceLook = new T.Vector3();
  const sampleS = (fn, t) => hermite(SPACE, t, fn);
  const sampleW = (fn, t) => hermite(W, t, fn);
  const forward0 = new T.Vector3(0, -Math.sin(FORWARD_EL), Math.cos(FORWARD_EL)).normalize();
  const S0 = forward0.clone().multiplyScalar(-Math.pow(10, SPACE[0].d));
  // Handheld: quiet near the ground, almost nothing in space.
  const wobble = (t, f) => Math.sin(t * f) * 0.6 + Math.sin(t * f * 2.13 + 1.7) * 0.3 + Math.sin(t * f * 3.7 + 4.1) * 0.1;

  // The last seconds fly straight through the ring on the axis the space shot starts with.
  function worldPose(t, outP, outL) {
    const lastKey = W[W.length - 1];
    if (t > lastKey.t) {
      const u = (t - lastKey.t) / (LENGTH - lastKey.t);
      const start = new T.Vector3(lastKey.p[0], lastKey.p[1] + groundAt(lastKey.p[0], lastKey.p[2]), lastKey.p[2]);
      const e = u * u * (3 - 2 * u) * 0.35 + u * 0.65; // never stops: keeps speed through the plane
      outP.lerpVectors(start, gateCenter, e);
      const lookEnd = gateCenter.clone().addScaledVector(forward0, 200);
      outL.lerpVectors(new T.Vector3(...lastKey.l), lookEnd, sstep(0, 0.75, u));
      return { f: lastKey.f, e: lastKey.e + (1 - lastKey.e) * u, fd: 40, b: 0 };
    }
    const px = sampleW((k) => k.p[0], t), pz = sampleW((k) => k.p[2], t);
    const agl = sampleW((k) => k.a ?? 0, t);
    outP.set(px, sampleW((k) => k.p[1], t) + (agl > 0.001 ? agl * groundAt(px, pz) : 0), pz);
    // Never below the true surface.
    outP.y = Math.max(outP.y, world.heightCPU(px, pz) + 0.5, 5.5);
    outL.set(sampleW((k) => k.l[0], t), sampleW((k) => k.l[1], t), sampleW((k) => k.l[2], t));
    return { f: sampleW((k) => k.f, t), e: sampleW((k) => k.e, t), fd: sampleW((k) => k.fd, t), b: sampleW((k) => k.b, t) };
  }

  const state = { regime: "space", spaceCam: new T.PerspectiveCamera(50, 1, 0.0001, 4000), portal: 0, caption: null };

  function poseSpace(t, cam) {
    const d = Math.pow(10, sampleS((k) => k.d, t));
    const az = sampleS((k) => k.az, t), el = sampleS((k) => k.el, t);
    const fx = sampleS((k) => k.f[0], t), fy = sampleS((k) => k.f[1], t), fz = sampleS((k) => k.f[2], t);
    cam.position.set(fx - Math.sin(az) * Math.cos(el) * d, fy + Math.sin(el) * d, fz - Math.cos(az) * Math.cos(el) * d);
    const ox = sampleS((k) => k.off[0], t), oy = sampleS((k) => k.off[1], t), oz = sampleS((k) => k.off[2], t);
    spaceLook.set(fx + ox * d * 3, fy + oy * d * 3, fz + oz * d * 3);
    cam.up.set(0, 1, 0);
    cam.lookAt(spaceLook);
    const fov = sampleS((k) => k.fov, t);
    if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }
    return { e: sampleS((k) => k.e, t) };
  }

  function applyPlanet(t, cam) {
    space.roP.value.copy(cam.position).sub(PLANET_AT).divideScalar(PLANET_R);
    // Star placed low behind the limb, so the planet rises as a burning crescent.
    space.sunP.value.set(-0.8, 0.25, -0.22).normalize().multiplyScalar(400);
    space.planetOn.value = sstep(11.6, 13.0, t);
    space.whiteout.value = sstep(16.75, T_WORLD - 0.03, t);
  }

  function apply(t) {
    state.caption = ACTS.filter((a) => t >= a.t).pop();
    const inSpace = t < T_WORLD;
    space.time.value = t;
    if (inSpace) {
      state.regime = "space";
      const o = poseSpace(t, camera);
      applyPlanet(t, camera);
      post.exposure.value = o.e;
      post.dofOn.value = 0;
      post.flash.value = 0;
      post.focus.value = 10;
      post.bokeh.value = 0;
    } else {
      state.regime = "world";
      const o = worldPose(t, worldCam, worldLook);
      camera.position.copy(worldCam);
      const shake = sstep(30, 33, t) * (1 - sstep(50, 54, t)) * 0.016 + (1 - sstep(24, 28, t)) * 0.012;
      camera.up.set(0, 1, 0);
      camera.lookAt(worldLook);
      camera.rotateX(wobble(t, 1.1) * shake);
      camera.rotateY(wobble(t + 7, 0.9) * shake);
      camera.rotateZ(wobble(t + 3, 0.7) * shake * 0.8);
      if (Math.abs(o.f - camera.fov) > 0.001) { camera.fov = o.f; camera.updateProjectionMatrix(); }
      post.exposure.value = o.e;
      post.focus.value = Math.max(0.2, o.fd);
      post.focalLen.value = Math.max(50, o.fd * 12);
      post.bokeh.value = o.b;
      post.dofOn.value = o.b > 0.02 ? Math.min(1, o.b) : 0;
      post.flash.value = 1 - sstep(T_WORLD, T_WORLD + 0.55, t);
    }
    // Scope bars ease in only for the ground shots, where framing is deliberate.
    post.letterbox.value = 0.1 * sstep(29, 32, t) * (1 - sstep(53, 55.5, t));
    post.fogAmount.value = 1;
    // The crossing has to match the opening frame, so motion blur fades out before it.
    post.blurScale.value = 0.34 * (1 - sstep(53.6, 55.2, t)) + 0.0 * t;
    if (t < 1.2) post.blurScale.value = 0.34 * sstep(0, 1.2, t);

    // What the portal shows: the same space camera the film will cut to, offset by
    // the world camera's remaining distance to the gate, so parallax lines up.
    const spaceCam = state.spaceCam;
    if (!inSpace && t > 42) {
      const k = 1 / 340;  // matches the world camera speed to the opening space move at the crossing
      // Only the distance to the gate carries over, so the hole stays on the ring's axis.
      spaceCam.position.copy(S0).addScaledVector(forward0, -camera.position.distanceTo(gateCenter) * k);
      // The hole stays centred in the ring: the view is turned so it sits along the line
      // to the gate, a rotation that shrinks to nothing exactly at the crossing.
      toGate.copy(gateCenter).addScaledVector(forward0, 30).sub(camera.position).normalize();
      turn.setFromUnitVectors(toGate, forward0);
      spaceCam.quaternion.copy(turn).multiply(camera.quaternion);
      spaceCam.fov = camera.fov;
      spaceCam.aspect = camera.aspect;
      spaceCam.updateProjectionMatrix();
      spaceCam.updateMatrixWorld();
      state.portal = 1;
    } else {
      state.portal = 0;
    }
    return inSpace;
  }
  return { apply, length: LENGTH, state };
}

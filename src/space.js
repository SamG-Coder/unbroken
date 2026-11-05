import * as T from "three/webgpu";
import * as N from "three/tsl";

// Everything beyond the sky is one fragment shader on a backdrop sphere: a lensed
// black hole, a raymarched spiral galaxy and a shaded planet with atmosphere,
// plus a million instanced stars. Units: galaxy radius = 100, event horizon = RS.
export const RS = 0.02;
export const PLANET_AT = new T.Vector3(46, 0.35, -31);
export const PLANET_R = 0.0016;

const COMMON = /* wgsl */ `
fn h31(p: vec3f) -> f32 { var q = fract(p * 0.1031); q += dot(q, q.zyx + 31.32); return fract((q.x + q.y) * q.z); }
fn vn3(p: vec3f) -> f32 {
  let i = floor(p); let f = p - i; let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3f(1, 0, 0)), u.x), mix(h31(i + vec3f(0, 1, 0)), h31(i + vec3f(1, 1, 0)), u.x), u.y),
             mix(mix(h31(i + vec3f(0, 0, 1)), h31(i + vec3f(1, 0, 1)), u.x), mix(h31(i + vec3f(0, 1, 1)), h31(i + vec3f(1, 1, 1)), u.x), u.y), u.z);
}
fn fbm3(p0: vec3f, oct: i32) -> f32 {
  var p = p0; var a = 0.5; var s = 0.0;
  for (var i = 0; i < oct; i++) { s += a * vn3(p); p = p * 2.03 + vec3f(1.7, 9.2, 4.1); a *= 0.5; }
  return s;
}
// Deep sky: tiny hashed stars and faint coloured gas.
fn deepSky(rd: vec3f) -> vec3f {
  var col = vec3f(0);
  for (var l = 0; l < 2; l++) {
    let sc = 170.0 + f32(l) * 240.0;
    let c = floor(rd * sc);
    let h = h31(c + f32(l) * 13.0);
    if (h > 0.985) {
      let f = rd * sc - c - 0.5;
      let d = length(f);
      let b = pow(max(0.0, 1.0 - d * 2.2), 5.0) * (h - 0.985) * 300.0;
      col += b * mix(vec3f(1.0, 0.75, 0.55), vec3f(0.6, 0.78, 1.0), h31(c + 3.0));
    }
  }
  let g = fbm3(rd * 3.2, 4);
  col += vec3f(0.006, 0.005, 0.016) * smoothstep(0.42, 0.8, g);
  return col;
}
// Spiral density at p, in galaxy units. Returns (emission rgb, absorption).
fn galaxyAt(p: vec3f, quality: f32) -> vec4f {
  let rad = length(p.xz);
  let r = rad / 100.0;
  let theta = atan2(p.z, p.x);
  let thick = 0.8 + 3.2 * exp(-r * 7.0) + 2.0 * r;
  let vertical = exp(-abs(p.y) / thick);
  let swirl = theta * 2.0 - log(r + 0.035) * 3.6;
  let warp = (fbm3(vec3f(p.x, p.y * 3.0, p.z) * 0.06, 3) - 0.5) * 2.2;
  let armA = pow(0.5 + 0.5 * cos(swirl + warp), 2.6);
  let lanes = pow(0.5 + 0.5 * cos(swirl + warp + 0.85), 6.0);
  let fine = fbm3(vec3f(p.x, p.y * 2.0, p.z) * 0.31 + 7.0, i32(quality));
  let disc = exp(-r * 3.1) * smoothstep(1.25, 0.8, r);
  let bulge = exp(-length(vec3f(p.x, p.y * 1.8, p.z)) / 7.5);
  let young = vec3f(0.3, 0.48, 1.0) * (armA * 3.4 + 0.06) * disc * smoothstep(0.24, 0.68, fine);
  let hii = vec3f(1.0, 0.16, 0.34) * pow(armA, 3.0) * smoothstep(0.54, 0.72, fine) * disc * 2.2;
  let old = vec3f(1.0, 0.68, 0.38) * (bulge * 3.2 + disc * 0.12);
  let emit = (young + hii) * vertical * 0.34 + old * exp(-abs(p.y) / (thick * 1.2)) * 0.34;
  let absorb = lanes * disc * smoothstep(0.32, 0.62, fine) * exp(-abs(p.y) / 0.9) * 0.34 * smoothstep(0.03, 0.2, r);
  return vec4f(emit, absorb);
}
fn marchGalaxy(ro: vec3f, rd: vec3f, jitter: f32, steps: i32) -> vec3f {
  // Slab |y| < 14, ray clipped to the galaxy.
  let H = 14.0;
  var t0 = 0.0; var t1 = 460.0;
  if (abs(rd.y) > 1e-4) {
    let a = (H - ro.y) / rd.y; let b = (-H - ro.y) / rd.y;
    t0 = max(0.0, min(a, b)); t1 = min(t1, max(a, b));
  } else if (abs(ro.y) > H) { return vec3f(0); }
  if (t0 >= t1) { return vec3f(0); }
  var col = vec3f(0); var tr = 1.0;
  let dt = (t1 - t0) / f32(steps);
  var t = t0 + dt * jitter;
  for (var i = 0; i < steps; i++) {
    let g = galaxyAt(ro + rd * t, 2.0);
    let a = exp(-g.w * dt * 0.95);
    col += g.xyz * dt * tr;
    tr *= a;
    if (tr < 0.01) { break; }
    t += dt;
  }
  return col * 0.3;
}
`;

const shadeSpace = N.wgslFn(/* wgsl */ `
fn shadeSpace(rd0: vec3f, ro: vec3f, time: f32, rs: f32, jitter: f32, steps: f32, roP: vec3f, sunP: vec3f, planetOn: f32, whiteout: f32) -> vec3f {
  var rd = normalize(rd0);
  var col = vec3f(0);
  var through = vec3f(1);
  var escaped = rd;
  var origin = ro;
  // --- Black hole: null geodesics in the Schwarzschild metric (r_s = 1).
  let bh = ro / rs;
  let bhDist = length(bh);
  if (bhDist < 4000.0) {
    var p = bh; var v = rd;
    // Rays that start far away begin at the edge of the lensing region.
    let startR = 180.0;
    let b = dot(p, v); let c = dot(p, p) - startR * startR;
    var enters = true;
    if (bhDist > startR) {
      let disc = b * b - c;
      if (disc < 0.0 || b > 0.0) { enters = false; } else { p += v * (-b - sqrt(disc)); }
    }
    if (enters) {
      let hv = cross(p, v);
      let h2 = dot(hv, hv);
      var captured = false;
      var i = 0;
      loop {
        if (i >= 180) { break; }
        i++;
        let r2 = dot(p, p);
        let r = sqrt(r2);
        if (r < 1.002) { captured = true; break; }
        if (r > startR * 1.02 && dot(p, v) > 0.0) { break; }
        let dtt = clamp(r * 0.075, 0.018, 8.0);
        let acc = -1.5 * h2 * p / (r2 * r2 * r);
        let nv = normalize(v + acc * dtt);
        let np = p + nv * dtt;
        // Accretion disc in the y = 0 plane: thin, turbulent, Doppler beamed.
        if (p.y * np.y < 0.0) {
          let s = p.y / (p.y - np.y);
          let q = mix(p, np, s);
          let dr = length(q.xz);
          if (dr > 2.7 && dr < 15.5) {
            let ang = atan2(q.z, q.x);
            let orbit = time * 7.0 / pow(dr, 1.5);
            let turb = fbm3(vec3f(cos(ang + orbit) * dr * 1.15, sin(ang + orbit) * dr * 1.15, dr * 0.75), 4);
            let rings = 0.62 + 0.38 * sin(dr * 7.0 + turb * 7.0);
            let fall = smoothstep(2.6, 3.2, dr) * pow(smoothstep(15.5, 3.4, dr), 2.2);
            let T = pow(3.0 / dr, 1.3);
            // Relativistic beaming from the disc's orbital velocity along the ray.
            let orbitDir = normalize(vec3f(-q.z, 0.0, q.x));
            let beta = sqrt(0.5 / dr);
            let dop = 1.0 / (1.0 - beta * dot(orbitDir, -nv));
            let I = pow(dop, 3.6) * T * T * fall * (smoothstep(0.25, 0.75, turb) * 2.0 + 0.08) * rings;
            let hot = mix(vec3f(1.0, 0.26, 0.035), vec3f(1.0, 0.86, 0.66), pow(clamp(T * dop * 0.62, 0.0, 1.0), 1.6));
            let cool = mix(hot, vec3f(0.78, 0.86, 1.0), clamp((dop - 1.32) * 1.5, 0.0, 0.55));
            let tau = 0.62 * fall;
            col += through * cool * I * 4.2;
            through *= (1.0 - tau);
          }
        }
        p = np; v = nv;
      }
      escaped = v;
      if (captured) { through = vec3f(0); }
      // Photon ring: light that wrapped the hole, a hair outside capture.
      origin = ro; rd = escaped;
    }
  }
  // --- Distant universe seen along the (possibly bent) ray.
  var bg = deepSky(rd);
  let farFromCore = smoothstep(5.0, 130.0, length(origin));
  let gal = marchGalaxy(origin, rd, jitter, i32(steps)) * (farFromCore * 0.985 + 0.015) * (1.0 - planetOn * 0.92);
  bg += gal;
  col += through * bg;
  // --- Planet + its star.
  if (planetOn > 0.0) {
    let toSun = normalize(sunP - roP);
    let sMu = max(dot(rd, toSun), 0.0);
    col += vec3f(1.0, 0.86, 0.68) * (pow(sMu, 90000.0) * 900.0 + pow(sMu, 2400.0) * 9.0 + pow(sMu, 90.0) * 0.1) * planetOn;
    let rp = roP;
    let bp = dot(rp, rd);
    let RA = 1.09;
    let cA = dot(rp, rp) - RA * RA;
    let dA = bp * bp - cA;
    if (dA > 0.0) {
      let tA0 = max(0.0, -bp - sqrt(dA));
      let tA1 = -bp + sqrt(dA);
      let cS = dot(rp, rp) - 1.0;
      let dS = bp * bp - cS;
      var surf = -1.0;
      if (dS > 0.0) { surf = -bp - sqrt(dS); }
      let L = normalize(sunP);
      var pc = vec3f(0);
      var shadow = 1.0;
      if (surf > 0.0) {
        let n = normalize(rp + rd * surf);
        // Blocks out what is behind the planet disc entirely.
        col = vec3f(0);
        let warpN = n + (vec3f(fbm3(n * 2.3, 3), fbm3(n * 2.3 + 4.0, 3), fbm3(n * 2.3 + 9.0, 3)) - 0.5) * 0.65;
        let lod = 5;
        let land = fbm3(warpN * 3.4, lod + 2);
        let isLand = smoothstep(0.5, 0.53, land);
        let mtn = fbm3(warpN * 16.0, 3);
        let ndl = dot(n, L);
        let lit = smoothstep(-0.05, 0.25, ndl);
        let ocean = vec3f(0.004, 0.035, 0.09) * (0.6 + 0.4 * smoothstep(0.28, 0.5, land)) + vec3f(0.0, 0.08, 0.07) * smoothstep(0.46, 0.5, land);
        let terra = mix(vec3f(0.11, 0.135, 0.045), vec3f(0.32, 0.26, 0.17), smoothstep(0.42, 0.68, mtn));
        var base = mix(ocean, terra, isLand);
        // Sun glint on the water.
        let hv2 = normalize(L - rd);
        let glint = pow(max(dot(n, hv2), 0.0), 240.0) * 3.5 * (1.0 - isLand);
        // Cloud deck: two scales of domain-warped noise.
        let flow = n * 5.0 + (vec3f(fbm3(n * 4.0 + time * 0.012, 3)) - 0.5) * 1.4;
        let cl = smoothstep(0.46, 0.68, fbm3(flow, 7));
        let high = smoothstep(0.5, 0.7, fbm3(n * vec3f(2.0, 9.0, 2.0) + 21.0, 4)) * 0.5;
        let cloud = clamp(cl + high, 0.0, 1.0);
        base = mix(base, vec3f(0.92, 0.9, 0.86), cloud);
        pc = base * lit * vec3f(1.0, 0.93, 0.85) * 2.2 + vec3f(1.0, 0.72, 0.4) * glint * lit;
        // City lights on the night side, under the clouds.
        let cells = fbm3(n * 42.0, 3);
        let night = smoothstep(0.08, -0.12, ndl);
        pc += vec3f(1.0, 0.62, 0.28) * smoothstep(0.6, 0.72, cells) * isLand * night * (1.0 - cloud) * 0.5;
        // Terminator burns red where evening light skims the cloud tops.
        let term = smoothstep(-0.12, 0.05, ndl) * smoothstep(0.32, 0.04, ndl);
        pc += vec3f(1.0, 0.34, 0.1) * term * (0.45 + cloud * 1.6);
      }
      // Rim atmosphere: single scattering, a few steps through the shell.
      let tEnd = select(tA1, surf, surf > 0.0);
      let nS = 10;
      let dtA = (tEnd - tA0) / f32(nS);
      var ray = vec3f(0); var optical = 0.0;
      let mu = dot(rd, L);
      let phR = 0.75 * (1.0 + mu * mu);
      let phM = 0.08 * (1.0 - 0.72) / pow(1.0 + 0.5184 - 1.44 * mu, 1.5);
      for (var k = 0; k < nS; k++) {
        let q = rp + rd * (tA0 + (f32(k) + 0.5) * dtA);
        let h = (length(q) - 1.0) / 0.09;
        let den = exp(-h * 3.8);
        optical += den * dtA;
        // Sun visibility grazing the planet: red at the terminator.
        let qN = normalize(q);
        let sunUp = dot(qN, L);
        let sv = smoothstep(-0.2, 0.1, sunUp);
        let tint = mix(vec3f(1.0, 0.28, 0.06), vec3f(1.0), smoothstep(-0.05, 0.4, sunUp));
        ray += den * dtA * sv * tint * exp(-optical * vec3f(9.0, 20.0, 42.0) * 1.0);
      }
      let inscatter = ray * (vec3f(0.14, 0.34, 1.0) * phR * 19.0 + vec3f(1.0, 0.8, 0.6) * phM * 19.0);
      let ext = exp(-optical * vec3f(4.0, 9.0, 20.0));
      if (surf > 0.0) { col = pc * ext + inscatter; } else { col = col * ext + inscatter; }
    }
    // Falling into the deck: the same warm white the cloud layer begins with.
    col = mix(col, vec3f(4.2, 3.5, 2.9), whiteout);
  }
  return col;
}
`, [N.code(COMMON)]);

export function createSpace(quality) {
  const scene = new T.Scene();
  const time = N.uniform(0);
  const rsU = N.uniform(RS);
  const roP = N.uniform(new T.Vector3());
  const sunP = N.uniform(new T.Vector3(-24, 3.2, 31).normalize().multiplyScalar(60));
  const planetOn = N.uniform(0);
  const whiteout = N.uniform(0);
  const frame = N.uniform(0);

  const backdrop = new T.Mesh(new T.SphereGeometry(1, 32, 16), new T.MeshBasicNodeMaterial({ side: T.BackSide, depthWrite: false, depthTest: false }));
  backdrop.frustumCulled = false;
  backdrop.material.positionNode = N.positionLocal.mul(10).add(N.cameraPosition);
  const rdV = N.varying(N.positionGeometry, "vSkyDir");
  const jitter = N.fract(N.screenCoordinate.xy.dot(N.vec2(0.06711056, 0.00583715)).fract().mul(52.9829189).add(frame.mul(0.618)));
  backdrop.material.colorNode = shadeSpace({
    rd0: rdV, ro: N.cameraPosition, time, rs: rsU, jitter, steps: N.float(quality.galaxySteps), roP, sunP, planetOn, whiteout,
  });
  backdrop.renderOrder = -10;
  scene.add(backdrop);

  // Stars: positions come from instanceIndex hashes alone, shaped into arms.
  const count = quality.stars;
  const quad = new T.InstancedBufferGeometry();
  quad.setAttribute("position", new T.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  quad.instanceCount = count;

  const mat = new T.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: T.AdditiveBlending, side: T.DoubleSide });
  const prevVP = N.uniform(new T.Matrix4());
  const curVP = N.uniform(new T.Matrix4());
  const aspect = N.uniform(16 / 9);
  const idx = N.instanceIndex.toFloat();
  // Split the index first: sin() of a large float loses all its randomness.
  const idLo = N.mod(idx, 1024);
  const idHi = N.floor(idx.div(1024));
  const hash = (seed) => N.fract(N.sin(idLo.mul(12.9898).add(idHi.mul(78.233)).add(seed)).mul(43758.5453));
  const u = hash(1.1), a = hash(2.3), b = hash(3.7), c = hash(5.9), e = hash(7.7), g = hash(9.1);
  const rad = N.pow(u, 0.62).mul(118).add(0.7);
  const arm = N.floor(a.mul(2));
  const logT = N.log(rad.div(100).add(0.035)).mul(1.8);
  const spread = b.sub(0.5).mul(b.sub(0.5).abs().mul(3.2)).mul(N.mix(0.4, 3.1, c));
  const theta = arm.mul(Math.PI).add(logT).add(spread).sub(time.mul(0.012).div(rad.mul(0.03).add(0.4)));
  const y = e.sub(0.5).mul(N.mix(1.6, 6.5, N.exp(rad.mul(-0.06)))).mul(g.mul(g).add(0.15));
  const world = N.vec3(N.cos(theta).mul(rad), y, N.sin(theta).mul(rad));

  const clip = curVP.mul(N.vec4(world, 1));
  const prevClip = prevVP.mul(N.vec4(world, 1));
  const behind = clip.w.lessThan(0.0001).or(prevClip.w.lessThan(0.0001));
  const ndc = clip.xy.div(clip.w);
  const pndc = prevClip.xy.div(prevClip.w);
  // Each star is a streak between its last and current screen position.
  const velo = N.clamp(ndc.sub(pndc).mul(N.vec2(aspect, 1)), N.vec2(-0.22), N.vec2(0.22));
  const speed = N.length(velo);
  const dist = N.length(world.sub(N.cameraPosition));
  const coreClose = N.smoothstep(0.4, 9, N.length(N.cameraPosition));
  const lum = N.mix(0.25, 1.5, c.mul(c)).mul(N.float(30).div(dist.add(16)).add(0.12)).mul(N.float(1).add(N.pow(g, 22).mul(3.5))).mul(coreClose.mul(0.97).add(0.03));
  const size = N.clamp(lum.mul(0.0019), 0.00075, 0.012);
  const dirX = N.select(speed.greaterThan(1e-5), velo.div(N.max(speed, 1e-5)), N.vec2(1, 0));
  const dirY = N.vec2(dirX.y.negate(), dirX.x);
  const lp = N.positionGeometry.xy;
  const along = dirX.mul(lp.x.mul(size.add(speed.mul(0.32))));
  const across = dirY.mul(lp.y.mul(size));
  const center = ndc.sub(N.mul(ndc.sub(pndc), 0.5));
  const off = along.add(across).div(N.vec2(aspect, 1));
  mat.vertexNode = N.select(behind, N.vec4(9, 9, 9, 1), N.vec4(center.add(off).mul(clip.w), N.mul(clip.w, 0.5), clip.w));
  const vUV = N.varying(lp, "vStarUV");
  const temp = N.varying(N.mix(N.vec3(1, 0.62, 0.36), N.vec3(0.58, 0.74, 1), N.smoothstep(0.15, 0.85, N.mix(a, N.float(0.95).sub(N.exp(rad.mul(-0.045))).mul(1.15), 0.72))), "vStarT");
  const vLum = N.varying(lum.div(N.float(1).add(speed.mul(28))), "vStarL");
  mat.colorNode = N.Fn(() => {
    const d = N.length(vUV);
    const core = N.smoothstep(1, 0.08, d);
    return temp.mul(core.mul(core)).mul(vLum).mul(3.0);
  })();
  const stars = new T.Mesh(quad, mat);
  stars.frustumCulled = false;
  scene.add(stars);

  return {
    scene, time, frame, roP, sunP, planetOn, whiteout, backdrop, stars, prevVP, curVP, aspect,
    beginFrame(camera, cut) {
      camera.updateMatrixWorld();
      const vp = new T.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      prevVP.value.copy(cut ? vp : curVP.value);
      curVP.value.copy(vp);
      aspect.value = camera.aspect;
      frame.value = (frame.value + 1) % 1024;
    },
  };
}

import * as T from "three/webgpu";
import * as N from "three/tsl";

const hashF = (idx, seed) => N.fract(N.sin(idx.mul(12.9898).add(seed)).mul(43758.5453));

function quadGeo(count) {
  const g = new T.InstancedBufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = count;
  return g;
}

// Sunlit dust and pollen: a box of drifting motes that wraps around the camera,
// brightest when looking towards the sun, as real airborne dust is.
export function createMotes(world, sky, count = 26000) {
  const mat = new T.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide });
  const idx = N.instanceIndex.toFloat();
  const box = N.vec3(70, 26, 70);
  const seedP = N.vec3(hashF(idx, 1.3), hashF(idx, 2.7), hashF(idx, 4.1));
  const drift = N.vec3(
    world.time.mul(0.55).add(N.sin(world.time.mul(0.27).add(seedP.y.mul(30))).mul(1.3)),
    N.sin(world.time.mul(0.41).add(seedP.x.mul(40))).mul(0.6).add(world.time.mul(0.1)),
    world.time.mul(-0.32).add(N.cos(world.time.mul(0.31).add(seedP.z.mul(30))).mul(1.1)),
  );
  // Wrap in a box centred on the camera.
  const rel = N.mod(seedP.mul(box).add(drift).sub(N.cameraPosition), box).sub(box.mul(0.5));
  const pos = N.cameraPosition.add(rel);
  const size = N.mix(0.008, 0.022, hashF(idx, 6.3));
  const right = N.cameraWorldMatrix.mul(N.vec4(1, 0, 0, 0)).xyz;
  const up = N.cameraWorldMatrix.mul(N.vec4(0, 1, 0, 0)).xyz;
  const lp = N.positionGeometry.xy;
  mat.positionNode = pos.add(right.mul(lp.x.mul(size))).add(up.mul(lp.y.mul(size)));
  const vUV = N.varying(lp, "vMoteUV");
  const dist = N.length(rel);
  const fade = N.varying(N.smoothstep(32, 12, dist).mul(N.smoothstep(0.6, 3, dist)).mul(N.smoothstep(46, 16, N.cameraPosition.y.sub(world.heightAt(N.cameraPosition.xz)))), "vMoteFade");
  const groundY = N.varying(world.fieldAt(pos.xz).a, "vMoteVis");
  mat.colorNode = N.Fn(() => {
    const d = N.length(vUV);
    const v = N.normalize(N.positionWorld.sub(N.cameraPosition));
    const phase = N.pow(N.max(v.dot(sky.sun), 0), 4).mul(5).add(0.25);
    return sky.sunColor.mul(N.vec3(1.2, 1.0, 0.75)).mul(N.smoothstep(1, 0.1, d)).mul(phase).mul(fade).mul(groundY).mul(0.5);
  })();
  const mesh = new T.Mesh(quadGeo(count), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return mesh;
}

// Embers rising from the two braziers, swirling towards the gate's pull.
export function createEmbers(world, origin, count = 3200) {
  const mat = new T.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide });
  const idx = N.instanceIndex.toFloat();
  const life = N.fract(hashF(idx, 3.1).add(world.time.mul(N.mix(0.07, 0.17, hashF(idx, 5.3)))));
  const side = N.select(hashF(idx, 8.1).greaterThan(0.5), N.float(1), N.float(-1));
  const srcX = side.mul(21);
  const angle = hashF(idx, 1.9).mul(6.283).add(life.mul(5));
  const rad = N.mix(0.25, 1.6, hashF(idx, 2.2)).mul(life.mul(5.4).add(0.35));
  const h = life.mul(N.mix(10, 40, hashF(idx, 7.1)));
  const pull = life.mul(life).mul(side.mul(-14));
  const pos = N.vec3(
    N.float(origin.x).add(srcX).add(pull).add(N.cos(angle).mul(rad)),
    N.float(origin.y).add(6.8).add(h),
    N.float(origin.z - 19).add(N.sin(angle).mul(rad)).add(life.mul(4)),
  );
  const size = N.mix(0.022, 0.08, hashF(idx, 9.3)).mul(N.float(1).sub(life.mul(0.6)));
  const right = N.cameraWorldMatrix.mul(N.vec4(1, 0, 0, 0)).xyz;
  const up = N.cameraWorldMatrix.mul(N.vec4(0, 1, 0, 0)).xyz;
  const lp = N.positionGeometry.xy;
  mat.positionNode = pos.add(right.mul(lp.x.mul(size))).add(up.mul(lp.y.mul(size)));
  const vUV = N.varying(lp, "vEmberUV");
  const fade = N.varying(N.smoothstep(0, 0.05, life).mul(N.smoothstep(1, 0.5, life)), "vEmberFade");
  mat.colorNode = N.Fn(() => {
    const d = N.length(vUV);
    return N.vec3(1, 0.36, 0.08).mul(N.smoothstep(1, 0.05, d).pow(2)).mul(fade).mul(14);
  })();
  const mesh = new T.Mesh(quadGeo(count), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  return mesh;
}

// Volumetric-looking flames: camera-facing cards shaded by scrolling warped noise.
export function createFire(world, tiles, origin) {
  const group = new T.Group();
  const flameMat = new T.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide });
  const t = world.time;
  flameMat.colorNode = N.Fn(() => {
    const uv = N.uv();
    const p = N.vec2(uv.x.sub(0.5).mul(2), uv.y);
    const n1 = tiles.soil.sample(N.vec2(p.x.mul(0.18), p.y.mul(0.24).sub(t.mul(0.32)))).b;
    const n2 = tiles.soil.sample(N.vec2(p.x.mul(0.5).add(0.3), p.y.mul(0.5).sub(t.mul(0.74)))).b;
    const warpX = p.x.add(n1.sub(0.5).mul(1.1).mul(p.y));
    const body = N.float(1).sub(N.abs(warpX).div(N.mix(0.72, 0.0, N.pow(p.y, 0.8)).add(0.001)));
    const heat = N.clamp(body.mul(1.6).add(n2.sub(0.5).mul(1.4)).sub(p.y.mul(0.72)), 0, 1);
    const col = N.mix(N.vec3(1.0, 0.13, 0.015), N.vec3(1.0, 0.68, 0.24), heat);
    return col.mul(heat.pow(1.5)).mul(N.smoothstep(0, 0.1, p.y)).mul(4.5);
  })();
  const bowlMat = new T.MeshStandardNodeMaterial({ roughness: 0.65, metalness: 0.8 });
  bowlMat.colorNode = N.vec3(0.07, 0.05, 0.04);
  const emberBed = new T.MeshBasicNodeMaterial();
  emberBed.colorNode = N.vec3(6, 1.4, 0.2);
  const lights = [];
  for (const sx of [-21, 21]) {
    const base = new T.Group();
    base.position.set(origin.x + sx, origin.y + 3.5, origin.z - 19);
    const stem = new T.Mesh(new T.CylinderGeometry(0.42, 0.85, 3.2, 12), bowlMat);
    stem.position.y = 1.6;
    stem.castShadow = true;
    const bowl = new T.Mesh(new T.CylinderGeometry(1.9, 0.75, 1.2, 20), bowlMat);
    bowl.position.y = 3.5;
    bowl.castShadow = true;
    const coals = new T.Mesh(new T.CircleGeometry(1.75, 20), emberBed);
    coals.rotation.x = -Math.PI / 2;
    coals.position.y = 4.09;
    base.add(stem, bowl, coals);
    for (let c = 0; c < 3; c++) {
      const flame = new T.Mesh(new T.PlaneGeometry(4.6, 8.2), flameMat);
      flame.position.y = 7.9;
      flame.rotation.y = (c / 3) * Math.PI;
      base.add(flame);
    }
    group.add(base);
    const light = new T.PointLight(0xff7a2a, 900, 60, 2);
    light.position.set(origin.x + sx, origin.y + 8.5, origin.z - 19);
    group.add(light);
    lights.push(light);
  }
  return { group, lights };
}

// A loose wheeling flock over the ocean: two-triangle gulls with flapping wings.
export function createBirds(world, count = 64) {
  const wing = [-1, 0, 0, 0, 0, 0.26, 0, 0, -0.14, 1, 0, 0, 0, 0, 0.26, 0, 0, -0.14];
  const g = new T.InstancedBufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(wing, 3));
  g.instanceCount = count;
  const idx = N.instanceIndex.toFloat();
  const mat = new T.MeshStandardNodeMaterial({ side: T.DoubleSide, roughness: 0.8 });
  mat.colorNode = N.vec3(0.62, 0.6, 0.57);
  const p = N.positionGeometry;
  const flap = N.sin(world.time.mul(7.5).add(hashF(idx, 1.3).mul(6.28)));
  const offs = N.vec3(hashF(idx, 3.3).sub(0.5).mul(140), hashF(idx, 4.4).sub(0.5).mul(34), hashF(idx, 5.5).sub(0.5).mul(140));
  const orbit = world.time.mul(0.11).add(offs.x.mul(0.004));
  const center = N.vec3(N.sin(orbit).mul(90).add(50), N.float(52).add(N.sin(orbit.mul(2)).mul(8)), N.cos(orbit).mul(70).add(-1070));
  const fwd = N.normalize(N.vec3(N.cos(orbit), 0, N.sin(orbit).negate()));
  const right = N.normalize(N.cross(N.vec3(0, 1, 0), fwd));
  const size = N.float(0.8);
  const wingY = N.abs(p.x).mul(flap.mul(0.55));
  const local = right.mul(p.x.mul(size)).add(fwd.mul(p.z.mul(size))).add(N.vec3(0, wingY.mul(size), 0));
  mat.positionNode = center.add(offs).add(local);
  const mesh = new T.Mesh(g, mat);
  mesh.frustumCulled = false;
  return mesh;
}

import * as T from "three/webgpu";
import * as N from "three/tsl";
import { LitStandard } from "./lighting.js";

// GPU meadow in the manner of Ghost of Tsushima: blades have no CPU data at all.
// Each instance derives its cell from instanceIndex + the snapped camera, then
// grows from hashes, the terrain field and a travelling gust field.

function bladeGeometry(segments) {
  const verts = [];
  const idx = [];
  for (let i = 0; i <= segments; i++) {
    const v = i / segments;
    verts.push(-1, v, 0, 1, v, 0);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new T.InstancedBufferGeometry();
  g.setAttribute("position", new T.BufferAttribute(new Float32Array(verts), 3));
  g.setAttribute("normal", new T.BufferAttribute(new Float32Array(verts.length).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

const hash21 = N.Fn(([p]) => {
  const q = N.fract(N.vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  q.addAssign(q.dot(q.yzx.add(33.33)));
  return N.fract(q.x.add(q.y).mul(q.z));
});

function layer(world, sky, { count, spacing, segments, widthScale, heightScale, inner, outer, flowers = false }) {
  const K = Math.ceil(Math.sqrt(count));
  const geo = bladeGeometry(segments);
  geo.instanceCount = K * K;

  const anchor = N.uniform(new T.Vector2());
  const camY = N.uniform(0);

  const idx = N.instanceIndex.toFloat();
  const ci = N.mod(idx, K);
  const cj = N.floor(idx.div(K));
  const cell = anchor.add(N.vec2(ci, cj).sub(K / 2));
  const jitter = N.vec2(hash21(cell.add(1.7)), hash21(cell.add(9.3)));
  const base = cell.add(jitter).mul(spacing);
  const r1 = hash21(cell.add(31.1));
  const r2 = hash21(cell.add(47.7));
  const r3 = hash21(cell.add(73.9));

  const field = world.fieldAt(base);
  const masks = world.masksAt(base);
  const y = field.r;
  const n = N.vec3(field.g, N.sqrt(N.max(N.float(1).sub(field.g.mul(field.g)).sub(field.b.mul(field.b)), 0.001)), field.b);

  const toCam = base.sub(N.cameraPosition.xz);
  const d = N.length(toCam);
  // Grass where the meadow is: not on steep ground, sand, deep forest, or at the far edge.
  const clump = world.weatherNode.sample(base.div(61)).level(0).r;
  const slopeOK = N.smoothstep(0.86, 0.94, n.y);
  const landOK = N.smoothstep(9, 13, y).mul(N.float(1).sub(N.smoothstep(240, 330, y)));
  // Worn ground around the gate plinth, so the steps stay readable.
  const fromGate = N.abs(base.sub(N.vec2(world.gatePos.x, world.gatePos.z))).sub(N.vec2(38, 27));
  const worn = N.smoothstep(0, 16, N.max(fromGate.x, fromGate.y));
  const forestDim = N.mix(1, 0.32, N.smoothstep(0.25, 0.8, masks.r));
  const fadeOut = N.float(1).sub(N.smoothstep(outer * 0.72, outer, d));
  const fadeIn = inner > 0 ? N.smoothstep(inner * 0.72, inner, d) : N.float(1);
  // Culled instances collapse to a point; the rasteriser rejects them cheaply.
  const toView = N.normalize(N.vec3(toCam.x, y.sub(N.cameraPosition.y), toCam.y));
  const viewDirW = N.normalize(N.cameraWorldMatrix.mul(N.vec4(0, 0, -1, 0)).xyz);
  const inFront = N.smoothstep(-0.22, 0.1, toView.dot(viewDirW)).add(N.smoothstep(14, 6, d)).clamp(0, 1);
  const alive = worn.mul(slopeOK).mul(landOK).mul(fadeOut).mul(fadeIn).mul(inFront).mul(forestDim).mul(N.smoothstep(r3.mul(0.75), r3.mul(0.75).add(0.2), clump.mul(1.2).add(0.15)));

  // Wind: long travelling gusts plus a fast flutter unique to each blade.
  const t = world.time;
  const windDir = N.normalize(N.vec2(0.82, -0.57));
  const gustUV = base.mul(0.019).sub(windDir.mul(t.mul(0.11)));
  const gust = world.weatherNode.sample(gustUV).level(0).g;
  const gustB = world.weatherNode.sample(gustUV.mul(3.1).add(0.31)).level(0).b;
  const strength = N.smoothstep(0.24, 0.72, gust).mul(0.8).add(gustB.mul(0.25));
  const flutter = N.sin(t.mul(3.4).add(r1.mul(40)).add(base.x.mul(0.9))).mul(0.09);

  const height = N.mix(0.34, 1.0, r2.mul(r2)).mul(heightScale).mul(N.mix(0.55, 1.28, clump)).mul(alive);
  const width = N.mix(0.016, 0.03, r1).mul(widthScale).mul(alive.min(1));
  const yaw = r1.mul(Math.PI * 2);
  const facing = N.vec2(N.cos(yaw), N.sin(yaw));
  const side = N.vec2(facing.y.negate(), facing.x);

  // Quadratic bend, tilted downwind; the camera parts the meadow as it passes.
  const v = N.positionLocal.y;
  const u = N.positionLocal.x;
  const pushDir = N.normalize(toCam.add(0.001));
  const nearCam = N.smoothstep(7, 0.8, d).mul(N.smoothstep(7, 1.5, N.cameraPosition.y.sub(y)));
  const lean = windDir.mul(strength.mul(0.85).add(flutter)).add(facing.mul(N.mix(0.12, 0.6, r3))).add(pushDir.mul(nearCam.mul(1.5)));
  const bend = v.mul(v);
  const horizontal = lean.mul(bend).mul(height);
  const rise = N.sqrt(N.max(N.float(1).sub(lean.dot(lean).mul(0.42)), 0.08)).mul(height).mul(v);
  const taper = N.float(1).sub(v.mul(v).mul(v).mul(0.96)).mul(N.smoothstep(0, 0.06, v).mul(0.5).add(0.5));
  // Far layers widen so their total coverage stays constant as blades thin out.
  const offs = side.mul(u.mul(width).mul(taper));
  const world3 = N.vec3(base.x.add(horizontal.x).add(offs.x), y.add(rise).sub(0.04), base.y.add(horizontal.y).add(offs.y));

  const vis = N.varying(field.a.mul(world.cloudShadow(base)), "vGrassVis");
  const shade = N.varying(N.vec4(r1, r2, clump, N.max(strength, 0)), "vGrassShade");
  const blade = N.varying(v, "vGrassV");
  const edge = N.varying(u, "vGrassU");
  const curveN = N.normalize(N.vec3(lean.x.mul(-1.4).mul(v).add(facing.x.mul(0.7)), 1, lean.y.mul(-1.4).mul(v).add(facing.y.mul(0.7))));
  // Normals lean to the terrain for a soft, unified field at distance.
  const groundMix = N.smoothstep(6, 70, d).mul(0.75).add(0.15);
  const nW = N.varying(N.normalize(N.mix(curveN, n, groundMix)), "vGrassN");
  const flowerTip = N.varying(N.smoothstep(0.985, 1, r3).mul(flowers ? 0 : 1), "vGrassF");

  const mat = new LitStandard({ side: T.DoubleSide }, {
    visibility: vis,
    translucency: N.mix(N.float(0.2), N.float(1.15), blade),
    tint: N.vec3(0.5, 0.56, 0.09),
    diffuseOnly: true,
  });
  mat.name = flowers ? "Flowers" : "Grass";
  mat.positionNode = world3;
  mat.normalNode = N.transformNormalToView(N.normalize(nW));
  mat.colorNode = N.Fn(() => {
    const root = N.vec3(0.045, 0.07, 0.016);
    const mid = N.mix(N.vec3(0.035, 0.085, 0.022), N.vec3(0.08, 0.115, 0.026), shade.z);
    const tip = N.mix(N.vec3(0.055, 0.14, 0.03), N.vec3(0.17, 0.2, 0.05), shade.x.mul(0.55).add(shade.z.mul(0.5)));
    const base2 = N.mix(N.mix(root, mid, N.smoothstep(0, 0.5, blade)), tip, N.smoothstep(0.42, 1, blade));
    // A central vein catches light.
    const vein = N.smoothstep(0.75, 0, N.abs(edge)).mul(0.14).add(0.92);
    // Blades converge on the terrain far colour so the layers melt together.
    const far = N.smoothstep(26, 150, N.length(N.positionWorld.sub(N.cameraPosition)));
    return N.mix(base2.mul(vein), N.mix(N.vec3(0.04, 0.09, 0.022), N.vec3(0.13, 0.15, 0.035), shade.z), far);
  })();
  mat.roughnessNode = N.float(0.8);
  mat.metalnessNode = N.float(0);
  mat.aoNode = N.mix(N.float(0.35), N.float(1), N.smoothstep(0, 0.6, blade));

  const mesh = new T.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = mat.name;
  return {
    mesh,
    update(camera) {
      anchor.value.set(Math.floor(camera.position.x / spacing), Math.floor(camera.position.z / spacing));
      camY.value = camera.position.y;
    },
  };
}

export function createGrass(world, sky, q) {
  const near = layer(world, sky, { count: q.grassNear, spacing: 0.085, segments: 6, widthScale: 1.25, heightScale: 0.86, inner: 0, outer: 46 });
  const mid = layer(world, sky, { count: q.grassMid, spacing: 0.34, segments: 3, widthScale: 2.1, heightScale: 0.9, inner: 38, outer: 215 });
  const group = new T.Group();
  group.add(near.mesh, mid.mesh);
  return { group, update(camera) { near.update(camera); mid.update(camera); } };
}

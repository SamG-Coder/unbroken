import * as T from "three/webgpu";
import * as N from "three/tsl";
import { storage2D, dispatch, buildMips, NOISE_WGSL } from "./gpu.js";
import { LitStandard } from "./lighting.js";

// A forest grown once at load. Three broadleaf forms and a conifer are built
// from recursive limbs, each in three detail levels. Instances are bucketed into
// 120 m tiles so frustum culling works, and detail follows the camera's route.

const LEAF_WGSL = /* wgsl */ `
${NOISE_WGSL}
@group(0) @binding(0) var out: texture_storage_2d<rgba8unorm, write>;
const SIZE = 1024.0;
// Leaf spray: many small overlapping pointed leaves. rg = tangent normal, b = shade, a = coverage.
fn leaf(p: vec2f, c: vec2f, ang: f32, s: f32) -> vec4f {
  let d = p - c; let ca = cos(ang); let sa = sin(ang);
  let q = vec2f(ca * d.x + sa * d.y, -sa * d.x + ca * d.y) / s;
  let w = 0.34 * (1.0 - q.x * q.x) * (0.85 + 0.15 * q.x);
  let inside = smoothstep(0.0, 0.03, w - abs(q.y)) * step(abs(q.x), 1.0);
  let vein = smoothstep(0.03, 0.0, abs(q.y)) * 0.2 + 0.05 * sin(q.x * 40.0 + abs(q.y) * 30.0);
  return vec4f(q.y * 1.2 * ca - q.x * 0.4 * sa, q.y * 1.2 * sa + q.x * 0.4 * ca, vein, inside);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let uv = (vec2f(id.xy) + 0.5) / SIZE;
  // Atlas split into 2x2 spray variants.
  let cell = floor(uv * 2.0);
  let p = fract(uv * 2.0) * 2.0 - 1.0;
  var n = vec2f(0); var shade = 0.0; var a = 0.0;
  let seed = cell.x + cell.y * 2.0 + 1.0;
  for (var i = 0; i < 90; i++) {
    let f = f32(i);
    let h = hash22(vec2f(f, seed * 7.3));
    let r = sqrt(h.x) * 0.84;
    let th = h.y * 6.2831;
    let c = vec2f(cos(th), sin(th)) * r;
    let l = leaf(p, c, hash12(vec2f(f, seed)) * 6.2831 + th, 0.12 + 0.09 * hash12(vec2f(seed, f)));
    if (l.a > 0.5) {
      n = l.xy;
      shade = 0.46 + 0.54 * hash12(vec2f(f * 3.1, seed)) + l.z;
      a = 1.0;
    }
  }
  textureStore(out, vec2i(id.xy), vec4f(n * 0.5 + 0.5, shade, a));
}
`;

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const v3 = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);

// Limbs are tapered tubes; tips receive foliage sprays.
function growTree(kind, seed, lod) {
  const r = rng(seed);
  const barkPos = [], barkNrm = [], barkUV = [], barkIdx = [];
  const tips = [];
  const conifer = kind === 3;
  const H = conifer ? 25 + r() * 7 : 15 + r() * 5;
  const sides = lod === 0 ? 9 : lod === 1 ? 5 : 3;
  const seg = lod === 0 ? 6 : lod === 1 ? 3 : lod === 2 ? 2 : 1;

  function limb(start, dir, len, rad, depth, parentUp) {
    const points = [];
    let p = start.clone(), d = dir.clone().normalize();
    const gravity = conifer ? -0.03 : 0.015 * (depth - 1);
    for (let i = 0; i <= seg; i++) {
      points.push({ p: p.clone(), d: d.clone(), r: rad * Math.pow(1 - (i / seg) * 0.72, 1.1) });
      d.add(v3((r() - 0.5) * 0.38, gravity + (depth === 0 ? 0.03 : 0.1 * (conifer ? 0 : 1)), (r() - 0.5) * 0.38)).normalize();
      p.addScaledVector(d, len / seg);
    }
    const base = barkPos.length / 3;
    const up = Math.abs(dir.y) > 0.9 ? v3(1, 0, 0) : v3(0, 1, 0);
    for (let i = 0; i <= seg; i++) {
      const q = points[i];
      const X = up.clone().cross(q.d).normalize();
      const Y = q.d.clone().cross(X).normalize();
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2;
        const lobes = depth === 0 ? 1 + 0.12 * Math.sin(a * 5 + seed) + (i === 0 ? 0.42 * Math.pow(Math.max(0, Math.sin(a * 3 + seed)), 2) : 0) : 1;
        const n = X.clone().multiplyScalar(Math.cos(a)).addScaledVector(Y, Math.sin(a));
        barkPos.push(q.p.x + n.x * q.r * lobes, q.p.y + n.y * q.r * lobes, q.p.z + n.z * q.r * lobes);
        barkNrm.push(n.x, n.y, n.z);
        barkUV.push(k / sides, i * 0.22 * len);
      }
    }
    for (let i = 0; i < seg; i++) for (let k = 0; k < sides; k++) {
      const a = base + i * sides + k, b = base + i * sides + (k + 1) % sides;
      const c = a + sides, e = b + sides;
      barkIdx.push(a, c, b, b, c, e);
    }
    const maxDepth = lod === 3 ? 1 : conifer ? 2 : 4 - (lod === 2 ? 2 : lod === 1 ? 1 : 0);
    if (depth >= maxDepth) {
      tips.push({ p: points[seg].p.clone(), d: points[seg].d.clone(), size: conifer ? 1.2 : 1.9 });
      tips.push({ p: points[seg - 1].p.clone(), d: points[seg - 1].d.clone(), size: conifer ? 1.1 : 1.5 });
      return;
    }
    const count = conifer ? (depth === 0 ? (lod === 0 ? 34 : lod === 3 ? 6 : 18) : 3) : depth === 0 ? 5 : 3;
    for (let c = 0; c < count; c++) {
      const u = conifer && depth === 0 ? 0.16 + (c / count) * 0.84 : 0.4 + 0.6 * r();
      const f = Math.min(seg, Math.floor(u * seg));
      const q = points[f];
      const az = (c / count) * Math.PI * 2 * (conifer ? 5.3 : 1) + r() * 1.2;
      const out = v3(Math.cos(az), 0, Math.sin(az));
      const ndir = q.d.clone().multiplyScalar(conifer ? 0.0 : 0.55).add(out).add(v3(0, conifer ? -0.12 - 0.1 * (1 - u) : 0.52, 0)).normalize();
      const nlen = conifer ? len * 0.36 * (1.05 - u) + 0.8 : len * (0.56 + r() * 0.24);
      const nrad = Math.max(0.02, q.r * (conifer ? 0.2 : 0.58));
      limb(q.p, ndir, nlen, nrad, depth + 1, q.d);
    }
  }
  const trunkLen = conifer ? H : H * 0.42;
  limb(v3(0, -0.5, 0), v3(0, 1, 0), trunkLen, conifer ? 0.52 + r() * 0.15 : 0.72 + r() * 0.28, 0);

  // Foliage: sprays on every limb tip at full detail; further away, fewer and larger
  // sprays fill the same crown volume. Normals blow out from the crown centre, so
  // the canopy lights as one soft volume instead of as flat cards.
  const center = v3(), lo = v3(1e9, 1e9, 1e9), hi = v3(-1e9, -1e9, -1e9);
  tips.forEach((t) => { center.add(t.p); lo.min(t.p); hi.max(t.p); });
  center.multiplyScalar(1 / Math.max(1, tips.length));
  const radius = hi.clone().sub(lo).multiplyScalar(0.5);
  const leafPos = [], leafNrm = [], leafUV = [], leafIdx = [], leafAux = [];
  const addCard = (at, dirIn, s) => {
    const dir = dirIn.clone().add(v3(r() - 0.5, (r() - 0.5) * 0.6, r() - 0.5)).normalize();
    const A = v3(r() - 0.5, r() - 0.5, r() - 0.5).cross(dir).normalize();
    const B = dir.clone().cross(A).normalize();
    const crown = at.clone().sub(center).divide(radius.clone().addScalar(0.5)).normalize();
    const n = crown.multiplyScalar(0.9).add(v3(0, 0.4, 0)).normalize();
    const atlas = [Math.floor(r() * 2) / 2, Math.floor(r() * 2) / 2];
    const base = leafPos.length / 3;
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const P = at.clone().addScaledVector(A, x * s).addScaledVector(B, y * s);
      leafPos.push(P.x, P.y, P.z);
      leafNrm.push(n.x, n.y, n.z);
      leafUV.push(atlas[0] + (x * 0.5 + 0.5) * 0.5, atlas[1] + (y * 0.5 + 0.5) * 0.5);
      leafAux.push(Math.min(1, at.y / (H * 1.05)), r());
    }
    leafIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  if (lod === 0) {
    for (const t of tips) for (let c = 0; c < 4; c++) {
      const off = v3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(1.5);
      addCard(t.p.clone().add(off), t.d, t.size * (0.5 + r() * 0.4));
    }
  } else {
    const count = lod === 1 ? 170 : lod === 2 ? 44 : 12;
    const size = (conifer ? 1.25 : 1.75) * (lod === 1 ? 1.6 : lod === 2 ? 2.6 : 4.4);
    for (let i = 0; i < count; i++) {
      // Shell-biased samples in the crown; conifers narrow towards the top.
      const t = tips[Math.floor(r() * tips.length)];
      const at = t.p.clone().add(v3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(lod === 1 ? 2.4 : lod === 2 ? 3 : 5));
      addCard(at, t.d, size * (0.8 + r() * 0.45));
    }
  }
  const bark = new T.BufferGeometry();
  bark.setAttribute("position", new T.Float32BufferAttribute(barkPos, 3));
  bark.setAttribute("normal", new T.Float32BufferAttribute(barkNrm, 3));
  bark.setAttribute("uv", new T.Float32BufferAttribute(barkUV, 2));
  bark.setIndex(barkIdx);
  const leaves = new T.BufferGeometry();
  leaves.setAttribute("position", new T.Float32BufferAttribute(leafPos, 3));
  leaves.setAttribute("normal", new T.Float32BufferAttribute(leafNrm, 3));
  leaves.setAttribute("uv", new T.Float32BufferAttribute(leafUV, 2));
  leaves.setAttribute("aux", new T.Float32BufferAttribute(leafAux, 2));
  leaves.setIndex(leafIdx);
  return { bark, leaves };
}

// Distance from a point to the camera's ground route, used to pick tree detail.
function routeDistance(route, x, z) {
  let best = 1e9;
  for (let i = 0; i < route.length - 1; i++) {
    const [ax, az] = route[i], [bx, bz] = route[i + 1];
    const dx = bx - ax, dz = bz - az;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - dx * u, z - az - dz * u));
  }
  return best;
}

export function createForest(renderer, world, tiles, { route, density = 1 }) {
  const atlas = storage2D(renderer, 1024, { mips: true, name: "leaf atlas" });
  dispatch(renderer, LEAF_WGSL, [atlas.gpu.createView({ baseMipLevel: 0, mipLevelCount: 1 })], [128, 128], "leaf atlas");
  buildMips(renderer, atlas);
  const leafTex = N.texture(atlas.texture);

  const time = world.time;
  const instColor = N.varying(N.attribute("instanceColor", "vec3"), "vTreeTint");

  // Sway: whole tree in long gusts, branch tips in a faster flutter.
  const swayed = (flutter) => N.Fn(() => {
    const p = N.positionLocal;
    const inst = N.modelWorldMatrix;
    const w = N.vec3(N.attribute("instancePosition", "vec3"));
    const phase = w.x.mul(0.031).add(w.z.mul(0.027));
    const hNorm = N.max(p.y, 0).div(20);
    const big = N.sin(time.mul(0.9).add(phase)).mul(0.14).add(N.sin(time.mul(0.37).add(phase.mul(1.7))).mul(0.17));
    let disp = N.vec3(big.mul(hNorm).mul(hNorm).mul(2.4), 0, big.mul(hNorm).mul(hNorm).mul(-1.5));
    if (flutter) {
      const a = N.attribute("aux", "vec2");
      const f = N.sin(time.mul(2.7).add(a.y.mul(22)).add(phase.mul(4))).mul(0.06).add(N.sin(time.mul(5.3).add(a.y.mul(51))).mul(0.03));
      disp = disp.add(N.vec3(f, f.mul(0.6), f.negate().mul(0.8)));
    }
    return p.add(disp);
  })();

  const instVis = N.attribute("instanceVis", "float");
  const vis = N.varying(instVis, "vTreeVis");

  const barkMat = new LitStandard({ side: T.FrontSide }, { visibility: vis });
  barkMat.name = "Bark";
  barkMat.positionNode = swayed(false);
  const bu = N.uv().mul(N.vec2(2.0, 0.45));
  const barkS = tiles.rock.sample(bu);
  const barkS2 = tiles.rock.sample(bu.mul(N.vec2(3.1, 1.4)));
  const ridged = barkS.b.mul(0.65).add(barkS2.b.mul(0.35));
  barkMat.colorNode = N.mix(N.vec3(0.035, 0.026, 0.019), N.vec3(0.27, 0.2, 0.15), ridged.pow(1.2)).mul(instColor.mul(0.5).add(0.6));
  barkMat.roughnessNode = N.float(0.92);
  barkMat.metalnessNode = N.float(0);
  const bn = barkS.xy.mul(2).sub(1).add(barkS2.xy.mul(2).sub(1).mul(0.6));
  barkMat.normalNode = N.normalize(N.normalView.add(N.tangentView ? N.vec3(0) : N.vec3(0)).add(N.cameraViewMatrix.mul(N.vec4(bn.x.mul(0.7), bn.y.mul(0.7), bn.x.mul(-0.5), 0)).xyz));

  const leafS = leafTex.sample(N.uv());
  const alpha = leafS.a;
  const leafMat = new LitStandard({ side: T.DoubleSide, alphaTest: 0.5 }, {
    visibility: vis,
    translucency: N.float(0.42).mul(leafS.b.add(0.3)),
    tint: N.vec3(0.5, 0.48, 0.05),
    diffuseOnly: true,
  });
  leafMat.name = "Leaves";
  leafMat.positionNode = swayed(true);
  leafMat.alphaTestNode = N.mix(N.float(0.5), N.float(0.1), N.smoothstep(30, 320, N.length(N.positionWorld.sub(N.cameraPosition))));
  leafMat.opacityNode = alpha;
  leafMat.maskShadowNode = alpha.greaterThan(0.5);
  const aux = N.varying(N.attribute("aux", "vec2"), "vLeafAux");
  leafMat.colorNode = N.Fn(() => {
    const sh = leafS.b;
    const low = N.vec3(0.035, 0.065, 0.024);
    const hi = N.mix(N.vec3(0.085, 0.17, 0.03), N.vec3(0.2, 0.25, 0.04), aux.y);
    const crown = N.smoothstep(0.15, 1, aux.x);
    return N.mix(low, hi, crown.mul(0.8).add(0.2)).mul(sh.add(0.28)).mul(instColor.mul(1.05));
  })();
  leafMat.roughnessNode = N.float(0.9);
  leafMat.metalnessNode = N.float(0);
  leafMat.normalNode = N.normalize(N.normalView.add(N.cameraViewMatrix.mul(N.vec4(leafS.x.sub(0.5).mul(0.9), 0, leafS.y.sub(0.5).mul(0.9), 0)).xyz));
  leafMat.aoNode = N.mix(N.float(0.55), N.float(1), N.smoothstep(0.08, 0.9, aux.x));

  // Species: 3 broadleaf, 1 conifer, 3 detail levels each.
  const KINDS = 4;
  const protos = [];
  for (let k = 0; k < KINDS; k++) {
    protos.push([0, 1, 2, 3].map((lod) => growTree(k, 1000 + k * 73, lod)));
  }

  // Poisson-ish placement on a jittered grid, from the baked forest mask.
  const r = rng(77);
  const CELL_NEAR = 8.5, TILE = 120;
  const buckets = new Map();
  let total = 0;
  const addTree = (x, z, kind, scale, yaw) => {
    const d = routeDistance(route, x, z);
    const lod = d < 150 ? 0 : d < 520 ? 1 : 2;
    const key = `${kind}|${lod}|${Math.floor(x / TILE)}|${Math.floor(z / TILE)}`;
    if (!buckets.has(key)) buckets.set(key, { kind, lod, items: [] });
    const f = world.normalCPU(x, z);
    buckets.get(key).items.push({ x, y: world.heightCPU(x, z), z, scale, yaw, vis: f[2], tint: r() });
    total++;
  };
  for (let gz = -700; gz < 1800; gz += CELL_NEAR) {
    for (let gx = -1500; gx < 1500; gx += CELL_NEAR) {
      const x = gx + (r() - 0.5) * CELL_NEAR * 0.92, z = gz + (r() - 0.5) * CELL_NEAR * 0.92;
      const d = routeDistance(route, x, z);
      // Thin the far forest hard; keep it dense around the route.
      const keep = d < 150 ? 1 : d < 520 ? 0.55 : 0.2;
      if (r() > keep * density) continue;
      const m = world.maskCPU(x, z, 0);
      if (m < 0.35 || r() > m * m * 1.4) continue;
      const y = world.heightCPU(x, z);
      if (y > 150) continue;
      if (d < 17 || (d < 38 && r() < 0.5)) continue; // the camera corridor, thinned so light reaches the floor
      const conifer = y > 130 || r() < 0.14 ? 3 : Math.floor(r() * 3);
      const big = conifer === 3 ? 0.85 + r() * 0.55 : 0.8 + r() * 0.7;
      addTree(x, z, conifer, big * (1 + Math.max(0, 1 - d / 60) * 0.25), r() * Math.PI * 2);
    }
  }

  const group = new T.Group();
  group.name = "Forest";
  const counts = { trees: total, tris: 0 };
  const dummy = new T.Object3D();
  const tiles3 = [];
  for (const b of buckets.values()) {
    const count = b.items.length;
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3), visA = new Float32Array(count);
    const matA = new Float32Array(count * 16);
    let cx = 0, cz = 0, cy = 0;
    b.items.forEach((it, i) => {
      dummy.position.set(it.x, it.y - 0.15, it.z);
      dummy.rotation.set(0, it.yaw, 0);
      dummy.scale.setScalar(it.scale);
      dummy.updateMatrix();
      dummy.matrix.toArray(matA, i * 16);
      pos.set([it.x, it.y, it.z], i * 3);
      const warm = it.tint;
      col.set([0.82 + warm * 0.46, 0.92 + warm * 0.16, 0.72 + (1 - warm) * 0.3], i * 3);
      visA[i] = it.vis;
      cx += it.x; cy += it.y; cz += it.z;
    });
    const matrices = new T.InstancedBufferAttribute(matA, 16);
    const attrPos = new T.InstancedBufferAttribute(pos, 3), attrCol = new T.InstancedBufferAttribute(col, 3), attrVis = new T.InstancedBufferAttribute(visA, 1);
    const make = (src, mat, native) => {
      const g = src.clone();
      g.setAttribute("instancePosition", attrPos);
      g.setAttribute("instanceColor", attrCol);
      g.setAttribute("instanceVis", attrVis);
      const mesh = new T.InstancedMesh(g, mat, count);
      mesh.instanceMatrix = matrices;
      mesh.instanceColor = null;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      mesh.visible = false;
      group.add(mesh);
      return mesh;
    };
    const levels = {};
    for (const l of new Set([b.lod, 2, 3])) levels[l] = [make(protos[b.kind][l].bark, barkMat), make(protos[b.kind][l].leaves, leafMat)];
    counts.tris += (protos[b.kind][b.lod].leaves.index.count / 3 + protos[b.kind][b.lod].bark.index.count / 3) * count;
    tiles3.push({ native: b.lod, levels, x: cx / count, y: cy / count, z: cz / count, active: -1 });
  }
  // Detail follows the camera each frame; only nearby tiles draw into the shadow map.
  function update(camera, shadowReach = 420) {
    const p = camera.position;
    for (const tile of tiles3) {
      const d = Math.hypot(tile.x - p.x, tile.y - p.y, tile.z - p.z);
      const want = d < 520 ? tile.native : d < 1250 ? Math.max(tile.native, 2) : 3;
      if (want !== tile.active) {
        if (tile.active >= 0) for (const m of tile.levels[tile.active]) m.visible = false;
        for (const m of tile.levels[want]) m.visible = true;
        tile.active = want;
      }
      const cast = d < shadowReach && want <= 1;
      for (const m of tile.levels[want]) m.castShadow = cast;
    }
  }
  return { group, counts, update };
}

import * as T from "three/webgpu";
import * as N from "three/tsl";
import { storage2D, dispatch, buildMips, NOISE_WGSL } from "./gpu.js";
import { LitStandard } from "./lighting.js";

// Geometry clipmap over the baked island. Materials are triplanar rock, soil,
// sand and snow, all from tile textures baked on the GPU at load.
const GRID = 128, LEVELS = 9, BASE_CELL = 0.5;

const TILES_WGSL = /* wgsl */ `
${NOISE_WGSL}
@group(0) @binding(0) var rock: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var soil: texture_storage_2d<rgba8unorm, write>;
const SIZE = 1024.0;
fn thash(p: vec2f, per: f32) -> f32 { return hash12(((p % per) + per) % per); }
fn tnoise(p: vec2f, per: f32) -> f32 {
  let i = floor(p); let f = p - i; let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(thash(i, per), thash(i + vec2f(1, 0), per), u.x), mix(thash(i + vec2f(0, 1), per), thash(i + vec2f(1, 1), per), u.x), u.y);
}
fn tcell(p: vec2f, per: f32) -> vec2f {
  let i = floor(p); let f = p - i; var d1 = 9.0; var d2 = 9.0;
  for (var y = -1.0; y <= 1.0; y += 1.0) { for (var x = -1.0; x <= 1.0; x += 1.0) {
    let o = vec2f(x, y);
    let c = hash22((((i + o) % per) + per) % per);
    let d = length(o + c - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  } }
  return vec2f(d1, d2);
}
fn rockH(uv: vec2f) -> f32 {
  var s = 0.0; var a = 0.5; var per = 6.0;
  let w = vec2f(tnoise(uv * 8.0, 8.0), tnoise(uv * 8.0 + 3.7, 8.0)) * 0.08;
  for (var i = 0; i < 7; i++) {
    let n = 1.0 - abs(tnoise((uv + w) * per, per) * 2.0 - 1.0);
    s += a * n * n; per *= 2.0; a *= 0.55;
  }
  let c = tcell((uv + w) * 7.0, 7.0);
  let crack = smoothstep(0.0, 0.09, c.y - c.x);
  let c2 = tcell((uv + w * 1.4) * 19.0, 19.0);
  return s * 0.72 * (0.45 + 0.55 * crack) * (0.8 + 0.2 * smoothstep(0.0, 0.07, c2.y - c2.x)) + 0.06 * crack;
}
fn soilH(uv: vec2f) -> f32 {
  var s = 0.0; var a = 0.5; var per = 16.0;
  for (var i = 0; i < 6; i++) { s += a * tnoise(uv * per, per); per *= 2.0; a *= 0.6; }
  let pebbles = tcell(uv * 44.0, 44.0);
  let p = smoothstep(0.34, 0.1, pebbles.x) * step(0.72, hash12(floor(uv * 44.0)));
  return s * 0.8 + p * 0.24;
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let uv = (vec2f(id.xy) + 0.5) / SIZE;
  let e = 1.0 / SIZE;
  let h = rockH(uv);
  let nr = vec2f(rockH(uv + vec2f(e, 0)) - rockH(uv - vec2f(e, 0)), rockH(uv + vec2f(0, e)) - rockH(uv - vec2f(0, e))) * 34.0;
  textureStore(rock, vec2i(id.xy), vec4f(clamp(nr * 0.5 + 0.5, vec2f(0), vec2f(1)), h, tnoise(uv * 5.0, 5.0)));
  let g = soilH(uv);
  let ng = vec2f(soilH(uv + vec2f(e, 0)) - soilH(uv - vec2f(e, 0)), soilH(uv + vec2f(0, e)) - soilH(uv - vec2f(0, e))) * 28.0;
  textureStore(soil, vec2i(id.xy), vec4f(clamp(ng * 0.5 + 0.5, vec2f(0), vec2f(1)), g, tnoise(uv * 9.0 + 1.3, 9.0)));
}
`;

export function bakeTiles(renderer) {
  const rock = storage2D(renderer, 1024, { mips: true, name: "rock tile" });
  const soil = storage2D(renderer, 1024, { mips: true, name: "soil tile" });
  dispatch(renderer, TILES_WGSL, [rock.gpu.createView({ baseMipLevel: 0, mipLevelCount: 1 }), soil.gpu.createView({ baseMipLevel: 0, mipLevelCount: 1 })], [128, 128], "tiles");
  buildMips(renderer, rock);
  buildMips(renderer, soil);
  return { rock: N.texture(rock.texture), soil: N.texture(soil.texture) };
}

function clipGrid() {
  const n = GRID + 1, pos = new Float32Array(n * n * 3), idx = new Uint32Array(GRID * GRID * 6);
  for (let z = 0, k = 0; z < n; z++) for (let x = 0; x < n; x++, k += 3) { pos[k] = x - GRID / 2; pos[k + 2] = z - GRID / 2; }
  for (let z = 0, k = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
    const a = z * n + x, b = a + 1, c = a + n, d = c + 1;
    idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.BufferAttribute(pos, 3));
  g.setAttribute("normal", new T.BufferAttribute(new Float32Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(new T.BufferAttribute(idx, 1));
  return g;
}

export const GRASS_COLORS = {
  root: [0.05, 0.075, 0.018],
  mid: [0.17, 0.21, 0.04],
  tip: [0.42, 0.4, 0.11],
};

export function createTerrain(world, tiles) {
  const cell = N.uniform(1).onObjectUpdate(({ object }) => object.userData.cell);
  const origin = N.uniform(new T.Vector2()).onObjectUpdate(({ object }) => object.userData.origin);
  const hole = N.uniform(new T.Vector4()).onObjectUpdate(({ object }) => object.userData.hole);

  const lat = N.positionLocal.xz;
  const edge = N.max(N.abs(lat.x), N.abs(lat.y)).div(GRID / 2);
  const morph = N.smoothstep(0.74, 1, edge);
  const morphed = lat.sub(N.fract(lat.mul(0.5)).mul(2).mul(morph));
  const wp = origin.add(morphed.mul(cell));
  const vW = N.varying(wp, "vTerrainXZ");

  const vis = world.fieldAt(vW).a.mul(world.cloudShadow(vW));

  const mat = new LitStandard({ side: T.FrontSide }, { visibility: vis, diffuseOnly: true });
  mat.name = "Terrain";
  mat.positionNode = N.vec3(wp.x, world.heightAt(wp), wp.y);

  const f = world.fieldAt(vW);
  const m = world.masksAt(vW);
  const py = f.r;
  const ny = N.sqrt(N.max(N.float(1).sub(f.g.mul(f.g)).sub(f.b.mul(f.b)), 0.0001));
  const geo = N.normalize(N.vec3(f.g, ny, f.b));
  const P = N.vec3(vW.x, py, vW.y);
  const dist = N.length(N.cameraPosition.sub(P));
  const near = N.float(1).sub(N.smoothstep(40, 240, dist));
  const w = N.pow(N.abs(geo), N.vec3(4));
  const wn = w.div(w.x.add(w.y).add(w.z));
  const rs = (s) => {
    const a = tiles.rock.sample(P.zy.div(s));
    const b = tiles.rock.sample(P.xz.div(s));
    const c = tiles.rock.sample(P.xy.div(s));
    return { col: a.mul(wn.x).add(b.mul(wn.y)).add(c.mul(wn.z)), a, b, c };
  };
  const r1 = rs(9.0);
  const r2 = rs(61.0);
  const rockH = r1.col.b.mul(0.6).add(r2.col.b.mul(0.4));
  const nFromTri = (a, b, c, strength) => {
    const ta = a.xy.mul(2).sub(1).mul(strength);
    const tb = b.xy.mul(2).sub(1).mul(strength);
    const tc = c.xy.mul(2).sub(1).mul(strength);
    const nx = N.vec3(geo.x, ta.y.add(geo.y), ta.x.add(geo.z));
    const ny2 = N.vec3(tb.x.add(geo.x), geo.y, tb.y.add(geo.z));
    const nz = N.vec3(tc.x.add(geo.x), tc.y.add(geo.y), geo.z);
    return nx.mul(wn.x).add(ny2.mul(wn.y)).add(nz.mul(wn.z));
  };
  const detailFade = N.float(1).sub(N.smoothstep(120, 900, dist).mul(0.85));
  const rockN = N.normalize(nFromTri(r1.a, r1.b, r1.c, detailFade.mul(1.2)).add(nFromTri(r2.a, r2.b, r2.c, detailFade.mul(0.55))));
  const layer = py.mul(0.42).add(r2.col.a.mul(2.6));
  const band = N.sin(layer).mul(0.5).add(0.5).mul(N.sin(layer.mul(2.73)).mul(0.5).add(0.5));
  const rockBase = N.mix(N.vec3(0.075, 0.062, 0.052), N.vec3(0.36, 0.28, 0.2), band.mul(0.3).add(rockH.mul(0.9)));
  const mtn = N.smoothstep(150, 420, py);
  const rockCol = N.mix(rockBase, N.mix(N.vec3(0.05, 0.05, 0.058), N.vec3(0.2, 0.185, 0.19), rockH), mtn);
  const s1 = tiles.soil.sample(vW.div(5.5));
  const s2 = tiles.soil.sample(vW.div(37));
  const groundN = N.normalize(N.vec3(geo.x.add(s1.x.mul(2).sub(1).mul(0.9)).add(s2.x.mul(2).sub(1).mul(0.6)), geo.y, geo.z.add(s1.y.mul(2).sub(1).mul(0.9)).add(s2.y.mul(2).sub(1).mul(0.6))));
  const patch = tiles.soil.sample(vW.div(380)).a.mul(0.6).add(tiles.soil.sample(vW.div(97)).a.mul(0.4));
  const meadowCol = N.mix(N.vec3(0.04, 0.09, 0.02), N.vec3(0.13, 0.15, 0.035), N.smoothstep(0.32, 0.72, patch));
  const forestFloor = N.mix(N.vec3(0.05, 0.036, 0.022), N.vec3(0.095, 0.085, 0.03), s2.b);
  const bare = N.mix(N.vec3(0.1, 0.075, 0.05), N.vec3(0.26, 0.2, 0.13), s1.b);
  const ground = N.mix(N.mix(meadowCol, bare, near.mul(0.65).mul(N.smoothstep(0.55, 0.18, s2.b)).mul(0.5)), forestFloor, N.smoothstep(0.1, 0.55, m.r));
  const slope = N.float(1).sub(ny);
  const blend = N.smoothstep(0.1, 0.24, slope.add(rockH.sub(0.45).mul(0.18)));
  const sandMask = N.smoothstep(7.0, 3.4, py.add(s2.b.mul(2.4))).mul(N.smoothstep(0.42, 0.12, slope));
  const sand = N.mix(N.vec3(0.32, 0.27, 0.18), N.vec3(0.72, 0.6, 0.42), N.smoothstep(0.3, 2.6, py)).mul(s1.b.mul(0.34).add(0.78));
  const snow = N.smoothstep(540, 690, py.add(r2.col.a.mul(80))).mul(N.smoothstep(0.52, 0.26, slope));
  const colorFinal = N.mix(N.mix(N.mix(ground, rockCol, blend), sand, sandMask).mul(N.mix(0.42, 1, N.smoothstep(0.0, 3.5, py))), N.vec3(0.86, 0.87, 0.92), snow);
  const worldN = N.normalize(N.mix(N.mix(groundN, rockN, blend), geo, snow.mul(0.7)));

  mat.colorNode = N.Fn(() => {
    N.If(vW.x.greaterThan(hole.x).and(vW.x.lessThan(hole.z)).and(vW.y.greaterThan(hole.y)).and(vW.y.lessThan(hole.w)), () => { N.Discard(); });
    return colorFinal;
  })();
  mat.normalNode = N.transformNormalToView(worldN);
  mat.roughnessNode = N.mix(N.mix(0.95, 0.86, blend), 0.5, snow).sub(N.smoothstep(2.5, 0, py).mul(0.5));
  mat.metalnessNode = N.float(0);
  mat.aoNode = N.mix(N.float(1), rockH.mul(1.4).add(0.3).clamp(0, 1), blend).mul(N.smoothstep(0.82, 0.3, m.g).mul(0.72).add(0.28));

  const group = new T.Group();
  group.name = "Terrain";
  const geoGrid = clipGrid();
  const meshes = [];
  for (let i = 0; i < LEVELS; i++) {
    const mesh = new T.Mesh(geoGrid, mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.userData = { cell: BASE_CELL * 2 ** i, origin: new T.Vector2(), hole: new T.Vector4(1e9, 1e9, -1e9, -1e9) };
    group.add(mesh);
    meshes.push(mesh);
  }
  function update(camera) {
    let prev = null;
    for (let i = 0; i < LEVELS; i++) {
      const m = meshes[i];
      const c = m.userData.cell;
      const snap = c * 2;
      const ox = Math.round(camera.position.x / snap) * snap;
      const oz = Math.round(camera.position.z / snap) * snap;
      m.userData.origin.set(ox, oz);
      if (prev) {
        const half = (GRID / 2) * (c / 2);
        m.userData.hole.set(prev.x - half, prev.y - half, prev.x + half, prev.y + half);
      }
      prev = m.userData.origin;
    }
  }
  return { group, update };
}

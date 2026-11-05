import * as T from "three/webgpu";
import * as N from "three/tsl";
import { createOceanSimulation } from "./ocean-compute.js";

// Surface rendering around the ClearWater FFT simulation (ported from
// BakedVoxelLighting). A world-anchored clipmap, so waves never swim.
const GRID = 128, LEVELS = 13, BASE_CELL = 0.3;

function clipGrid() {
  const n = GRID + 1, pos = new Float32Array(n * n * 3), idx = new Uint32Array(GRID * GRID * 6);
  for (let z = 0, k = 0; z < n; z++) for (let x = 0; x < n; x++, k += 3) { pos[k] = x - GRID / 2; pos[k + 2] = z - GRID / 2; }
  for (let z = 0, k = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
    const a = z * n + x, b = a + 1, c = a + n, d = c + 1;
    idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.BufferAttribute(pos, 3));
  g.setIndex(new T.BufferAttribute(idx, 1));
  return g;
}

export function createOcean(renderer, sky, world, opts = {}) {
  const sim = createOceanSimulation(renderer, {
    significantHeight: 2.1, windSpeed: 11, windAngle: -1.75, swellAngle: -1.45, swellLength: 140, swellShare: 0.6, choppy: 1.15, ...opts,
  });
  const S = sim.sizes;
  const disp = sim.displacement.map((t) => N.texture(t));
  const slope = sim.derivatives.map((t) => N.texture(t));
  const caustic = N.texture(sim.caustics);
  const cell = N.uniform(1).onObjectUpdate(({ object }) => object.userData.cell);
  const origin = N.uniform(new T.Vector2()).onObjectUpdate(({ object }) => object.userData.origin);
  const hole = N.uniform(new T.Vector4()).onObjectUpdate(({ object }) => object.userData.hole);

  const mat = new T.MeshBasicNodeMaterial({ side: T.FrontSide });
  mat.name = "Ocean";
  const lat = N.positionLocal.xz;
  const edge = N.max(N.abs(lat.x), N.abs(lat.y)).div(GRID / 2);
  const morph = N.smoothstep(0.72, 1, edge);
  const morphed = lat.sub(N.fract(lat.mul(0.5)).mul(2).mul(morph));
  const wp = origin.add(morphed.mul(cell));
  // Waves die over the shallows: a depth-limited breaking cap on displacement.
  const vDepth = N.max(world.heightAt(wp).negate(), 0);
  const limit = N.clamp(vDepth.mul(0.3), 0.04, 1);
  let off = N.vec3(0);
  S.forEach((size, c) => {
    const lod = N.max(0, N.log2(cell.mul(morph.add(1)).div(size / 128)));
    off = off.add(disp[c].sample(wp.div(size)).level(lod).xyz.mul(c < 2 ? limit : 1));
  });
  const vW = N.varying(wp, "vOceanXZ");
  mat.positionNode = N.vec3(wp.x.add(off.x), off.y, wp.y.add(off.z));

  mat.colorNode = N.Fn(() => {
    const xz = vW;
    N.If(xz.x.greaterThan(hole.x).and(xz.x.lessThan(hole.z)).and(xz.y.greaterThan(hole.y)).and(xz.y.lessThan(hole.w)), () => { N.Discard(); });
    const p = N.positionWorld;
    const toEye = N.cameraPosition.sub(p);
    const t = N.length(toEye);
    const v = toEye.div(t);
    const bed = world.heightAt(xz);
    const depth = N.max(bed.negate(), 0.0);
    const lim = N.clamp(depth.mul(0.3), 0.04, 1);
    const w1 = N.float(1).sub(N.smoothstep(1400, 5200, t));
    const w2 = N.float(1).sub(N.smoothstep(90, 420, t));
    const s0 = slope[0].sample(xz.div(S[0])).mul(lim);
    const s1 = slope[1].sample(xz.div(S[1])).mul(w1).mul(lim);
    const s2 = slope[2].sample(xz.div(S[2])).mul(w2.mul(0.42));
    const s = s0.add(s1).add(s2);
    const stretch = N.max(N.vec2(1).add(s.zw), N.vec2(0.25));
    const raw = N.normalize(N.vec3(s.x.div(stretch.x).negate(), 1, s.y.div(stretch.y).negate()));
    const n = N.normalize(N.mix(raw, N.vec3(0, 1, 0), N.smoothstep(350, 5200, t).mul(0.62)));
    const nv = N.clamp(n.dot(v), 0.015, 1);
    const fg = N.float(1).sub(nv);
    const rough = N.float(0.09).add(N.smoothstep(40, 4200, t).mul(0.34));
    const fres = N.float(0.05).add(N.max(N.float(1).sub(rough), 0.0204).sub(0.0204).mul(fg.mul(fg).mul(fg).mul(fg).mul(fg)));
    const refl = N.reflect(v.negate(), n).toVar();
    refl.y.assign(N.abs(refl.y).add(0.1));
    const reflCol = sky.lut(refl.normalize());

    // Sun: GGX with roughness widened by distance gives the long glitter road.
    const l = sky.sun;
    const h = N.normalize(l.add(v));
    const nh = N.clamp(n.dot(h), 0, 1);
    const a2 = rough.mul(rough).mul(rough).mul(rough);
    const dn = nh.mul(nh).mul(a2.sub(1)).add(1);
    const ggx = a2.div(dn.mul(dn).mul(Math.PI));
    const nl = N.clamp(n.dot(l), 0, 1);
    const spec = ggx.mul(N.min(nl.mul(6).add(0.12), 1)).mul(fres.add(0.03)).mul(0.35);

    // Water body: deep navy to turquoise over shallows, lit from below by caustics.
    const shallow = N.exp(depth.mul(-0.1));
    const deep = N.mix(N.vec3(0.0075, 0.032, 0.058), N.vec3(0.012, 0.11, 0.115), shallow);
    const caust = caustic.sample(xz.div(sim.causticSize)).rgb;
    const bedTint = N.vec3(0.42, 0.34, 0.21).mul(caust.mul(0.9).add(0.25)).mul(N.exp(depth.mul(N.vec3(-0.46, -0.13, -0.09))));
    const lightAmt = N.clamp(l.y.mul(2.5).add(0.45), 0, 1);
    const body = deep.add(bedTint.mul(0.45)).mul(sky.sunColor.mul(1.2).add(0.42)).mul(lightAmt).toVar();

    // Crest subsurface: the sun glowing through thin backlit wave tops.
    const crestH = p.y.div(1.9);
    const back = N.pow(N.clamp(v.dot(l.negate().add(n.mul(0.6)).normalize()), 0, 1), 3.5);
    body.addAssign(N.vec3(0.05, 0.42, 0.33).mul(back.mul(N.smoothstep(-0.1, 1.2, crestH))).mul(sky.sunColor).mul(1.05));

    // Foam: Jacobian whitecaps, widened with a coarse mip so they read as lace.
    const fine = slope[1].sample(xz.div(S[1])).add(slope[0].sample(xz.div(S[0])));
    const wide = slope[1].sample(xz.div(S[1])).level(2.5).add(slope[0].sample(xz.div(S[0])).level(1.5));
    const jf = N.vec2(1).add(fine.zw);
    const jw = N.vec2(1).add(wide.zw);
    const J1 = jf.x.mul(jf.y);
    const J2 = jw.x.mul(jw.y);
    const lace = slope[2].sample(xz.div(S[2]).mul(0.73)).x.mul(0.8).add(0.5);
    const whitecap = N.smoothstep(0.62, 0.22, J1).mul(0.9).add(N.smoothstep(0.86, 0.52, J2).mul(0.4).mul(N.smoothstep(0.42, 0.72, lace)));
    // Surf: animated rings where the sea climbs the island.
    const shoreBand = N.smoothstep(14, 0.3, depth);
    const surfWave = N.sin(depth.mul(0.75).sub(world.time.mul(1.1)).add(xz.x.mul(0.012))).mul(0.5).add(0.5);
    const surfLace = N.smoothstep(0.34, 0.66, lace.add(surfWave.mul(0.42)).sub(0.2));
    const surf = shoreBand.mul(surfLace).mul(N.smoothstep(0.1, 0.9, surfWave).mul(0.6).add(N.smoothstep(4, 0.6, depth)));
    const foam = N.clamp(whitecap.add(surf), 0, 1).mul(N.float(1).sub(N.smoothstep(400, 2200, t).mul(0.85)));
    const foamLit = sky.sunColor.mul(N.max(nl, 0.15).mul(1.2)).add(sky.lut(N.vec3(0, 1, 0)).mul(1.0));

    const shade = world.cloudShadow(xz);
    const col = N.mix(body, reflCol, fres).add(sky.sunColor.mul(spec).mul(shade.mul(0.75).add(0.25).mul(26)));
    return N.vec4(N.mix(col, foamLit.mul(shade.mul(0.55).add(0.45)), foam.mul(0.92)), 1);
  })();

  const group = new T.Group();
  group.name = "Ocean";
  const geo = clipGrid();
  const meshes = [];
  for (let i = 0; i < LEVELS; i++) {
    const m = new T.Mesh(geo, mat);
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    m.userData = { cell: BASE_CELL * 2 ** i, origin: new T.Vector2(), hole: new T.Vector4(1e9, 1e9, -1e9, -1e9) };
    group.add(m);
    meshes.push(m);
  }
  function update(time, camera) {
    sim.update(time, sky.sun.value);
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
  return { group, update, sim };
}

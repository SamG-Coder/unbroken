import * as T from "three/webgpu";
import * as N from "three/tsl";
import { LitStandard } from "./lighting.js";

// The Last Gate: a colossal ring of 28 carved voussoirs on a stepped plinth,
// flanked by leaning monoliths. No imported mesh: every stone is built here,
// subdivided, then carved by displacement from the same rock tile as the cliffs.
export const GATE_RADIUS = 27;
const TUBE_R = 4.6;

function chiselBox(w, h, d, segs, jitter = 0.2, seed = 1) {
  const g = new T.BoxGeometry(w, h, d, segs, segs, segs);
  const p = g.attributes.position;
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const noise = (x, y, z) => {
    const s = Math.sin(x * 12.9 + y * 78.2 + z * 37.7 + seed) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // Chamfer the corners, as a worn hand-cut block would have.
    const c = 0.82;
    const ex = Math.abs(x) / hx, ey = Math.abs(y) / hy, ez = Math.abs(z) / hz;
    const k = Math.max(0, Math.max(ex, 0) + Math.max(ey, 0) + Math.max(ez, 0) - 2.3);
    const pull = 1 - k * (1 - c);
    x *= pull; y *= pull; z *= pull;
    const q = (noise(Math.round(x * 2), Math.round(y * 2), Math.round(z * 2)) - 0.5) * jitter;
    p.setXYZ(i, x + q, y + q * 0.6, z - q);
  }
  g.computeVertexNormals();
  return g;
}

export function createGate(world, sky, tiles, origin) {
  const group = new T.Group();
  group.name = "Gate";
  group.position.copy(origin);

  const glyphPulse = N.uniform(1);
  const rockMaterial = (scale, opts = {}) => {
    const P = N.positionWorld;
    const n0 = N.normalWorld;
    const w = N.pow(N.abs(n0), N.vec3(4));
    const wn = w.div(w.x.add(w.y).add(w.z));
    const tri = (s) => {
      const a = tiles.rock.sample(P.zy.div(s));
      const b = tiles.rock.sample(P.xz.div(s));
      const c = tiles.rock.sample(P.xy.div(s));
      return { col: a.mul(wn.x).add(b.mul(wn.y)).add(c.mul(wn.z)), a, b, c };
    };
    const t1 = tri(scale);
    const t2 = tri(scale * 0.21);
    const h = t1.col.b.mul(0.66).add(t2.col.b.mul(0.34));
    const nd = (t, k) => {
      const a = t.a.xy.mul(2).sub(1).mul(k), b = t.b.xy.mul(2).sub(1).mul(k), c = t.c.xy.mul(2).sub(1).mul(k);
      return N.vec3(0, a.y, a.x).mul(wn.x).add(N.vec3(b.x, 0, b.y).mul(wn.y)).add(N.vec3(c.x, c.y, 0).mul(wn.z));
    };
    const nW = N.normalize(n0.add(nd(t1, 1.25)).add(nd(t2, 0.9)));
    const up = nW.y;
    const stone = N.mix(N.vec3(0.11, 0.1, 0.09), N.vec3(0.42, 0.37, 0.3), h.mul(1.25).sub(0.1).clamp(0, 1));
    // Moss climbs on upward faces, with grey lichen patches.
    const mossAmt = N.smoothstep(0.32, 0.72, up.add(t2.col.a.mul(0.35)).sub(0.12));
    const moss = N.mix(N.vec3(0.05, 0.09, 0.02), N.vec3(0.15, 0.2, 0.04), t1.col.a);
    const lichen = N.smoothstep(0.62, 0.72, t2.col.a).mul(0.26);
    const m = new LitStandard({ side: T.FrontSide });
    m.colorNode = N.mix(N.mix(stone, N.vec3(0.45, 0.43, 0.36), lichen), moss, mossAmt);
    m.normalNode = N.transformNormalToView(nW);
    m.roughnessNode = N.mix(0.9, 1, mossAmt);
    m.metalnessNode = N.float(0);
    m.aoNode = h.mul(1.4).add(0.3).clamp(0, 1);
    return m;
  };
  const stoneMat = rockMaterial(5.5);
  const plinthMat = rockMaterial(7.5);

  // Ring voussoirs with carved glyph bands on the inner face.
  const SEGMENTS = 28;
  const ring = new T.Group();
  const rimPivot = new T.Vector3(0, GATE_RADIUS + 3.3, 0);
  ring.position.copy(rimPivot);
  for (let i = 0; i < SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    const arc = (Math.PI * 2 * (GATE_RADIUS + TUBE_R)) / SEGMENTS;
    const thick = TUBE_R * (i % 7 === 0 ? 2.5 : 2.0);
    const depth = i % 7 === 0 ? 9.2 : 7;
    const geo = chiselBox(arc * 0.97, thick, depth, 12, 0.14, i * 3.1);
    const m = new T.Mesh(geo, stoneMat);
    const radial = GATE_RADIUS + thick * 0.5;
    m.position.set(Math.cos(a) * radial, Math.sin(a) * radial, 0);
    m.rotation.z = a + Math.PI / 2;
    // Age: a few stones have slipped, which keeps the silhouette from being too perfect.
    if (i % 5 === 2) { m.position.z += 0.4; m.rotation.x = 0.012; m.rotation.y = 0.01; }
    m.castShadow = true;
    m.receiveShadow = true;
    ring.add(m);
  }
  group.add(ring);

  // Glyph band: emissive runes cut into the inner face, driven by a travelling pulse.
  const glyphGeo = new T.RingGeometry(GATE_RADIUS + 0.45, GATE_RADIUS + 1.9, 256, 1);
  const glyphMat = new T.MeshBasicNodeMaterial({ side: T.DoubleSide, transparent: true, depthWrite: false, blending: T.AdditiveBlending });
  const guv = N.uv();
  glyphMat.colorNode = N.Fn(() => {
    const p = N.positionLocal.xy;
    const ang = N.atan(p.y, p.x).div(Math.PI * 2).add(0.5);
    const rad = N.length(p).sub(GATE_RADIUS + 0.45).div(1.45);
    const cols = N.float(96);
    const cx = ang.mul(cols);
    const id = N.floor(cx);
    const fx = N.fract(cx).sub(0.5);
    const fy = rad.sub(0.5);
    const h = N.fract(N.sin(id.mul(12.9898)).mul(43758.5453));
    const h2 = N.fract(N.sin(id.mul(78.233)).mul(12543.31));
    // Rune: a vertical stroke plus an angled tick from a hash.
    const stroke = N.smoothstep(0.075, 0.04, N.abs(fx.sub(h.sub(0.5).mul(0.3))));
    const tick = N.smoothstep(0.05, 0.02, N.abs(fy.sub(fx.mul(h2.mul(1.6).sub(0.8))).sub(h.sub(0.5).mul(0.5))));
    const inBand = N.smoothstep(0.42, 0.34, N.abs(fy));
    const glyph = N.max(stroke, tick).mul(inBand);
    const sweep = N.pow(N.fract(ang.sub(world.time.mul(0.11))), 6).mul(3).add(0.38);
    return N.vec3(1.0, 0.44, 0.13).mul(glyph).mul(sweep).mul(1.1).mul(glyphPulse);
  })();
  const glyphFront = new T.Mesh(glyphGeo, glyphMat);
  glyphFront.position.copy(rimPivot);
  glyphFront.position.z = -3.55;
  group.add(glyphFront);
  const glyphBack = glyphFront.clone();
  glyphBack.position.z = 3.55;
  group.add(glyphBack);

  // Stepped plinth: four concentric tiers of cut stone, with gaps and sunken blocks.
  const steps = new T.Group();
  for (let tier = 0; tier < 4; tier++) {
    const width = 76 - tier * 13, depth = 54 - tier * 9, h = 1.15;
    const stones = 12 + tier * 2;
    const y = tier * h + h / 2 - 0.45;
    const sw = width / stones;
    for (let i = 0; i < stones; i++) {
      for (const side of [-1, 1]) {
        const geo = chiselBox(sw * 0.985, h, depth / 2 * 0.985, 5, 0.1, tier * 31 + i * 7 + side);
        const m = new T.Mesh(geo, plinthMat);
        const sink = (Math.sin(i * 12.3 + tier * 4.7 + side) * 0.5 + 0.5) * 0.26;
        m.position.set(-width / 2 + sw * (i + 0.5), y - sink, side * depth / 4);
        m.rotation.y = (Math.sin(i * 7.7 + tier) - 0.5) * 0.008;
        m.castShadow = true;
        m.receiveShadow = true;
        steps.add(m);
      }
    }
  }
  group.add(steps);

  // Leaning monoliths along the approach, with their own weathered caps.
  const monoSpots = [
    [-36, -56, 15, -0.05], [36, -56, 17, 0.04], [-46, -94, 12, 0.11], [46, -96, 13, -0.09],
    [-54, -22, 10, 0.16], [54, -18, 11, -0.13],
  ];
  monoSpots.forEach(([x, z, h, tilt], i) => {
    const geo = chiselBox(4.2, h, 3.1, 12, 0.22, 90 + i * 5);
    const m = new T.Mesh(geo, stoneMat);
    const groundY = world.heightCPU(origin.x + x, origin.z + z) - origin.y;
    m.position.set(x, groundY + h / 2 - 0.9, z);
    m.rotation.set(tilt * 0.4, i * 1.3, tilt);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  });

  // Portal disc: samples the rendered galaxy through the ring.
  const center = rimPivot.clone().add(origin);
  const portalMat = new T.MeshBasicNodeMaterial({ side: T.DoubleSide });
  portalMat.name = "Portal";
  const portal = new T.Mesh(new T.CircleGeometry(GATE_RADIUS + 0.3, 128), portalMat);
  portal.position.copy(rimPivot);
  portal.frustumCulled = false;
  group.add(portal);
  // Linked after the space target exists.
  const linkPortal = (spaceTex) => {
    const radial = N.Fn(() => {
      const r = N.length(N.positionLocal.xy).div(GATE_RADIUS);
      // Space itself bends at the rim: an Einstein ring around the gate.
      const c = N.screenUV.sub(N.uniform(0.5));
      const bend = N.pow(N.clamp(r, 0, 1), 7).mul(0.08);
      const uv = N.screenUV.sub(N.positionLocal.xy.div(GATE_RADIUS).mul(N.vec2(1, -1)).mul(bend));
      const inner = spaceTex.sample(uv).rgb;
      const edge = N.smoothstep(0.86, 1.0, r);
      const hot = N.vec3(1.0, 0.5, 0.2).mul(N.pow(edge, 4).mul(1.1));
      return inner.add(hot);
    });
    // Alpha 0 marks these pixels: nothing in the atmosphere may veil the far side of the gate.
    portalMat.outputNode = N.vec4(radial(), 0);
    portalMat.needsUpdate = true;
  };
  return { group, ring, glyphPulse, center, radius: GATE_RADIUS, rimPivot, portal, linkPortal };
}

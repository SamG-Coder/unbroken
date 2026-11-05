import * as T from "three/webgpu";
import * as N from "three/tsl";
import { subPass, blueNoiseish } from "./passes.js";

// Volumetric cumulus: half-resolution raymarch through a Perlin-Worley volume,
// with Beer-Powder lighting and a dual-lobe phase. Output: rgb in-scatter, a transmittance.
export const CLOUD_BASE = 780, CLOUD_TOP = 2600;

export function createClouds(sky, world, { camPos, depthTex, frame, rayDir, viewDist, steps = 64, lightSteps = 6 }) {
  const vol = N.texture3D(world.volume.texture);
  const wind = N.vec3(world.time.mul(3.2), 0, world.time.mul(1.4));

  const density = N.Fn(([p, cheap]) => {
    const h = N.clamp(p.y.sub(CLOUD_BASE).div(CLOUD_TOP - CLOUD_BASE), 0, 1);
    const cov = world.coverage(p.xz).toVar();
    // Towers: coverage controls how tall each mass grows.
    const profile = N.smoothstep(0, 0.07, h).mul(N.smoothstep(N.clamp(cov.mul(1.05), 0.12, 1), N.clamp(cov.mul(0.5), 0.05, 0.6), h));
    const base = vol.sample(p.add(wind).div(2700)).level(0).r;
    const lumps = vol.sample(p.add(wind).div(880)).level(0).g;
    const shape = base.mul(0.62).add(lumps.mul(0.38));
    const d = N.clamp(shape.sub(N.float(1).sub(cov.mul(profile))).div(N.max(cov.mul(profile), 0.03)), 0, 1).toVar();
    N.If(cheap.lessThan(0.5).and(d.greaterThan(0.001)), () => {
      const q = p.add(wind.mul(1.6)).add(N.vec3(0, world.time.mul(-1.2), 0));
      const e1 = vol.sample(q.div(390)).level(0);
      const e2 = vol.sample(q.div(120)).level(0).g;
      const wisp = N.mix(e1.g.mul(0.6).add(e1.b.mul(0.4)).add(e2.mul(0.14)), N.float(1).sub(e1.g), N.smoothstep(0.12, 0.5, h).oneMinus().mul(0.35));
      d.assign(N.clamp(d.sub(wisp.mul(0.2).mul(N.float(1).sub(d.mul(0.7)))).div(0.9), 0, 1));
    });
    return d.mul(N.smoothstep(0, 0.2, h).mul(0.55).add(0.45));
  });

  const build = () => N.Fn(() => {
    const uv = N.screenUV;
    const ro = camPos;
    const rd = rayDir(uv);
    const depthDist = viewDist(uv);
    const y0 = N.float(CLOUD_BASE).sub(ro.y).div(rd.y);
    const y1 = N.float(CLOUD_TOP).sub(ro.y).div(rd.y);
    const tNear = N.max(N.min(y0, y1), 0);
    const tFar = N.min(N.max(y0, y1), N.min(depthDist, 62000));
    const col = N.vec3(0).toVar();
    const trans = N.float(1).toVar();
    const mu = rd.dot(sky.sun);
    // Dual-lobe Henyey-Greenstein: a silver forward lining and a soft back lobe.
    const hg = (g) => N.float(1 - g * g).div(N.float(1 + g * g).sub(mu.mul(2 * g)).pow(1.5).mul(4 * Math.PI));
    const phase = hg(0.82).mul(0.55).add(hg(-0.25).mul(0.45)).mul(4 * Math.PI);
    const sunL = sky.sunColor.mul(N.vec3(7.6, 7.0, 7.2));
    const zen = sky.lut(N.vec3(0, 1, 0));
    const hor = sky.lut(N.normalize(N.vec3(rd.x, 0.03, rd.z)));

    N.If(tNear.lessThan(tFar), () => {
      const t = tNear.add(blueNoiseish(N.screenCoordinate.xy, frame).mul(N.clamp(tNear.mul(0.03), 30, 700))).toVar();
      const stepSize = N.float(0).toVar();
      N.Loop(steps, ({ i }) => {
        N.If(t.greaterThan(tFar).or(trans.lessThan(0.012)), () => { N.Break(); });
        stepSize.assign(N.clamp(t.mul(0.03), 30, 700));
        const p = ro.add(rd.mul(t));
        const d = density(p, N.float(t.greaterThan(52000)));
        N.If(d.greaterThan(0.002), () => {
          // March towards the sun with growing steps.
          const od = N.float(0).toVar();
          const ls = N.float(38).toVar();
          const q = p.toVar();
          N.Loop(lightSteps, () => {
            q.addAssign(sky.sun.mul(ls));
            od.addAssign(density(q, N.float(1)).mul(ls));
            ls.mulAssign(1.9);
          });
          const h = N.clamp(p.y.sub(CLOUD_BASE).div(CLOUD_TOP - CLOUD_BASE), 0, 1);
          const sigma = 0.0115;
          const beer = N.exp(od.mul(-sigma * 1.1)).mul(0.78).add(N.exp(od.mul(-sigma * 0.22)).mul(0.22));
          const powder = N.float(1).sub(N.exp(d.mul(-9))).mul(0.55).add(0.45);
          const direct = sunL.mul(beer).mul(powder).mul(phase);
          const ambientHigh = N.mix(zen.mul(0.9), hor.mul(0.75), 0.45);
          const ambient = N.mix(N.vec3(0.09, 0.12, 0.2).mul(0.5), ambientHigh.mul(0.75), h.pow(0.65).mul(0.8).add(0.2)).mul(N.mix(0.6, 1.0, h));
          const lit = direct.add(ambient);
          const ext = d.mul(sigma).mul(1.15);
          const a = N.exp(ext.mul(stepSize).negate());
          // Energy-conserving integral across the step.
          const inc = lit.sub(lit.mul(a)).div(N.max(ext, 1e-5)).mul(ext);
          // Distance haze folds far clouds into the horizon.
          const haze = N.exp(t.mul(-0.000045));
          const final = N.mix(hor.mul(1.05), inc, haze);
          col.addAssign(final.mul(trans));
          trans.mulAssign(a);
        });
        t.addAssign(stepSize);
      });
    });
    return N.vec4(col, trans);
  })();

  return subPass(build, 0.42);
}

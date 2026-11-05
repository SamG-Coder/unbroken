import * as T from "three/webgpu";
import * as N from "three/tsl";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { motionBlur } from "three/addons/tsl/display/MotionBlur.js";
import { createClouds } from "./clouds.js";
import { subPass, blueNoiseish } from "./passes.js";

// The whole picture is one graph: scene -> AO -> aerial perspective + clouds +
// god rays -> TRAA -> DoF -> motion blur -> bloom/flare -> grade -> display.
export function createPost(renderer, scene, camera, sky, world, grade, quality) {
  const frame = N.uniform(0);
  const beauty = N.pass(scene, camera);
  beauty.setMRT(N.mrt({
    output: N.output,
    normal: N.packNormalToRGB(N.normalView),
  }));
  const colorTex = beauty.getTextureNode("output");
  const normalTex = beauty.getTextureNode("normal");
  const depthTex = beauty.getTextureNode("depth");
  const viewZ = beauty.getViewZNode();

  // Fullscreen quads have their own camera, so the film camera arrives as uniforms.
  const camPos = N.uniform(new T.Vector3());
  const camWorld = N.uniform(new T.Matrix4());
  const camInvProj = N.uniform(new T.Matrix4());
  const rayDir = N.Fn(([uv]) => {
    const clip = N.vec4(uv.x.mul(2).sub(1), N.float(1).sub(uv.y).mul(2).sub(1), 0.5, 1);
    const view = camInvProj.mul(clip);
    return N.normalize(camWorld.mul(N.vec4(view.xyz.div(view.w), 0)).xyz);
  });
  // Metres along the ray to the rendered surface; huge for sky pixels.
  const depthSample = (uv) => depthTex.sample(uv).level(0).r;
  const isSky = (d) => d.lessThanEqual(0.0000001);
  const viewDist = N.Fn(([uv]) => {
    const d = depthSample(uv);
    const clip = N.vec4(uv.x.mul(2).sub(1), N.float(1).sub(uv.y).mul(2).sub(1), d, 1);
    const view = camInvProj.mul(clip);
    const dist = N.length(view.xyz.div(view.w));
    return N.select(isSky(d), N.float(1e7), dist);
  });

  // Motion vectors from depth: the world is static, only the camera moves, and this
  // stays exact for every procedurally displaced mesh in the film.
  const invVP = N.uniform(new T.Matrix4());
  const prevVP = N.uniform(new T.Matrix4());
  const velocityTex = subPass(() => N.Fn(() => {
    const uv = N.screenUV;
    const d = N.max(depthSample(uv), 1e-7);
    const clip = N.vec4(uv.x.mul(2).sub(1), N.float(1).sub(uv.y).mul(2).sub(1), d, 1);
    const wp = invVP.mul(clip);
    const prev = prevVP.mul(wp);
    const prevUV = prev.xy.div(prev.w).mul(N.vec2(0.5, -0.5)).add(0.5);
    return N.vec4(uv.sub(prevUV), 0, 1);
  })(), 1);

  const gtao = ao(depthTex, N.sample((uv) => N.unpackRGBToNormal(normalTex.sample(uv))), camera);
  gtao.radius.value = 3.2;
  gtao.distanceExponent.value = 1.3;
  gtao.thickness.value = 2.5;
  gtao.samples.value = quality.ao;
  gtao.resolutionScale = 0.5;

  const clouds = createClouds(sky, world, { camPos, depthTex, frame, rayDir, viewDist, steps: quality.cloudSteps, lightSteps: quality.cloudLight });

  // Screen-space light shafts: march sky visibility towards the sun's screen spot.
  const sunUV = N.uniform(new T.Vector2(0.5, 0.5));
  const sunOn = N.uniform(0);
  const shafts = subPass(() => N.Fn(() => {
    const uv = N.screenUV;
    const delta = sunUV.sub(uv).mul(1 / 28);
    const p = uv.add(delta.mul(blueNoiseish(N.screenCoordinate.xy, frame))).toVar();
    const sum = N.float(0).toVar();
    const w = N.float(1).toVar();
    N.Loop(28, () => {
      const onScreen = p.x.greaterThan(0).and(p.x.lessThan(1)).and(p.y.greaterThan(0)).and(p.y.lessThan(1));
      const vis = N.select(onScreen, N.float(isSky(depthSample(p))), 0);
      sum.addAssign(vis.mul(w));
      w.mulAssign(0.965);
      p.addAssign(delta);
    });
    return N.vec4(N.vec3(sum.div(28 * 0.6)), 1);
  })(), 0.5);

  const cloudsPass = clouds.passNode;
  const shaftsPass = shafts.passNode;
  const exposure = N.uniform(1);
  const fogAmount = N.uniform(1);
  const space = N.uniform(0); // 1 = in space, no atmosphere at all

  const composite = N.Fn(() => {
    const uv = N.screenUV;
    const raw = colorTex.sample(uv);
    const occl = N.mix(N.float(1), gtao.getTextureNode().sample(uv).r, 0.92);
    const d = viewDist(uv);
    const rd = rayDir(uv);
    const skyPix = d.greaterThan(1e6);
    // Sky pixels are drawn here so every effect sees one consistent atmosphere.
    const base = N.select(skyPix, sky.sky(rd), raw.rgb.mul(occl)).toVar();
    // Height-exponential aerial perspective towards the sky colour in this direction.
    const camY = camPos.y;
    const k = N.float(0.00017).mul(fogAmount);
    const falloff = N.float(0.0031);
    const dy = rd.y.mul(falloff).mul(N.min(d, 90000));
    const integral = N.select(N.abs(dy).greaterThan(0.002), N.float(1).sub(N.exp(dy.negate())).div(dy), N.float(1));
    const od = k.mul(N.exp(camY.mul(falloff).negate())).mul(N.min(d, 90000)).mul(integral);
    const trans = N.exp(od.negate());
    const fogDir = N.normalize(N.vec3(rd.x, N.max(rd.y, 0.012), rd.z));
    const inscatter = sky.lut(fogDir).mul(1.04).add(sky.sunColor.mul(N.pow(N.max(rd.dot(sky.sun), 0), 22).mul(0.55)));
    const air = N.select(skyPix, base, N.mix(inscatter, base, trans)).toVar();
    // Clouds in front of everything they should cover.
    const cl = clouds.sample(uv);
    air.assign(air.mul(cl.a).add(cl.rgb));
    // Shafts: only the path to the sun scatters, so this stays physically located.
    const facing = N.smoothstep(0.1, 0.95, N.max(rd.dot(sky.sun), 0));
    const sh = shafts.sample(uv).r;
    air.addAssign(sky.sunColor.mul(sh).mul(facing).mul(0.05).mul(sunOn).mul(cl.a));
    // The portal keeps its own light, untouched by this world's air.
    const portalPix = raw.a.lessThan(0.5).and(d.lessThan(700));
    return N.vec4(N.min(N.select(space.greaterThan(0.5).or(portalPix), raw.rgb, air), N.vec3(24)), 1);
  })();

  const aa = traa(composite, depthTex, velocityTex, camera);
  aa.depthThreshold = 0.0005;
  aa.edgeDepthDiff = 0.001;
  aa.maxVelocityWeight = 0.5;

  const focus = N.uniform(40);
  const focalLen = N.uniform(40);
  const bokeh = N.uniform(0.0);
  const dofOn = N.uniform(0);
  const dofRaw = quality.dof ? dof(aa, viewZ, focus, focalLen, bokeh) : null;
  const aaTex = aa.getTextureNode();
  const dofNode = quality.dof ? N.mix(aaTex, dofRaw, dofOn) : aaTex;
  const blurScale = N.uniform(0.34);
  const blurred = quality.motionBlur > 0
    ? motionBlur(N.convertToTexture(dofNode), N.clamp(velocityTex.xy.mul(blurScale), N.vec2(-0.04), N.vec2(0.04)), N.int(quality.motionBlur))
    : dofNode;
  const blurredTex = N.convertToTexture(blurred);
  const glow = bloom(blurredTex, 0.14, 0.58, 2.4);

  // Grade: filmic curve, warm highlight / teal shadow split, gate weave vignette, grain.
  const letterbox = N.uniform(0);
  const lift = N.uniform(new T.Vector3(0.0, 0.0, 0.0));
  const fade = N.uniform(0);
  const flash = N.uniform(0);
  const saturate = N.uniform(1.04);
  const display = N.Fn(() => {
    const uv = N.screenUV;
    // Slight lens chromatic split, strongest in the corners.
    const c = uv.sub(0.5);
    const r2 = c.dot(c);
    const ca = c.mul(r2).mul(0.0065);
    const main = N.vec3(blurredTex.sample(uv.add(ca)).r, blurredTex.sample(uv).g, blurredTex.sample(uv.sub(ca)).b);
    let hdr = main.add(glow.rgb.mul(0.85)).mul(N.vec3(0.97, 0.95, 1.1));
    hdr = hdr.mul(exposure);
    // Filmic curve (Narkowicz ACES fit) with highlight desaturation towards white.
    const a = hdr.mul(0.72);
    const curve = (x) => x.mul(x.mul(2.51).add(0.03)).div(x.mul(x.mul(2.43).add(0.59)).add(0.14));
    const perChannel = N.clamp(curve(a), 0, 1);
    // Blend in a hue-preserving version: orange stays orange instead of skewing yellow.
    const Ly = N.max(a.dot(N.vec3(0.2126, 0.7152, 0.0722)), 1e-5);
    const huePreserved = N.clamp(a.mul(N.clamp(curve(Ly), 0, 1).div(Ly)), 0, 1);
    const fit = N.mix(perChannel, huePreserved, 0.55);
    const luma = fit.dot(N.vec3(0.2126, 0.7152, 0.0722));
    let out = N.max(N.mix(N.vec3(luma), fit, saturate), N.vec3(0));
    // Split tone, multiplicative so black stays black.
    const L = luma;
    out = out.mul(N.mix(N.vec3(0.95, 1.0, 1.07), N.vec3(1.05, 1.0, 0.94), N.smoothstep(0.05, 0.6, L)));
    out = out.add(lift);
    // Vignette.
    const vig = N.smoothstep(0.92, 0.18, N.length(c.mul(N.vec2(1.08, 1.2))));
    out = out.mul(N.mix(0.72, 1, vig));
    out = N.mix(out, N.vec3(0), fade);
    // Warm white that carries the camera through the planet cloud deck.
    out = N.mix(out, N.vec3(1.0, 0.93, 0.84), flash);
    // Film grain in display space.
    const g = blueNoiseish(N.screenCoordinate.xy.add(frame.mul(13.7)), frame).sub(0.5);
    let srgb = N.pow(N.clamp(out, 0, 1), N.vec3(1 / 2.2));
    srgb = srgb.add(g.mul(0.022).mul(N.float(1).sub(L.mul(0.6))));
    // Scope bars.
    const barH = N.float(0.5).sub(letterbox).add(0.002);
    const bar = N.smoothstep(barH.sub(0.0008), barH.add(0.0008), N.abs(uv.y.sub(0.5)));
    return N.vec4(N.mix(srgb, N.vec3(0), bar), 1);
  })();

  const pipeline = new T.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  pipeline.outputNode = display;

  const _vp = new T.Matrix4();
  let hasPrev = false;
  return {
    invVP, prevVP,
    beginFrame(cut = false) {
      camera.updateMatrixWorld();
      _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      if (!hasPrev || cut) prevVP.value.copy(_vp);
      hasPrev = true;
      invVP.value.copy(_vp).invert();
      camPos.value.copy(camera.position);
      camWorld.value.copy(camera.matrixWorld);
      camInvProj.value.copy(camera.projectionMatrixInverse);
    },
    endFrame() { prevVP.value.copy(_vp); },
    setRegime(s, isSpace) {
      beauty.scene = s;
      space.value = isSpace ? 1 : 0;
      cloudsPass.enabled = !isSpace;
      shaftsPass.enabled = !isSpace;
    },
    dbg: { colorTex, composite, aa, blurredTex, clouds, glow, shafts, gtao },
    flash, dofOn, pipeline, frame, exposure, fogAmount, sunUV, sunOn, space, focus, focalLen, bokeh, blurScale, letterbox, fade, lift, saturate, glow, aa, beauty,
    render() { frame.value = (frame.value + 1) % 1024; pipeline.render(); this.endFrame(); },
  };
}

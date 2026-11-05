import * as T from "three/webgpu";
import * as N from "three/tsl";
import { buildSky, SUN } from "./sky.js";
import { buildWorld, GATE } from "./world.js";
import { createOcean } from "./ocean/surface.js";
import { createPost } from "./post.js";
import { createDirector, ACTS, LENGTH } from "./director.js";
import { bakeTiles, createTerrain } from "./terrain.js";
import { createGrass } from "./grass.js";
import { createForest } from "./trees.js";
import { createGate } from "./gate.js";
import { createSpace } from "./space.js";
import { createMotes, createEmbers, createFire, createBirds } from "./fx.js";
import { createLoader, createUI } from "./ui.js";
import { createPlayer } from "./audio.js";

const params = new URLSearchParams(location.search);
const ROUTE = [[0, -560], [0, -220], [0, 60], [0, 300], [0, 500]];
const canvas = document.getElementById("view");
const root = document.getElementById("ui");
const headless = params.has("freeze") || params.has("capture");

const TIERS = {
  ultra: { ao: 16, cloudSteps: 128, cloudLight: 6, dof: true, motionBlur: 16, grassNear: 1500000, grassMid: 1300000, shadowMap: 4096, galaxySteps: 56, stars: 1400000, motes: 26000 },
  high: { ao: 8, cloudSteps: 72, cloudLight: 5, dof: true, motionBlur: 8, grassNear: 1100000, grassMid: 1000000, shadowMap: 4096, galaxySteps: 40, stars: 1000000, motes: 26000 },
  low: { ao: 6, cloudSteps: 56, cloudLight: 4, dof: false, motionBlur: 6, grassNear: 420000, grassMid: 380000, shadowMap: 2048, galaxySteps: 24, stars: 320000, motes: 9000 },
};

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

async function boot() {
  T.Node.captureStackTrace = params.has("trace");
  const loader = createLoader(root);
  if (!navigator.gpu) {
    loader.fail("This film renders live and needs WebGPU, which this browser does not offer. Try a recent desktop Chrome or Edge.");
    window.UNBROKEN_ERROR = "no webgpu";
    return;
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter || !adapter.features.has("float32-filterable")) {
    loader.fail("This film renders live, and this GPU is missing a feature it needs. Try a recent desktop GPU.");
    window.UNBROKEN_ERROR = "unsupported adapter";
    return;
  }

  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  const tierName = params.get("q") ?? (mobile ? "low" : "high");
  const quality = TIERS[tierName] ?? TIERS.high;

  const renderer = new T.WebGPURenderer({ canvas, antialias: false, reversedDepthBuffer: true, powerPreference: "high-performance" });
  // Internal resolution tops out at 1440p outside capture: the post stack is the point, not the pixel count.
  const maxSide = params.has("capture") ? 7680 : 2560;
  const fitScale = () => Math.min(1, maxSide / Math.max(innerWidth, innerHeight));
  let dynamicScale = 1;
  const applySize = () => {
    renderer.setPixelRatio(fitScale() * dynamicScale * (params.has("capture") ? 1 : Math.min(devicePixelRatio, 1.5)));
    renderer.setSize(innerWidth, innerHeight, false);
  };
  applySize();
  await renderer.init();
  renderer.toneMapping = T.NoToneMapping;
  renderer.outputColorSpace = T.LinearSRGBColorSpace;

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(46, innerWidth / innerHeight, 0.25, 180000);

  loader.step("Scattering light through an atmosphere", 0.05);
  await nextFrame();
  const sky = buildSky();
  loader.step("Eroding an island", 0.12);
  await nextFrame();
  const world = await buildWorld(renderer);
  loader.step("Starting a sea", 0.22);
  await nextFrame();
  const ocean = createOcean(renderer, sky, world);
  scene.add(ocean.group);
  const space = createSpace(quality);
  loader.step("Cutting rock and growing a meadow", 0.3);
  await nextFrame();
  const tiles = bakeTiles(renderer);
  const terrain = createTerrain(world, tiles);
  scene.add(terrain.group);
  const grass = createGrass(world, sky, quality);
  scene.add(grass.group);
  loader.step("Growing a forest", 0.38);
  await nextFrame();
  const forest = createForest(renderer, world, tiles, { route: ROUTE });
  scene.add(forest.group);
  loader.step("Raising the gate", 0.46);
  await nextFrame();
  const gate = createGate(world, sky, tiles, GATE);
  scene.add(gate.group);
  scene.add(createMotes(world, sky, quality.motes));
  scene.add(createEmbers(world, GATE));
  scene.add(createBirds(world));
  const fire = createFire(world, tiles, GATE);
  scene.add(fire.group);

  // The portal is a live window: the space scene is rendered here first each frame.
  const portalRT = new T.RenderTarget(1024, 576, { type: T.HalfFloatType, depthBuffer: false });
  portalRT.texture.minFilter = portalRT.texture.magFilter = T.LinearFilter;
  gate.linkPortal(N.texture(portalRT.texture));

  // Lights take physical values from the same atmosphere as the sky.
  const E = 6.2;
  const sunLight = new T.DirectionalLight(new T.Color(sky.trans[0], sky.trans[1], sky.trans[2]), E);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
  scene.add(sunLight, sunLight.target);
  // One high-resolution map that travels with the camera, stretched along the sun's
  // very long evening shadows.
  const SHADOW_R = 190;
  Object.assign(sunLight.shadow.camera, { left: -SHADOW_R, right: SHADOW_R, top: SHADOW_R, bottom: -SHADOW_R, near: 10, far: 2600 });
  sunLight.shadow.bias = -0.0006;
  sunLight.shadow.normalBias = 0.25;
  sunLight.shadow.radius = 2.5;
  const shadowFocus = new T.Vector3();
  const skyAvg = sky.average();
  // Ambient leans to the blue of the open sky: warm sun, cool shade.
  scene.add(new T.HemisphereLight(new T.Color(skyAvg[0] * 0.7, skyAvg[1] * 0.95, skyAvg[2] * 1.3), new T.Color(0.11, 0.095, 0.07), Math.PI * 0.4));

  const post = createPost(renderer, scene, camera, sky, world, null, quality);
  const director = createDirector({ camera, post, world, sky, space, gateCenter: gate.center });

  const state = { t: Number(params.get("t") ?? 0), playing: !headless, speed: 1 };
  const tmp = new T.Vector3();
  const portalSize = new T.Vector2();
  let lastInSpace = null;
  function update(t) {
    world.time.value = t + 30;
    const inSpace = director.apply(t);
    const cut = inSpace !== lastInSpace;
    lastInSpace = inSpace;
    post.setRegime(inSpace ? space.scene : scene, inSpace);
    post.beginFrame(cut);
    if (inSpace) { space.beginFrame(camera, cut); return; }
    if (director.state.portal) {
      renderer.getDrawingBufferSize(portalSize);
      const w = Math.max(64, Math.round(portalSize.x * 0.75)), h = Math.max(64, Math.round(portalSize.y * 0.75));
      if (portalRT.width !== w || portalRT.height !== h) portalRT.setSize(w, h);
      // Slightly in the past of the shot's opening frame, so the disc is already turning.
      space.time.value = t - LENGTH;
      space.planetOn.value = 0;
      space.whiteout.value = 0;
      space.beginFrame(director.state.spaceCam, true);
      renderer.setRenderTarget(portalRT);
      renderer.render(space.scene, director.state.spaceCam);
      renderer.setRenderTarget(null);
    }
    ocean.update(t + 40, camera);
    // Shadow map centred ahead of the camera, snapped to its texel grid so it never shimmers.
    shadowFocus.set(0, 0, -1).applyQuaternion(camera.quaternion).multiplyScalar(90).add(camera.position);
    const snap = ((SHADOW_R * 2) / quality.shadowMap) * 8;
    shadowFocus.set(Math.round(shadowFocus.x / snap) * snap, Math.round(shadowFocus.y / snap) * snap, Math.round(shadowFocus.z / snap) * snap);
    sunLight.target.position.copy(shadowFocus);
    sunLight.position.copy(shadowFocus).addScaledVector(SUN, 1300);
    sunLight.target.updateMatrixWorld();
    sunLight.updateMatrixWorld();
    terrain.update(camera);
    forest.update(camera);
    // No meadow over open water or from the air: the blades are too small to see there.
    const overLand = Math.max(world.heightCPU(camera.position.x, camera.position.z), world.heightCPU(camera.position.x, camera.position.z + 240)) > 8;
    grass.group.visible = overLand && camera.position.y - world.heightCPU(camera.position.x, camera.position.z) < 260;
    grass.update(camera);
    // Sun's screen position for the shafts.
    tmp.copy(SUN).multiplyScalar(5000).add(camera.position).project(camera);
    post.sunUV.value.set(tmp.x * 0.5 + 0.5, 0.5 - tmp.y * 0.5);
    post.sunOn.value = tmp.z < 1 && Math.abs(tmp.x) < 2 && Math.abs(tmp.y) < 2 ? 1 : 0;
  }

  // Warm every pipeline under the loader, so nothing compiles mid-shot.
  if (!params.has("freeze")) {
    const warmth = [1, 12, 18.5, 24, 33, 40, 48, 52, 55];
    for (let i = 0; i < warmth.length; i++) {
      loader.step("Compiling light", 0.5 + (i / warmth.length) * 0.48);
      update(warmth[i]);
      post.render();
      await renderer.backend.device.queue.onSubmittedWorkDone();
      await nextFrame();
    }
  }

  const player = createPlayer();
  const film = {
    state,
    seek(t) { state.t = t; player.resync(t); },
    toggleSound: () => player.toggle(state.t),
  };
  const ui = params.has("freeze") ? null : createUI(root, film);
  if (params.has("capture")) document.body.classList.add("capture");
  const info = { res: "", rev: T.REVISION, tris: "" };
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${(n / 1e3).toFixed(0)}k`);
  const blades = quality.grassNear + quality.grassMid;
  info.tris = `${fmt(blades)} blades · ${fmt(forest.counts.trees)} trees · ${fmt(quality.stars)} stars`;

  // Resolution adapts to hold the frame rate; it never touches the picture's look.
  let frameAcc = 0, frames = 0, last = performance.now(), fps = 60, coolDown = 0;
  function tick(now) {
    const raw = now - last;
    const dt = Math.min(0.1, raw / 1000);
    last = now;
    if (state.playing) state.t = (state.t + dt * state.speed) % LENGTH;
    update(state.t);
    post.render();
    frameAcc += raw;
    frames++;
    if (frames >= 45) {
      const avg = frameAcc / frames;
      fps = 1000 / avg;
      frameAcc = 0;
      frames = 0;
      if (!headless && --coolDown <= 0) {
        if (avg > 22 && dynamicScale > 0.5) { dynamicScale = Math.max(0.5, dynamicScale * 0.87); applySize(); coolDown = 3; }
        else if (avg < 13.5 && dynamicScale < 1) { dynamicScale = Math.min(1, dynamicScale * 1.06); applySize(); coolDown = 6; }
      }
      renderer.getDrawingBufferSize(portalSize);
      info.res = `${portalSize.x}x${portalSize.y}`;
    }
    ui?.update(state.t, director.state.caption ?? ACTS[0], fps, info);
  }
  addEventListener("resize", () => {
    applySize();
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });
  if (!params.has("capture")) renderer.setAnimationLoop(tick);

  await loader.done();

  // Automation surface: deterministic frames for the exporter and screenshot harness.
  window.UNBROKEN = {
    renderer, scene, camera, world, post, director, state, GATE, T, N, ACTS, LENGTH, forest,
    seek(t) { state.t = t; state.playing = false; },
    async renderAt(t) {
      state.t = t;
      update(t);
      post.render();
      ui?.update(t, director.state.caption ?? ACTS[0], 60, null);
      await renderer.backend.device.queue.onSubmittedWorkDone();
    },
    ready: true,
  };
}

boot().catch((e) => {
  console.error(e);
  window.UNBROKEN_ERROR = String(e?.stack ?? e);
});

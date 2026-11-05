import { ACTS, LENGTH } from "./director.js";

const GH = "https://github.com/SamG-Coder/";
const LIVE = (r) => `https://samg-coder.github.io/${r}/`;

// The index: the game and graphics work this film draws on. `play` marks a live demo.
const INDEX = [
  ["Oceans", [
    ["clearwater", "Infinite FFT water, WebGPU and native", 1],
    ["WaterCuda", "Infinite islands and a spectral ocean", 1],
    ["ClearWater6.1", "Earth-scale ocean with outpost defence", 1],
    ["north-swell", "Tessendorf ocean in Three.js WebGPU", 1],
    ["dynamic-gaussian", "FFT water, caustics, Gaussian clouds", 1],
    ["MountainRIver", "Endless river with waterfalls", 1],
    ["coastal-simulation-cuda-webshader", "GPU-resident coastal simulation", 1],
  ]],
  ["Worlds", [
    ["BakedVoxelLighting", "Woodland with GPU baking and HLOD", 1],
    ["RustBakedVoxelLighting", "The same woodland in native Vulkan", 0],
    ["Meshlet", "Meshlet terrain, weather and runoff", 0],
    ["CudaAmazonForest", "Infinite seeded Amazon forest", 1],
    ["RealGrass", "Endless simulated GPU meadow", 1],
    ["arbor-cuda", "324 ray-traced procedural trees", 1],
    ["xylem-cuda", "A tree growing from root to leaf", 1],
    ["stratum", "Fly-through procedural city", 1],
    ["stratum-hyperdetail", "Endlessly traversable seeded city", 1],
    ["RealisticCity", "Address-seeded building walkthrough", 1],
    ["DesertedIslandDemo", "First-person island at sunset", 1],
  ]],
  ["Games", [
    ["forest-reborn", "Anime fantasy RPG with simulated MMO", 1],
    ["Umbra-The-Last-Gate", "Shadow-hunter action RPG", 1],
    ["Jelly-Colosseum", "Jelly gladiators, fifty rounds", 1],
    ["event-horizon-overdrive", "Gravity-powered arena roguelite", 1],
    ["nocturne", "Survival with evolving enemy tactics", 1],
    ["neon_city", "Open-world city-life action game", 1],
    ["ordinary-animals", "Absurd animal-battling parody", 1],
    ["AntLifeRPG", "A worker ant in a living terrarium", 1],
    ["RealIsland", "First-person island survival", 1],
    ["ForestSideScroll", "Secret River: painted path tracing", 1],
    ["NotMinecraft", "Mining at 1 cm voxel resolution", 1],
    ["strata-cuda-voxel", "Creative voxel sandbox", 1],
    ["FLOOF-CUDA", "Fur creature in a playable meadow", 1],
    ["aeris-cuda-gt", "GPU driving on a coastal circuit", 1],
    ["DBZSim", "Unofficial flight prototype", 1],
    ["polaris-play", "Arcade inside a simulated LCD", 1],
    ["ashen-vale", "2D RPG on .NET 10 and Vulkan", 0],
  ]],
  ["Simulation", [
    ["RealFireThreeJS", "3D fluid fire and smoke", 1],
    ["milky-way", "CUDA-resident barred spiral", 1],
    ["ThreeNaniteTest", "Cluster hierarchy in the browser", 1],
    ["SandDune", "Sand, water and goldfish", 1],
    ["grain-cuda-sand", "131,072 simulated grains", 1],
    ["Mud", "Wet mud on concrete", 1],
    ["vapor-cuda-boiling-lab", "Boiling water and volumetric mist", 1],
    ["dermis-cuda", "Live portrait with strand hair", 1],
  ]],
  ["Engines and mods", [
    ["ThreeBrowserStudio", "LLM-first Three.js authoring", 0],
    ["openmw-web", "Morrowind's engine in the browser", 0],
    ["KingdomComeGlueMapper", "KCD1 terrain into KCD2", 0],
    ["SkyrimScape", "Skyrim as a click adventure", 0],
    ["mojave-isometric-modding-tool", "Isometric Fallout: New Vegas", 0],
    ["GrassStress", "60 million path-traced blades", 0],
  ]],
];

const CSS = `
.brand, .caption, .stats { text-shadow: 0 1px 2px rgba(0,0,0,.55), 0 0 18px rgba(0,0,0,.45); }
.caption .n, .brand span, .stats, .caption a { color: rgba(243,236,224,.86); }
body.capture .bar, body.capture .stats { display: none; }
#ui a { color: inherit; }
.hud { position: absolute; transition: opacity .6s ease; }
body.ui-hidden .hud { opacity: 0 !important; pointer-events: none !important; }
.brand { top: 26px; left: 30px; pointer-events: none; }
.brand b { display: block; font: 600 15px/1 ui-sans-serif, "Segoe UI", system-ui, sans-serif; letter-spacing: .42em; }
.brand span { display: block; margin-top: 8px; font-size: 12px; color: var(--dim); letter-spacing: .03em; }
.stats { top: 26px; right: 30px; text-align: right; font: 500 11px/1.65 ui-monospace, "Cascadia Mono", Consolas, monospace; color: var(--dim); pointer-events: none; font-variant-numeric: tabular-nums; }
.caption { left: 30px; bottom: 78px; max-width: min(520px, 80vw); pointer-events: auto; }
.caption .t { font: 300 clamp(24px, 3.1vw, 40px)/1.1 ui-sans-serif, "Segoe UI Light", "Segoe UI", system-ui, sans-serif; letter-spacing: -.012em; }
.caption .n { margin-top: 8px; font-size: 13px; color: var(--dim); }
.caption a { display: inline-block; margin-top: 8px; font: 500 11px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; color: var(--dim); text-decoration: none; border-bottom: 1px solid var(--hair); padding-bottom: 3px; }
.caption a:hover, .caption a:focus-visible { color: var(--ink); border-color: var(--ink); }
.caption { transition: none; will-change: opacity, transform; }
.bar { left: 30px; right: 30px; bottom: 24px; display: flex; align-items: center; gap: 14px; pointer-events: auto; }
.bar button { all: unset; cursor: pointer; font: 500 11px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; color: var(--dim); padding: 9px 11px; border: 1px solid var(--hair); border-radius: 3px; backdrop-filter: blur(8px); background: rgba(0,0,0,.18); white-space: nowrap; }
.bar button:hover, .bar button:focus-visible { color: var(--ink); border-color: var(--ink); }
.track { position: relative; flex: 1; height: 26px; cursor: pointer; touch-action: none; }
.track::before { content: ""; position: absolute; left: 0; right: 0; top: 12px; height: 2px; background: var(--hair); }
.fill { position: absolute; left: 0; top: 12px; height: 2px; background: var(--ink); }
.tick { position: absolute; top: 8px; width: 1px; height: 10px; background: var(--hair); }
.index { position: fixed; inset: 0; overflow: auto; background: rgba(6,6,8,.82); backdrop-filter: blur(22px) saturate(1.2); pointer-events: auto; opacity: 0; visibility: hidden; transition: opacity .35s ease, visibility .35s; padding: clamp(24px, 6vw, 80px); z-index: 5; }
.index.open { opacity: 1; visibility: visible; }
.index h2 { margin: 0; font: 300 clamp(28px, 4vw, 52px)/1.05 ui-sans-serif, "Segoe UI Light", "Segoe UI", system-ui, sans-serif; letter-spacing: -.015em; max-width: 18ch; }
.index p.lede { color: var(--dim); max-width: 62ch; margin: 16px 0 44px; font-size: 15px; }
.index h3 { font: 500 11px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; letter-spacing: .14em; text-transform: uppercase; color: var(--dim); margin: 38px 0 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr)); gap: 0 28px; }
.row { display: block; padding: 11px 0; border-top: 1px solid rgba(243,236,224,.11); text-decoration: none; }
.row b { font-weight: 500; font-size: 14px; word-break: break-word; }
.row span { display: block; font-size: 12.5px; color: var(--dim); margin-top: 2px; }
.row i { float: right; font: 500 10px/1.6 ui-monospace, "Cascadia Mono", Consolas, monospace; font-style: normal; color: #f0b27a; }
.row:hover b, .row:focus-visible b { text-decoration: underline; text-underline-offset: 3px; }
.close { position: fixed; top: 22px; right: 26px; all: unset; }
.indexclose { position: fixed; top: 24px; right: 28px; cursor: pointer; font: 500 11px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; color: var(--dim); padding: 9px 11px; border: 1px solid var(--hair); border-radius: 3px; background: rgba(0,0,0,.3); }
.indexclose:hover, .indexclose:focus-visible { color: var(--ink); border-color: var(--ink); }
.loader { position: fixed; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; background: #000; z-index: 10; transition: opacity 1.1s ease; text-align: center; padding: 24px; }
.loader b { font: 600 18px/1 ui-sans-serif, "Segoe UI", system-ui, sans-serif; letter-spacing: .5em; margin-right: -.5em; }
.loader .step { margin-top: 18px; min-height: 20px; font-size: 13px; color: var(--dim); }
.loader .line { margin-top: 18px; width: min(260px, 60vw); height: 1px; background: var(--hair); overflow: hidden; }
.loader .line i { display: block; height: 100%; width: 0; background: var(--ink); transition: width .4s ease; }
.loader.fallback a { color: var(--ink); }
@media (max-width: 720px) {
  .brand { left: 16px; top: 16px; } .stats { display: none; }
  .caption { left: 16px; bottom: 66px; } .bar { left: 16px; right: 16px; bottom: 14px; gap: 8px; }
  .bar .opt { display: none; }
}
@media (prefers-reduced-motion: reduce) { .hud, .index, .loader { transition: none; } }
`;

export function createLoader(root) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const el = document.createElement("div");
  el.className = "loader";
  el.innerHTML = `<b>UNBROKEN</b><div class="line"><i></i></div><div class="step" aria-live="polite"></div>`;
  root.append(el);
  const bar = el.querySelector("i"), step = el.querySelector(".step");
  return {
    el,
    step(text, frac) { step.textContent = text; bar.style.width = `${Math.round(frac * 100)}%`; },
    async done() {
      el.style.opacity = 0;
      el.style.pointerEvents = "none";
      await new Promise((r) => setTimeout(r, 1150));
      el.remove();
    },
    fail(message) {
      el.classList.add("fallback");
      el.innerHTML = `<b>UNBROKEN</b><div class="step" style="max-width:52ch;color:var(--ink)">${message}</div>
        <div class="step"><a href="${GH}">More work on GitHub</a></div>`;
    },
  };
}

export function createUI(root, film) {
  root.insertAdjacentHTML("beforeend", `
    <div class="hud brand"><b>UNBROKEN</b><span>One shot. No cuts. No video, no model or texture files.</span></div>
    <div class="hud stats" aria-hidden="true"></div>
    <div class="hud caption"><div class="t"></div><div class="n"></div><a target="_blank" rel="noopener"></a></div>
    <div class="hud bar">
      <button class="play" aria-label="Pause">Pause</button>
      <div class="track" role="slider" tabindex="0" aria-label="Position in the film" aria-valuemin="0" aria-valuemax="${LENGTH}"><div class="fill"></div></div>
      <button class="snd opt" aria-pressed="false">Sound off</button>
      <button class="idx">Index</button>
      <button class="hide opt" title="Hide interface (H)">Hide</button>
    </div>
    <div class="index" role="dialog" aria-label="Index of projects" aria-hidden="true">
      <button class="indexclose">Close</button>
      <h2>Every project in this film, and the rest of the shelf.</h2>
      <p class="lede">Ideas from these repositories run through the shot. Everything you just saw is new code on three.js r187, generated in your browser, apart from the FFT ocean solver, which comes directly from BakedVoxelLighting.</p>
      <div class="sections"></div>
    </div>`);
  const q = (s) => root.querySelector(s);
  const cap = q(".caption"), capT = q(".caption .t"), capN = q(".caption .n"), capA = q(".caption a");
  const track = q(".track"), fill = q(".fill"), stats = q(".stats"), playBtn = q(".play"), sndBtn = q(".snd"), index = q(".index");
  ACTS.forEach((a) => {
    if (a.t === 0) return;
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.style.left = `${(a.t / LENGTH) * 100}%`;
    track.append(tick);
  });
  q(".sections").innerHTML = INDEX.map(([name, rows]) => `<h3>${name}</h3><div class="grid">${rows.map(([r, d, live]) =>
    `<a class="row" href="${live ? LIVE(r) : GH + r}" target="_blank" rel="noopener">${live ? "<i>PLAY</i>" : ""}<b>${r}</b><span>${d}</span></a>`).join("")}</div>`).join("");

  let shown = null;
  function caption(act) {
    if (act === shown) return;
    shown = act;
    capT.textContent = act.title;
    capN.textContent = act.note;
    capA.textContent = `github/${act.repo}`;
    capA.href = GH + act.repo;
  }
  const setPlaying = (p) => { film.state.playing = p; playBtn.textContent = p ? "Pause" : "Play"; playBtn.setAttribute("aria-label", p ? "Pause" : "Play"); };
  playBtn.onclick = () => setPlaying(!film.state.playing);
  const openIndex = (open) => { index.classList.toggle("open", open); index.setAttribute("aria-hidden", String(!open)); };
  q(".idx").onclick = () => openIndex(true);
  q(".indexclose").onclick = () => openIndex(false);
  const toggleUI = () => document.body.classList.toggle("ui-hidden");
  q(".hide").onclick = toggleUI;
  sndBtn.onclick = async () => {
    const on = await film.toggleSound();
    sndBtn.textContent = on ? "Sound on" : "Sound off";
    sndBtn.setAttribute("aria-pressed", String(on));
  };
  const seekFromX = (x) => {
    const r = track.getBoundingClientRect();
    film.seek(Math.max(0, Math.min(0.999, (x - r.left) / r.width)) * LENGTH);
  };
  let dragging = false, wasPlaying = true;
  track.addEventListener("pointerdown", (e) => { dragging = true; wasPlaying = film.state.playing; setPlaying(false); track.setPointerCapture(e.pointerId); seekFromX(e.clientX); });
  track.addEventListener("pointermove", (e) => { if (dragging) seekFromX(e.clientX); });
  track.addEventListener("pointerup", () => { dragging = false; setPlaying(wasPlaying); });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") openIndex(false);
    if (index.classList.contains("open")) return;
    if (e.key === " ") { e.preventDefault(); setPlaying(!film.state.playing); }
    if (e.key === "ArrowRight") film.seek((film.state.t + 3) % LENGTH);
    if (e.key === "ArrowLeft") film.seek((film.state.t - 3 + LENGTH) % LENGTH);
    if (e.key.toLowerCase() === "h") toggleUI();
    if (e.key.toLowerCase() === "m") sndBtn.click();
    if (e.key.toLowerCase() === "i") openIndex(true);
  });
  let idle;
  const wake = () => {
    document.body.style.cursor = "";
    clearTimeout(idle);
    idle = setTimeout(() => { document.body.style.cursor = "none"; }, 3000);
  };
  addEventListener("pointermove", wake);
  wake();

  return {
    update(t, act, fps, info) {
      caption(act);
      const i = ACTS.indexOf(act);
      const end = ACTS[i + 1]?.t ?? LENGTH;
      const lit = Math.min(Math.max(0, (t - act.t - 0.5) / 0.7), 1) * Math.min(Math.max(0, (end - t - 0.2) / 0.5), 1);
      cap.style.opacity = lit;
      cap.style.transform = `translateY(${(1 - lit) * 6}px)`;
      fill.style.width = `${(t / LENGTH) * 100}%`;
      track.setAttribute("aria-valuenow", t.toFixed(1));
      if (info) stats.innerHTML = `${fps.toFixed(0)} fps · ${info.res}<br>three.js r${info.rev} · WebGPU<br>${info.tris}`;
    },
  };
}

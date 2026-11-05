# UNBROKEN

One camera move, 56 seconds, looping forever: out of a black hole, across a galaxy, down through a planet's atmosphere and evening clouds, over an FFT ocean, up a sea cliff, through a meadow and a forest, and into a stone gate with that same black hole inside it.

There are no cuts, no video, and no model or texture files. The whole production build is about 360 KB gzipped. Everything on screen is generated in the browser by [three.js r187](https://github.com/mrdoob/three.js) on WebGPU.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5317 in a recent desktop Chrome or Edge with WebGPU. Browsers without it get a short message.

| Key | Action |
|---|---|
| Space | Pause and play |
| Left / Right | Seek 3 seconds |
| H | Hide the interface |
| M | Sound |
| I | Project index |

URL options: `?q=ultra|high|low` picks the quality tier, `?t=31` starts at a time.

## How it works

The film is a pure function of time. `src/director.js` samples keyframes for camera, focus and exposure, so any time in the film can be reproduced exactly.

| Part | File | What it does |
|---|---|---|
| Black hole, galaxy, planet | `src/space.js` | One fragment shader. Null geodesics through a Schwarzschild metric with a Doppler-beamed disc, a raymarched spiral disc, and a planet with single-scattering atmosphere. About a million instanced stars derive their positions from `instanceIndex` alone and streak with camera motion. |
| Portal | `src/gate.js`, `src/director.js` | The space scene renders into a target and the ring samples it in screen space. Its camera is rotated so the hole sits on the line to the gate, and that rotation shrinks to nothing at the crossing, so the frame after the plane matches the frame before it. |
| Atmosphere | `src/sky.js` | Rayleigh, Mie and ozone single scattering integrated once into a LUT. Water, fog and clouds all read the same table. |
| Clouds | `src/clouds.js` | Reduced-resolution raymarch through a Perlin-Worley volume baked at load, with Beer-Powder lighting and a dual-lobe phase function. |
| Ocean | `src/ocean/` | Three-cascade FFT in hand-written WGSL compute, carried over from [BakedVoxelLighting](https://github.com/SamG-Coder/BakedVoxelLighting), with a new surface shader. |
| Island | `src/world.js`, `src/terrain.js` | Heightfield with gully erosion and baked sun visibility, generated in compute at load, and drawn as a geometry clipmap with triplanar materials. |
| Meadow | `src/grass.js` | Over 2 million blades with no CPU data. Each instance works out its cell, height and wind from `instanceIndex`, the snapped camera and the terrain field. Blades part around the lens. |
| Forest | `src/trees.js` | Four species grown recursively at load, in four detail levels, bucketed into tiles. Detail follows the camera. |
| Picture | `src/post.js` | GTAO, aerial perspective, cloud and shaft composite, TRAA, depth of field, motion blur, bloom, filmic grade with hue preservation, grain. Motion vectors come from depth, which stays exact for procedurally displaced geometry. |
| Score | `src/audio.js` | Synthesized offline into one buffer that loops in step with the film. |

## Tools

With `npm run dev` running, `scripts/shot.mjs` takes stills at chosen times, `scripts/perf.mjs` reports GPU cost across the film, and `scripts/uicheck.mjs` walks through the page as a visitor.

## Credits

The ocean solver comes from [BakedVoxelLighting](https://github.com/SamG-Coder/BakedVoxelLighting). The other acts are new code that revisits ideas from these projects: [event-horizon-overdrive](https://github.com/SamG-Coder/event-horizon-overdrive), [milky-way](https://github.com/SamG-Coder/milky-way), [STRATUM-EARTH](https://github.com/SamG-Coder/STRATUM-EARTH), [dynamic-gaussian](https://github.com/SamG-Coder/dynamic-gaussian), [clearwater](https://github.com/SamG-Coder/clearwater), [RealGrass](https://github.com/SamG-Coder/RealGrass) and [Umbra: The Last Gate](https://github.com/SamG-Coder/Umbra-The-Last-Gate). The gully erosion filter follows Clay John's technique, and the filmic curve is Krzysztof Narkowicz's ACES fit.

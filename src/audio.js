// The score is synthesized, like everything else: one 56 second buffer rendered
// offline and looped in step with the film. It follows the same acts as the camera.
const LENGTH = 56;

function noise(ctx, seconds) {
  const b = ctx.createBuffer(2, seconds * ctx.sampleRate, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let v = 0, seed = 12345 + c * 777;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      v = v * 0.5 + (seed / 4294967296 - 0.5);
      d[i] = v;
    }
  }
  return b;
}

const env = (param, points) => {
  param.setValueAtTime(points[0][1], points[0][0]);
  for (const [t, v] of points.slice(1)) param.linearRampToValueAtTime(v, t);
};

export async function renderScore(sampleRate = 44100) {
  const ctx = new OfflineAudioContext(2, LENGTH * sampleRate, sampleRate);
  const master = ctx.createDynamicsCompressor();
  master.threshold.value = -14;
  master.ratio.value = 3;
  const out = ctx.createGain();
  out.gain.value = 0.82;
  master.connect(out).connect(ctx.destination);

  // Reverb from a synthetic decaying impulse.
  const ir = ctx.createBuffer(2, sampleRate * 5, sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let seed = 99 + c * 5;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      d[i] = (seed / 4294967296 - 0.5) * Math.exp((-i / d.length) * 7);
    }
  }
  const verb = ctx.createConvolver();
  verb.buffer = ir;
  const verbGain = ctx.createGain();
  verbGain.gain.value = 0.55;
  verb.connect(verbGain).connect(master);

  // Harmonic bed: D minor pads that open to a wide D major chord when the gate appears.
  const chords = [
    [0, 12, [73.42, 110, 146.83, 174.61]],
    [12, 21.5, [65.41, 98, 130.81, 164.81]],
    [21.5, 31, [87.31, 130.81, 174.61, 220]],
    [31, 38.5, [58.27, 116.54, 174.61, 233.08]],
    [38.5, 46, [73.42, 146.83, 220, 293.66]],
    [46, 56, [73.42, 146.83, 220, 277.18, 369.99]],
  ];
  for (const [a, b, notes] of chords) {
    const g = ctx.createGain();
    env(g.gain, [[Math.max(0, a - 1.5), 0], [a + 2, 0.12], [b - 0.5, 0.12], [Math.min(LENGTH, b + 2), 0]]);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    env(lp.frequency, [[a, 280], [(a + b) / 2, 1100], [b, 420]]);
    g.connect(lp);
    lp.connect(master);
    lp.connect(verb);
    notes.forEach((f, i) => {
      for (const [det, pan] of [[-5, -0.5], [5, 0.5]]) {
        const o = ctx.createOscillator();
        o.type = i === 0 ? "triangle" : "sawtooth";
        o.frequency.value = f;
        o.detune.value = det;
        const vca = ctx.createGain();
        vca.gain.value = (i === 0 ? 0.9 : 0.26) / notes.length;
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        o.connect(vca).connect(p).connect(g);
        o.start(Math.max(0, a - 1.5));
        o.stop(Math.min(LENGTH, b + 2.5));
      }
    });
  }

  // Sub rumble: the black hole at the top and the approach to the gate at the end.
  const sub = ctx.createOscillator();
  sub.frequency.value = 36.7;
  const subG = ctx.createGain();
  env(subG.gain, [[0, 0.5], [5, 0.34], [8.5, 0.0], [46, 0], [53, 0.5], [55.8, 0.56], [56, 0.5]]);
  sub.connect(subG).connect(master);
  sub.start();

  const n = noise(ctx, LENGTH);
  const bed = (points, type, freqPoints, q = 0.7, send = 0.1) => {
    const s = ctx.createBufferSource();
    s.buffer = n;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    env(f.frequency, freqPoints);
    const g = ctx.createGain();
    env(g.gain, points);
    s.connect(f).connect(g);
    g.connect(master);
    const v = ctx.createGain();
    v.gain.value = send;
    g.connect(v).connect(verb);
    s.start();
  };
  // Atmosphere entry roar peaks at the cloud deck.
  bed([[12, 0], [16.8, 0.62], [17.6, 0.5], [20.5, 0]], "bandpass", [[12, 300], [17.2, 1800], [21, 400]], 0.5, 0.25);
  // Ocean: slow swell in the noise floor.
  const swellPts = [[20, 0]];
  for (let t = 22; t < 32; t += 1.6) swellPts.push([t, 0.26 + (t % 3.2 < 1.6 ? 0.2 : 0)]);
  swellPts.push([33.5, 0]);
  bed(swellPts, "lowpass", [[20, 900], [26, 1500], [33, 700]], 0.4, 0.2);
  // Wind through the meadow and leaves.
  bed([[30, 0], [33, 0.14], [38, 0.16], [44, 0.2], [48, 0.05], [50, 0]], "bandpass", [[30, 2200], [38, 3600], [46, 5200]], 0.8, 0.05);

  // Impacts where scale changes: each one a low thump with a bright tail.
  for (const t of [5.2, 11.6, 17.4, 21.5, 31, 38.5, 46]) {
    const o = ctx.createOscillator();
    o.type = "sine";
    env(o.frequency, [[t, 110], [t + 0.5, 34]]);
    const g = ctx.createGain();
    env(g.gain, [[t, 0.0], [t + 0.012, 0.52], [t + 1.6, 0]]);
    o.connect(g);
    g.connect(master);
    g.connect(verb);
    o.start(t);
    o.stop(t + 1.8);
  }

  const rendered = await ctx.startRendering();
  // Hard-guarantee no clipping.
  let peak = 0;
  for (let c = 0; c < 2; c++) for (const v of rendered.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.97) for (let c = 0; c < 2; c++) { const d = rendered.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= 0.97 / peak; }
  return rendered;
}

export function toWav(buffer) {
  const channels = buffer.numberOfChannels, n = buffer.length;
  const out = new DataView(new ArrayBuffer(44 + n * channels * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); out.setUint32(4, 36 + n * channels * 2, true); str(8, "WAVEfmt "); out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); out.setUint16(22, channels, true); out.setUint32(24, buffer.sampleRate, true);
  out.setUint32(28, buffer.sampleRate * channels * 2, true); out.setUint16(32, channels * 2, true); out.setUint16(34, 16, true);
  str(36, "data"); out.setUint32(40, n * channels * 2, true);
  const data = [...Array(channels).keys()].map((c) => buffer.getChannelData(c));
  for (let i = 0, p = 44; i < n; i++) for (let c = 0; c < channels; c++, p += 2) out.setInt16(p, Math.max(-1, Math.min(1, data[c][i])) * 32767, true);
  return out.buffer;
}

export function createPlayer() {
  let ctx = null, source = null, gain = null, buffer = null, on = false;
  return {
    async toggle(t) {
      if (on) { gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1); source?.stop(ctx.currentTime + 0.4); source = null; on = false; return false; }
      ctx ??= new AudioContext();
      await ctx.resume();
      buffer ??= await renderScore(ctx.sampleRate);
      this.start(t);
      on = true;
      return true;
    },
    start(t) {
      gain = ctx.createGain();
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(1, ctx.currentTime, 0.2);
      gain.connect(ctx.destination);
      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(gain);
      source.start(0, t % LENGTH);
    },
    resync(t) {
      if (!on) return;
      source?.stop();
      this.start(t);
    },
  };
}

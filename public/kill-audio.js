/* Synthesised gore for the kill sequences: bone crunch and snap, flesh tearing, wet bites and squelches, the
   survivor choking, gasping and gurgling, a body hitting the floor, a wall slam, a point-blank creature screech,
   an impaling spike, grave dirt, tinnitus, and a heartbeat that slows into a monitor's flatline. Everything runs
   through one bus (compressor + soft clip) into the caller's master gain; the caller owns the context. Every cue is
   a finite graph that disconnects itself when its last source ends; stop() fades the lot. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.HollowKillAudio = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const CUES = ['grab', 'crunch', 'snap', 'tear', 'squelch', 'bite', 'gurgle', 'choke', 'gasp', 'whoosh', 'thud', 'slam',
    'ring', 'screech', 'impale', 'dirt', 'flat'];
  // Base level per cue (before the caller's level and the bus); point-blank but never painful.
  const LEVELS = { grab: .5, crunch: .55, snap: .5, tear: .5, squelch: .45, bite: .55, gurgle: .38, choke: .4, gasp: .34,
    whoosh: .3, thud: .6, slam: .65, ring: .045, screech: .42, impale: .5, dirt: .45, flat: .07 };
  // Screech fundamentals by kind (Hz).
  const VOICES = { warden: 105, stalker: 240, crawler: 520, shrieker: 410, gravekeeper: 82 };
  const MAX_VOICES = 24, LOOKAHEAD = .12;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  let shaperCurve = null, clipCurve = null;
  function curve(k) {
    const c = new Float32Array(1025);
    for (let i = 0; i < c.length; i++) { const x = i * 2 / (c.length - 1) - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return c;
  }

  function create({ context, output, noiseBuffer, random } = {}) {
    const methods = ['createGain', 'createBufferSource', 'createOscillator', 'createBiquadFilter', 'createDynamicsCompressor', 'createWaveShaper'];
    if (!context || methods.some(m => typeof context[m] !== 'function') || !Number.isFinite(context.currentTime) ||
        !output || typeof output.connect !== 'function' || !noiseBuffer || !(noiseBuffer.duration > 0) ||
        (random !== undefined && typeof random !== 'function')) {
      throw new TypeError('HollowKillAudio needs an AudioContext, an output node and a nonempty noise AudioBuffer');
    }
    const draw = random || Math.random;
    const r01 = () => { const v = Number(draw()); return Number.isFinite(v) ? clamp(v, 0, .999999) : .5; };
    const rand = (a, b) => a + r01() * (b - a);
    const hz = v => clamp(v, 20, (context.sampleRate || 44100) * .45);
    const voices = new Set(), log = [];
    const heart = { bpm: 0, level: 0, nextAt: 0 };
    let bus = null, nextId = 1, played = 0;
    const inactive = () => context.state === 'closed';

    function connectBus() {
      if (bus) return bus;
      const mix = context.createGain(), comp = context.createDynamicsCompressor(), clip = context.createWaveShaper();
      mix.gain.value = 1;
      comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 6; comp.attack.value = .003; comp.release.value = .18;
      clip.curve = clipCurve || (clipCurve = curve(1.3)); clip.oversample = '2x';
      mix.connect(comp); comp.connect(clip); clip.connect(output);
      bus = { mix, nodes: [mix, comp, clip] };
      return bus;
    }
    function release(v) {
      if (v.closed) return;
      v.closed = true;
      for (const s of v.sources) { s.onended = null; try { s.stop(); } catch (e) { /* already stopped */ } }
      for (const n of v.nodes) { try { n.disconnect(); } catch (e) { /* gone */ } }
      v.sources.clear(); v.nodes.clear(); voices.delete(v);
    }
    function voice(cue, level) {
      if (voices.size >= MAX_VOICES) { let old = null; for (const v of voices) if (!old || v.at < old.at) old = v; if (old) release(old); }
      const b = connectBus(), out = context.createGain();
      out.gain.value = level; out.connect(b.mix);
      const v = { id: nextId++, cue, at: context.currentTime, end: context.currentTime, sources: new Set(), nodes: new Set([out]), out, closed: false };
      voices.add(v);
      return v;
    }
    const add = (v, node) => { v.nodes.add(node); return node; };
    function run(v, src, start, stop, offset) {
      v.sources.add(src); v.end = Math.max(v.end, stop);
      src.onended = () => { v.sources.delete(src); if (!v.sources.size) release(v); };
      if (offset === undefined) src.start(start); else src.start(start, offset);
      src.stop(stop);
    }
    function gain(v, dest, value) { const g = add(v, context.createGain()); g.gain.value = value; g.connect(dest); return g; }
    function filter(v, dest, type, f, q) { const n = add(v, context.createBiquadFilter()); n.type = type; n.frequency.value = hz(f); n.Q.value = q; n.connect(dest); return n; }
    // Envelope on a fresh gain: silent start, linear attack, exponential decay, true zero at the end.
    function hit(v, dest, start, attack, decay, level) {
      const g = add(v, context.createGain()), p = g.gain;
      p.setValueAtTime(0, start); p.linearRampToValueAtTime(level, start + attack);
      p.exponentialRampToValueAtTime(Math.max(level * .001, 1e-5), start + attack + decay);
      p.linearRampToValueAtTime(0, start + attack + decay + .004);
      g.connect(dest);
      return { g, end: start + attack + decay + .006 };
    }
    // Breakpoint envelope [[phase, amount]...] over `length`, closing at zero.
    function shape(v, dest, start, length, level, points) {
      const g = add(v, context.createGain()), p = g.gain;
      p.setValueAtTime(0, start);
      for (const [ph, a] of points) p.linearRampToValueAtTime(level * a, start + length * ph);
      p.linearRampToValueAtTime(0, start + length + .004);
      g.connect(dest);
      return { g, end: start + length + .006 };
    }
    function osc(v, dest, type, start, end, pitch) {
      const o = add(v, context.createOscillator());
      o.type = type;
      o.frequency.setValueAtTime(hz(pitch[0][1]), start);
      for (let i = 1; i < pitch.length; i++) o.frequency.exponentialRampToValueAtTime(hz(pitch[i][1]), start + pitch[i][0]);
      o.connect(dest); run(v, o, start, end);
      return o;
    }
    function noise(v, dest, start, end, rate = 1) {
      const s = add(v, context.createBufferSource());
      s.buffer = noiseBuffer; s.loop = false; s.playbackRate.value = clamp(rate, .25, 4);
      const span = (end - start) * s.playbackRate.value, offset = rand(0, Math.max(0, noiseBuffer.duration - span - .01));
      s.connect(dest); run(v, s, start, Math.min(end, start + (noiseBuffer.duration - offset) / s.playbackRate.value - .001), offset);
      return s;
    }
    // A burst of irregular clicks (bone grinding, dirt clods, wet crackle) on one noise source.
    function crackle(v, dest, start, length, count, level, width = [.002, .012]) {
      const s = add(v, context.createBufferSource()), g = add(v, context.createGain()), p = g.gain;
      s.buffer = noiseBuffer; s.loop = false;
      p.setValueAtTime(0, start);
      let at = start + rand(0, .006), end = start;
      for (let i = 0; i < count && at < start + length; i++) {
        const w = rand(width[0], width[1]), peak = level * rand(.25, 1);
        p.setValueAtTime(0, at); p.linearRampToValueAtTime(peak, at + w * .2); p.linearRampToValueAtTime(peak * rand(.1, .4), at + w * .5);
        p.linearRampToValueAtTime(0, at + w); end = at + w;
        at = end + rand(.002, Math.max(.004, length / Math.max(1, count) * 1.7));
      }
      s.connect(g); g.connect(dest);
      const stop = Math.max(end, start) + .01, offset = rand(0, Math.max(0, noiseBuffer.duration - (stop - start) - .01));
      run(v, s, start, stop, offset);
      return stop;
    }
    function shaper(v, dest) { const w = add(v, context.createWaveShaper()); w.curve = shaperCurve || (shaperCurve = curve(6)); w.oversample = '2x'; w.connect(dest); return w; }

    /* ---------- cue kits ---------- */
    const KIT = {
      grab(v, t, o) {
        osc(v, hit(v, v.out, t, .004, .16, .8).g, 'sine', t, t + .2, [[0, 95], [.15, 46]]);
        noise(v, hit(v, filter(v, v.out, 'bandpass', 1500, .9), t, .01, .14, .5).g, t, t + .17);
        noise(v, hit(v, filter(v, v.out, 'highpass', 1400, .7), t, .001, .03, .7).g, t, t + .04);
      },
      crunch(v, t, o) {
        const k = o.level;
        crackle(v, filter(v, v.out, 'bandpass', 2000 * o.pitch, 1.3), t, .14 + .08 * k, Math.round(8 + 8 * k), 1, [.002, .009]);
        crackle(v, filter(v, v.out, 'lowpass', 900, .8), t + .01, .16, 6, .8, [.004, .016]);
        osc(v, hit(v, v.out, t, .003, .1, .6).g, 'sine', t, t + .12, [[0, 140 * o.pitch], [.1, 55]]);
        osc(v, hit(v, filter(v, v.out, 'bandpass', 700, 3), t + .02, .004, .07, .25).g, 'sawtooth', t + .02, t + .1, [[0, 190], [.07, 120]]);
      },
      snap(v, t, o) {
        noise(v, hit(v, filter(v, v.out, 'highpass', 1800, .8), t, .0006, .014, 1).g, t, t + .02);
        noise(v, hit(v, filter(v, v.out, 'bandpass', 3100 * o.pitch, 14), t, .001, .06, 1.6).g, t, t + .07);
        osc(v, hit(v, v.out, t, .002, .06, .5).g, 'sine', t, t + .07, [[0, 170], [.06, 70]]);
        crackle(v, filter(v, v.out, 'bandpass', 2600, 1.2), t + .012, .06, 4, .6);
      },
      tear(v, t, o) {
        const len = .38 + .14 * r01(), band = filter(v, v.out, 'bandpass', 900, 1.6);
        band.frequency.setValueAtTime(hz(800 * o.pitch), t); band.frequency.exponentialRampToValueAtTime(hz(2600 * o.pitch), t + len * .7);
        band.frequency.exponentialRampToValueAtTime(hz(1400), t + len);
        crackle(v, band, t, len, Math.round(30 + 20 * o.level), 1.1, [.003, .014]);
        noise(v, shape(v, filter(v, v.out, 'bandpass', 1700, .8), t, len, .35, [[.1, 1], [.5, .7], [.85, .9], [1, 0]]).g, t, t + len + .01, .8);
        noise(v, shape(v, filter(v, v.out, 'lowpass', 450, 2), t, len * .8, .7, [[.05, 1], [.4, .5], [1, 0]]).g, t, t + len, .6);
      },
      squelch(v, t, o) {
        const len = .2 + .08 * r01(), lp = filter(v, v.out, 'lowpass', 1300, 9);
        lp.frequency.setValueAtTime(hz(1400 * o.pitch), t); lp.frequency.exponentialRampToValueAtTime(hz(260), t + len);
        noise(v, hit(v, lp, t, .006, len, 1).g, t, t + len + .02, .9);
        crackle(v, filter(v, v.out, 'bandpass', 1100, 2), t + .01, len * .8, 7, .7, [.004, .02]);
        osc(v, hit(v, v.out, t, .003, .09, .35).g, 'sine', t, t + .1, [[0, 110], [.09, 60]]);
      },
      bite(v, t, o) {
        noise(v, hit(v, filter(v, v.out, 'highpass', 4200, .8), t, .0005, .012, .8).g, t, t + .02);
        KIT.crunch(v, t + .008, o); KIT.squelch(v, t + .03, o);
      },
      gurgle(v, t, o) {
        const len = .7 + .3 * r01(), pitch = rand(95, 120) * o.pitch;
        const tract = filter(v, v.out, 'lowpass', 1100, 1.5), bub = add(v, context.createGain()), p = bub.gain;
        bub.connect(tract);
        p.setValueAtTime(0, t);
        let at = t;
        while (at < t + len) { const w = rand(.025, .07); p.linearRampToValueAtTime(rand(.3, 1), at + w * .3); p.linearRampToValueAtTime(rand(0, .15), at + w); at += w; }
        p.linearRampToValueAtTime(0, at + .01);
        osc(v, filter(v, bub, 'bandpass', 600, 3), 'sawtooth', t, at + .02, [[0, pitch], [len * .5, pitch * 1.1], [len, pitch * .8]]);
        noise(v, filter(v, bub, 'bandpass', 500, 2.5), t, at + .02, .7);
        crackle(v, filter(v, v.out, 'bandpass', 900, 3), t, len, Math.round(10 + 8 * o.level), .5, [.006, .02]);
      },
      choke(v, t, o) {
        const len = .3 + .12 * r01(), f0 = rand(230, 290) * o.pitch, cut = t + len;
        const mouth = add(v, context.createGain());
        for (const [f, q, w] of [[820, 6, 1], [1250, 7, .7], [2600, 8, .3]]) mouth.connect(filter(v, gain(v, v.out, w), 'bandpass', f * rand(.95, 1.05), q));
        const e = shape(v, mouth, t, len, .9, [[.04, 1], [.4, .85], [.8, .7], [.97, .5], [1, 0]]);
        osc(v, e.g, 'sawtooth', t, e.end, [[0, f0 * .9], [len * .25, f0 * 1.25], [len * .7, f0 * 1.1], [len, f0 * .7]]);
        noise(v, shape(v, filter(v, v.out, 'bandpass', 1400, 1), t, len, .35, [[.05, 1], [.9, .6], [1, 0]]).g, t, cut + .01);
        // Cut off by a wet catch in the throat.
        noise(v, hit(v, filter(v, v.out, 'lowpass', 700, 4), cut, .002, .08, .7).g, cut, cut + .1);
      },
      gasp(v, t, o) {
        const len = .32 + .1 * r01(), band = filter(v, v.out, 'bandpass', 1100, 2.2);
        band.frequency.setValueAtTime(hz(900), t); band.frequency.exponentialRampToValueAtTime(hz(2300), t + len);
        noise(v, shape(v, band, t, len, 1, [[.15, .4], [.6, 1], [.92, .8], [1, 0]]).g, t, t + len + .01, 1.1);
      },
      whoosh(v, t, o) {
        const len = .32, band = filter(v, v.out, 'bandpass', 300, 1.4);
        band.frequency.setValueAtTime(hz(280), t); band.frequency.exponentialRampToValueAtTime(hz(1900 * o.pitch), t + len * .6);
        band.frequency.exponentialRampToValueAtTime(hz(500), t + len);
        noise(v, shape(v, band, t, len, 1, [[.5, .6], [.7, 1], [1, 0]]).g, t, t + len + .01);
      },
      thud(v, t, o) {
        osc(v, hit(v, v.out, t, .004, .34, 1).g, 'sine', t, t + .38, [[0, 78], [.3, 34]]);
        noise(v, hit(v, filter(v, v.out, 'lowpass', 320, .9), t, .003, .24, .9).g, t, t + .28);
        crackle(v, filter(v, v.out, 'bandpass', 1600, 1), t + .01, .18, 6, .3);
      },
      slam(v, t, o) {
        KIT.thud(v, t, o);
        osc(v, hit(v, v.out, t, .002, .5, .7).g, 'sine', t, t + .55, [[0, 58], [.45, 27]]);
        noise(v, hit(v, filter(v, v.out, 'bandpass', 420, 1.6), t, .002, .45, .6).g, t, t + .5);
        crackle(v, filter(v, v.out, 'bandpass', 2400, 1.1), t, .22, 14, .8);
        osc(v, hit(v, v.out, t + .07, .004, .28, .25).g, 'sine', t + .07, t + .36, [[0, 64], [.25, 32]]);
      },
      ring(v, t, o) {
        const len = 2.6;
        for (const [f, w] of [[5200, 1], [7050, .55], [5232, .5]]) osc(v, shape(v, v.out, t, len, w, [[.05, 1], [.4, .7], [1, 0]]).g, 'sine', t, t + len + .01, [[0, f * o.pitch]]);
      },
      screech(v, t, o) {
        const len = clamp(o.length || 1.15, .3, 2.4), f0 = (VOICES[o.kind] || 240) * o.pitch, soft = o.soft;
        const tract = add(v, context.createGain()), hp = filter(v, v.out, 'highpass', 160, .7);
        for (const [f, q, w] of [[f0 * 2.6 + 500, 4, 1], [f0 * 6 + 1400, 5, .6], [3200, 3, .35]]) tract.connect(filter(v, gain(v, hp, w), 'bandpass', f, q));
        const e = shape(v, soft ? tract : shaper(v, tract), t, len, soft ? .5 : 1, [[.03, .6], [.08, 1], [.4, .85], [.6, 1], [.85, .8], [1, 0]]);
        const vib = add(v, context.createOscillator()), wobble = add(v, context.createGain());
        vib.type = 'sine'; vib.frequency.value = rand(6, 9); wobble.gain.value = f0 * .04; vib.connect(wobble);
        for (const ratio of [1, 1.013, 1.51, 2.03]) {
          const s = osc(v, e.g, 'sawtooth', t, e.end, [[0, f0 * ratio * .8], [.08, f0 * ratio * 1.08], [len * .5, f0 * ratio], [len, f0 * ratio * .72]]);
          wobble.connect(s.frequency);
        }
        run(v, vib, t, e.end);
        // The big ones roar from the chest as well.
        if (f0 < 150) osc(v, shape(v, soft ? v.out : shaper(v, v.out), t, len, .5, [[.05, 1], [.7, .8], [1, 0]]).g, 'sawtooth', t, t + len + .01, [[0, f0 * .5], [len, f0 * .42]]);
        noise(v, shape(v, filter(v, v.out, 'bandpass', 2800, .9), t, len, .55, [[.05, 1], [.7, .8], [1, 0]]).g, t, t + len + .01, 1.2);
      },
      impale(v, t, o) {
        const scrape = filter(v, v.out, 'bandpass', 4200, 7);
        noise(v, shape(v, scrape, t, .32, 1, [[.05, 1], [.5, .6], [1, 0]]).g, t, t + .33, 1.3);
        for (const [p, w, d] of [[1, .25, .5], [2.76, .12, .35], [5.4, .06, .2]]) osc(v, hit(v, v.out, t, .002, d, w).g, 'triangle', t, t + d + .01, [[0, 1900 * p * o.pitch]]);
        KIT.crunch(v, t + .03, o); KIT.squelch(v, t + .06, o);
      },
      dirt(v, t, o) {
        crackle(v, filter(v, v.out, 'lowpass', 2600, .7), t, .55, Math.round(30 + 20 * o.level), .9, [.003, .02]);
        noise(v, shape(v, filter(v, v.out, 'lowpass', 1100, .7), t, .6, .6, [[.05, 1], [.3, .6], [1, 0]]).g, t, t + .61, .8);
        osc(v, hit(v, v.out, t, .004, .2, .55).g, 'sine', t, t + .22, [[0, 90], [.18, 45]]);
      },
      flat(v, t, o) {
        const len = 3.2;
        osc(v, shape(v, v.out, t, len, 1, [[.02, 1], [.85, .9], [1, 0]]).g, 'sine', t, t + len + .01, [[0, 980]]);
        osc(v, shape(v, v.out, t, len, .25, [[.02, 1], [.85, .9], [1, 0]]).g, 'sine', t, t + len + .01, [[0, 1960]]);
        osc(v, shape(v, v.out, t, len, 6, [[.3, .5], [.7, 1], [1, 0]]).g, 'sine', t, t + len + .01, [[0, 44]]);
      }
    };

    function play(cue, opts) {
      if (inactive() || !CUES.includes(cue)) return null;
      const o = opts && typeof opts === 'object' ? opts : {};
      const soft = o.effects === false, level = LEVELS[cue] * clamp(Number.isFinite(o.level) ? o.level : 1, 0, 1.5) * (soft && cue !== 'flat' ? .6 : 1);
      if (level <= 0) return null;
      let v = null;
      try {
        v = voice(cue, level);
        const t = Math.max(context.currentTime + .005, Number.isFinite(o.at) ? o.at : 0);
        KIT[cue](v, t, { level: clamp(Number.isFinite(o.level) ? o.level : 1, 0, 1.5), pitch: clamp(Number.isFinite(o.pitch) ? o.pitch : 1, .4, 2.5) * rand(.96, 1.04), kind: o.kind, soft, length: o.length });
        if (!v.sources.size) throw new Error('silent cue');
        played++; log.push(cue); if (log.length > 32) log.shift();
        return v.id;
      } catch (error) {
        if (v) release(v);
        return null;
      }
    }

    // Heartbeat: bpm 0 stops it. update() schedules beats a little ahead on the audio clock.
    function setHeart(bpm, level) { heart.bpm = clamp(Number(bpm) || 0, 0, 220); heart.level = clamp(Number.isFinite(level) ? level : .8, 0, 1); if (!heart.bpm) heart.nextAt = 0; }
    function beat(at, strain) {
      const v = voice('heart', .5 * heart.level), body = filter(v, v.out, 'lowpass', 300, .8), gap = .32 - .12 * strain;
      for (const [type, w, ratio] of [['sine', 1, 1], ['triangle', .4, 2.02]]) {
        const f = (50 + 12 * strain) * ratio;
        osc(v, hit(v, body, at, .008, .17, w).g, type, at, at + .2, [[0, f], [.12, f * .6]]);
        osc(v, hit(v, body, at + gap, .008, .14, w * .62).g, type, at + gap, at + gap + .17, [[0, f * 1.1], [.1, f * .7]]);
      }
      noise(v, hit(v, body, at, .005, .1, .45).g, at, at + .12, .5);
    }
    function update() {
      if (inactive() || !heart.bpm || heart.level < .01) return;
      const now = context.currentTime;
      try {
        if (!heart.nextAt || heart.nextAt < now - .3) heart.nextAt = now + .02;
        while (heart.nextAt <= now + LOOKAHEAD) { beat(Math.max(heart.nextAt, now + .005), clamp((heart.bpm - 50) / 120, 0, 1)); heart.nextAt += 60 / heart.bpm; }
      } catch (error) { heart.bpm = 0; }
    }
    function stop(fade) {
      heart.bpm = 0; heart.nextAt = 0;
      if (!bus) { for (const v of Array.from(voices)) release(v); return; }
      const f = clamp(Number.isFinite(fade) ? fade : .05, .005, 3), old = bus, list = Array.from(voices), now = context.currentTime;
      bus = null;
      try { old.mix.gain.cancelScheduledValues(now); old.mix.gain.setValueAtTime(old.mix.gain.value, now); old.mix.gain.linearRampToValueAtTime(0, now + f); } catch (e) { /* closing */ }
      for (const v of list) { voices.delete(v); const at = Math.max(now, Math.min(v.end, now + f + .01)); for (const s of v.sources) { try { s.stop(at); } catch (e) { /* stopped */ } } }
      const done = () => { for (const v of list) release(v); for (const n of old.nodes) { try { n.disconnect(); } catch (e) { /* gone */ } } };
      if (inactive() || !list.length) done();
      else { let left = list.reduce((n, v) => n + v.sources.size, 0); for (const v of list) for (const s of v.sources) s.onended = () => { if (--left <= 0) done(); }; }
    }
    function snapshot() {
      return { voices: voices.size, maxVoices: MAX_VOICES, played, heart: { bpm: heart.bpm, level: heart.level }, recent: log.slice(-12), bus: !!bus };
    }
    return Object.freeze({ play, heart: setHeart, update, stop, snapshot });
  }
  return Object.freeze({ create, CUES: Object.freeze(CUES.slice()), VOICES: Object.freeze(Object.assign({}, VOICES)) });
});

/* Call-of-Duty style first-person camera + viewmodel motion. Pure math (no THREE). update() mutates and
   returns one pose object (no per-frame allocation). Springs are stepped with exact closed-form solutions
   and every blend is an exact exponential, so motion is the same at 30, 60 or 144 fps. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HollowCameraFX = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DEG = Math.PI / 180, TAU = Math.PI * 2;
  // Amplitude pairs are [at walkSpeed, at runSpeed]; slower speeds scale linearly down to 0.
  const TUNING = deepFreeze({
    maxDt: .1, walkSpeed: 3, runSpeed: 6.8,
    cadence: { idle: 1.35, walk: 2, run: 2.95, max: 3.4, crouch: .8 },
    bob: { dip: [.025, .06], side: [.015, .035], nod: [.26 * DEG, .63 * DEG], roll: [.34 * DEG, .92 * DEG],
      yaw: [.12 * DEG, .4 * DEG], attack: [.18, .12], crouch: .95, aim: .25, tired: 1.12 },
    gun: { x: [.006, .022], y: [.004, .014], z: [.002, .007], pitch: [.35 * DEG, 1.1 * DEG],
      yaw: [.45 * DEG, 1.7 * DEG], roll: [.7 * DEG, 2.9 * DEG], aim: .2 },
    lean: { walk: 2.5 * DEG, run: 3 * DEG, slide: 4 * DEG },
    sprint: { fov: 8, pitch: -1.1 * DEG },
    land: { min: 1.5, perSpeed: .0135, max: .12, nodFrom: 4.5, nodPerSpeed: .006, nodMax: .05, fov: -2.5, traumaFrom: 9 },
    trauma: { decay: 1.25, rot: 3 * DEG, pos: .03, danger: .05, slide: .035, hz: [6.5, 13.7, 28.1], amp: [.6, .28, .12] },
    kick: { motionOff: .25, gunMotionOff: .4, gunZ: .1, gunPitch: .16, max: .15 },
    punch: { roll: 4.3 * DEG, yaw: 2.6 * DEG, pitch: 3.4 * DEG, fov: -3 },
    sway: { gain: .035, yaw: 4.3 * DEG, pitch: 3.2 * DEG, aim: .35 },
    breath: { idleHz: .24, tiredHz: .42, dangerHz: .07, idlePitch: .04 * DEG, tiredPitch: .6 * DEG },
    woozy: { from: 45, full: 10, roll: 1.5 * DEG },
    // [omega rad/s, damping ratio]
    springs: { kick: [27, .75], gunKick: [30, .6], land: [12, .55], nod: [10, .5], gunLand: [9.5, .42],
      punch: [14, .42], lean: [8, .9], sway: [12, .55] },
    limits: { pos: [.12, .2, .1], rot: .3, fov: [-12, 14], gunPos: .2, gunRot: .45 }
  });
  const EMPTY = Object.freeze({});
  function deepFreeze(o) { for (const k in o) if (o[k] && typeof o[k] === 'object') deepFreeze(o[k]); return Object.freeze(o); }
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const num = v => typeof v === 'number' && Number.isFinite(v) ? v : 0;
  const out = (v, lim) => v !== v ? 0 : v < -lim ? -lim : v > lim ? lim : v;
  const smoothstep = (a, b, v) => { const x = clamp((v - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
  const approach = (cur, target, rate, dt) => target + (cur - target) * Math.exp(-rate * dt);
  const bySpeed = (pair, s, walk, run) => s <= walk ? pair[0] * s / walk
    : pair[0] + (pair[1] - pair[0]) * Math.min(1.15, (s - walk) / (run - walk));
  function cadence(s, walk, run) {
    const c = TUNING.cadence;
    return s <= walk ? c.idle + (c.walk - c.idle) * s / walk : Math.min(c.max, c.walk + (c.run - c.walk) * (s - walk) / (run - walk));
  }
  // Heel strike: sharp drop right after the plant (u=0), smooth rise back by the next plant.
  const dip = (u, a) => u < a ? Math.sin(Math.PI / 2 * u / a) : .5 + .5 * Math.cos(Math.PI * (u - a) / (1 - a));

  function springKind(omega, zeta) {
    zeta = Math.min(zeta, 1);
    const crit = zeta >= .999, wd = omega * Math.sqrt(Math.max(0, 1 - zeta * zeta));
    const peakT = crit ? 1 / omega : Math.atan2(wd, zeta * omega) / wd;
    // gain: velocity impulse that peaks at exactly 1 from rest.
    return { omega, zeta, wd, crit, m: new Float64Array(4), gain: crit ? omega * Math.E : omega * Math.exp(zeta * omega * peakT) };
  }
  function prepare(k, dt) {
    const m = k.m, w = k.omega;
    if (k.crit) { const e = Math.exp(-w * dt); m[0] = e * (1 + w * dt); m[1] = e * dt; m[2] = -e * w * w * dt; m[3] = e * (1 - w * dt); return; }
    const e = Math.exp(-k.zeta * w * dt), c = Math.cos(k.wd * dt), s = Math.sin(k.wd * dt) / k.wd, zw = k.zeta * w;
    m[0] = e * (c + zw * s); m[1] = e * s; m[2] = -e * w * w * s; m[3] = e * (c - zw * s);
  }
  function stepSpring(sp, k, target) {
    const dx = sp.x - target, v = sp.v, m = k.m;
    sp.x = target + m[0] * dx + m[1] * v; sp.v = m[2] * dx + m[3] * v;
  }
  function hash(i, ch, sh) {
    let h = (Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(ch + 1, 0x165667b1) ^ sh) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
    return (h >>> 0) / 2147483647.5 - 1;
  }
  // 1D gradient noise in [-1, 1] (quintic fade, C2 smooth).
  function gnoise(x, ch, sh) {
    const i = Math.floor(x), f = x - i, u = f * f * f * (f * (f * 6 - 15) + 10);
    const a = hash(i, ch, sh) * f, b = hash(i + 1, ch, sh) * (f - 1);
    return 2 * (a + (b - a) * u);
  }
  function fbm(t, ch, sh) {
    const z = TUNING.trauma;
    return z.amp[0] * gnoise(t * z.hz[0], ch, sh) + z.amp[1] * gnoise(t * z.hz[1], ch + 16, sh) + z.amp[2] * gnoise(t * z.hz[2], ch + 32, sh);
  }

  function create(options) {
    const raw = typeof options === 'number' ? options : options && options.seed;
    const seed = Number.isFinite(raw) ? raw | 0 : 1337, seedHash = hash(seed, 977, 0x5bd1e995) * 2147483647 | 0;
    const K = {}; for (const name in TUNING.springs) K[name] = springKind(TUNING.springs[name][0], TUNING.springs[name][1]);
    const S = {}, impulse = [];
    for (const [name, kind] of [['kickP', 'kick'], ['kickY', 'kick'], ['kickR', 'kick'], ['gKz', 'gunKick'], ['gKp', 'gunKick'],
      ['gKy', 'gunKick'], ['gKr', 'gunKick'], ['landY', 'land'], ['landF', 'land'], ['landP', 'nod'], ['landR', 'nod'],
      ['gLandY', 'gunLand'], ['gLandP', 'gunLand'], ['punchP', 'punch'], ['punchY', 'punch'], ['punchR', 'punch'],
      ['punchF', 'punch'], ['gPunchX', 'punch'], ['gPunchY', 'punch'], ['gPunchR', 'punch']]) {
      S[name] = { x: 0, v: 0 }; impulse.push(S[name], K[kind]);
    }
    S.lean = { x: 0, v: 0 }; S.swayX = { x: 0, v: 0 }; S.swayY = { x: 0, v: 0 };
    const pose = { pos: { x: 0, y: 0, z: 0 }, rot: { pitch: 0, yaw: 0, roll: 0 }, fov: 0,
      weapon: { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 }, footstep: 0, stepIntensity: 0 };
    let rngState, t, p, steps, stepRate, trauma, sSpeed, gait, sprint, aim, crouch, slide, air, breath, breathHz, phi,
      wooz, danger, slideSide, mo;

    function rng() {
      rngState = (rngState + 0x6d2b79f5) | 0;
      let r = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    }
    function bump(sp, dv, cap) { sp.v = clamp(sp.v + dv, -cap, cap); }
    function reset() {
      rngState = seed; t = 0; p = .5; steps = 0; stepRate = 0; trauma = 0; sSpeed = 0; gait = 0; sprint = 0; aim = 0;
      crouch = 0; slide = 0; air = 0; breath = 0; breathHz = TUNING.breath.idleHz; phi = 0; wooz = 0; danger = 0;
      slideSide = 1; mo = 1;
      for (const name in S) S[name].x = S[name].v = 0;
      const P = pose.pos, R = pose.rot, W = pose.weapon;
      P.x = P.y = P.z = R.pitch = R.yaw = R.roll = W.x = W.y = W.z = W.pitch = W.yaw = W.roll = 0;
      pose.fov = pose.footstep = pose.stepIntensity = 0;
    }
    reset();

    function addTrauma(amount) { trauma = clamp(trauma + num(amount), 0, 1); }
    function kick(pitch, yaw) {
      const kp = clamp(num(pitch), -.3, .3), ky = clamp(num(yaw), -.3, .3), mag = Math.hypot(kp, ky);
      if (!mag) return;
      const g = K.kick.gain, gg = K.gunKick.gain, cap = TUNING.kick.max * g;
      bump(S.kickP, kp * g, cap); bump(S.kickY, ky * g, cap); bump(S.kickR, (rng() * 2 - 1) * mag * .35 * g, cap * .5);
      bump(S.gKz, TUNING.kick.gunZ * Math.tanh(mag * 25) * gg, .15 * gg);
      bump(S.gKp, TUNING.kick.gunPitch * Math.tanh(kp * 16) * gg, .25 * gg);
      bump(S.gKy, (ky * 2 + (rng() * 2 - 1) * mag * .15) * gg, .12 * gg);
      bump(S.gKr, (rng() * 2 - 1) * mag * .8 * gg, .12 * gg);
    }
    function land(impactSpeed) {
      const L = TUNING.land, v = Math.min(30, Math.abs(num(impactSpeed)));
      if (v <= L.min) return;
      const depth = Math.min(L.max, (v - L.min) * L.perSpeed), nod = clamp((v - L.nodFrom) * L.nodPerSpeed, 0, L.nodMax);
      const gl = K.land.gain, gn = K.nod.gain, gw = K.gunLand.gain;
      bump(S.landY, -depth * gl, L.max * 1.1 * gl);
      bump(S.landF, depth / L.max * L.fov * gl, Math.abs(L.fov) * 1.1 * gl);
      bump(S.landP, -nod * gn, L.nodMax * 1.2 * gn);
      bump(S.landR, (rng() * 2 - 1) * nod * .5 * gn, L.nodMax * .6 * gn);
      bump(S.gLandY, -depth * .5 * gw, L.max * .6 * gw);
      bump(S.gLandP, -(depth * .45 + nod * .5) * gw, .1 * gw);
      if (v > L.traumaFrom) addTrauma((v - L.traumaFrom) * .07);
    }
    function punch(x, y) {
      let px = clamp(num(x), -1.5, 1.5), py = clamp(num(y), -1.5, 1.5);
      if (!px && !py) { const a = rng() * TAU; px = Math.cos(a) * .7; py = Math.sin(a) * .7; }
      const P = TUNING.punch, g = K.punch.gain, m = Math.min(1.5, Math.hypot(px, py)), c = 1.6 * g;
      // A hit from the right (x>0) knocks the view away from it: roll and yaw to the left.
      bump(S.punchR, px * P.roll * g, P.roll * c); bump(S.punchY, px * P.yaw * g, P.yaw * c);
      bump(S.punchP, py * P.pitch * g, P.pitch * c); bump(S.punchF, m * P.fov * g, Math.abs(P.fov) * c);
      bump(S.gPunchX, -px * .03 * g, .05 * c); bump(S.gPunchY, -m * .025 * g, .04 * c); bump(S.gPunchR, px * .09 * g, .14 * c);
    }
    const kinds = Object.keys(K).map(name => K[name]);
    function update(dt, input) {
      const I = input && typeof input === 'object' ? input : EMPTY;
      dt = num(dt); dt = dt > 0 ? Math.min(dt, TUNING.maxDt) : 0;
      const walk = num(I.walkSpeed) > .1 ? I.walkSpeed : TUNING.walkSpeed;
      const run = Math.max(walk + .5, num(I.runSpeed) > .1 ? I.runSpeed : TUNING.runSpeed);
      const speed = clamp(num(I.speed), 0, 30), strafe = clamp(num(I.strafe), -1, 1);
      const aiming = !!I.aiming, onGround = !!I.onGround, sliding = !!I.sliding, exhausted = !!I.exhausted;
      const grounded = onGround && !sliding;
      const stamina = Number.isFinite(I.stamina) ? clamp(I.stamina, 0, 1) : 1;
      const health = Number.isFinite(I.health) ? clamp(I.health, 0, 100) : 100;
      t += dt;
      sprint = approach(sprint, I.running || sliding ? smoothstep(walk * .9, run * .95, speed) : 0, 5, dt);
      aim = approach(aim, aiming ? 1 : 0, 12, dt);
      crouch = approach(crouch, I.crouching ? 1 : 0, 8, dt);
      slide = approach(slide, sliding ? 1 : 0, 9, dt);
      air = approach(air, onGround ? 0 : 1, 8, dt);
      gait = approach(gait, grounded ? 1 : 0, 10, dt);
      sSpeed = approach(sSpeed, speed, 7, dt);
      danger = approach(danger, clamp(num(I.danger), 0, 1), 3, dt);
      const breathTarget = exhausted ? 1 : (1 - stamina) * .35, W = TUNING.woozy, B = TUNING.breath;
      breath = approach(breath, breathTarget, breathTarget > breath ? 2.5 : .6, dt);
      wooz = approach(wooz, clamp((W.from - health) / (W.from - W.full), 0, 1), 1.2, dt);
      const hz = B.idleHz + (B.tiredHz - B.idleHz) * breath + B.dangerHz * danger;
      phi = (phi + Math.PI * (breathHz + hz) * dt) % TAU; breathHz = hz;

      // Step cycle: advances with the gait (distance / stride), plants fire exactly on integer crossings.
      const gate = grounded ? smoothstep(.2, .8, speed) : 0;
      stepRate = cadence(speed, walk, run) * (1 - (1 - TUNING.cadence.crouch) * crouch) * gate;
      let foot = 0;
      if (dt > 0) {
        const np = p + stepRate * dt, k = Math.floor(np);
        if (k !== Math.floor(p)) { foot = k & 1 ? -1 : 1; steps++; }
        p = np >= 2 ? np - 2 : np;
        // Standing still: glide to mid-step so the first plant after starting lands ~half a step later.
        const glide = 1 - smoothstep(0, .15, gate);
        if (glide > 0) p += (.5 - (p - Math.floor(p))) * (1 - Math.exp(-4 * glide * dt));
      }
      if (sliding && Math.abs(strafe) > .2) slideSide = strafe > 0 ? -1 : 1;

      for (let i = 0; i < kinds.length; i++) prepare(kinds[i], dt);
      for (let i = 0; i < impulse.length; i += 2) stepSpring(impulse[i], impulse[i + 1], 0);
      const L = TUNING.lean, SW = TUNING.sway, steady = 1 - (1 - SW.aim) * aim;
      stepSpring(S.lean, K.lean, -strafe * (L.walk + (L.run - L.walk) * sprint) * clamp(speed / (walk * .6), 0, 1) * (1 - .5 * aim)
        + (sliding ? L.slide * slideSide : 0));
      const lx = dt > 0 ? clamp(num(I.lookDX) / dt, -40, 40) : 0, ly = dt > 0 ? clamp(num(I.lookDY) / dt, -40, 40) : 0;
      stepSpring(S.swayX, K.sway, SW.yaw * Math.tanh(-lx * SW.gain / SW.yaw) * steady);
      stepSpring(S.swayY, K.sway, SW.pitch * Math.tanh(-ly * SW.gain / SW.pitch) * steady);
      trauma = Math.max(0, trauma - TUNING.trauma.decay * dt);
      let guard = p + phi + sprint + breath + sSpeed + S.lean.x + S.lean.v + S.swayX.x + S.swayX.v + S.swayY.x + S.swayY.v;
      for (let i = 0; i < impulse.length; i += 2) guard += impulse[i].x + impulse[i].v;
      if (!Number.isFinite(guard)) reset();
      mo = I.motion ? 1 : 0;

      // Camera bob: heel-strike dip + nod at step rate, lateral sway + roll at half rate.
      const BOB = TUNING.bob, GUN = TUNING.gun, s = sSpeed;
      const theta = Math.PI * p, sT = Math.sin(theta), cT = Math.cos(theta);
      const d = dip(p - Math.floor(p), BOB.attack[0] + (BOB.attack[1] - BOB.attack[0]) * sprint);
      const amp = gait * mo * (1 - (1 - BOB.aim) * aim), tired = 1 + (BOB.tired - 1) * breath;
      let px = -bySpeed(BOB.side, s, walk, run) * amp * (1 - .2 * crouch) * sT, pz = 0;
      let py = -bySpeed(BOB.dip, s, walk, run) * amp * (1 - (1 - BOB.crouch) * crouch) * tired * d;
      let rp = -bySpeed(BOB.nod, s, walk, run) * amp * (1 - .4 * crouch) * tired * d;
      let ry = bySpeed(BOB.yaw, s, walk, run) * amp * cT, rr = bySpeed(BOB.roll, s, walk, run) * amp * sT;
      let fov = TUNING.sprint.fov * sprint * mo;
      rp += TUNING.sprint.pitch * sprint * mo;
      // Viewmodel figure-8: lateral at half rate, vertical at step rate, lowest just after each plant.
      const gAmp = gait * mo * (1 - (1 - GUN.aim) * aim) * (1 - .2 * crouch), c2 = Math.cos(2 * theta - .6);
      let wx = bySpeed(GUN.x, s, walk, run) * gAmp * sT, wy = -bySpeed(GUN.y, s, walk, run) * gAmp * c2;
      let wz = bySpeed(GUN.z, s, walk, run) * gAmp * Math.cos(2 * theta), wp = -bySpeed(GUN.pitch, s, walk, run) * gAmp * c2;
      let wyaw = bySpeed(GUN.yaw, s, walk, run) * gAmp * Math.sin(theta + .4), wr = -bySpeed(GUN.roll, s, walk, run) * gAmp * sT;
      rr += S.lean.x * mo; wx += S.lean.x * .22 * mo; wr += S.lean.x * .9 * mo;
      wr += .12 * slide * slideSide * mo; wx -= .01 * slide * mo;
      wy += .008 * air * mo; wp += .012 * air * mo;

      // Breathing (idle -> exhausted), slow drift of the held weapon.
      const b = (Math.sin(phi) + .22 * Math.sin(2 * phi + .9)) / 1.12;
      rp += (B.idlePitch + (B.tiredPitch - B.idlePitch) * breath) * b * mo;
      py += (.0005 + .0035 * breath) * b * mo; rr += .0025 * breath * Math.cos(phi + .7) * mo;
      const idle = mo * (1 - .65 * aim * (1 - .5 * breath)) * (1 + 2.2 * breath);
      wy += .0016 * idle * b - .006 * breath * mo; wp += .004 * idle * b;
      wx += .0012 * idle * Math.sin(TAU * .13 * t + .7); wyaw += .003 * idle * Math.sin(TAU * .11 * t + 1.9);
      wr += .004 * idle * Math.sin(TAU * .09 * t + .3);
      if (wooz > 1e-4) {
        const z = wooz * mo;
        rr += W.roll * z * (.72 * Math.sin(TAU * .13 * t) + .28 * Math.sin(TAU * .31 * t + 1.7));
        rp += .006 * z * Math.sin(TAU * .083 * t + .5); ry += .006 * z * Math.sin(TAU * .097 * t + 2.3);
        fov += 1.1 * z * Math.sin(TAU * .11 * t + .9);
        wr += .05 * z * Math.sin(TAU * .13 * t + .4); wy -= .012 * z; wp -= .02 * z;
      }
      // Trauma^2 shake (+ faint danger tremor and slide rumble) from seeded multi-octave noise.
      const Z = TUNING.trauma, shake = Math.min(1, trauma * trauma + Z.danger * danger + Z.slide * slide * Math.min(1, speed / run)) * mo;
      if (shake > 1e-6) {
        rp += Z.rot * shake * fbm(t, 0, seedHash); ry += Z.rot * shake * fbm(t, 1, seedHash); rr += Z.rot * shake * fbm(t, 2, seedHash);
        px += Z.pos * shake * fbm(t, 3, seedHash); py += Z.pos * shake * fbm(t, 4, seedHash); pz += Z.pos * .5 * shake * fbm(t, 5, seedHash);
        wx += .004 * shake * fbm(t, 6, seedHash); wy += .004 * shake * fbm(t, 7, seedHash); wr += .01 * shake * fbm(t, 8, seedHash);
      }
      const kc = mo ? 1 : TUNING.kick.motionOff, kg = mo ? 1 : TUNING.kick.gunMotionOff;
      rp += S.kickP.x * kc; ry += S.kickY.x * kc; rr += S.kickR.x * mo;
      wz += S.gKz.x * kg; wp += S.gKp.x * kg; wy += S.gKp.x * .08 * kg; wyaw += S.gKy.x * kg; wr += S.gKr.x * kg;
      py += S.landY.x * mo; fov += S.landF.x * mo; rp += S.landP.x * mo; rr += S.landR.x * mo;
      wy += S.gLandY.x * mo; wp += S.gLandP.x * mo;
      rp += S.punchP.x * mo; ry += S.punchY.x * mo; rr += S.punchR.x * mo; fov += S.punchF.x * mo;
      wx += S.gPunchX.x * mo; wy += S.gPunchY.x * mo; wr += S.gPunchR.x * mo;
      // Look sway: the weapon lags behind the turn (offset + cant toward the lag side).
      wyaw += S.swayX.x * mo; wx -= S.swayX.x * .12 * mo; wr += S.swayX.x * .5 * mo;
      wp += S.swayY.x * mo; wy += S.swayY.x * .1 * mo;

      const Lm = TUNING.limits, P = pose.pos, R = pose.rot, G = pose.weapon;
      P.x = out(px, Lm.pos[0]); P.y = out(py, Lm.pos[1]); P.z = out(pz, Lm.pos[2]);
      R.pitch = out(rp, Lm.rot); R.yaw = out(ry, Lm.rot); R.roll = out(rr, Lm.rot);
      pose.fov = fov === fov ? clamp(fov, Lm.fov[0], Lm.fov[1]) : 0;
      G.x = out(wx, Lm.gunPos); G.y = out(wy, Lm.gunPos); G.z = out(wz, Lm.gunPos);
      G.pitch = out(wp, Lm.gunRot); G.yaw = out(wyaw, Lm.gunRot); G.roll = out(wr, Lm.gunRot);
      pose.footstep = foot;
      pose.stepIntensity = clamp(Math.pow(Math.min(speed, run * 1.2) / run, 1.3) * (1 - .45 * crouch) * (exhausted ? 1.1 : 1)
        * (1 - .15 * aim), 0, 1) * gate;
      return pose;
    }
    function snapshot() {
      return { trauma, phase: p, stepRate, steps, time: t, gait, sprint, aim, crouch, slide, air, breath, breathHz, wooz, danger,
        lean: S.lean.x, swayYaw: S.swayX.x, swayPitch: S.swayY.x, kickPitch: S.kickP.x, landing: S.landY.x, motion: mo,
        footstep: pose.footstep, stepIntensity: pose.stepIntensity };
    }
    return Object.freeze({ update, addTrauma, kick, land, punch, reset, snapshot, pose });
  }
  return Object.freeze({ create, TUNING });
});

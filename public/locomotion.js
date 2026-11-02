/* Player locomotion: eased sprint, stamina and exhaustion, slides and jump costs. Pure and
   renderer-independent; dt-linear ramps keep 30, 60 and 144 fps in agreement. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HollowLocomotion = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Mirrors HollowSystems.PLAYER, used when it is missing or incomplete.
  const DEFAULTS = Object.freeze({
    walk: 3, run: 6.8, crouch: 1.5, aimWalk: 2.1, sprintAccel: .45,
    staminaDrain: 1 / 7, staminaRegenIdle: 1 / 5, staminaRegenMove: 1 / 8,
    exhaustedRecover: .35, exhaustedSpeed: .85, jumpCost: .08, slideCost: .16, slideSpeed: 7.5, slideTime: .65
  });
  const TUNING = Object.freeze({
    sprintRelease: .25, regenDelay: .6, sprintForward: .5, strafe: .9, backpedal: .75,
    slideMinStamina: .2, moveThreshold: .08, maxDt: .1
  });
  const EVENTS = Object.freeze({ EXHAUSTED: 1, RECOVERED: 2, SPRINT_START: 4, SPRINT_STOP: 8, SLIDE_START: 16, SLIDE_END: 32, JUMP: 64 });
  const NOISE = Object.freeze({ idle: .02, crouch: .09, walk: .3, sprint: .8, slide: .8 });
  const EMPTY = Object.freeze({});

  function axis(value) {
    const v = Number(value);
    return v === v ? (v > 1 ? 1 : v < -1 ? -1 : v) : 0;
  }

  function create(player) {
    const P = {};
    for (const key of Object.keys(DEFAULTS)) {
      const v = player && typeof player === 'object' ? Number(player[key]) : NaN;
      P[key] = v > 0 && v < Infinity ? v : DEFAULTS[key];
    }
    Object.freeze(P);
    const s = { speed: P.walk, running: false, sprint: 0, stamina: 1, exhausted: false, sliding: false, slideT: 0,
      crouching: false, moving: false, events: 0, noise: NOISE.idle };
    let ramp = 0, regenWait = 0, pending = 0, onGround = true;

    function reset() {
      ramp = regenWait = pending = 0; onGround = true;
      s.speed = P.walk; s.running = false; s.sprint = 0; s.stamina = 1; s.exhausted = false; s.sliding = false;
      s.slideT = 0; s.crouching = false; s.moving = false; s.events = 0; s.noise = NOISE.idle;
    }

    function update(dt, input) {
      dt = typeof dt === 'number' && dt > 0 ? (dt < TUNING.maxDt ? dt : TUNING.maxDt) : 0;
      const i = input && typeof input === 'object' ? input : EMPTY;
      let forward = axis(i.forward), strafe = axis(i.strafe), m = Math.hypot(forward, strafe);
      if (m > 1) { forward /= m; strafe /= m; m = 1; }
      const moving = typeof i.moving === 'boolean' ? i.moving : m > TUNING.moveThreshold;
      const aiming = !!i.aiming, wasRunning = s.running;
      onGround = !!i.onGround;
      let events = pending;
      pending = 0;
      if (s.sliding) {
        s.slideT -= dt;
        if (s.slideT <= 0) { s.slideT = 0; s.sliding = false; events |= EVENTS.SLIDE_END; }
      }
      const crouching = !!i.crouch || s.sliding;
      // Cosine between the input and straight ahead: 1 forward, 0 pure strafe, -1 backpedal.
      const ahead = m > 1e-6 ? forward / m : 1;
      let running = !!i.sprint && moving && m > 1e-6 && ahead >= TUNING.sprintForward && !crouching && !aiming &&
        !s.exhausted && s.stamina > 0;
      if (running) {
        s.stamina -= P.staminaDrain * dt; regenWait = TUNING.regenDelay;
      } else {
        let rest = dt;
        if (regenWait > 0) { const used = regenWait < rest ? regenWait : rest; regenWait -= used; rest -= used; }
        if (rest > 0 && s.stamina < 1) s.stamina = Math.min(1, s.stamina + (moving ? P.staminaRegenMove : P.staminaRegenIdle) * rest);
      }
      if (!s.exhausted && s.stamina <= 1e-9) { s.stamina = 0; s.exhausted = true; running = false; events |= EVENTS.EXHAUSTED; }
      else if (s.exhausted && s.stamina >= P.exhaustedRecover) { s.exhausted = false; events |= EVENTS.RECOVERED; }
      ramp = running ? Math.min(1, ramp + dt / P.sprintAccel) : Math.max(0, ramp - dt / TUNING.sprintRelease);
      if (running !== wasRunning) events |= running ? EVENTS.SPRINT_START : EVENTS.SPRINT_STOP;
      const sprint = 1 - (1 - ramp) * (1 - ramp);
      if (s.sliding) {
        const u = 1 - s.slideT / P.slideTime, k = u * u * (3 - 2 * u);
        s.speed = P.slideSpeed + (P.crouch - P.slideSpeed) * k;
      } else {
        const base = (crouching ? P.crouch : aiming ? P.aimWalk : P.walk) * (s.exhausted ? P.exhaustedSpeed : 1);
        const direction = ahead >= 0 ? TUNING.strafe + (1 - TUNING.strafe) * ahead : TUNING.strafe + (TUNING.strafe - TUNING.backpedal) * ahead;
        s.speed = (base + (P.run - base) * sprint) * direction;
      }
      s.running = running; s.sprint = sprint; s.crouching = crouching; s.moving = moving; s.events = events;
      s.noise = s.sliding ? NOISE.slide : running ? NOISE.sprint : moving ? (crouching ? NOISE.crouch : NOISE.walk) : NOISE.idle;
      return s;
    }

    function jump() {
      if (pending & EVENTS.JUMP || s.crouching || !(s.stamina >= P.jumpCost)) return false;
      s.stamina = Math.max(0, s.stamina - P.jumpCost); regenWait = TUNING.regenDelay; pending |= EVENTS.JUMP;
      onGround = false;
      return true;
    }
    function slide() {
      if (s.sliding || !s.running || !onGround || !(s.stamina > TUNING.slideMinStamina)) return false;
      s.stamina -= P.slideCost; regenWait = TUNING.regenDelay; pending |= EVENTS.SLIDE_START;
      s.sliding = true; s.slideT = P.slideTime; s.crouching = true;
      return true;
    }
    function snapshot() {
      return { speed: s.speed, running: s.running, sprint: s.sprint, stamina: s.stamina, exhausted: s.exhausted,
        sliding: s.sliding, slideT: s.slideT, crouching: s.crouching, moving: s.moving, events: s.events, noise: s.noise,
        ramp, regenDelay: regenWait, onGround };
    }
    return Object.freeze({ update, jump, slide, reset, snapshot, state: s, constants: P });
  }

  return Object.freeze({ create, EVENTS, DEFAULTS, TUNING, NOISE });
});

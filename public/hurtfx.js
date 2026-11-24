/* Getting hit by a creature. plan() is pure: from the blow (its damage, the health it left, where it came from and
   which creature struck) it decides how hard the view is punched and staggered, how long the legs drag, how much the
   ears ring and the world goes dull, and how much blood lands on the screen and where. create() is the pooled DOM
   layer that throws that blood: splats with runs on the side the blow came from, raking gashes from the slashers, a
   bite from below for the crawler, and a red flash at the edge. Every node is made up front, only transform and
   opacity animate (Web Animations, with a timed fallback) and nothing reads layout. The splatter is painted once
   into canvases and copied onto a pooled node when it is used. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.HollowHurtFX = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PI = Math.PI, TAU = PI * 2;
  const POOL = Object.freeze({ splats: 10, claws: 2, bites: 1, variants: 4 });
  // How each creature's blow lands. style: the screen wound (blunt splats, claw rakes, a bite from below). jolt: the
  // sideways punch, pitch: the view knocked up (+) or yanked down (-), trauma: shake, stagger: the view dropping as the
  // legs buckle, slow: [speed at its worst, seconds], ring and muffle: how much a heavy blow rings and dulls the ears,
  // blood: how much lands on the screen. Unknown creatures get DEFAULT scaled by their damage.
  const KINDS = Object.freeze({
    warden: Object.freeze({ style: 'blunt', jolt: 1.3, pitch: .9, trauma: 1.2, stagger: 1.3, slow: Object.freeze([.4, 1.1]), ring: 1, muffle: 1, blood: 1.1 }),
    stalker: Object.freeze({ style: 'claw', jolt: 1.05, pitch: .3, trauma: 1, stagger: .8, slow: Object.freeze([.6, .6]), ring: .35, muffle: .5, blood: 1, marks: 3 }),
    crawler: Object.freeze({ style: 'bite', jolt: .6, pitch: -.7, trauma: .8, stagger: .55, slow: Object.freeze([.45, 1.2]), ring: 0, muffle: .25, blood: .85 }),
    shrieker: Object.freeze({ style: 'claw', jolt: .85, pitch: .25, trauma: .9, stagger: .7, slow: Object.freeze([.6, .7]), ring: .9, muffle: .7, blood: .9, marks: 4 }),
    // The boss's spade and the ground it breaks: the heaviest blow there is, driving the view down into the legs.
    gravekeeper: Object.freeze({ style: 'blunt', jolt: 1.5, pitch: 1.1, trauma: 1.4, stagger: 1.6, slow: Object.freeze([.35, 1.3]), ring: 1, muffle: 1, blood: 1.2 })
  });
  const DEFAULT = Object.freeze({ style: 'blunt', jolt: 1, pitch: .5, trauma: 1, stagger: 1, slow: Object.freeze([.55, .8]), ring: .6, muffle: .7, blood: 1 });
  const STYLES = Object.freeze(['blunt', 'claw', 'bite']);

  function num(value, fallback) { value = Number(value); return Number.isFinite(value) ? value : fallback; }
  function clamp(value, lo, hi) { return value < lo ? lo : value > hi ? hi : value; }
  function round(value) { return Math.round(value * 1000) / 1000; }
  function wrap(angle) { angle %= TAU; return angle > PI ? angle - TAU : angle <= -PI ? angle + TAU : angle; }
  function own(o, key) { return typeof key === 'string' && Object.prototype.hasOwnProperty.call(o, key); }
  function mulberry(seed) {
    let s = seed | 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- the plan (pure) ---------- */
  // info: { damage, health (left after the blow), max, bearing (screen angle of the attacker: 0 ahead, +PI/2 right,
  // as HollowHUDFX.bearing), kind, effects, motion, seed }.
  function plan(info) {
    const i = info && typeof info === 'object' ? info : {};
    const K = own(KINDS, i.kind) ? KINDS[i.kind] : DEFAULT, max = num(i.max, 100) > 0 ? num(i.max, 100) : 100;
    const damage = clamp(num(i.damage, 25), 0, 500), health = clamp(num(i.health, max - damage), 0, max);
    const effects = i.effects !== false, motion = i.motion !== false, rand = mulberry(num(i.seed, 1) >>> 0 || 1);
    // Severity: a Warden blow is about 1.1, a Stalker's .55, a Crawler's bite .3.
    const s = clamp(damage / 60, 0, 1.5), hurt = 1 - health / max, heavy = s >= .8 || (health <= 30 && s >= .3);
    const bearing = wrap(num(i.bearing, 0)), side = Math.sin(bearing), front = Math.cos(bearing);
    const jolt = {
      x: round(clamp(side * K.jolt * (.55 + .6 * s), -1.5, 1.5)),
      y: round(clamp(K.pitch * (.35 + .6 * s) * (front > -.3 ? 1 : -.5), -1.5, 1.5)),
      trauma: round(clamp((.22 + .38 * s) * K.trauma, 0, 1) * (motion ? 1 : .35)),
      stagger: round(clamp(K.stagger * (2.2 + 4.5 * s), 0, 9) * (motion ? 1 : .3))
    };
    const slow = { factor: round(1 - (1 - K.slow[0]) * clamp(.55 + .5 * s, 0, 1)), time: round(K.slow[1] * clamp(.7 + .5 * s, .5, 1.6)) };
    // Ears: a heavy blow (or any blow once badly hurt) rings; every blow dulls the world for a moment.
    const ringing = clamp(K.ring * (s - .25) * 1.4 + (hurt > .7 ? .25 : 0), 0, 1);
    const ring = ringing > .05 ? { gain: round(ringing), time: round(1 + 2.4 * ringing), hz: Math.round(3100 + 900 * rand()) } : null;
    const dull = clamp(K.muffle * (.25 + .75 * s), 0, 1);
    const muffle = { amount: round(dull), time: round(.35 + 1.6 * dull), hz: Math.round(18000 * Math.pow(450 / 18000, dull)) };

    const amount = clamp((.35 + .8 * s) * K.blood, 0, 1.5) * (effects ? 1 : .55);
    const count = clamp(Math.round(1 + 5.5 * amount), 1, POOL.splats), bite = K.style === 'bite';
    const gauss = () => (rand() + rand() + rand() - 1.5) * 1.15;
    const splats = [];
    for (let k = 0; k < count; k++) {
      // Around the edge of the view, heaped on the side the blow came from (a bite comes up from below).
      const a = bite ? PI + side * .5 + gauss() * .75 : bearing + gauss() * (1.25 - .35 * Math.min(1, s));
      const r = .5 + .38 * rand();
      const size = (.15 + .19 * rand()) * (.75 + .45 * Math.min(1.2, s)) * (k === 0 ? 1.35 : 1);
      splats.push({
        x: round(clamp(.5 + .5 * Math.sin(a) * r * 1.15, .03, .97)), y: round(clamp(.5 - .5 * Math.cos(a) * r * 1.1, .04, .96)),
        size: round(size), rot: round((rand() - .5) * .5), variant: Math.floor(rand() * POOL.variants),
        opacity: round(clamp(.55 + .35 * Math.min(1, s) + .1 * rand(), .4, .95) * (effects ? 1 : .8)),
        life: round((1.6 + 2.2 * Math.min(1.2, s) + rand()) * (effects ? 1 : .7)),
        run: round(effects && motion ? (.02 + .05 * rand()) * (1 + s) : 0), delay: round(k * .014)
      });
    }
    const claws = [];
    if (K.style === 'claw') {
      // One rake across the view, swept from the side the claws came from.
      const from = side >= 0 ? 1 : -1;
      claws.push({ x: round(.5 + side * .12), y: round(.46 + (rand() - .5) * .12), angle: round(from * (.42 + .3 * rand())), from,
        length: round(.62 + .25 * Math.min(1.2, s)), marks: K.marks || 3, opacity: round(effects ? .9 : .7),
        life: round((2.2 + 2 * Math.min(1.2, s)) * (effects ? 1 : .7)), sweep: .09 });
    }
    const bites = bite ? [{ x: round(.5 + side * .16), y: .84, size: round(.48 + .2 * Math.min(1.2, s)), opacity: round(effects ? .92 : .72),
      life: round((2.4 + 1.6 * s) * (effects ? 1 : .7)) }] : [];
    const flash = { x: round(.5 + .5 * side), y: round(bite ? 1 : .5 - .5 * front), opacity: round(clamp(.25 + .45 * s, 0, .8) * (effects ? 1 : .5)),
      life: round(.25 + .35 * Math.min(1, s)) };
    return { kind: own(KINDS, i.kind) ? i.kind : null, style: K.style, severity: round(s), heavy, damage, health, bearing: round(bearing),
      jolt, slow, ring, muffle, blood: { amount: round(amount), splats, claws, bites, flash } };
  }

  /* ---------- splatter painted in code ---------- */
  const BLOOD = 'rgb(116,5,8)', DEEP = 'rgb(46,0,2)';
  function paintSplat(ctx, S, seed) {
    const r = mulberry(seed), cx = S * .5, cy = S * .42, R = S * .17;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    // One path for the whole stain, so overlaps never darken: a lumpy core, a few short spines thrown out of it, a spray
    // of satellite drops and runs down from the bottom of the core.
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = r() * TAU, d = R * .55 * Math.sqrt(r()), rr = R * (.28 + .45 * r()), x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      ctx.moveTo(x + rr, y); ctx.arc(x, y, rr, 0, TAU);
    }
    for (let i = 0, n = 4 + Math.floor(r() * 4); i < n; i++) {
      const a = r() * TAU, len = R * (.85 + .75 * r()), w = R * (.05 + .07 * r()), nx = -Math.sin(a), ny = Math.cos(a);
      const bx = cx + Math.cos(a) * R * .5, by = cy + Math.sin(a) * R * .5, tx = cx + Math.cos(a) * len, ty = cy + Math.sin(a) * len;
      ctx.moveTo(bx + nx * w, by + ny * w); ctx.lineTo(tx, ty); ctx.lineTo(bx - nx * w, by - ny * w); ctx.closePath();
      const br = w * (.4 + .45 * r());
      ctx.moveTo(tx + br, ty); ctx.arc(tx, ty, br, 0, TAU);
    }
    for (let i = 0; i < 64; i++) {
      const a = r() * TAU, d = R * (1.05 + 1.9 * Math.pow(r(), .8)), rr = Math.max(.7, S * .013 * Math.pow(r(), 1.6) * (2.6 - d / R * .55));
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      ctx.moveTo(x + rr, y); ctx.arc(x, y, rr, 0, TAU);
    }
    for (let i = 0, n = 3 + Math.floor(r() * 3); i < n; i++) {
      const x = cx + (r() - .5) * R * 1.4, y0 = cy + R * (.2 + .3 * r()), len = S * (.12 + .34 * r()), w = S * (.006 + .01 * r());
      ctx.moveTo(x - w, y0); ctx.lineTo(x - w * .6, y0 + len); ctx.lineTo(x + w * .6, y0 + len); ctx.lineTo(x + w, y0); ctx.closePath();
      ctx.moveTo(x + w * 1.25, y0 + len); ctx.arc(x, y0 + len, w * 1.25, 0, TAU);
    }
    ctx.fillStyle = BLOOD;
    ctx.fill();
    // Thick in the middle, a darker drying rim, and a wet sheen.
    ctx.globalCompositeOperation = 'source-atop';
    const g = ctx.createRadialGradient(cx - R * .2, cy - R * .25, R * .1, cx, cy, R * 3);
    g.addColorStop(0, 'rgba(150,16,14,.5)'); g.addColorStop(.3, 'rgba(90,0,4,0)'); g.addColorStop(1, 'rgba(30,0,0,.7)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = 'rgba(255,190,180,.13)';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath(); ctx.arc(cx + (r() - .6) * R * .8, cy + (r() - .7) * R * .8, R * (.08 + .1 * r()), 0, TAU); ctx.fill();
    }
    ctx.restore();
  }
  // Parallel gashes (left to right) with ragged edges, a deep dark core and blood running down from each.
  function paintClaw(ctx, W, H, seed, marks) {
    const r = mulberry(seed);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    for (let m = 0; m < marks; m++) {
      const y = H * (.2 + .6 * m / Math.max(1, marks - 1)) + (r() - .5) * H * .06, tilt = (r() - .5) * H * .1;
      const x0 = W * (.04 + .08 * r()), x1 = W * (.9 + .08 * r()), thick = H * (.05 + .03 * r());
      const edge = (u, k) => y + tilt * (u - .5) + k * thick * Math.pow(Math.sin(PI * u), .6) * (.75 + .5 * r());
      for (let pass = 0; pass < 2; pass++) {
        const k = pass ? .35 : .5;
        ctx.beginPath();
        ctx.moveTo(x0, y - tilt * .5);
        for (let s = 1; s <= 24; s++) { const u = s / 24; ctx.lineTo(x0 + (x1 - x0) * u, edge(u, -k)); }
        for (let s = 23; s >= 1; s--) { const u = s / 24; ctx.lineTo(x0 + (x1 - x0) * u, edge(u, k)); }
        ctx.closePath();
        ctx.fillStyle = pass ? DEEP : BLOOD;
        ctx.fill();
      }
      ctx.beginPath();
      for (let d = 0, n = 2 + Math.floor(r() * 3); d < n; d++) {
        const u = .15 + .7 * r(), x = x0 + (x1 - x0) * u, top = edge(u, .4), len = H * (.08 + .22 * r()), w = W * (.004 + .004 * r());
        ctx.moveTo(x - w, top); ctx.lineTo(x - w * .6, top + len); ctx.lineTo(x + w * .6, top + len); ctx.lineTo(x + w, top); ctx.closePath();
        ctx.moveTo(x + w * 1.3, top + len); ctx.arc(x, top + len, w * 1.3, 0, TAU);
      }
      ctx.fillStyle = BLOOD;
      ctx.fill();
    }
    ctx.restore();
  }
  // Two arcs of tooth punctures, smeared, with blood welling between them.
  function paintBite(ctx, W, H, seed) {
    const r = mulberry(seed);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    for (let jaw = 0; jaw < 2; jaw++) {
      const cy = jaw ? H * .78 : H * .3, bow = (jaw ? -1 : 1) * H * .22;
      for (let t = 0; t < 9; t++) {
        const u = (t + .5) / 9, x = W * (.1 + .8 * u), y = cy + bow * Math.sin(PI * u) + (r() - .5) * H * .04;
        const w = W * (.012 + .01 * r()), h = H * (.06 + .05 * r()) * (jaw ? -1 : 1);
        ctx.moveTo(x - w, y); ctx.lineTo(x, y + h); ctx.lineTo(x + w, y); ctx.arc(x, y, w, 0, PI, true);
      }
    }
    for (let i = 0; i < 26; i++) {
      const x = W * (.12 + .76 * r()), y = H * (.35 + .4 * r()), rr = W * (.004 + .014 * Math.pow(r(), 2));
      ctx.moveTo(x + rr, y); ctx.arc(x, y, rr, 0, TAU);
    }
    ctx.fillStyle = BLOOD;
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-over';
    const g = ctx.createRadialGradient(W * .5, H * .55, H * .05, W * .5, H * .55, W * .45);
    g.addColorStop(0, 'rgba(110,4,6,.55)'); g.addColorStop(1, 'rgba(110,4,6,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  /* ---------- the DOM layer ---------- */
  const SPLAT = 256, CLAW = [512, 192], BITE = [512, 256];
  function create(options) {
    const o = options && typeof options === 'object' ? options : {};
    const host = o.root && typeof o.root.appendChild === 'function' ? o.root : null;
    const doc = o.document || (host && host.ownerDocument) || null;
    const live = !!(host && doc && typeof doc.createElement === 'function');
    let motion = o.motion !== false, effects = o.effects !== false, disposed = false, clock = 0, hits = 0, last = null;
    let layer = null, animated = false, painted = false;
    const splats = [], claws = [], bites = [], flashes = [], pools = [splats, claws, bites, flashes];
    const art = { splats: [], claws: [], bite: null };

    function canvas(w, h) {
      const c = doc.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
    function context2d(c) { try { return c && typeof c.getContext === 'function' ? c.getContext('2d') : null; } catch (error) { return null; } }
    function node(tag, w, h, css) {
      const n = tag === 'canvas' ? canvas(w, h) : doc.createElement(tag);
      n.style.cssText = 'position:absolute;left:0;top:0;opacity:0;will-change:transform,opacity;' + css;
      n.hidden = true;
      layer.appendChild(n);
      return n;
    }
    function slot(pool, n) { pool.push({ node: n, ctx: null, active: false, end: 0, fade: 0, anims: [], art: -1 }); }

    if (live) {
      layer = doc.createElement('div');
      layer.className = 'hurt-layer';
      layer.setAttribute('aria-hidden', 'true');
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:0;contain:layout paint style';
      // Under the HUD (markers, labels and arcs draw over the blood).
      if (typeof host.insertBefore === 'function' && host.firstChild) host.insertBefore(layer, host.firstChild); else host.appendChild(layer);
      // A touch of blur: blood on the eyes and the lens, not printed on the glass.
      for (let i = 0; i < POOL.splats; i++) slot(splats, node('canvas', SPLAT, SPLAT, 'transform-origin:50% 42%;filter:blur(.7px)'));
      for (let i = 0; i < POOL.claws; i++) slot(claws, node('canvas', CLAW[0], CLAW[1], 'transform-origin:50% 50%'));
      for (let i = 0; i < POOL.bites; i++) slot(bites, node('canvas', BITE[0], BITE[1], 'transform-origin:50% 50%'));
      slot(flashes, node('div', 0, 0, 'inset:0;width:100%;height:100%'));
      animated = typeof layer.animate === 'function';
    }

    // Painted on first use of the layer, once: four splatters, a three- and a four-mark rake, a bite.
    function paint() {
      if (painted || !live) return;
      painted = true;
      for (let v = 0; v < POOL.variants; v++) {
        const c = canvas(SPLAT, SPLAT), ctx = context2d(c);
        if (!ctx) return;
        paintSplat(ctx, SPLAT, 1013 + v * 7919);
        art.splats.push(c);
      }
      for (const marks of [3, 4]) {
        const c = canvas(CLAW[0], CLAW[1]), ctx = context2d(c);
        paintClaw(ctx, CLAW[0], CLAW[1], 77 + marks, marks);
        art.claws[marks] = c;
      }
      const c = canvas(BITE[0], BITE[1]), ctx = context2d(c);
      paintBite(ctx, BITE[0], BITE[1], 4242);
      art.bite = c;
    }
    function copy(item, source) {
      if (!source) return;
      if (!item.ctx) item.ctx = context2d(item.node);
      if (!item.ctx || item.art === source) return;
      item.ctx.clearRect(0, 0, item.node.width, item.node.height);
      item.ctx.drawImage(source, 0, 0);
      item.art = source;
    }

    function stop(item) {
      for (let i = 0; i < item.anims.length; i++) { try { item.anims[i].cancel(); } catch (error) { /* already gone */ } }
      item.anims.length = 0;
    }
    function play(item, frames, life, delay) {
      if (!animated) return;
      try { item.anims.push(item.node.animate(frames, { duration: Math.max(1, Math.round(life * 1000)), delay: Math.max(0, Math.round((delay || 0) * 1000)), fill: 'both' })); }
      catch (error) { /* detached node */ }
    }
    function take(pool) {
      let pick = null;
      for (let i = 0; i < pool.length; i++) {
        const item = pool[i];
        if (!item.active) return item;
        if (!pick || item.end < pick.end) pick = item;
      }
      return pick;
    }
    // Without Web Animations the node shows at `peak` and drops to 0 at its fade time (update() does that).
    function begin(item, life, peak) {
      stop(item);
      item.active = true;
      item.end = clock + life;
      item.fade = clock + life * .7;
      item.node.hidden = false;
      if (!animated) item.node.style.opacity = String(peak);
    }
    function release(item) {
      stop(item);
      item.active = false;
      item.node.hidden = true;
      if (!animated) item.node.style.opacity = '0';
    }
    const T = (x, y, extra) => 'translate(' + x + ',' + y + ')' + (extra || '');

    function hit(p) {
      if (disposed || !live || !p || typeof p !== 'object' || !p.blood) return 0;
      paint();
      const b = p.blood;
      let shown = 0;
      hits++;
      for (const s of Array.isArray(b.splats) ? b.splats : []) {
        const item = take(splats), n = item.node, size = clamp(num(s.size, .2), .02, .9) * 100, o = clamp(num(s.opacity, .8), 0, 1);
        const life = clamp(num(s.life, 2), .2, 10), rot = num(s.rot, 0).toFixed(3) + 'rad', run = (clamp(num(s.run, 0), 0, .3) * 100).toFixed(2) + 'vh';
        copy(item, art.splats[clamp(Math.floor(num(s.variant, 0)), 0, POOL.variants - 1)]);
        n.style.left = (clamp(num(s.x, .5), 0, 1) * 100).toFixed(2) + '%';
        n.style.top = (clamp(num(s.y, .5), 0, 1) * 100).toFixed(2) + '%';
        n.style.width = n.style.height = size.toFixed(2) + 'vmin';
        begin(item, life + num(s.delay, 0), o);
        const at = (t, extra) => T('-50%', '-42%', ' translateY(' + t + ') rotate(' + rot + ')' + (extra || ''));
        play(item, motion ? [
          { opacity: 0, transform: at('0vh', ' scale(.55)') },
          { opacity: o, transform: at('0vh', ' scale(1.05)'), offset: .025, easing: 'ease-out' },
          { opacity: o, transform: at('0vh', ' scale(1)'), offset: .07 },
          { opacity: round(o * .9), transform: at(run, ' scale(1)'), offset: .72 },
          { opacity: 0, transform: at(run, ' scale(1)') }
        ] : [{ opacity: 0 }, { opacity: o, offset: .03 }, { opacity: round(o * .9), offset: .72 }, { opacity: 0 }], life, s.delay);
        shown++;
      }
      for (const c of Array.isArray(b.claws) ? b.claws : []) {
        const item = take(claws), n = item.node, len = clamp(num(c.length, .7), .1, 1.4) * 100, o = clamp(num(c.opacity, .9), 0, 1);
        const life = clamp(num(c.life, 3), .3, 10), angle = num(c.angle, 0).toFixed(3) + 'rad', from = num(c.from, 1) < 0 ? -1 : 1;
        copy(item, art.claws[c.marks === 4 ? 4 : 3]);
        n.style.left = (clamp(num(c.x, .5), 0, 1) * 100).toFixed(2) + '%';
        n.style.top = (clamp(num(c.y, .5), 0, 1) * 100).toFixed(2) + '%';
        n.style.width = len.toFixed(2) + 'vmin';
        n.style.height = (len * CLAW[1] / CLAW[0]).toFixed(2) + 'vmin';
        begin(item, life, o);
        // Swept in from the side the claws came from, then left to fade.
        const sweep = clamp(num(c.sweep, .09), .02, .5) / life, flip = from > 0 ? ' scaleX(-1)' : '';
        const at = (k) => T('-50%', '-50%', ' rotate(' + angle + ')' + flip + ' scaleX(' + k + ')');
        play(item, motion ? [
          { opacity: o, transform: at(.05) },
          { opacity: o, transform: at(1), offset: round(sweep), easing: 'ease-out' },
          { opacity: round(o * .85), transform: at(1), offset: .7 },
          { opacity: 0, transform: at(1) }
        ] : [{ opacity: 0 }, { opacity: o, offset: round(sweep) }, { opacity: round(o * .85), offset: .7 }, { opacity: 0 }], life);
        shown++;
      }
      for (const c of Array.isArray(b.bites) ? b.bites : []) {
        const item = take(bites), n = item.node, size = clamp(num(c.size, .5), .1, 1.2) * 100, o = clamp(num(c.opacity, .9), 0, 1);
        const life = clamp(num(c.life, 3), .3, 10);
        copy(item, art.bite);
        n.style.left = (clamp(num(c.x, .5), 0, 1) * 100).toFixed(2) + '%';
        n.style.top = (clamp(num(c.y, .85), 0, 1) * 100).toFixed(2) + '%';
        n.style.width = size.toFixed(2) + 'vmin';
        n.style.height = (size * BITE[1] / BITE[0]).toFixed(2) + 'vmin';
        begin(item, life, o);
        play(item, motion ? [
          { opacity: 0, transform: T('-50%', '-30%', ' scale(1.15)') },
          { opacity: o, transform: T('-50%', '-50%', ' scale(1)'), offset: .04, easing: 'ease-out' },
          { opacity: round(o * .85), transform: T('-50%', '-48%', ' scale(1)'), offset: .7 },
          { opacity: 0, transform: T('-50%', '-46%', ' scale(1)') }
        ] : [{ opacity: 0 }, { opacity: o, offset: .04 }, { opacity: round(o * .85), offset: .7 }, { opacity: 0 }], life);
        shown++;
      }
      const f = b.flash;
      if (f && num(f.opacity, 0) > 0) {
        const item = flashes[0], o = clamp(num(f.opacity, .4), 0, 1), life = clamp(num(f.life, .4), .1, 2);
        const x = (clamp(num(f.x, .5), 0, 1) * 100).toFixed(1) + '%', y = (clamp(num(f.y, .5), 0, 1) * 100).toFixed(1) + '%';
        item.node.style.background = 'radial-gradient(ellipse 75% 85% at ' + x + ' ' + y + ', rgba(150,0,0,.85), rgba(90,0,0,.35) 45%, rgba(40,0,0,0) 80%)';
        begin(item, life, o);
        play(item, [{ opacity: o }, { opacity: round(o * .5), offset: .35 }, { opacity: 0 }], life);
      }
      last = { style: STYLES.includes(p.style) ? p.style : 'blunt', severity: num(p.severity, 0), splats: shown };
      return shown;
    }

    function update(dt) {
      if (disposed) return;
      dt = Number(dt);
      clock += Number.isFinite(dt) && dt > 0 ? dt : 0;
      for (let p = 0; p < pools.length; p++) {
        const pool = pools[p];
        for (let i = 0; i < pool.length; i++) {
          const item = pool[i];
          if (!item.active) continue;
          if (!animated && clock >= item.fade && item.node.style.opacity !== '0') item.node.style.opacity = '0';
          if (clock >= item.end) release(item);
        }
      }
    }
    function clear() {
      if (disposed) return;
      for (let p = 0; p < pools.length; p++) for (let i = 0; i < pools[p].length; i++) release(pools[p][i]);
      last = null;
    }
    function setOptions(next) {
      if (disposed || !next || typeof next !== 'object') return;
      if (typeof next.motion === 'boolean') motion = next.motion;
      if (typeof next.effects === 'boolean') effects = next.effects;
    }
    function dispose() {
      if (disposed) return;
      clear();
      disposed = true;
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    }
    function count(pool) { let n = 0; for (let i = 0; i < pool.length; i++) if (pool[i].active) n++; return n; }
    function snapshot() {
      return { active: { splats: count(splats), claws: count(claws), bites: count(bites), flash: count(flashes) }, hits,
        last: last && { ...last }, options: { motion, effects }, painted, live: live && !disposed };
    }
    return Object.freeze({ hit, update, clear, setOptions, dispose, snapshot });
  }

  return Object.freeze({ create, plan, KINDS, POOL, STYLES });
});

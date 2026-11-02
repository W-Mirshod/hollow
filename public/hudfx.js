/* Dopamine layer for the gameplay HUD: CoD-style hit markers, kill points, streak labels, a running
   score, directional damage arcs and alert banners. DOM only (no THREE). Every node is pooled up front,
   only transform and opacity animate (Web Animations, CSS-class fallback) and update() never reads layout. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.HollowHUDFX = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PI = Math.PI, TAU = PI * 2;
  const POOL = Object.freeze({ markers: 3, pops: 3, labels: 2, damage: 6, banners: 2 });
  // Seconds. Points keep accumulating while kills land within `window` of the previous one.
  const TIMING = Object.freeze({
    hit: .14, headshot: .17, kill: .18, armored: .12,
    window: 1, popFade: .45,
    labelIn: .16, labelHold: 1.1, wardenHold: 1.6, labelOut: .45, swap: .12,
    damage: 1.1, merge: .45,
    bannerIn: .26, bannerOut: .45, banner: Object.freeze({ danger: 1.8, objective: 2.4, info: 2 }),
    announce: 4
  });
  const KICKERS = Object.freeze({ danger: 'Threat', objective: 'Objective', info: 'Notice' });
  const MAX_SCORE = 999999999;
  const shared = typeof WeakMap === 'function' ? new WeakMap() : null; // document -> { users, link }

  function num(value, fallback) { value = Number(value); return Number.isFinite(value) ? value : fallback; }
  function clamp(value, lo, hi) { return value < lo ? lo : value > hi ? hi : value; }
  function words(value, max) { return value == null ? '' : String(value).replace(/\s+/g, ' ').trim().slice(0, max); }
  function group(value) { return String(Math.max(0, Math.floor(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function round(value) { return Math.round(value * 1000) / 1000; }
  function wrap(angle) { angle %= TAU; return angle > PI ? angle - TAU : angle <= -PI ? angle + TAU : angle; }
  function apart(a, b) { return Math.abs(wrap(a - b)); }

  // Screen angle of a world source: 0 = ahead (top), +PI/2 = right, PI = behind. Matches game.js
  // forward = (-sin yaw, -cos yaw) and right = (cos yaw, -sin yaw).
  function bearing(px, pz, yaw, sx, sz) {
    const vx = sx - px, vz = sz - pz;
    if (!(vx || vz)) return 0;
    const s = Math.sin(yaw), c = Math.cos(yaw), angle = Math.atan2(vx * c - vz * s, -vx * s - vz * c);
    return Number.isFinite(angle) ? angle : 0;
  }

  function create(options) {
    const o = options && typeof options === 'object' ? options : {};
    const host = o.root && typeof o.root.appendChild === 'function' ? o.root : null;
    const doc = o.document || (host && host.ownerDocument) || null;
    const live = !!(host && doc && typeof doc.createElement === 'function');
    let motion = o.motion !== false, effects = o.effects !== false, touch = !!o.touch, disposed = false;
    let clock = 0, target = 0, shown = 0, printed = -1, counting = false, scoreOn = false, said = '', saidAt = -Infinity;
    let layer = null, liveRegion = null, scoreBox = null, scoreValue = null, scoreAnim = null, animated = false;
    let pop = null, label = null, banner = null;
    const markers = [], pops = [], labels = [], arcs = [], banners = [], pools = [markers, pops, labels, arcs, banners];

    function make(tag, cls, parent) {
      const node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (parent) parent.appendChild(node);
      return node;
    }
    function slot(pool, node, parts) {
      node.hidden = true;
      pool.push(Object.assign({ node, active: false, shown: false, fade: 0, end: 0, anims: [] }, parts));
    }

    if (live) {
      layer = make('div', 'hfx-layer');
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
      const fx = make('div', 'hfx-fx', layer);
      fx.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < POOL.damage; i++) {
        const node = make('div', 'hfx-dmg', fx);
        slot(arcs, node, { arc: make('i', 'hfx-dmg-arc', node), angle: 0, amount: 0 });
      }
      scoreBox = make('div', 'hfx-score', fx);
      make('span', 'hfx-score-cap', scoreBox).textContent = 'Score';
      scoreValue = make('b', 'hfx-score-value', scoreBox);
      scoreBox.hidden = true;
      for (let i = 0; i < POOL.banners; i++) {
        const node = make('div', 'hfx-banner', fx), band = make('i', 'hfx-banner-band', node);
        const kicker = make('span', 'hfx-banner-kicker', node), title = make('span', 'hfx-banner-title', node);
        slot(banners, node, { band, kicker, ghostA: make('span', 'hfx-banner-ghost hfx-ghost-a', title),
          ghostB: make('span', 'hfx-banner-ghost hfx-ghost-b', title), text: make('span', 'hfx-banner-text', title), words: '' });
      }
      for (let i = 0; i < POOL.labels; i++) {
        const node = make('div', 'hfx-label', fx), bar = make('i', 'hfx-label-bar', node), title = make('span', 'hfx-label-title', node);
        slot(labels, node, { bar, ghost: make('span', 'hfx-label-ghost', title), text: make('span', 'hfx-label-text', title),
          sub: make('span', 'hfx-label-sub', node), name: '' });
      }
      for (let i = 0; i < POOL.pops; i++) {
        const node = make('div', 'hfx-pop', fx);
        slot(pops, node, { value: make('b', 'hfx-pop-value', node), tag: make('span', 'hfx-pop-tag', node), total: 0, kills: 0, last: 0, open: false });
      }
      for (let i = 0; i < POOL.markers; i++) {
        const node = make('div', 'hfx-hit', fx);
        for (let k = 0; k < 4; k++) make('i', '', node);
        slot(markers, node);
      }
      liveRegion = make('div', 'hfx-live', layer);
      liveRegion.setAttribute('role', 'status');
      liveRegion.setAttribute('aria-live', 'polite');
      liveRegion.setAttribute('aria-atomic', 'true');
      liveRegion.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap';
      animated = typeof layer.animate === 'function';
      flags();
      host.appendChild(layer);
      attach();
    }

    function attach() {
      const entry = shared ? shared.get(doc) || { users: 0, link: null } : { users: 0, link: null };
      entry.users++;
      if (shared) shared.set(doc, entry);
      const href = o.stylesheet === undefined ? 'hudfx.css' : o.stylesheet;
      let present = !!entry.link;
      try { present = present || !!(doc.querySelector && doc.querySelector('link[href*="hudfx.css"]')); } catch (error) { /* old selector engines */ }
      if (href && !present && doc.head) {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.setAttribute('data-hfx', '');
        doc.head.appendChild(link);
        entry.link = link;
      }
      // The pooled X marker replaces the legacy #reticleHit diamond (kept in the DOM, hidden by hudfx.css).
      if (o.legacyReticle !== true && doc.documentElement && doc.documentElement.classList) doc.documentElement.classList.add('hfx-active');
    }
    function detach() {
      const entry = shared && shared.get(doc);
      if (entry && --entry.users > 0) return;
      if (entry && entry.link && entry.link.parentNode) entry.link.parentNode.removeChild(entry.link);
      if (shared) shared.delete(doc);
      if (doc.documentElement && doc.documentElement.classList) doc.documentElement.classList.remove('hfx-active');
    }
    function flags() {
      if (!layer) return;
      layer.classList.toggle('hfx-still', !motion);
      layer.classList.toggle('hfx-calm', !effects);
      layer.classList.toggle('hfx-touch', touch);
    }

    function stop(item) {
      for (let i = 0; i < item.anims.length; i++) { try { item.anims[i].cancel(); } catch (error) { /* already gone */ } }
      item.anims.length = 0;
    }
    function play(item, node, frames, life) {
      if (!animated) return;
      try { item.anims.push(node.animate(frames, { duration: Math.max(1, Math.round(life * 1000)), fill: 'forwards' })); } catch (error) { /* detached node */ }
    }
    function take(pool, avoid) {
      let pick = null;
      for (let i = 0; i < pool.length; i++) {
        const item = pool[i];
        if (item === avoid) continue;
        if (!item.active) return item;
        if (!pick || item.end < pick.end) pick = item;
      }
      return pick || avoid;
    }
    // Without Web Animations the item shows via `hfx-show`; hudfx.css fades it when the class drops.
    function begin(item, life, fade) {
      stop(item);
      item.active = true;
      item.end = clock + life;
      item.fade = clock + Math.max(0, life - fade);
      item.node.hidden = false;
      if (!animated && !item.shown) { item.node.classList.add('hfx-show'); item.shown = true; }
    }
    function release(item) {
      stop(item);
      item.active = false;
      item.node.hidden = true;
      if (item.shown) { item.node.classList.remove('hfx-show'); item.shown = false; }
    }
    function retire(item) { // quick exit when a newer label/banner takes over
      stop(item);
      item.end = clock + TIMING.swap;
      item.fade = clock;
      play(item, item.node, motion ? [{ opacity: 1, transform: 'translateY(0) scale(1)' }, { opacity: 0, transform: 'translateY(-10px) scale(.96)' }]
        : [{ opacity: 1 }, { opacity: 0 }], TIMING.swap);
    }
    function scale(value) { return 'scale(' + round(value) + ')'; }
    function at(seconds, life) { return round(clamp(seconds / life, 0, 1)); }

    function hit(info) {
      if (disposed || !live) return false;
      const i = info && typeof info === 'object' ? info : {};
      const kill = !!i.kill, head = !!i.headshot, armored = !!i.armored && !kill;
      const life = kill ? TIMING.kill : head ? TIMING.headshot : armored ? TIMING.armored : TIMING.hit;
      const item = take(markers), node = item.node, base = head ? 1.3 : 1;
      begin(item, life, life * .6);
      node.classList.toggle('hfx-kill', kill);
      node.classList.toggle('hfx-head', head);
      node.classList.toggle('hfx-armor', armored);
      play(item, node, motion ? [
        { opacity: 1, transform: scale(base * (head ? 1.5 : kill ? 1.34 : armored ? 1.04 : 1.2)) },
        { opacity: 1, transform: scale(base * (kill ? 1.06 : 1)), offset: .4, easing: 'ease-in' },
        { opacity: 0, transform: scale(base * (kill ? 1.12 : armored ? .94 : 1.03)) }
      ] : [{ opacity: 1 }, { opacity: 1, offset: .45, easing: 'ease-in' }, { opacity: 0 }], life);
      return true;
    }

    function points(add, kind, head) {
      const open = !!(pop && pop.active && pop.open);
      const item = open ? pop : take(pops, pop);
      if (!open) { if (pop) pop.open = false; item.total = 0; item.kills = 0; }
      item.total = Math.min(MAX_SCORE, item.total + add);
      item.kills++;
      item.open = true;
      item.last = clock;
      const life = TIMING.window + TIMING.popFade, hold = at(TIMING.window, life);
      begin(item, life, TIMING.popFade);
      item.value.textContent = '+' + group(item.total);
      item.tag.textContent = item.kills > 1 ? item.kills + ' kills' : [kind || 'kill', head ? 'headshot' : ''].filter(Boolean).join(' · ');
      const still = 'translate(0,0) scale(1)';
      play(item, item.node, motion ? (open ? [
        { opacity: 1, transform: 'translate(0,0) scale(1.24)' },
        { opacity: 1, transform: still, offset: .09, easing: 'ease-in' },
        { opacity: 1, transform: still, offset: hold },
        { opacity: 0, transform: 'translate(0,-14px) scale(1)' }
      ] : [
        { opacity: 0, transform: 'translate(-12px,0) scale(.86)' },
        { opacity: 1, transform: 'translate(0,0) scale(1.1)', offset: .05 },
        { opacity: 1, transform: still, offset: .13 },
        { opacity: 1, transform: still, offset: hold },
        { opacity: 0, transform: 'translate(0,-14px) scale(1)' }
      ]) : [{ opacity: open ? 1 : 0 }, { opacity: 1, offset: .05 }, { opacity: 1, offset: hold }, { opacity: 0 }], life);
      pop = item;
      return true;
    }

    function medal(name, info) {
      if (label && label.active) retire(label);
      const item = take(labels, label), node = item.node, tier = info.warden ? 4 : clamp(info.count, 1, 4);
      for (let t = 1; t <= 4; t++) node.classList.toggle('hfx-tier-' + t, t === tier);
      node.classList.toggle('hfx-warden', info.warden);
      item.name = name;
      item.text.textContent = name;
      item.ghost.textContent = name;
      item.sub.textContent = [info.count > 1 ? '×' + info.count : '', info.points > 0 ? '+' + group(info.points) : ''].filter(Boolean).join('  ·  ');
      const hold = info.warden ? TIMING.wardenHold : TIMING.labelHold, life = TIMING.labelIn + hold + TIMING.labelOut;
      const a = at(TIMING.labelIn, life), settle = at(TIMING.labelIn + .09, life), b = at(TIMING.labelIn + hold, life);
      begin(item, life, TIMING.labelOut);
      const rest = 'translateY(0) scale(1)';
      play(item, node, motion ? [
        { opacity: 0, transform: 'translateY(0) scale(1.4)', easing: 'cubic-bezier(.2,.9,.25,1)' },
        { opacity: 1, transform: 'translateY(0) scale(.97)', offset: a },
        { opacity: 1, transform: rest, offset: settle },
        { opacity: 1, transform: rest, offset: b },
        { opacity: 0, transform: 'translateY(-8px) scale(1)' }
      ] : [{ opacity: 0 }, { opacity: 1, offset: a }, { opacity: 1, offset: b }, { opacity: 0 }], life);
      // Blur-to-sharp: a pre-blurred glow copy hands over to the crisp text (opacity only).
      play(item, item.ghost, [{ opacity: effects ? .95 : .6 }, { opacity: 0, offset: at(TIMING.labelIn + .12, life) }, { opacity: 0 }], life);
      if (effects && info.flash > 0) {
        const peak = round(.45 + .55 * info.flash), glow = round(.22 * info.flash), lift = at(TIMING.labelIn + .05, life), ebb = at(TIMING.labelIn + .55, life);
        play(item, item.bar, motion ? [
          { opacity: 0, transform: 'scaleX(.2)' },
          { opacity: peak, transform: 'scaleX(1)', offset: lift, easing: 'ease-out' },
          { opacity: glow, transform: 'scaleX(1.04)', offset: ebb },
          { opacity: 0, transform: 'scaleX(1.06)' }
        ] : [{ opacity: 0 }, { opacity: peak, offset: lift, easing: 'ease-out' }, { opacity: glow, offset: ebb }, { opacity: 0 }], life);
      }
      label = item;
      return true;
    }

    function kill(info) {
      if (disposed || !live) return false;
      const i = info && typeof info === 'object' ? info : {};
      const add = Math.max(0, Math.round(num(i.points, 0))), name = words(i.label, 28);
      const kind = words(i.kind, 16).replace(/[^a-z ]/gi, '').toLowerCase(), count = clamp(Math.floor(num(i.count, 1)), 1, 99);
      let done = false;
      if (add > 0) done = points(add, kind, !!i.headshot);
      if (name) done = medal(name, { count, points: add, flash: clamp(num(i.flash, .5), 0, 1), warden: kind === 'warden' || /warden/i.test(name) }) || done;
      return done;
    }

    function setScore(total) {
      if (disposed) return target;
      const value = clamp(Math.round(num(total, 0)), 0, MAX_SCORE), rising = value > target;
      if (value < shown) shown = value;
      target = value;
      if (live) {
        if (!scoreOn) { scoreOn = true; scoreBox.hidden = false; }
        if (rising && motion && animated) {
          if (scoreAnim) { try { scoreAnim.cancel(); } catch (error) { /* gone */ } }
          try { scoreAnim = scoreValue.animate([{ transform: 'scale(1.16)' }, { transform: 'scale(1)' }], { duration: 280, easing: 'ease-out' }); } catch (error) { scoreAnim = null; }
        }
        paint();
      }
      return target;
    }
    function paint() {
      const value = Math.floor(shown + 1e-6), rising = shown < target;
      if (value !== printed) { printed = value; scoreValue.textContent = group(value); }
      if (rising !== counting) { counting = rising; scoreBox.classList.toggle('hfx-counting', rising); }
    }

    function damage(angle, amount) {
      if (disposed || !live) return false;
      let a = Number(angle);
      if (!Number.isFinite(a)) return false;
      a = wrap(a);
      const k = clamp(num(amount, .6), .15, 1);
      let item = null;
      for (let i = 0; i < arcs.length; i++) if (arcs[i].active && apart(arcs[i].angle, a) < TIMING.merge) { item = arcs[i]; break; }
      const merged = !!item;
      if (!item) item = take(arcs);
      item.angle = a;
      item.amount = merged ? Math.min(1, Math.max(item.amount, k) + .15) : k;
      item.node.style.transform = 'rotate(' + a.toFixed(4) + 'rad)';
      const life = TIMING.damage + .35 * item.amount, peak = round(effects ? .55 + .45 * item.amount : .38 + .27 * item.amount);
      begin(item, life, life * .62);
      play(item, item.node, [
        { opacity: 0 },
        { opacity: effects ? round(Math.min(1, peak * 1.15)) : peak, offset: effects ? .06 : .14 },
        { opacity: peak, offset: .38 },
        { opacity: 0 }
      ], life);
      if (motion) play(item, item.arc, [{ transform: 'translateY(-12px) scaleX(.82)' }, { transform: 'translateY(0) scaleX(1)', offset: .12, easing: 'ease-in' },
        { transform: 'translateY(0) scaleX(1)' }], life);
      return true;
    }

    function announce(text) {
      if (!liveRegion || (text === said && clock - saidAt < TIMING.announce)) return;
      said = text;
      saidAt = clock;
      liveRegion.textContent = text;
    }

    function showBanner(message, settings) {
      if (disposed || !live) return false;
      const text = words(message, 48);
      if (!text) return false;
      const s = settings && typeof settings === 'object' ? settings : {};
      const tone = Object.prototype.hasOwnProperty.call(KICKERS, s.tone) ? s.tone : 'info';
      const life = clamp(num(s.duration, TIMING.banner[tone]), .6, 8);
      if (banner && banner.active) retire(banner);
      const item = take(banners, banner), node = item.node;
      node.classList.toggle('hfx-danger', tone === 'danger');
      node.classList.toggle('hfx-objective', tone === 'objective');
      node.classList.toggle('hfx-info', tone === 'info');
      item.words = text;
      item.kicker.textContent = s.kicker == null ? KICKERS[tone] : words(s.kicker, 32);
      item.text.textContent = text;
      item.ghostA.textContent = text;
      item.ghostB.textContent = text;
      const out = Math.min(TIMING.bannerOut, life * .4), a = at(Math.min(TIMING.bannerIn, life * .3), life), b = at(life - out, life);
      begin(item, life, out);
      play(item, node, motion ? [
        { opacity: 0, transform: 'scale(1.1)', easing: 'cubic-bezier(.2,.9,.25,1)' },
        { opacity: 1, transform: 'scale(1)', offset: a },
        { opacity: 1, transform: 'scale(1)', offset: b },
        { opacity: 0, transform: 'scale(.98)' }
      ] : [{ opacity: 0 }, { opacity: 1, offset: a }, { opacity: 1, offset: b }, { opacity: 0 }], life);
      if (effects && tone === 'danger') {
        // Two short dips plus offset ghosts: a glitch, kept small and well under three flashes a second.
        play(item, item.text, [{ opacity: 0 }, { opacity: 1, offset: at(.03, life) }, { opacity: .18, offset: at(.07, life) }, { opacity: 1, offset: at(.1, life) },
          { opacity: .45, offset: at(.17, life) }, { opacity: 1, offset: at(.21, life) }, { opacity: 1 }], life);
        // [time, opacity, x-jolt]; the jolt (a transform) only plays with motion on.
        const ghost = steps => steps.map(([t, opacity, x]) => {
          const frame = { opacity };
          if (motion) frame.transform = 'translateX(' + x + 'px)';
          if (t != null) frame.offset = at(t, life);
          return frame;
        });
        play(item, item.ghostA, ghost([[0, 0, 0], [.04, .85, -5], [.1, 0, 3], [.17, .6, -2], [.26, 0, 0], [null, 0, 0]]), life);
        play(item, item.ghostB, ghost([[0, 0, 0], [.05, .5, 5], [.12, 0, 0], [null, 0, 0]]), life);
      }
      banner = item;
      announce(text);
      return true;
    }

    function setOptions(next) {
      if (disposed || !next || typeof next !== 'object') return;
      if (typeof next.motion === 'boolean') motion = next.motion;
      if (typeof next.effects === 'boolean') effects = next.effects;
      if (typeof next.touch === 'boolean') touch = next.touch;
      flags();
    }

    function tick(pool) {
      for (let i = 0; i < pool.length; i++) {
        const item = pool[i];
        if (!item.active) continue;
        if (item.shown && clock >= item.fade) { item.node.classList.remove('hfx-show'); item.shown = false; }
        if (clock >= item.end) release(item);
      }
    }
    function update(dt) {
      if (disposed) return;
      dt = Number(dt);
      if (!Number.isFinite(dt) || dt < 0) dt = 0;
      clock += dt;
      if (pop && pop.open && clock - pop.last > TIMING.window) pop.open = false;
      for (let p = 0; p < pools.length; p++) tick(pools[p]);
      if (shown < target) {
        shown += Math.max((target - shown) * (1 - Math.exp(-dt * 7)), dt * 260);
        if (target - shown < 1) shown = target;
      }
      if (live) paint();
    }

    function clear() {
      if (disposed) return;
      for (let p = 0; p < pools.length; p++) for (let i = 0; i < pools[p].length; i++) release(pools[p][i]);
      if (pop) pop.open = false;
      pop = label = banner = null;
      target = shown = 0;
      said = '';
      saidAt = -Infinity;
      if (!live) return;
      if (scoreAnim) { try { scoreAnim.cancel(); } catch (error) { /* gone */ } scoreAnim = null; }
      scoreOn = false;
      scoreBox.hidden = true;
      paint();
      liveRegion.textContent = '';
    }

    function dispose() {
      if (disposed) return;
      clear();
      disposed = true;
      if (!live) return;
      if (layer.parentNode) layer.parentNode.removeChild(layer);
      detach();
    }

    function active(pool) { let n = 0; for (let i = 0; i < pool.length; i++) if (pool[i].active) n++; return n; }
    function snapshot() {
      return {
        score: target, displayedScore: Math.floor(shown + 1e-6),
        active: { markers: active(markers), pops: active(pops), labels: active(labels), damage: active(arcs), banners: active(banners) },
        label: label && label.active ? label.name : null, banner: banner && banner.active ? banner.words : null,
        pending: pop && pop.active && pop.open ? pop.total : 0,
        options: { motion, effects, touch }, live: live && !disposed
      };
    }

    return Object.freeze({ hit, kill, score: setScore, damage, banner: showBanner, setOptions, update, clear, dispose, snapshot });
  }

  return Object.freeze({ create, bearing, POOL, TIMING });
});

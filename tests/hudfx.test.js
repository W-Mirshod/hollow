'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const HUD = require('../public/hudfx');

const PI = Math.PI;
const near = (actual, expected, eps = 1e-9, msg) => assert.ok(Math.abs(actual - expected) <= eps, `${msg || ''} expected ${expected}, got ${actual}`);

// Minimal DOM: just what hudfx.js touches, plus write counters and an animate() stub that records keyframes.
const rejected = [];
// What a browser would reject or mis-render: unordered offsets, mixed property sets, anything but transform/opacity.
function invalid(keyframes, options) {
  const props = k => Object.keys(k).filter(key => key !== 'offset' && key !== 'easing').sort().join();
  if (!Array.isArray(keyframes) || keyframes.length < 2 || !(options.duration > 0)) return 'bad animation request';
  let last = 0;
  for (const k of keyframes) {
    if (k.offset !== undefined) { if (!(k.offset >= last && k.offset <= 1)) return 'offsets go backwards: ' + JSON.stringify(keyframes); last = k.offset; }
    if (props(k) !== props(keyframes[0])) return 'mixed keyframe properties: ' + JSON.stringify(keyframes);
    const other = Object.keys(k).find(key => !['offset', 'easing', 'opacity', 'transform'].includes(key));
    if (other) return 'animates ' + other;
  }
  return '';
}
class ClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.forEach(n => this.set.add(n)); }
  remove(...names) { names.forEach(n => this.set.delete(n)); }
  toggle(name, force) { const on = force === undefined ? !this.set.has(name) : !!force; if (on) this.set.add(name); else this.set.delete(name); return on; }
  contains(name) { return this.set.has(name); }
  toString() { return [...this.set].join(' '); }
}
class Element {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.attributes = new Map(); this.classList = new ClassList(); this.style = {}; this.hidden = false;
    this.text = ''; this.textWrites = 0; this.animations = [];
    doc.created++;
    if (doc.animated) this.animate = (keyframes, options) => {
      const problem = invalid(keyframes, options);
      if (problem) { rejected.push(problem); throw new TypeError(problem); } // hudfx.js swallows this, so it is also recorded
      const anim = { el: this, keyframes, options, cancelled: false, cancel() { this.cancelled = true; } };
      this.animations.push(anim); doc.animations.push(anim);
      return anim;
    };
  }
  get className() { return this.classList.toString(); }
  set className(value) { this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean)); }
  appendChild(child) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.children.push(child); return child; }
  append(...nodes) { nodes.forEach(n => this.appendChild(n)); }
  removeChild(child) { const i = this.children.indexOf(child); assert.ok(i >= 0, 'removeChild of a non-child'); this.children.splice(i, 1); child.parentNode = null; return child; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
  set textContent(value) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this.text = String(value); this.textWrites++; }
  get innerHTML() { return this.text; }
  set innerHTML(value) { this.ownerDocument.htmlWrites++; this.text = String(value); }
  querySelector(selector) {
    const m = /^(\w+)\[(\w+)\*="([^"]+)"\]$/.exec(selector);
    assert.ok(m, 'unsupported selector ' + selector);
    for (const el of walk(this)) {
      const value = el.getAttribute(m[2]) ?? el[m[2]];
      if (el !== this && el.tagName === m[1].toUpperCase() && typeof value === 'string' && value.includes(m[3])) return el;
    }
    return null;
  }
}
function dom({ animated = true } = {}) {
  const doc = { created: 0, htmlWrites: 0, animated, animations: [] };
  doc.createElement = tag => new Element(doc, tag);
  doc.documentElement = new Element(doc, 'html');
  doc.head = doc.documentElement.appendChild(new Element(doc, 'head'));
  doc.body = doc.documentElement.appendChild(new Element(doc, 'body'));
  doc.querySelector = selector => doc.documentElement.querySelector(selector);
  const root = doc.body.appendChild(new Element(doc, 'div'));
  root.id = 'hud';
  doc.created = 0;
  return { doc, root };
}
function* walk(el) { yield el; for (const c of el.children) yield* walk(c); }
const count = el => [...walk(el)].length - 1;
const all = (root, cls) => [...walk(root)].filter(el => el.classList.contains(cls));
const shown = (root, cls) => all(root, cls).filter(el => !el.hidden);
const animsOf = (root, cls) => all(root, cls).flatMap(el => el.animations);
const transformed = anims => anims.some(a => a.keyframes.some(k => 'transform' in k));
const peak = anims => Math.max(0, ...anims.flatMap(a => a.keyframes.map(k => k.opacity ?? 0)));
function dips(frames) { // how many times opacity falls and then recovers
  let n = 0, falling = false;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].opacity, b = frames[i].opacity;
    if (b < a) falling = true;
    else if (b > a && falling) { n++; falling = false; }
  }
  return n;
}
const METHODS = ['hit', 'kill', 'score', 'damage', 'banner', 'setOptions', 'update', 'clear', 'dispose', 'snapshot'];

test('exports the API surface and builds one pointer-free layer inside the root', () => {
  assert.equal(typeof HUD.create, 'function');
  assert.equal(typeof HUD.bearing, 'function');
  assert.ok(Object.isFrozen(HUD) && Object.isFrozen(HUD.POOL) && Object.isFrozen(HUD.TIMING));
  const { doc, root } = dom();
  const hud = HUD.create({ root, document: doc, motion: true, effects: true, touch: true });
  for (const name of METHODS) assert.equal(typeof hud[name], 'function', name);
  assert.ok(Object.isFrozen(hud));
  assert.equal(root.children.length, 1);
  const layer = root.children[0];
  assert.ok(layer.classList.contains('hfx-layer') && layer.classList.contains('hfx-touch'));
  assert.match(layer.style.cssText, /pointer-events:none/);
  for (const el of walk(layer)) {
    if (el === layer) continue;
    assert.ok(el.className === '' || el.className.split(' ').every(c => c.startsWith('hfx-')), 'hfx- prefix: ' + el.className);
    assert.equal(el.id, undefined, 'no ids');
  }
  const fx = all(root, 'hfx-fx')[0], live = all(root, 'hfx-live')[0];
  assert.equal(fx.getAttribute('aria-hidden'), 'true');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(live.getAttribute('role'), 'status');
  assert.equal(live.parentNode, layer, 'the live region is outside the aria-hidden subtree');
  assert.equal(doc.head.children.length, 1, 'stylesheet injected');
  const link = doc.head.children[0];
  assert.equal(link.rel, 'stylesheet');
  assert.equal(link.href, 'hudfx.css');
  assert.ok(doc.documentElement.classList.contains('hfx-active'));
  HUD.create({ root, document: doc });
  assert.equal(doc.head.children.length, 1, 'stylesheet injected once per document');
  assert.deepEqual(hud.snapshot(), {
    score: 0, displayedScore: 0, active: { markers: 0, pops: 0, labels: 0, damage: 0, banners: 0 },
    label: null, banner: null, pending: 0, options: { motion: true, effects: true, touch: true }, live: true
  });
  const own = dom();
  const fixed = own.doc.head.appendChild(own.doc.createElement('link'));
  fixed.setAttribute('href', './hudfx.css');
  HUD.create({ root: own.root, document: own.doc }).dispose();
  assert.deepEqual(own.doc.head.children, [fixed], 'an existing <link> is reused and left alone');
  const none = dom();
  HUD.create({ root: none.root, document: none.doc, stylesheet: false, legacyReticle: true });
  assert.equal(none.doc.head.children.length, 0);
  assert.ok(!none.doc.documentElement.classList.contains('hfx-active'));
});

test('without a root or document create() returns an inert instance', () => {
  const { doc } = dom();
  for (const options of [undefined, null, {}, { document: doc }, { root: {} }, { root: { appendChild() {} } }]) {
    const hud = HUD.create(options);
    for (const name of METHODS) assert.equal(typeof hud[name], 'function');
    assert.equal(hud.hit({ kill: true }), false);
    assert.equal(hud.kill({ label: 'DOUBLE KILL', points: 100 }), false);
    assert.equal(hud.damage(1, 1), false);
    assert.equal(hud.banner('IT SEES YOU', { tone: 'danger' }), false);
    hud.setOptions({ motion: false, effects: false, touch: true });
    hud.score(300);
    hud.update(1);
    const snap = hud.snapshot();
    assert.equal(snap.live, false);
    assert.equal(snap.displayedScore, 300, 'score bookkeeping still works');
    assert.deepEqual(snap.active, { markers: 0, pops: 0, labels: 0, damage: 0, banners: 0 });
    assert.deepEqual(snap.options, { motion: false, effects: false, touch: true });
    hud.clear(); hud.dispose(); hud.dispose(); hud.update(NaN);
  }
  assert.equal(doc.head.children.length, 0, 'an inert instance never touches the document');
  assert.equal(doc.created, 0);
});

test('pooled nodes stay bounded across 5000 hits, kills and damage events', () => {
  const { doc, root } = dom();
  const hud = HUD.create({ root, document: doc });
  const nodes = count(root);
  doc.created = 0;
  for (let i = 0; i < 5000; i++) {
    hud.hit({ headshot: i % 7 === 0, kill: i % 11 === 0, armored: i % 13 === 0 });
    hud.kill({ label: i % 3 ? null : ['HEADSHOT', 'DOUBLE KILL', 'RAMPAGE', 'WARDEN DOWN'][i % 4], points: 100 + i % 50, kind: ['stalker', 'warden'][i % 2], count: 1 + i % 6, flash: .5 });
    hud.damage(i * .7, (i % 10) / 10);
    if (i % 40 === 0) hud.banner(i % 80 ? 'FUSE 2/3' : 'IT SEES YOU', { tone: i % 80 ? 'objective' : 'danger' });
    hud.score(i * 10);
    hud.update(i % 4 ? 1 / 60 : 0);
  }
  assert.equal(doc.created, 0, 'no node is created after create()');
  assert.equal(count(root), nodes);
  const { active } = hud.snapshot();
  for (const [key, size] of [['markers', HUD.POOL.markers], ['pops', HUD.POOL.pops], ['labels', HUD.POOL.labels], ['damage', HUD.POOL.damage], ['banners', HUD.POOL.banners]]) {
    assert.ok(active[key] >= 1 && active[key] <= size, `${key} ${active[key]} within pool ${size}`);
  }
  const running = doc.animations.filter(a => !a.cancelled).length;
  assert.ok(running <= 34, 'superseded animations are cancelled, ' + running + ' left running');
  hud.update(10);
  assert.deepEqual(hud.snapshot().active, { markers: 0, pops: 0, labels: 0, damage: 0, banners: 0 });
  assert.equal(doc.animations.filter(a => !a.cancelled).length <= 1, true, 'released items cancel their animations');
});

test('bearing() follows the game yaw conventions', () => {
  // Fixed cases at yaw 0: forward is -z, right is +x.
  near(HUD.bearing(0, 0, 0, 0, -5), 0);
  near(HUD.bearing(0, 0, 0, 5, 0), PI / 2);
  near(HUD.bearing(0, 0, 0, 0, 5), PI);
  near(HUD.bearing(0, 0, 0, -5, 0), -PI / 2);
  near(HUD.bearing(0, 0, 0, 3, -3), PI / 4);
  for (const yaw of [0, .7, -1.2, PI / 2, PI, -2.6, 5.5, 31]) {
    const f = [-Math.sin(yaw), -Math.cos(yaw)], r = [Math.cos(yaw), -Math.sin(yaw)], p = [3.5, -8], d = 4.2;
    const at = (x, z) => HUD.bearing(p[0], p[1], yaw, p[0] + x * d, p[1] + z * d);
    near(at(f[0], f[1]), 0, 1e-9, 'front @' + yaw);
    near(at(r[0], r[1]), PI / 2, 1e-9, 'right @' + yaw);
    near(Math.abs(at(-f[0], -f[1])), PI, 1e-9, 'behind @' + yaw);
    near(at(-r[0], -r[1]), -PI / 2, 1e-9, 'left @' + yaw);
    near(at(f[0] - r[0], f[1] - r[1]), -PI / 4, 1e-9, 'front-left @' + yaw);
  }
  assert.equal(HUD.bearing(2, 2, 1, 2, 2), 0, 'source on the player');
  for (const bad of [[NaN, 0, 0, 1, 1], [0, 0, NaN, 1, 1], [0, 0, 0, undefined, 1], [0, 0, Infinity, 1, 1]]) assert.equal(HUD.bearing(...bad), 0);
});

test('damage arcs rotate toward the screen angle and merge nearby hits', () => {
  const { doc, root } = dom();
  const hud = HUD.create({ root, document: doc });
  const cases = [[0, 'rotate(0.0000rad)'], [PI / 2, 'rotate(1.5708rad)'], [PI, 'rotate(3.1416rad)'], [-PI / 2, 'rotate(-1.5708rad)'],
    [-PI, 'rotate(3.1416rad)'], [3 * PI / 2, 'rotate(-1.5708rad)'], [TAU() + .25, 'rotate(0.2500rad)']];
  for (const [angle, transform] of cases) {
    hud.clear();
    assert.equal(hud.damage(angle, .8), true);
    const arcs = shown(root, 'hfx-dmg');
    assert.equal(arcs.length, 1);
    assert.equal(arcs[0].style.transform, transform, 'angle ' + angle);
  }
  hud.clear();
  hud.damage(HUD.bearing(0, 0, .7, Math.cos(.7) * 3, -Math.sin(.7) * 3), 1);
  assert.equal(shown(root, 'hfx-dmg')[0].style.transform, 'rotate(1.5708rad)', 'a source on the right draws on the right');
  hud.clear();
  hud.damage(1, .3);
  hud.damage(1.3, .3);
  assert.equal(hud.snapshot().active.damage, 1, 'hits from about the same side refresh one arc');
  hud.damage(PI - .2, .9);
  hud.damage(-PI + .1, .9);
  assert.equal(hud.snapshot().active.damage, 2, 'merging wraps across ±PI');
  assert.equal(hud.damage(NaN, 1), false);
  assert.equal(hud.damage(undefined), false);
  assert.equal(hud.snapshot().active.damage, 2);
  hud.update(5);
  assert.equal(hud.snapshot().active.damage, 0);
  function TAU() { return PI * 2; }
});

test('labels, points and banners are written with textContent only', () => {
  const { doc, root } = dom();
  const hud = HUD.create({ root, document: doc });
  hud.kill({ label: '<b>x</b>', points: 100, count: 2, kind: '<i>stalker</i>' });
  hud.banner('<img src=x onerror=alert(1)>', { tone: 'danger', kicker: '<u>k</u>' });
  const label = shown(root, 'hfx-label')[0];
  const text = all(label, 'hfx-label-text')[0];
  assert.equal(text.textContent, '<b>x</b>');
  assert.equal(text.children.length, 0);
  assert.equal(all(label, 'hfx-label-ghost')[0].textContent, '<b>x</b>');
  assert.equal(all(label, 'hfx-label-sub')[0].textContent, '×2  ·  +100');
  assert.equal(all(shown(root, 'hfx-pop')[0], 'hfx-pop-tag')[0].textContent, 'istalkeri', 'kind is reduced to letters');
  const banner = shown(root, 'hfx-banner')[0];
  assert.equal(all(banner, 'hfx-banner-text')[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(all(banner, 'hfx-banner-kicker')[0].textContent, '<u>k</u>');
  assert.equal(all(root, 'hfx-live')[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(hud.snapshot().label, '<b>x</b>');
  assert.equal(doc.htmlWrites, 0, 'innerHTML is never used');
  assert.equal(hud.kill({ label: '   ', points: 0 }), false, 'blank labels and zero points show nothing');
  assert.equal(hud.banner('  '), false);
});

test('kill points accumulate within the window and then start a fresh pop', () => {
  const { doc, root } = dom();
  const hud = HUD.create({ root, document: doc });
  const pop = () => shown(root, 'hfx-pop').find(n => all(n, 'hfx-pop-value')[0].textContent === '+' + hud.snapshot().pending.toLocaleString('en-US'));
  hud.kill({ label: null, points: 100, kind: 'stalker', headshot: true, count: 1 });
  assert.equal(hud.snapshot().pending, 100);
  assert.equal(all(pop(), 'hfx-pop-tag')[0].textContent, 'stalker · headshot');
  hud.update(.5);
  hud.kill({ label: 'DOUBLE KILL', points: 150, kind: 'crawler', count: 2 });
  hud.update(.9);
  hud.kill({ points: 1000, kind: 'warden' });
  let snap = hud.snapshot();
  assert.equal(snap.pending, 1250);
  assert.equal(snap.active.pops, 1);
  assert.equal(all(pop(), 'hfx-pop-value')[0].textContent, '+1,250');
  assert.equal(all(pop(), 'hfx-pop-tag')[0].textContent, '3 kills');
  hud.update(HUD.TIMING.window + .01);
  snap = hud.snapshot();
  assert.equal(snap.pending, 0, 'window closed');
  assert.equal(snap.active.pops, 1, 'the closed pop is still fading out');
  hud.kill({ points: 120, kind: 'crawler' });
  snap = hud.snapshot();
  assert.equal(snap.pending, 120);
  assert.equal(snap.active.pops, 2);
  hud.update(HUD.TIMING.window + HUD.TIMING.popFade + .01);
  assert.equal(hud.snapshot().active.pops, 0);
});

test('score readout counts up smoothly, converges and snaps down', () => {
  const { doc, root } = dom();
  const hud = HUD.create({ root, document: doc });
  const box = all(root, 'hfx-score')[0], value = all(root, 'hfx-score-value')[0];
  assert.equal(box.hidden, true, 'hidden until the first score');
  assert.equal(hud.score(1250), 1250);
  assert.equal(box.hidden, false);
  assert.equal(hud.snapshot().displayedScore, 0);
  assert.ok(box.classList.contains('hfx-counting'));
  let previous = 0, frames = 0;
  const writes = value.textWrites;
  while (hud.snapshot().displayedScore < 1250 && frames < 600) {
    hud.update(1 / 60);
    const shownScore = hud.snapshot().displayedScore;
    assert.ok(shownScore >= previous, 'monotonic');
    if (frames === 0) assert.ok(shownScore > 0 && shownScore < 400, 'eases in rather than jumping: ' + shownScore);
    previous = shownScore;
    frames++;
  }
  assert.equal(hud.snapshot().displayedScore, 1250);
  assert.ok(frames >= 15 && frames <= 75, 'converges in ~0.25–1.25 s, took ' + frames + ' frames');
  assert.equal(value.textContent, '1,250');
  assert.ok(!box.classList.contains('hfx-counting'));
  const settled = value.textWrites;
  assert.ok(settled - writes <= frames, 'writes only when the number changes');
  for (let i = 0; i < 30; i++) hud.update(1 / 60);
  assert.equal(value.textWrites, settled, 'no writes while idle');
  hud.score(400);
  assert.equal(hud.snapshot().displayedScore, 400, 'decreases snap');
  assert.equal(value.textContent, '400');
  assert.equal(hud.score(NaN), 0);
  assert.equal(hud.score(-50), 0);
  assert.equal(hud.score(1e15), 999999999);
});

test('motion off drops every transform punch; effects off drops red flashes and glitch', () => {
  const run = options => {
    const { doc, root } = dom();
    const hud = HUD.create({ root, document: doc, ...options });
    hud.hit({ headshot: true });
    hud.hit({ kill: true });
    hud.hit({ armored: true });
    hud.kill({ label: 'TRIPLE KILL', points: 200, kind: 'stalker', count: 3, flash: .8 });
    hud.kill({ label: 'WARDEN DOWN', points: 500, kind: 'warden', count: 4, flash: 1 });
    hud.damage(1, 1);
    hud.banner('IT SEES YOU', { tone: 'danger' });
    hud.score(500);
    return { doc, root, hud, layer: root.children[0] };
  };
  const full = run({});
  assert.ok(transformed(full.doc.animations), 'motion on punches with transforms');
  assert.ok(animsOf(full.root, 'hfx-label-bar').length >= 1, 'effects on: red smear behind the label');
  const flicker = animsOf(full.root, 'hfx-banner-text');
  assert.equal(flicker.length, 1);
  const n = dips(flicker[0].keyframes);
  assert.ok(n >= 1 && n <= 2, 'glitch flicker is short: ' + n + ' dips');
  assert.ok(animsOf(full.root, 'hfx-banner-ghost').length >= 2);

  const still = run({ motion: false });
  assert.ok(still.layer.classList.contains('hfx-still'));
  assert.ok(still.doc.animations.length > 5);
  assert.equal(transformed(still.doc.animations), false, 'no scale/shake keyframes with motion off');
  for (const a of still.doc.animations) assert.ok(a.keyframes.every(k => Object.keys(k).every(key => ['opacity', 'offset', 'easing'].includes(key))), 'fades only');

  const calm = run({ effects: false });
  assert.ok(calm.layer.classList.contains('hfx-calm'));
  assert.equal(animsOf(calm.root, 'hfx-label-bar').length, 0, 'no red flash behind labels');
  assert.equal(animsOf(calm.root, 'hfx-banner-text').length, 0, 'no flicker');
  assert.equal(animsOf(calm.root, 'hfx-banner-ghost').length, 0, 'no glitch ghosts');
  for (const a of animsOf(calm.root, 'hfx-banner')) assert.equal(dips(a.keyframes), 0);
  assert.ok(peak(animsOf(calm.root, 'hfx-dmg')) <= peak(animsOf(full.root, 'hfx-dmg')) * .7, 'damage arcs at reduced intensity');
  assert.ok(peak(animsOf(calm.root, 'hfx-label-ghost')) < peak(animsOf(full.root, 'hfx-label-ghost')), 'softer focus glow');

  full.hud.setOptions({ motion: false, effects: false, touch: true });
  assert.ok(['hfx-still', 'hfx-calm', 'hfx-touch'].every(c => full.layer.classList.contains(c)));
  full.hud.setOptions({ motion: true, effects: true, touch: false, bogus: 1 });
  assert.ok(['hfx-still', 'hfx-calm', 'hfx-touch'].every(c => !full.layer.classList.contains(c)));
  full.hud.setOptions({ motion: 'no' });
  assert.equal(full.hud.snapshot().options.motion, true, 'only booleans change options');
});

test('banners announce through one polite live region without repeating', () => {
  const { doc, root } = dom();
  const hud = HUD.create({ root, document: doc });
  const live = all(root, 'hfx-live')[0];
  hud.kill({ label: 'DOUBLE KILL', points: 100, count: 2 });
  hud.hit({ kill: true });
  assert.equal(live.textWrites, 0, 'decorative events stay silent');
  hud.banner('IT SEES YOU', { tone: 'danger' });
  hud.banner('IT SEES YOU', { tone: 'danger' });
  assert.equal(live.textContent, 'IT SEES YOU');
  assert.equal(live.textWrites, 1, 'a repeat within the window is not re-announced');
  assert.equal(hud.snapshot().active.banners, 2, 'the older banner is retiring');
  assert.equal(hud.snapshot().banner, 'IT SEES YOU');
  hud.banner('FUSE 2/3', { tone: 'objective', duration: 3 });
  assert.equal(live.textContent, 'FUSE 2/3');
  assert.equal(all(shown(root, 'hfx-banner').find(b => b.classList.contains('hfx-objective')), 'hfx-banner-kicker')[0].textContent, 'Objective');
  hud.update(HUD.TIMING.swap + .01);
  assert.equal(hud.snapshot().active.banners, 1);
  hud.update(3);
  assert.equal(hud.snapshot().active.banners, 0);
  hud.banner('IT SEES YOU', { tone: 'danger' });
  assert.equal(live.textWrites, 3, 'after the window the same text may be announced again');
  hud.banner('POWER RESTORED', { tone: 'bogus', duration: -4 });
  assert.ok(shown(root, 'hfx-banner').some(b => b.classList.contains('hfx-info')), 'unknown tones fall back to info');
});

test('a new streak label retires the previous one immediately', () => {
  const { doc, root } = dom();
  const hud = HUD.create({ root, document: doc });
  hud.kill({ label: 'DOUBLE KILL', points: 150, count: 2, flash: .5 });
  hud.update(.2);
  hud.kill({ label: 'TRIPLE KILL', points: 180, count: 3, flash: .6 });
  hud.kill({ label: 'MULTI KILL', points: 200, count: 4, flash: .7 });
  assert.equal(hud.snapshot().label, 'MULTI KILL');
  assert.ok(hud.snapshot().active.labels <= HUD.POOL.labels);
  const visible = shown(root, 'hfx-label').filter(l => all(l, 'hfx-label-text')[0].textContent === 'MULTI KILL');
  assert.equal(visible.length, 1);
  assert.ok(visible[0].classList.contains('hfx-tier-4'));
  hud.update(HUD.TIMING.swap + .01);
  assert.equal(hud.snapshot().active.labels, 1);
  hud.kill({ label: 'WARDEN DOWN', points: 500, kind: 'warden', count: 1 });
  assert.ok(shown(root, 'hfx-label').some(l => l.classList.contains('hfx-warden')));
});

test('dispose() removes every node, the injected stylesheet and the reticle flag', () => {
  const { doc, root } = dom();
  const a = HUD.create({ root, document: doc }), b = HUD.create({ root, document: doc });
  a.hit({ kill: true }); a.kill({ label: 'RAMPAGE', points: 400, count: 5 }); a.damage(2, 1); a.banner('IT SEES YOU'); a.score(900);
  a.dispose();
  assert.equal(root.children.length, 1, 'only the other instance remains');
  assert.equal(doc.head.children.length, 1, 'shared stylesheet kept while another instance lives');
  assert.ok(doc.documentElement.classList.contains('hfx-active'));
  b.dispose();
  assert.equal(root.children.length, 0);
  assert.equal(doc.head.children.length, 0);
  assert.ok(!doc.documentElement.classList.contains('hfx-active'));
  assert.ok(doc.animations.every(x => x.cancelled), 'no animation keeps running');
  assert.equal(a.hit({}), false);
  assert.equal(a.kill({ label: 'X', points: 1 }), false);
  a.update(1); a.clear(); a.dispose(); a.setOptions({ motion: false });
  assert.equal(a.snapshot().live, false);
  assert.equal(root.children.length, 0);
});

test('update() tolerates NaN, negative and junk dt', () => {
  const { doc, root } = dom();
  const hud = HUD.create({ root, document: doc });
  hud.hit({});
  hud.score(100);
  for (const dt of [NaN, -1, -Infinity, Infinity, undefined, null, 'x', {}, []]) assert.doesNotThrow(() => hud.update(dt));
  let snap = hud.snapshot();
  assert.equal(snap.active.markers, 1, 'invalid dt does not advance time');
  assert.equal(snap.displayedScore, 0);
  hud.update('0.05');
  assert.equal(hud.snapshot().active.markers, 1);
  hud.update(1e9);
  snap = hud.snapshot();
  assert.equal(snap.active.markers, 0);
  assert.ok(Number.isFinite(snap.displayedScore));
  hud.update(1); hud.update(1);
  assert.equal(hud.snapshot().displayedScore, 100);
  assert.doesNotThrow(() => { hud.hit(null); hud.hit('x'); hud.kill(); hud.kill(5); hud.banner(null, null); hud.setOptions(); hud.setOptions(7); });
});

test('without Web Animations the CSS-class fallback shows, fades and releases', () => {
  const { doc, root } = dom({ animated: false });
  const hud = HUD.create({ root, document: doc });
  hud.hit({ kill: true });
  const marker = shown(root, 'hfx-hit')[0];
  assert.ok(marker.classList.contains('hfx-show') && marker.classList.contains('hfx-kill'));
  hud.update(HUD.TIMING.kill * .5);
  assert.ok(!marker.classList.contains('hfx-show'), 'class drops so CSS fades it');
  assert.equal(marker.hidden, false);
  hud.update(HUD.TIMING.kill);
  assert.equal(marker.hidden, true);
  hud.kill({ label: 'HEADSHOT', points: 150, headshot: true, count: 1 });
  assert.ok(shown(root, 'hfx-label')[0].classList.contains('hfx-show'));
  assert.ok(shown(root, 'hfx-pop')[0].classList.contains('hfx-show'));
  hud.update(5);
  assert.equal(shown(root, 'hfx-label').length + shown(root, 'hfx-pop').length, 0);
});

test('banners of any duration get a valid fade (short ones scale their fade-out)', () => {
  for (const motion of [true, false]) for (const effects of [true, false]) {
    const { doc, root } = dom();
    const hud = HUD.create({ root, document: doc, motion, effects });
    for (const duration of [-4, .1, .6, .61, 1, 2.4, 8, 60, 'x']) {
      for (const tone of ['danger', 'objective', 'info']) {
        hud.clear();
        assert.equal(hud.banner('FUSE 2/3', { tone, duration }), true);
        const node = shown(root, 'hfx-banner')[0], running = node.animations.filter(a => !a.cancelled);
        assert.equal(running.length, 1, `banner animates (duration ${duration}, ${tone})`);
        const frames = running[0].keyframes;
        assert.equal(frames[0].opacity, 0);
        assert.equal(frames[frames.length - 1].opacity, 0);
        assert.ok(frames.some(k => k.opacity === 1));
      }
    }
  }
});

test('every animation hudfx.js requested was valid for a browser', () => {
  assert.deepEqual(rejected, []);
});

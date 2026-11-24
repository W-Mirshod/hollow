'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Hurt = require('../public/hurtfx.js');

const PI = Math.PI;
const blow = (kind, damage, extra) => Hurt.plan({ kind, damage, health: 100 - damage, bearing: 0, seed: 3, ...extra });

// Minimal DOM: what hurtfx.js touches, an animate() that records and validates keyframes, and canvases with or
// without a 2D context.
function dom({ animated = true, canvas = true } = {}) {
  const doc = { animations: [], drawn: 0, painted: 0 };
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.style = {}; this.hidden = false;
      this.attributes = new Map(); this.ownerDocument = doc; this.width = 0; this.height = 0;
      if (animated) this.animate = (keyframes, options) => {
        const props = k => Object.keys(k).filter(key => key !== 'offset' && key !== 'easing').sort().join();
        let last = 0;
        for (const k of keyframes) {
          assert.ok(props(k) === props(keyframes[0]), 'every keyframe animates the same properties');
          assert.ok(Object.keys(k).every(key => ['offset', 'easing', 'opacity', 'transform'].includes(key)), 'only transform and opacity');
          if (k.offset !== undefined) { assert.ok(k.offset >= last && k.offset <= 1, 'offsets in order'); last = k.offset; }
        }
        assert.ok(options.duration > 0 && options.delay >= 0);
        const anim = { el: this, keyframes, options, cancelled: false, cancel() { this.cancelled = true; } };
        doc.animations.push(anim);
        return anim;
      };
    }
    get firstChild() { return this.children[0] || null; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    insertBefore(child, ref) { child.parentNode = this; this.children.splice(Math.max(0, this.children.indexOf(ref)), 0, child); return child; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getContext(kind) {
      if (!canvas || kind !== '2d' || this.tagName !== 'CANVAS') return null;
      const noop = () => {};
      return { clearRect: noop, save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop, arc: noop, closePath: noop,
        fillRect: noop, fill: () => { doc.painted++; }, drawImage: () => { doc.drawn++; },
        createRadialGradient: () => ({ addColorStop: noop }), set fillStyle(v) {}, set globalCompositeOperation(v) {} };
    }
  }
  doc.createElement = tag => new Element(tag);
  const root = new Element('div');
  root.appendChild(new Element('div'));    // the HUD's own layer, which the blood must stay under
  return { doc, root };
}

test('loads as a browser global and a CommonJS module', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/hurtfx.js'), 'utf8'), context);
  for (const api of [context.HollowHurtFX, Hurt]) {
    assert.ok(Object.isFrozen(api));
    assert.deepEqual(Object.keys(api.KINDS), ['warden', 'stalker', 'crawler', 'shrieker']);
    assert.equal(typeof api.plan, 'function');
  }
});

test('the plan is deterministic, bounded and survives junk', () => {
  assert.deepEqual(blow('stalker', 32), blow('stalker', 32));
  assert.notDeepEqual(blow('stalker', 32).blood, blow('stalker', 32, { seed: 4 }).blood);
  for (const info of [undefined, null, 5, 'x', {}, { damage: NaN, health: -9, bearing: Infinity, kind: 'toString', seed: -1 },
    { damage: 1e9, max: 0 }, { kind: 'gravekeeper', damage: 90, bearing: 7 }]) {
    const p = Hurt.plan(info);
    assert.ok(Hurt.STYLES.includes(p.style));
    for (const v of [p.severity, p.jolt.x, p.jolt.y, p.jolt.trauma, p.jolt.stagger, p.slow.factor, p.slow.time, p.muffle.amount, p.muffle.hz]) assert.ok(Number.isFinite(v));
    assert.ok(Math.abs(p.jolt.x) <= 1.5 && Math.abs(p.jolt.y) <= 1.5 && p.jolt.trauma <= 1 && p.slow.factor > 0 && p.slow.factor <= 1);
    assert.ok(p.blood.splats.length >= 1 && p.blood.splats.length <= Hurt.POOL.splats);
    for (const s of p.blood.splats) assert.ok(s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1 && s.size > 0 && s.opacity > 0 && s.life > 0);
  }
});

test('heavier blows punch harder, slow longer, ring the ears and throw more blood', () => {
  const light = blow('stalker', 12), mid = blow('stalker', 32), hard = blow('stalker', 60);
  assert.ok(light.jolt.trauma < mid.jolt.trauma && mid.jolt.trauma < hard.jolt.trauma);
  assert.ok(light.slow.factor > hard.slow.factor && light.slow.time < hard.slow.time);
  assert.ok(light.blood.amount < hard.blood.amount && light.blood.splats.length < hard.blood.splats.length);
  assert.ok(light.muffle.amount < hard.muffle.amount && light.muffle.hz > hard.muffle.hz);
  const warden = blow('warden', 68);
  assert.equal(warden.heavy, true);
  assert.ok(warden.ring && warden.ring.gain > .6 && warden.ring.time > 2 && warden.ring.hz > 3000, 'A Warden blow leaves the ears ringing');
  assert.ok(warden.muffle.amount > .9 && warden.muffle.hz < 700, 'and the world dull');
  assert.ok(warden.jolt.stagger > 2 * blow('crawler', 19).jolt.stagger, 'and the legs buckling');
  assert.ok(warden.slow.factor < .5);
  assert.equal(blow('crawler', 19).ring, null, 'A Crawler bite does not ring');
  // A light blow once badly hurt still rings.
  assert.ok(blow('shrieker', 24, { health: 12 }).ring && !blow('shrieker', 24, { health: 90 }).heavy);
  assert.equal(blow('shrieker', 24, { health: 12 }).heavy, true);
  // The game's existing Stalker feel is kept: about a .45 shake and a punch of half a unit up.
  const stalker = blow('stalker', 32, { bearing: PI / 2 });
  assert.ok(Math.abs(stalker.jolt.trauma - .43) < .05 && stalker.jolt.x > .6, JSON.stringify(stalker.jolt));
});

test('every creature lands differently', () => {
  const at = (kind, damage) => blow(kind, damage, { bearing: .9 });
  const w = at('warden', 68), s = at('stalker', 32), c = at('crawler', 19), k = at('shrieker', 24);
  assert.deepEqual([w.style, s.style, c.style, k.style], ['blunt', 'claw', 'bite', 'claw']);
  assert.ok(s.blood.claws.length === 1 && s.blood.claws[0].marks === 3 && k.blood.claws[0].marks === 4, 'Stalkers rake three, Shriekers four');
  assert.ok(c.blood.bites.length === 1 && c.blood.claws.length === 0 && w.blood.claws.length === 0);
  assert.ok(c.jolt.y < 0 && w.jolt.y > 0, 'A Crawler yanks the view down; a Warden knocks it up');
  assert.ok(c.slow.time > s.slow.time, 'A bitten leg drags longer');
  assert.ok(k.ring && (!s.ring || k.ring.gain > s.ring.gain), 'A Shrieker blow rings more than a Stalker one');
  const ys = c.blood.splats.map(p => p.y);
  assert.ok(ys.reduce((a, b) => a + b, 0) / ys.length > .6 && c.blood.flash.y === 1, 'Bite blood comes up from below');
  const boss = blow('gravekeeper', 90);
  assert.equal(boss.style, 'blunt');
  assert.ok(boss.heavy && boss.jolt.trauma >= w.jolt.trauma * .9, 'An unknown heavy hitter lands like one');
});

test('blood heaps on the side the blow came from; the punch knocks the view away from it', () => {
  const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
  const right = blow('warden', 68, { bearing: PI / 2 }), left = blow('warden', 68, { bearing: -PI / 2 }), front = blow('warden', 68, { bearing: 0 });
  assert.ok(mean(right.blood.splats.map(s => s.x)) > .6 && mean(left.blood.splats.map(s => s.x)) < .4);
  assert.ok(right.jolt.x > .5 && left.jolt.x < -.5 && Math.abs(front.jolt.x) < .01);
  assert.ok(right.blood.flash.x === 1 && left.blood.flash.x === 0);
  const claw = blow('stalker', 32, { bearing: PI / 2 }).blood.claws[0], other = blow('stalker', 32, { bearing: -PI / 2 }).blood.claws[0];
  assert.ok(claw.from === 1 && other.from === -1 && claw.angle * other.angle < 0, 'Rakes sweep in from the attacker\'s side');
});

test('reduced effects and motion: less blood, no runs, a gentler camera', () => {
  const full = blow('warden', 68), calm = blow('warden', 68, { effects: false }), still = blow('warden', 68, { motion: false });
  assert.ok(calm.blood.splats.length < full.blood.splats.length && calm.blood.flash.opacity < full.blood.flash.opacity);
  assert.ok(calm.blood.splats.every(s => s.run === 0) && still.blood.splats.every(s => s.run === 0));
  assert.ok(still.jolt.trauma < .5 * full.jolt.trauma && still.jolt.stagger < .5 * full.jolt.stagger);
});

test('the layer sits under the HUD, pools its nodes, animates only transform and opacity, and cleans up', () => {
  const { doc, root } = dom(), hud = root.children[0];
  const fx = Hurt.create({ root, document: doc });
  assert.equal(root.children[0].className, 'hurt-layer', 'inserted first, under the HUD');
  assert.equal(root.children[1], hud);
  const layer = root.children[0], nodes = layer.children.length;
  assert.equal(nodes, Hurt.POOL.splats + Hurt.POOL.claws + Hurt.POOL.bites + 1);
  assert.ok(layer.children.every(n => n.hidden));
  const p = blow('stalker', 32, { bearing: 1 });
  assert.equal(fx.hit(p), p.blood.splats.length + 1);
  assert.equal(layer.children.length, nodes, 'No nodes made per hit');
  const snap = fx.snapshot();
  assert.deepEqual(snap.active, { splats: p.blood.splats.length, claws: 1, bites: 0, flash: 1 });
  assert.ok(snap.painted && doc.painted > 0 && doc.drawn === p.blood.splats.length + 1, 'Painted once, copied per node');
  const shown = layer.children.filter(n => !n.hidden && n.tagName === 'CANVAS');
  assert.ok(shown.length === p.blood.splats.length + 1 && shown.every(n => /%$/.test(n.style.left) && /%$/.test(n.style.top)));
  const painted = doc.painted;
  for (let i = 0; i < 12; i++) fx.hit(blow('warden', 68, { seed: i }));
  assert.equal(doc.painted, painted, 'Never repainted');
  assert.ok(fx.snapshot().active.splats <= Hurt.POOL.splats, 'Busy pools reuse their oldest node');
  // Everything fades and is released.
  for (let i = 0; i < 60; i++) fx.update(.2);
  assert.deepEqual(fx.snapshot().active, { splats: 0, claws: 0, bites: 0, flash: 0 });
  assert.ok(layer.children.every(n => n.hidden));
  fx.hit(blow('crawler', 19));
  assert.equal(fx.snapshot().active.bites, 1);
  assert.equal(fx.snapshot().last.style, 'bite');
  fx.clear();
  assert.deepEqual(fx.snapshot().active, { splats: 0, claws: 0, bites: 0, flash: 0 });
  assert.ok(doc.animations.filter(a => !a.cancelled).every(a => a.el.hidden), 'Cleared nodes stop animating');
  fx.dispose();
  assert.equal(root.children.length, 1);
  assert.equal(fx.hit(p), 0);
  fx.update(1); fx.clear(); fx.dispose();
});

test('without Web Animations or a 2D canvas the layer still shows and fades the blood', () => {
  const { doc, root } = dom({ animated: false, canvas: false });
  const fx = Hurt.create({ root, document: doc, motion: false });
  const p = blow('warden', 68);
  assert.ok(fx.hit(p) > 0);
  const layer = root.children[0], shown = layer.children.filter(n => !n.hidden);
  assert.ok(shown.length > 0 && shown.every(n => Number(n.style.opacity) > 0));
  // Splats hold most of their life (the flash is gone in well under a second), then drop out by their fade time.
  const fade = Math.max(...p.blood.splats.map(s => (s.life + s.delay) * .7)), first = Math.min(...p.blood.splats.map(s => (s.life + s.delay) * .7));
  let clock = 0;
  while (clock + .1 < first) { fx.update(.1); clock += .1; }
  assert.ok(shown.filter(n => n.tagName === 'CANVAS').every(n => !n.hidden && Number(n.style.opacity) > 0), 'Still on screen before the fade');
  while (clock <= fade + .1) { fx.update(.1); clock += .1; }
  assert.ok(shown.filter(n => !n.hidden).every(n => n.style.opacity === '0'), 'Faded by its fade time');
  for (let i = 0; i < 60; i++) fx.update(.2);
  assert.ok(layer.children.every(n => n.hidden));
  assert.equal(Hurt.create({}).hit(p), 0, 'Headless: nothing to draw');
  assert.equal(Hurt.create({}).snapshot().live, false);
});

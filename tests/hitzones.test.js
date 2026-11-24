'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const THREE = require('three');
const Z = require('../public/hitzones.js');
const RULES = require('../public/systems.js');

const KINDS = ['warden', 'stalker', 'crawler', 'shrieker'];
const GRAVEKEEPER = { name: 'Gravekeeper', hp: 90, height: 3.6, head: 3.05, radius: .8 };
const rifle = RULES.WEAPONS.find(w => w.id === 'rifle'), pistol = RULES.WEAPONS.find(w => w.id === 'pistol');
const shotgun = RULES.WEAPONS.find(w => w.id === 'shotgun');
// Guns that do not exist yet: only their stats matter.
const magnum = { id: 'magnum-test', damage: 3.2, pellets: 1 }, smg = { id: 'smg-test', damage: .62, pellets: 1 };

// A shot from `distance` metres in front of a creature at (x, z) facing `yaw`, aimed at local (lx, ly) on it.
function frontal(kind, ly, { lx = 0, lz = 0, yaw = 0, x = 4, z = -2, distance = 6, eye = 1.6, stats = RULES.MONSTERS[kind], behind = false } = {}) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw), s = behind ? -1 : 1;
  const ox = x + fx * distance * s, oz = z + fz * distance * s, tx = x + rx * lx + fx * lz, tz = z + rz * lx + fz * lz;
  const d = new THREE.Vector3(tx - ox, ly - eye, tz - oz).normalize();
  const out = {};
  const region = Z.classify({ kind, stats, x, z, yaw, ox, oy: eye, oz, dx: d.x, dy: d.y, dz: d.z }, out);
  return { region, out };
}

function visuals() {
  const drawing = () => {
    const image = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), gradient = () => ({ addColorStop() {} });
    let pixels;
    return { createImageData: image, getImageData: (_x, _y, w, h) => pixels ? { width: w, height: h, data: pixels.data.slice() } : image(w, h),
      putImageData(v) { pixels = { width: v.width, height: v.height, data: v.data.slice() }; }, fillRect() {}, strokeRect() {}, fillText() {},
      beginPath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {}, arc() {}, closePath() {}, fill() {}, stroke() {}, save() {}, restore() {},
      translate() {}, rotate() {}, createLinearGradient: gradient, createRadialGradient: gradient };
  };
  const context = { window: {}, document: { createElement: () => { const d = drawing(); return { width: 0, height: 0, getContext: () => d }; } },
    WeakMap, Map, Set, Math, Float32Array, Uint8ClampedArray, Object, Array };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/visuals.js'), 'utf8'), context);
  return context.window.HollowVisuals;
}

test('loads as a browser global and a CommonJS module with a frozen API', () => {
  const context = { HollowSystems: RULES };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/hitzones.js'), 'utf8'), context);
  for (const api of [context.HollowHitZones, Z]) {
    assert.ok(Object.isFrozen(api));
    assert.deepEqual([...api.REGIONS], ['head', 'neck', 'chest', 'gut', 'armL', 'armR', 'legL', 'legR']);
    for (const name of ['classify', 'jointRegion', 'torsoRegion', 'layRegion', 'multiplier', 'damage', 'mass', 'impact', 'verdict', 'profile']) {
      assert.equal(typeof api[name], 'function', name);
    }
  }
  assert.equal(context.HollowHitZones.damage('rifle', 'chest', 5, 'stalker'), Z.damage('rifle', 'chest', 5, 'stalker'));
  assert.ok(Object.isFrozen(Z.BODIES.stalker.parts[0]), 'body tables are frozen');
});

test('frontal shots land where they are aimed on every kind, whichever way the creature faces', () => {
  const aims = {
    warden: [['head', 2.5], ['chest', 1.9], ['gut', 1.25], ['legL', .4, -.3], ['legR', .4, .3], ['armL', 1.2, -.6], ['armR', 1.1, .6]],
    stalker: [['head', 2.3], ['chest', 1.64, -.12], ['gut', 1.4], ['legL', .4, -.17], ['legR', .9, .24], ['armL', 1.85, -.32]],
    shrieker: [['head', 2.05], ['chest', 1.4, -.13], ['gut', 1.12], ['legL', .4, -.19], ['legR', .4, .18], ['armR', 1.45, .38]]
  };
  for (const [kind, list] of Object.entries(aims)) {
    for (const yaw of [0, 1.3, -2.4]) {
      for (const [want, ly, lx = 0] of list) {
        const { region } = frontal(kind, ly, { lx, yaw });
        assert.equal(region, want, `${kind} yaw ${yaw} aimed at ${want} (${lx}, ${ly})`);
      }
    }
  }
});

test('heads are hit where they are: above the pivot, behind the warden\'s hump, at a crawler\'s front', () => {
  for (const kind of ['warden', 'stalker', 'shrieker']) {
    const st = RULES.MONSTERS[kind];
    assert.equal(frontal(kind, st.head + .1).region, 'head', `${kind} above the pivot`);
    assert.equal(frontal(kind, st.head + .3, { behind: true }).region, kind === 'warden' ? 'chest' : 'head', `${kind} the back of the skull`);
  }
  // tests/dopamine.spec.js: aimed at y .72 where the ray meets a crawler's hit cylinder from in front, a headshot.
  assert.equal(frontal('crawler', .72, { distance: 3.5, lz: .43 }).region, 'head');
  const hump = frontal('crawler', .8, { behind: true, distance: 3.5 });
  assert.ok(hump.region === 'chest' || hump.region === 'gut', `a crawler's back is not its head (${hump.region})`);
  assert.equal(frontal('crawler', .3, { lx: -.55, distance: 4 }).region, 'armL');
  assert.equal(frontal('crawler', .3, { lx: -.6, behind: true, distance: 4 }).region, 'legL', 'from behind, its hind legs');
  // A ray that only grazes the hit cylinder keeps the old height rule.
  assert.equal(frontal('stalker', 2.2, { lx: .33 }).region, 'head', 'a near miss above the head pivot still counts as a headshot');
});

test('the classifier agrees with raycasts on the real visuals.js meshes', () => {
  const V = visuals();
  let seed = 11;
  const rnd = () => { seed = seed * 16807 % 2147483647; return seed / 2147483647; };
  for (const kind of [...KINDS, 'gravekeeper']) {
    const g = V.makeMonster(THREE, kind), st = RULES.MONSTERS[kind], yaw = rnd() * 6, ray = new THREE.Raycaster();
    g.position.set(3, 0, -7); g.rotation.set(0, yaw, 0); g.updateMatrixWorld(true);
    let hits = 0, agree = 0;
    for (let i = 0; i < 4000 && hits < 900; i++) {
      const a = rnd() * Math.PI * 2, dist = 3 + rnd() * 8, ty = rnd() * st.height, side = (rnd() - .5) * st.radius * 2.4;
      const o = new THREE.Vector3(3 + Math.sin(a) * dist, .3 + rnd() * 2.2, -7 + Math.cos(a) * dist);
      const d = new THREE.Vector3(3 + Math.cos(a) * side, ty, -7 - Math.sin(a) * side).sub(o).normalize();
      ray.set(o, d);
      const hit = ray.intersectObject(g, true)[0];
      if (!hit) continue;
      let region = null;
      for (let p = hit.object; p && p !== g && !region; p = p.parent) region = Z.jointRegion(p.name);
      if (!region) { const local = g.worldToLocal(hit.point.clone()); region = Z.torsoRegion(kind, st, local.y, local.z); }
      hits++;
      if (Z.classify({ kind, stats: st, x: 3, z: -7, yaw, ox: o.x, oy: o.y, oz: o.z, dx: d.x, dy: d.y, dz: d.z }) === region) agree++;
    }
    assert.ok(hits > 500, `${kind}: ${hits} mesh hits`);
    assert.ok(agree / hits > .82, `${kind}: ${(100 * agree / hits).toFixed(1)}% of ${hits} mesh hits classified alike`);
  }
});

test('posed bodies: a kneeling or leaning creature is read in its own posed frame', () => {
  const st = RULES.MONSTERS.stalker, eye = 1.6, ox = 0, oz = 6;
  const shot = (ly, pose) => {
    const d = new THREE.Vector3(0, ly - eye, -6).normalize();
    return Z.classify({ kind: 'stalker', stats: st, x: 0, z: 0, yaw: 0, ox, oy: eye, oz, dx: d.x, dy: d.y, dz: d.z, pose });
  };
  assert.equal(shot(2.3), 'head');
  assert.equal(shot(1.65, { x: 0, y: -.65, z: 0, pitch: .2, yaw: 0, roll: 0 }), 'head', 'a stalker down on one knee has its head at ~1.6 m');
  assert.notEqual(shot(1.65), 'head');
});

test('unknown kinds scale the closest template to their stats', () => {
  assert.equal(Z.profile('gravekeeper', GRAVEKEEPER).parts, Z.BODIES.gravekeeper.parts, 'the Gravekeeper has its own fitted body');
  const p = Z.profile('colossus', GRAVEKEEPER);
  assert.equal(p.quad, false);
  assert.ok(p.parts.length === Z.BODIES.warden.parts.length, 'an unknown broad boss uses the warden template');
  for (const kind of ['colossus', 'gravekeeper']) {
    const opts = { stats: GRAVEKEEPER, distance: 8 };
    assert.equal(frontal(kind, 3.3, opts).region, 'head', kind);
    assert.match(frontal(kind, 2.2, opts).region, /chest|gut/, kind);
    assert.match(frontal(kind, .5, { ...opts, lx: -.25 }).region, /leg/, kind);
  }
  const kind = 'colossus', opts = { stats: GRAVEKEEPER, distance: 8 };
  assert.equal(frontal(kind, 3.3, opts).region, 'head');
  assert.match(frontal(kind, 2.2, opts).region, /chest|gut/);
  assert.match(frontal(kind, .5, { ...opts, lx: -.4 }).region, /leg/);
  const tiny = Z.profile('mite', { height: .6, head: .35, radius: .3 });
  assert.equal(tiny.quad, true, 'a low creature is read as a crawler');
  assert.equal(Z.profile('ghost', null).parts.length, Z.BODIES.stalker.parts.length);
  for (const junk of [undefined, null, {}, { kind: 'stalker', dx: NaN, ox: Infinity }]) assert.ok(Z.REGIONS.includes(Z.classify(junk)));
});

test('mesh joints, torso heights and lying bodies map onto regions', () => {
  assert.deepEqual(['head', 'jaw', 'neck', 'armL', 'elbowL', 'armR', 'elbowR', 'legL', 'kneeL', 'legR', 'kneeR', 'pelvis', '', null].map(Z.jointRegion),
    ['head', 'head', 'neck', 'armL', 'armL', 'armR', 'armR', 'legL', 'legL', 'legR', 'legR', null, null, null]);
  assert.equal(Z.torsoRegion('stalker', null, 1.9, 0), 'chest');
  assert.equal(Z.torsoRegion('stalker', null, 1.3, 0), 'gut');
  assert.equal(Z.torsoRegion('crawler', null, .6, .2), 'chest');
  assert.equal(Z.torsoRegion('crawler', null, .6, -.4), 'gut');
  assert.deepEqual([0, 1, 2].map(k => Z.layRegion('stalker', k, -1)), ['legL', 'gut', 'chest']);
  assert.equal(Z.layRegion('crawler', 0, 1), 'legR');
});

test('damage keeps weaponDamage headshots and scales the rest by region: arms barely matter', () => {
  for (const kind of KINDS) {
    for (const w of RULES.WEAPONS) {
      for (const d of [2, 9, 30]) {
        assert.equal(Z.damage(w.id, 'head', d, kind), RULES.weaponDamage(w.id, true, d, kind), `${kind} ${w.id} head`);
        assert.equal(Z.damage(w.id, 'chest', d, kind), RULES.weaponDamage(w.id, false, d, kind));
      }
    }
    const m = r => Z.multiplier(kind, r);
    assert.ok(m('armL') < m('legL') && m('legL') < m('gut') && m('gut') < m('chest') && m('chest') < m('neck'), kind);
    assert.ok(m('armL') <= .6, `${kind} arm hits barely matter`);
    assert.equal(m('legL'), m('legR'));
  }
  assert.ok(Z.multiplier('warden', 'neck') < Z.multiplier('stalker', 'neck'), 'the warden\'s neck is wrapped');
  assert.equal(Z.damage(magnum, 'chest', 5, 'stalker'), 3.2, 'a gun known only by its stats deals its own damage');
  assert.equal(Z.damage(magnum, 'head', 5, 'warden'), 3.2 * 1.1);
  assert.equal(Z.damage('no-such-gun', 'chest', 5, 'stalker'), RULES.weaponDamage('rifle', false, 5, 'stalker'), 'unknown ids fall back like weaponDamage');
  assert.ok(Z.damage('rifle', 'nonsense', 5, 'stalker') === Z.damage('rifle', 'chest', 5, 'stalker'), 'unknown regions are chest hits');
});

test('reactions come from the gun\'s stats: heavy rounds shove and stagger, pellets and light rounds less', () => {
  const hit = (w, region, extra = {}) => Z.impact(w, { region, kind: 'stalker', distance: 5, dealt: Z.damage(w, region, 5, 'stalker'), ...extra });
  const body = hit(rifle, 'chest'), light = hit(smg, 'chest'), heavy = hit(magnum, 'chest'), pellet = hit(shotgun, 'chest');
  assert.ok(Math.abs(body.strength - 1) < 1e-9, 'a carbine round in the chest is the reference flinch');
  assert.ok(light.force < body.force && body.force < heavy.force);
  assert.ok(light.knock < body.knock && body.knock < heavy.knock);
  assert.ok(pellet.force < .45 && 8 * pellet.force > 2 * body.force, 'a pellet alone is light, a full blast is not');
  assert.ok(heavy.strength <= 2 && heavy.knock <= 6);
  const warden = Z.impact(rifle, { region: 'chest', kind: 'warden', distance: 5, dealt: 1 });
  assert.ok(warden.knock < .4 * body.knock && warden.stagger < .4 * body.stagger, 'the warden resists');
  const boss = Z.impact(rifle, { region: 'chest', kind: 'gravekeeper', stats: GRAVEKEEPER, distance: 5, dealt: 1 });
  assert.ok(boss.knock < warden.knock && boss.knock > 0, 'the gravekeeper resists even more but still moves');
  assert.ok(hit(rifle, 'legL').stagger > 2 * hit(rifle, 'armR').stagger, 'leg hits slow, arm hits barely matter');
  assert.ok(Z.impact(rifle, { region: 'chest', kind: 'stalker', distance: 25, dealt: 1 }).knock < body.knock, 'distance softens the push');
  assert.equal(hit(rifle, 'head').variant, 'bone');
  assert.equal(heavy.variant, 'meaty');
  assert.equal(light.variant, 'thwack');
  assert.ok(heavy.blood > body.blood && body.blood > light.blood && pellet.blood >= .2);
  assert.ok(heavy.exit > body.exit && body.exit > 0 && pellet.exit === 0, 'single heavy rounds leave exit wounds, pellets do not');
  assert.ok(heavy.weight > body.weight && body.weight > light.weight);
  for (const junk of [undefined, null, {}, { dealt: NaN, distance: -4, region: 7 }]) {
    const o = Z.impact(junk, junk);
    for (const k of ['force', 'strength', 'knock', 'stagger', 'heat', 'blood', 'wound', 'exit', 'reach', 'weight']) assert.ok(Number.isFinite(o[k]), k);
  }
});

test('a whole shot decides kneeling, decapitation, severed arms and the momentum of the fall', () => {
  const v = (w, tally) => Z.verdict(w, { kind: 'stalker', distance: 4, ...tally });
  assert.equal(v(shotgun, { legL: 4 * .546, force: 4 * .35 }).kneel, true, 'a blast in the legs drops a stalker to one knee');
  assert.equal(v(shotgun, { legL: 4 * .546, force: 1.4 }).kneelSide, 'legL');
  assert.equal(v(rifle, { legR: .7, force: .7 }).kneel, false, 'one carbine round does not');
  assert.equal(v(magnum, { legR: 2.24, force: 2.24 }).kneel, true, 'one magnum round does');
  assert.equal(v(shotgun, { kind: 'warden', legL: 3, force: 1.4 }).kneel, false, 'the warden stays up');
  assert.equal(v(shotgun, { kind: 'crawler', legL: 3, force: 1.4 }).kneel, false, 'crawlers have no knees to drop to');
  assert.equal(v(shotgun, { legL: 3, force: 1.4, killed: true }).kneel, false, 'the dead fall instead');

  assert.equal(v(rifle, { head: 1.85, killed: true }).gib, true, 'a killing headshot takes the head apart');
  assert.equal(v(rifle, { head: 1.85, killed: false }).gib, false, 'a survived one does not');
  assert.equal(v(smg, { head: 1.15, killed: true }).gib, false);
  assert.equal(v(smg, { head: 1.15, killed: true }).jaw, true, 'a light killing headshot tears the jaw instead');
  assert.equal(v(shotgun, { head: 1.44, killed: true, distance: 3 }).gib, true, 'a close blast to the head');
  assert.equal(v(shotgun, { head: 1.44, killed: true, distance: 14 }).gib, false, 'a stray pellet from far away');

  assert.equal(v(shotgun, { armR: 2.1, chest: 2, killed: true, distance: 3 }).sever, 'armR', 'a close blast tears the arm off');
  assert.equal(v(shotgun, { armR: 2.1, chest: 2, killed: false, distance: 3 }).sever, '', 'only on killing blows');
  assert.equal(v(rifle, { armL: .55, killed: true, distance: 3 }).sever, '', 'a carbine round does not');
  assert.equal(v(magnum, { chest: 3.2, killed: true, distance: 6 }).sever.length > 0, true, 'a magnum through the chest at close range');
  assert.equal(v(rifle, { head: 1.85, armL: 3, killed: true }).sever, '', 'a gibbed head is enough');

  const near = v(shotgun, { chest: 6, force: 2.8, killed: true, distance: 2 }), far = v(shotgun, { chest: 6, force: 2.8, killed: true, distance: 20 });
  const tap = v(rifle, { chest: 1, force: 1, killed: true, distance: 2 });
  assert.ok(near.deathForce > far.deathForce && near.deathForce > tap.deathForce && near.deathForce <= 3);
  assert.equal(near.region, 'chest');
  assert.ok(v(shotgun, { kind: 'warden', chest: 6, force: 2.8, killed: true, distance: 2 }).deathForce < near.deathForce, 'heavy bodies fall with less momentum');
  assert.ok(near.chunks > tap.chunks && near.chunks <= 16);
  assert.equal(v(rifle, { chest: 1, force: 1 }).chunks, 0, 'a survived carbine round throws no chunks');
  assert.ok(v(rifle, { head: 1.85, killed: true }).chunks >= 4, 'a gib throws plenty');
});

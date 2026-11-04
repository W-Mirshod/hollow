'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../public/systems');
const navigation = require('../public/navigation');
const { collidersForRooms } = require('./helpers/visuals-fixture');

const W = rules.SIZE;
const inside = (room, x, z) => x >= room.x && x < room.x + room.w && z >= room.z && z < room.z + room.d;

test('the campaign has three frozen floors with rising pressure and weapons that must be found', () => {
  const floors = rules.FLOORS, ids = rules.WEAPONS.map(w => w.id), found = new Set(rules.STARTING_WEAPONS);
  assert.equal(Object.isFrozen(floors), true);
  assert.deepEqual(floors.map(f => f.code), ['B1', 'B2', 'B3']);
  assert.deepEqual([...rules.STARTING_WEAPONS], ['pistol'], 'a run starts with the sidearm alone');
  assert.equal(Object.isFrozen(rules.STARTING_WEAPONS), true);
  floors.forEach((floor, index) => {
    assert.equal(Object.isFrozen(floor), true);
    assert.equal(Object.isFrozen(floor.weapons), true);
    for (const key of ['id', 'code', 'name', 'item', 'items', 'exit']) assert.ok(typeof floor[key] === 'string' && floor[key], `${floor.id}.${key}`);
    for (const key of ['active', 'sleepers', 'ammo', 'release']) assert.ok(Number.isInteger(floor[key]) && floor[key] > 0, `${floor.id}.${key}`);
    assert.ok(floor.active + floor.sleepers <= 20, `${floor.id} fits the twenty-body monster pool`);
    const { rooms } = rules.generateFloor(index, rules.seeded(index));
    for (const [gun, roomId] of Object.entries(floor.weapons)) {
      assert.ok(ids.includes(gun) && !rules.STARTING_WEAPONS.includes(gun), `${floor.id}: ${gun} is a pickup`);
      const room = rooms.find(r => r.id === roomId);
      assert.ok(room && !room.shelter && !room.fuse, `${floor.id}: the ${gun} lies in an open room without an objective`);
      found.add(gun);
    }
    if (!index) return;
    const previous = floors[index - 1];
    assert.ok(floor.ammo > previous.ammo, 'each floor stocks more ammunition');
    assert.ok(floor.active + floor.sleepers > previous.active + previous.sleepers, 'each floor holds more bodies');
    assert.ok(floor.release > previous.release, 'deeper exits take longer to open');
  });
  assert.deepEqual([...found].sort(), [...ids].sort(), 'every gun can be found');
  assert.equal(floors[0].release, 10, 'B1 keeps the original release time');
  assert.deepEqual(Object.keys(floors[0].weapons), ['rifle'], 'B1 hides the carbine; the shotgun waits below');
});

test('floor B1 is the original ward and consumes the same random draws', () => {
  for (let seed = 0; seed < 50; seed++) {
    assert.deepEqual(rules.generateFloor(0, rules.seeded(seed)), rules.generateMaze(rules.seeded(seed)), `seed ${seed}`);
  }
  const a = rules.seeded(9), b = rules.seeded(9);
  rules.generateFloor(0, a); rules.generateMaze(b);
  assert.equal(a(), b());
  assert.deepEqual(rules.generateFloor(-3, rules.seeded(4)), rules.generateFloor(0, rules.seeded(4)));
  assert.deepEqual(rules.generateFloor(9, rules.seeded(4)), rules.generateFloor(2, rules.seeded(4)));
});

for (const index of [1, 2]) {
  const code = rules.FLOORS[index].code;
  test(`250 seeded ${code} layouts are connected, sealed and never rely on rooms for circulation`, () => {
    const variants = new Set();
    for (let seed = 0; seed < 250; seed++) {
      const layout = rules.generateFloor(index, rules.seeded(seed)), { grid, rooms } = layout, label = `${code} seed ${seed}`;
      assert.deepEqual(Object.keys(layout).sort(), ['grid', 'rooms']);
      assert.equal(grid.length, W);
      assert.ok(grid.every(row => row.length === W && row.every(cell => cell === 0 || cell === 1)), label);
      variants.add(grid.map(row => row.join('')).join(''));
      assert.ok(rooms.length > 10, `${label}: more rooms than B1`);
      assert.equal(new Set(rooms.map(r => r.id)).size, rooms.length);
      assert.equal(rooms.filter(r => r.fuse).length, 3, label);
      assert.ok(rooms.filter(r => r.shelter).length >= 3, label);
      const distances = rules.flood(grid, 1, 1);
      let open = 0;
      for (let z = 0; z < W; z++) for (let x = 0; x < W; x++) {
        if (!grid[z][x]) { open++; assert.ok(distances[z * W + x] >= 0, `${label}: disconnected ${x},${z}`); }
        if (x === 0 || z === 0 || x === W - 1 || z === W - 1) {
          const gate = (x === 0 && z === 2) || (x === W - 1 && z === W - 2);
          assert.equal(grid[z][x], gate ? 0 : 1, `${label}: boundary ${x},${z}`);
        }
      }
      assert.ok(open > 600, `${label}: only ${open} open cells`);
      for (let z = 1; z <= 3; z++) for (let x = 1; x <= 5; x++) assert.equal(grid[z][x], 0, `${label}: arrival lobby ${x},${z}`);
      assert.equal(grid[W - 2][W - 2], 0, `${label}: exit approach`);
      const locked = new Set(rooms.filter(r => r.shelter).map(r => r.door.z * W + r.door.x));
      const lockedDistances = rules.flood(grid, 1, 1, (x, z) => locked.has(z * W + x));
      assert.ok(lockedDistances[(W - 2) * W + W - 1] >= 0, `${label}: locked shelters block the exit`);
      const doors = new Set(rooms.map(r => r.door.z * W + r.door.x));
      const circulation = rules.flood(grid, 1, 1, (x, z) => doors.has(z * W + x));
      for (let z = 0; z < W; z++) for (let x = 0; x < W; x++) {
        if (!grid[z][x] && !doors.has(z * W + x) && !rooms.some(r => inside(r, x, z))) {
          assert.ok(circulation[z * W + x] >= 0, `${label}: room-dependent circulation ${x},${z}`);
        }
      }
      for (const room of rooms) {
        assert.ok(room.x > 0 && room.z > 0 && room.x + room.w < W - 1 && room.z + room.d < W - 1, `${label}: bounds ${room.id}`);
        assert.deepEqual(room.door, { x: room.x + (room.w >> 1) - (room.w === 3 ? 1 : 0), z: room.z + room.d });
        for (let z = room.z - 1; z <= room.z + room.d; z++) for (let x = room.x - 1; x <= room.x + room.w; x++) {
          if (inside(room, x, z)) {
            assert.equal(grid[z][x], 0, `${label}: blocked floor ${room.id}`);
            assert.equal(lockedDistances[z * W + x] >= 0, !room.shelter, `${label}: shelter isolation ${room.id}`);
            continue;
          }
          assert.equal(grid[z][x], x === room.door.x && z === room.door.z ? 0 : 1, `${label}: envelope ${room.id} at ${x},${z}`);
        }
        const below = (room.door.z + 1) * W + room.door.x;
        assert.ok(circulation[below] >= 0, `${label}: ${room.id} door opens onto a hall`);
      }
    }
    assert.ok(variants.size >= 24, `${code}: only ${variants.size} distinct layouts`);
  });
}

test('lower floors are deterministic and never share mutable room state', () => {
  for (const index of [1, 2]) {
    const first = rules.generateFloor(index, rules.seeded(0x2468)), repeat = rules.generateFloor(index, rules.seeded(0x2468));
    assert.deepEqual(first, repeat);
    assert.notDeepEqual(first.grid, rules.generateFloor(index, rules.seeded(0x2469)).grid);
    first.rooms[0].door.x = -100; first.rooms[0].fuse = 'mutated';
    const again = rules.generateFloor(index, rules.seeded(0x2468));
    assert.notEqual(again.rooms[0].door.x, -100);
    assert.notEqual(again.rooms[0].fuse, 'mutated');
  }
});

test('furnished lower floors stay connected for all four monster types', () => {
  const start = [13.5, 7.5], circles = [{ x: 16.5, z: 7.5, r: .42 }, { x: 10.5, z: 7.5, r: .75 }];
  for (const index of [1, 2]) for (let seed = 0; seed < 8; seed++) {
    const layout = rules.generateFloor(index, rules.seeded(seed)), label = `${rules.FLOORS[index].code} seed ${seed}`;
    const doors = layout.rooms.filter(r => r.shelter).map(r => ({ x: (r.door.x + .5) * 3, z: (r.door.z + .5) * 3, w: 3, d: .25, open: true }));
    const nav = navigation.create({ grid: layout.grid, props: collidersForRooms(layout.rooms), circles, doors: () => doors });
    const targets = layout.rooms.map(r => ({ id: r.id, x: (r.x + r.w / 2) * 3, z: (r.z + r.d / 2) * 3 }));
    targets.push({ id: 'exit', x: 100.5, z: 100.5 });
    for (const [kind, monster] of Object.entries(rules.MONSTERS)) {
      for (const target of targets) {
        const points = nav.path(...start, target.x, target.z, monster.radius);
        assert.ok(points.length, `${label}: a ${kind} cannot reach ${target.id}`);
        let previous = start;
        for (const point of points) {
          assert.equal(nav.clear(previous[0], previous[1], point[0], point[1], monster.radius), true, `${label}: ${kind} to ${target.id}`);
          previous = point;
        }
        assert.deepEqual(points[points.length - 1], [target.x, target.z]);
      }
    }
  }
});

test('sleepers wake within seconds of a torch beam, a sprint or footsteps, but a careful crouch slips past', () => {
  const S = rules.SLEEP, rate = rules.sleepDisturbance, seconds = (distance, stimulus) => S.wake / rate(distance, stimulus);
  assert.equal(Object.isFrozen(S), true);
  assert.equal(rate(.5, {}), Infinity, 'bumping into a body wakes it');
  assert.equal(rate(.5, { moving: true, crouching: true }), Infinity);
  for (const distance of [2, 6, 10, 14]) assert.ok(seconds(distance, { torch: true }) < 1, `torch at ${distance} m`);
  assert.ok(rate(3, { torch: true }) > rate(12, { torch: true }), 'a close beam is worse');
  assert.equal(rate(S.torch + .1, { torch: true }), 0);
  for (const distance of [2, 5, 9]) assert.ok(seconds(distance, { moving: true, running: true }) < 1.5, `sprint at ${distance} m`);
  assert.equal(rate(S.run + .1, { moving: true, running: true }), 0);
  assert.ok(seconds(3, { moving: true }) < 1, 'walking past at arm\'s length');
  assert.equal(rate(S.walk + .1, { moving: true }), 0);
  assert.equal(rate(2.5, { moving: true, crouching: true }), 0, 'a crouch-walk at a respectful distance is silent');
  assert.ok(rate(1.5, { moving: true, crouching: true }) > 0);
  assert.ok(rate(1.5, { moving: true, crouching: true }) < rate(1.5, { moving: true }));
  assert.ok(rate(1.5, { moving: true }) < rate(1.5, { moving: true, running: true }));
  assert.ok(rate(1.5, {}) > 0 && seconds(1.5, {}) > 3, 'lingering beside a body wakes it eventually');
  assert.equal(rate(3, {}), 0);
  assert.ok(rate(5, { torch: true, moving: true, running: true }) > rate(5, { torch: true }), 'stimuli add up');
  for (const bad of [NaN, Infinity, undefined]) assert.equal(rate(bad, { torch: true, moving: true, running: true }), 0);
  assert.equal(rate(5, null), 0);
  assert.ok(S.chain > S.walk && S.rise > 0 && S.rise < 1.5 && S.decay > 0);
});

test('gunfire wakes every sleeper within earshot, nearest first, louder guns further', () => {
  for (const weapon of rules.WEAPONS) {
    const reach = weapon.noise * rules.SLEEP.shot, near = rules.shotWakeDelay(2, weapon.noise), far = rules.shotWakeDelay(reach - .5, weapon.noise);
    assert.ok(reach > 10, `${weapon.id} carries down a hall`);
    assert.ok(near > 0 && near < far && far <= 1.05, weapon.id);
    assert.equal(rules.shotWakeDelay(reach + .5, weapon.noise), -1);
  }
  const loud = id => rules.WEAPONS.find(w => w.id === id).noise;
  assert.ok(rules.shotWakeDelay(25, loud('shotgun')) > 0);
  assert.equal(rules.shotWakeDelay(25, loud('pistol')), -1, 'the sidearm is the quiet option');
  for (const bad of [[NaN, 30], [5, NaN], [-1, 30], [Infinity, 30], [5, 0], [5, -10]]) assert.equal(rules.shotWakeDelay(...bad), -1);
});

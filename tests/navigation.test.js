'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const navigation = require('../public/navigation');
const rules = require('../public/systems');
const { collidersForRooms } = require('./helpers/visuals-fixture');

function openGrid(columns = 12, rows = columns) {
  return Array.from({ length: rows }, (_, z) => Array.from({ length: columns }, (_, x) => x === 0 || z === 0 || x === columns - 1 || z === rows - 1 ? 1 : 0));
}
function assertClearPath(nav, start, points, radius) {
  assert.ok(points.length > 0, `No path from ${start}`);
  assert.ok(points.length < 1000, 'Route was not bounded/smoothed');
  let previous = start;
  for (const point of points) {
    assert.ok(point.every(Number.isFinite));
    assert.equal(nav.clear(previous[0], previous[1], point[0], point[1], radius), true,
      `Blocked segment ${previous} -> ${point}, radius ${radius}`);
    previous = point;
  }
}

function assertPhysicalPath(grid, props, circles, start, points, radius) {
  let previous = start;
  for (const point of points) {
    const steps = Math.max(1, Math.ceil(Math.hypot(point[0] - previous[0], point[1] - previous[1]) / .25));
    for (let step = 0; step <= steps; step++) {
      const f = step / steps, x = previous[0] + (point[0] - previous[0]) * f, z = previous[1] + (point[1] - previous[1]) * f;
      const contacts = props.slice();
      const cx = Math.floor(x / 3), cz = Math.floor(z / 3);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (grid[cz + dz]?.[cx + dx] === 1) contacts.push({ x: (cx + dx + .5) * 3, z: (cz + dz + .5) * 3, w: 3, d: 3 });
      }
      for (const obstacle of contacts) {
        const resolved = { x, z };
        rules.circleBox(resolved, radius, obstacle);
        assert.ok(Math.hypot(resolved.x - x, resolved.z - z) < 1e-5, `Physics contact at ${x},${z}`);
      }
      for (const obstacle of circles) assert.ok(Math.hypot(x - obstacle.x, z - obstacle.z) >= radius + obstacle.r - 1e-5);
    }
    previous = point;
  }
}

test('navigation exports the same pure create API in browsers and Node', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/navigation.js'), 'utf8'), context, { timeout: 1000 });
  assert.equal(typeof context.HollowNavigation.create, 'function');
  assert.equal(typeof navigation.create, 'function');
});

test('paths retain exact clear goals and redirect the former unreachable infirmary-bed center safely', () => {
  const nav = navigation.create({ grid: openGrid(), props: [{ x: 21.85, z: 11.25, w: 1.06, d: 2.12, h: .9 }] });
  const start = [25.5, 13.5], blocked = [22.5, 10.5];
  for (const radius of [.58, .34, .43]) {
    assert.equal(nav.clear(blocked[0], blocked[1], blocked[0], blocked[1], radius), false);
    const route = nav.path(...start, ...blocked, radius);
    assertClearPath(nav, start, route, radius);
    const end = route[route.length - 1];
    assert.ok(Math.hypot(end[0] - blocked[0], end[1] - blocked[1]) < 1.5);
    const exact = nav.path(...start, 25.5, 10.5, radius);
    assertClearPath(nav, start, exact, radius);
    assert.deepEqual(exact[exact.length - 1], [25.5, 10.5]);
  }
});

test('thin props between clear endpoints cannot be crossed or skipped by smoothing', () => {
  const nav = navigation.create({ grid: openGrid(8), props: [{ x: 10.5, z: 10.5, w: .08, d: 3 }] });
  const start = [7.5, 10.5], goal = [13.5, 10.5], radius = .43;
  assert.equal(nav.clear(...start, ...start, radius), true);
  assert.equal(nav.clear(...goal, ...goal, radius), true);
  assert.equal(nav.clear(...start, ...goal, radius), false);
  const route = nav.path(...start, ...goal, radius);
  assertClearPath(nav, start, route, radius);
  assert.ok(route.some(point => Math.abs(point[1] - 10.5) > 1.5));
  assert.deepEqual(route[route.length - 1], goal);
});

test('swept discs use rounded corner clearance instead of overly conservative inflated box corners', () => {
  const nav = navigation.create({ grid: openGrid(8), props: [{ x: 6, z: 6, w: 2, d: 2 }] });
  assert.equal(nav.clear(7.4, 7.4, 8, 8, .5), true);
  assert.equal(nav.clear(7.3, 7.3, 8, 8, .5), false);
  assert.equal(nav.clear(5, 4.5, 7, 4.5, .5), true);
  assert.equal(nav.clear(5, 4.51, 7, 4.51, .5), false);
});

test('live door changes invalidate routes without rebuilding static masks', () => {
  const grid = Array.from({ length: 9 }, () => Array(9).fill(1));
  for (let x = 1; x < 8; x++) grid[4][x] = 0;
  const door = { x: 13.5, z: 13.5, w: .25, d: 3, open: true };
  const nav = navigation.create({ grid, doors: () => [door] }), start = [4.5, 13.5], goal = [22.5, 13.5];
  assertClearPath(nav, start, nav.path(...start, ...goal, .58), .58);
  door.open = false;
  assert.equal(nav.clear(...start, ...goal, .58), false);
  assert.deepEqual(nav.path(...start, ...goal, .58), []);
  door.open = true;
  assertClearPath(nav, start, nav.path(...start, ...goal, .58), .58);
});

test('circle pillars and the fallen chandelier are routed around with full body clearance', () => {
  const nav = navigation.create({ grid: openGrid(8), circles: [{ x: 10.5, z: 7.5, r: .75 }, { x: 16.5, z: 7.5, r: .42 }] });
  const start = [4.5, 7.5], goal = [19.5, 7.5], radius = .58;
  assert.equal(nav.clear(...start, ...goal, radius), false);
  const route = nav.path(...start, ...goal, radius);
  assertClearPath(nav, start, route, radius);
  assert.deepEqual(route[route.length - 1], goal);
  assert.ok(route.some(point => Math.abs(point[1] - 7.5) > 1));
});

test('radius-specific caches do not let a Warden through a smaller creature’s gap', () => {
  const nav = navigation.create({ grid: openGrid(7), props: [
    { x: 6.5, z: 10.5, w: 7, d: .3 }, { x: 14.5, z: 10.5, w: 7, d: .3 }
  ] });
  const start = [10.5, 4.5], goal = [10.5, 16.5];
  assertClearPath(nav, start, nav.path(...start, ...goal, .34), .34);
  assert.deepEqual(nav.path(...start, ...goal, .58), []);
  assertClearPath(nav, start, nav.path(...start, ...goal, .43), .43);
  assert.deepEqual(nav.path(...start, ...goal, .58), []);
});

test('static invalidation refreshes moved/added furniture and never teleports an embedded start', () => {
  const props = [{ x: 10.5, z: 10.5, w: 2, d: 2 }], nav = navigation.create({ grid: openGrid(7), props });
  const start = [4.5, 10.5], goal = [16.5, 10.5];
  assertClearPath(nav, start, nav.path(...start, ...goal, .58), .58);
  assert.deepEqual(nav.path(10.5, 10.5, ...goal, .58), []);
  props.push({ x: 10.5, z: 10.5, w: .2, d: 15 });
  nav.invalidate();
  assert.deepEqual(nav.path(...start, ...goal, .58), []);
});

test('embedded goals redirect to the closest reachable side of a divider, not through it', () => {
  const nav = navigation.create({ grid: openGrid(7), props: [{ x: 10.5, z: 10.5, w: .2, d: 15 }] });
  const start = [4.5, 10.5], route = nav.path(...start, 10.6, 10.5, .58);
  assertClearPath(nav, start, route, .58);
  const end = route[route.length - 1];
  assert.ok(end[0] < 10.5);
  assert.ok(Math.hypot(end[0] - 10.6, end[1] - 10.5) < 1.2);
});

test('an actor touching furniture at its exact radius can still find a route away', () => {
  const nav = navigation.create({ grid: openGrid(8), props: [{ x: 10.5, z: 10.5, w: 2, d: 2 }] });
  const start = [11.84, 10.5], goal = [7.5, 10.5];
  assert.equal(nav.clear(...start, ...start, .34), true);
  assertClearPath(nav, start, nav.path(...start, ...goal, .34), .34);
});

test('malformed coordinates are bounded, rectangular grids work, and exterior AI exits stay closed', () => {
  const grid = openGrid(9, 5); grid[2][0] = grid[2][8] = 0;
  const nav = navigation.create({ grid });
  assertClearPath(nav, [4.5, 7.5], nav.path(4.5, 7.5, 22.5, 7.5, .34), .34);
  for (const coordinates of [[Infinity, 7, 10, 7, .34], [5, 7, NaN, 7, .34], [5, 7, 10, 7, -1], [5, 7, 10, 7, 0], [5, 7, 1e100, 7, .34]]) {
    assert.deepEqual(nav.path(...coordinates), []);
    assert.equal(nav.clear(...coordinates), false);
  }
  assert.equal(nav.clear(4.5, 7.5, 1.5, 7.5, .34), false);
  assert.equal(nav.clear(22.5, 7.5, 25.5, 7.5, .34), false);
  assert.throws(() => navigation.create({ grid: [[0], [0, 1]] }), TypeError);
});

test('furnished production labyrinths remain connected for all four monster types, including the formerly disconnected seeds', () => {
  const start = [13.5, 7.5];
  for (let seed = 0; seed < 25; seed++) {
    const layout = rules.generateMaze(rules.seeded(seed));
    const doors = layout.rooms.filter(room => room.shelter).map(room => ({ x: (room.door.x + .5) * 3, z: (room.door.z + .5) * 3, w: 3, d: .25, open: true }));
    const props = collidersForRooms(layout.rooms), circles = [{ x: 16.5, z: 7.5, r: .42 }, { x: 10.5, z: 7.5, r: .75 }];
    const nav = navigation.create({ grid: layout.grid, props, circles, doors: () => doors });
    for (const [kind, monster] of Object.entries(rules.MONSTERS)) {
      // The Gravekeeper only walks the Graveyard (floors.test.js covers its arena).
      if (monster.boss) continue;
      const destinations = layout.rooms.map(room => ({ id: room.id, x: (room.x + room.w / 2) * 3, z: (room.z + room.d / 2) * 3 }));
      destinations.push({ id: 'exit', x: 100.5, z: 100.5 });
      for (const target of destinations) {
        const points = nav.path(...start, target.x, target.z, monster.radius);
        assert.ok(points.length, `seed ${seed}, ${kind}, ${target.id} is disconnected`);
        assertClearPath(nav, start, points, monster.radius);
        if ([0, 1, 6, 7].includes(seed)) assertPhysicalPath(layout.grid, props, circles, start, points, monster.radius);
        assert.deepEqual(points[points.length - 1], [target.x, target.z]);
      }
    }
  }
});

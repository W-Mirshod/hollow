'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../public/systems');

test('the labyrinth is at least 1.5 times its original width and depth', () => {
  assert.equal(rules.SIZE, 35);
  assert.equal(rules.BASELINE_SIZE, 23);
  assert.ok(rules.SIZE / rules.BASELINE_SIZE >= 1.5);
  assert.equal(rules.CELL, 3);
  assert.equal(rules.SIZE * rules.CELL, 105);
});

test('250 seeded labyrinths have connected rooms, reachable exits and four properly sealed shelters', () => {
  for (let seed = 0; seed < 250; seed++) {
    const { grid, rooms } = rules.generateMaze(rules.seeded(seed));
    const label = `seed ${seed}`;
    const width = rules.SIZE;
    assert.equal(grid.length, width, label);
    assert.ok(grid.every(row => row.length === width && row.every(cell => cell === 0 || cell === 1)), label);
    assert.equal(rooms.length, 10, label);
    assert.equal(new Set(rooms.map(room => room.id)).size, rooms.length, label);
    assert.equal(rooms.filter(room => room.shelter).length, 4, label);
    assert.equal(rooms.filter(room => room.fuse).length, 3, label);
    const distances = rules.flood(grid, 1, 1);
    let openCells = 0;
    for (let z = 0; z < width; z++) {
      for (let x = 0; x < width; x++) {
        if (grid[z][x] === 0) {
          openCells++;
          assert.ok(distances[z * width + x] >= 0, `${label}: disconnected cell ${x},${z}`);
        }
        if (x === 0 || z === 0 || x === width - 1 || z === width - 1) {
          const gate = (x === 0 && z === 2) || (x === width - 1 && z === width - 2);
          assert.equal(grid[z][x], gate ? 0 : 1, `${label}: boundary ${x},${z}`);
        }
      }
    }
    assert.ok(openCells > 600, `${label}: insufficient traversable space`);
    const lockedCells = new Set(rooms.filter(room => room.shelter).map(room => room.door.z * width + room.door.x));
    const lockedDistances = rules.flood(grid, 1, 1, (x, z) => lockedCells.has(z * width + x));
    assert.ok(lockedDistances[(width - 2) * width + width - 1] >= 0, `${label}: locked shelters block exit`);
    for (const room of rooms) {
      assert.ok(room.x > 0 && room.z > 0 && room.x + room.w < width - 1 && room.z + room.d < width - 1, `${label}: room bounds ${room.id}`);
      for (let z = room.z; z < room.z + room.d; z++) {
        for (let x = room.x; x < room.x + room.w; x++) {
          assert.equal(grid[z][x], 0, `${label}: blocked room floor ${room.id}`);
          assert.equal(rules.insideRoom(room, (x + .5) * rules.CELL, (z + .5) * rules.CELL), true);
          assert.equal(lockedDistances[z * width + x] >= 0, !room.shelter, `${label}: shelter isolation ${room.id}`);
        }
      }
      if (!room.shelter) continue;
      for (let z = room.z - 1; z <= room.z + room.d; z++) {
        for (let x = room.x - 1; x <= room.x + room.w; x++) {
          if (x >= room.x && x < room.x + room.w && z >= room.z && z < room.z + room.d) continue;
          const door = x === room.door.x && z === room.door.z;
          assert.equal(grid[z][x], door ? 0 : 1, `${label}: breached shelter perimeter ${room.id} at ${x},${z}`);
        }
      }
      const within = rules.flood(grid, room.x + 1, room.z + 1, (x, z) => x === room.door.x && z === room.door.z);
      assert.equal([...within].filter(distance => distance >= 0).length, room.w * room.d, `${label}: hidden room has another exit`);
    }
  }
});

test('250 seeded wards preserve room geometry, fixture types and stable objective rooms', () => {
  const expected = [
    ['infirmary', 'infirmary', 7, 3, 3, 3, 7, 6],
    ['archive', 'archive', 17, 3, 5, 3, 19, 6],
    ['refuge-a', 'security', 9, 11, 3, 3, 9, 14],
    ['generator', 'generator', 27, 7, 5, 5, 29, 12],
    ['armory', 'armory', 3, 19, 5, 3, 5, 22],
    ['refuge-b', 'security', 21, 17, 3, 3, 21, 20],
    ['refuge-c', 'security', 29, 25, 3, 3, 29, 28],
    ['laboratory', 'maintenance', 19, 27, 5, 5, 21, 32],
    ['refuge-d', 'security', 3, 29, 3, 3, 3, 32],
    ['stores', 'lounge', 11, 25, 3, 3, 11, 28]
  ];
  for (let seed = 0; seed < 250; seed++) {
    const layout = rules.generateMaze(rules.seeded(seed));
    assert.deepEqual(Object.keys(layout).sort(), ['grid', 'rooms']);
    assert.deepEqual(layout.rooms.map(r => [r.id, r.type, r.x, r.z, r.w, r.d, r.door.x, r.door.z]), expected, `seed ${seed}`);
    assert.deepEqual(layout.rooms.filter(r => r.shelter).map(r => r.id), ['refuge-a', 'refuge-b', 'refuge-c', 'refuge-d']);
    assert.deepEqual(layout.rooms.filter(r => r.fuse).map(r => r.id), ['archive', 'generator', 'laboratory']);
  }
});

test('250 seeded wards have long main halls, enclosed rooms and independent service loops', () => {
  const variants = new Set();
  for (let seed = 0; seed < 250; seed++) {
    const { grid, rooms } = rules.generateMaze(rules.seeded(seed));
    const label = `seed ${seed}`, width = rules.SIZE;
    variants.add(grid.map(row => row.join('')).join(''));
    const assertHall = (x0, z0, x1, z1) => {
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        assert.equal(grid[z][x], 0, `${label}: blocked main hall ${x},${z}`);
      }
    };
    assertHall(15, 1, 15, 33);
    assertHall(14, 7, 16, 23);
    assertHall(1, 7, 25, 9);
    for (const z of [1, 15, 23, 33]) assertHall(1, z, 33, z);
    for (const x of [1, 25, 33]) assertHall(x, 1, x, 33);
    assertHall(1, 1, 5, 3);

    // Circulation must not rely on cutting through any furnished room.
    const doors = new Set(rooms.map(r => r.door.z * width + r.door.x));
    const circulation = rules.flood(grid, 1, 1, (x, z) => doors.has(z * width + x));
    for (let z = 0; z < width; z++) for (let x = 0; x < width; x++) {
      const inRoom = rooms.some(r => x >= r.x && x < r.x + r.w && z >= r.z && z < r.z + r.d);
      if (!grid[z][x] && !inRoom && !doors.has(z * width + x)) {
        assert.ok(circulation[z * width + x] >= 0, `${label}: room-dependent circulation ${x},${z}`);
      }
    }
    for (const room of rooms) {
      for (let z = room.z - 1; z <= room.z + room.d; z++) {
        for (let x = room.x - 1; x <= room.x + room.w; x++) {
          if (x >= room.x && x < room.x + room.w && z >= room.z && z < room.z + room.d) continue;
          const door = x === room.door.x && z === room.door.z;
          assert.equal(grid[z][x], door ? 0 : 1, `${label}: room envelope ${room.id} at ${x},${z}`);
        }
      }
      const hallZ = [7, 15, 23, 29, 33].find(z => z > room.door.z);
      assertHall(room.door.x, room.door.z, room.door.x, hallZ);
    }

    // Cut an entire hall section, not just one lane: an alternate route must
    // still exist outside rooms, without a maze-length detour.
    for (const [cut, start, goal] of [
      [[14, 10, 16, 13], [15, 9], [15, 15]],
      [[17, 14, 24, 15], [15, 15], [25, 15]],
      [[14, 29, 16, 30], [15, 23], [15, 33]]
    ]) {
      const [x0, z0, x1, z1] = cut;
      const distances = rules.flood(grid, ...start, (x, z) => doors.has(z * width + x) || (x >= x0 && x <= x1 && z >= z0 && z <= z1));
      const distance = distances[goal[1] * width + goal[0]];
      const direct = Math.abs(goal[0] - start[0]) + Math.abs(goal[1] - start[1]);
      assert.ok(distance > direct && distance <= 40, `${label}: missing or excessive service detour around ${cut}: ${distance}`);
    }
  }
  assert.ok(variants.size >= 24, `Only ${variants.size} distinct service layouts`);
});

test('seeded generation is deterministic and generated room definitions do not share mutable state', () => {
  const first = rules.generateMaze(rules.seeded(0x12345678));
  const repeat = rules.generateMaze(rules.seeded(0x12345678));
  const other = rules.generateMaze(rules.seeded(0x12345679));
  assert.deepEqual(first, repeat);
  assert.notDeepEqual(first.grid, other.grid);
  first.rooms[0].door.x = -100;
  first.grid[1][1] = 1;
  assert.notEqual(repeat.rooms[0].door.x, -100);
  assert.equal(repeat.grid[1][1], 0);
  for (const seed of [0, -1, 1, 0x7fffffff, 0xffffffff]) {
    const random = rules.seeded(seed);
    for (let sample = 0; sample < 100; sample++) {
      const value = random();
      assert.ok(Number.isFinite(value) && value >= 0 && value < 1);
    }
  }
});

test('room containment uses world coordinates and honors an interior margin', () => {
  const room = { x: 3, z: 5, w: 3, d: 3 };
  assert.equal(rules.insideRoom(room, 13.5, 19.5), true);
  assert.equal(rules.insideRoom(room, 9, 19.5), false);
  assert.equal(rules.insideRoom(room, 18, 19.5), false);
  assert.equal(rules.insideRoom(room, 13.5, 15), false);
  assert.equal(rules.insideRoom(room, 13.5, 24), false);
  assert.equal(rules.insideRoom(room, 9.2, 19.5), true);
  assert.equal(rules.insideRoom(room, 9.2, 19.5, .3), false);
  assert.equal(rules.insideRoom(room, 9.4, 19.5, .3), true);
});

test('circle/box wall contacts push out all faces, corners and embedded centers', () => {
  const box = { x: 0, z: 0, w: 2, d: 2 };
  const radius = .3;
  for (const [x, z, expectedX, expectedZ] of [
    [1.1, 0, 1.3, 0], [-1.1, 0, -1.3, 0], [0, 1.1, 0, 1.3], [0, -1.1, 0, -1.3],
    [0, 0, -1.3, 0], [1.15, 1.15, 1 + radius / Math.SQRT2, 1 + radius / Math.SQRT2]
  ]) {
    const point = { x, z };
    assert.equal(rules.circleBox(point, radius, box), true);
    assert.ok(Math.abs(point.x - expectedX) < 1e-10);
    assert.ok(Math.abs(point.z - expectedZ) < 1e-10);
  }
  for (const point of [{ x: 2, z: 2 }, { x: 1.3, z: 0 }]) {
    const original = { ...point };
    assert.equal(rules.circleBox(point, radius, box), false);
    assert.deepEqual(point, original);
  }
  const random = rules.seeded(77);
  for (let index = 0; index < 1000; index++) {
    const point = { x: (random() - .5) * 2.6, z: (random() - .5) * 2.6 };
    rules.circleBox(point, radius, box);
    const nearestX = Math.max(-1, Math.min(point.x, 1));
    const nearestZ = Math.max(-1, Math.min(point.z, 1));
    assert.ok(Math.hypot(point.x - nearestX, point.z - nearestZ) >= radius - 1e-9, `remaining penetration ${index}`);
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.z));
  }
});

test('three weapons have distinct immutable stats, limited reserves and bounded distance falloff', () => {
  assert.equal(rules.WEAPONS.length, 3);
  assert.deepEqual(rules.WEAPONS.map(weapon => weapon.id), ['rifle', 'pistol', 'shotgun']);
  assert.equal(Object.isFrozen(rules.WEAPONS), true);
  for (const weapon of rules.WEAPONS) {
    assert.equal(Object.isFrozen(weapon), true);
    assert.ok(Number.isInteger(weapon.capacity) && weapon.capacity > 0);
    assert.ok(Number.isInteger(weapon.reserve) && weapon.reserve > 0 && weapon.reserve <= weapon.capacity,
      'Starting reserves are deliberately limited to at most one magazine');
    assert.ok(weapon.damage > 0 && weapon.interval > 0 && weapon.reload > 0 && weapon.spread > 0);
    assert.ok(Number.isInteger(weapon.pellets) && weapon.pellets >= 1);
    const close = rules.weaponDamage(weapon.id, false, 2, 'stalker');
    const middle = rules.weaponDamage(weapon.id, false, 30, 'stalker');
    const distant = rules.weaponDamage(weapon.id, false, 1000, 'stalker');
    assert.ok(close >= middle && middle >= distant && distant > 0);
    assert.ok(rules.weaponDamage(weapon.id, true, 2, 'stalker') > close);
  }
  assert.equal(rules.WEAPONS[0].automatic, true);
  assert.equal(rules.WEAPONS[1].automatic, false);
  assert.equal(rules.WEAPONS[2].automatic, false);
  assert.equal(rules.WEAPONS[2].pellets, 8);
  assert.ok(rules.WEAPONS[2].noise > rules.WEAPONS[0].noise);
  assert.ok(rules.WEAPONS[0].noise > rules.WEAPONS[1].noise);
  assert.ok(rules.WEAPONS[0].capacity + rules.WEAPONS[0].reserve < rules.MONSTERS.warden.hp * 2,
    'Two Wardens cost more body shots than the starting carbine inventory');
});

test('four monster archetypes include a slow Warden that survives more than twenty rifle hits', () => {
  // The Gravekeeper (boss: true) is S2's one-off boss, outside the shared pool and these archetype rules.
  assert.deepEqual(Object.keys(rules.MONSTERS).filter(kind => !rules.MONSTERS[kind].boss).sort(), ['crawler', 'shrieker', 'stalker', 'warden']);
  assert.deepEqual(Object.keys(rules.MONSTERS).filter(kind => rules.MONSTERS[kind].boss), ['gravekeeper']);
  const warden = rules.MONSTERS.warden;
  const bodyDamage = rules.weaponDamage('rifle', false, 5, 'warden');
  const headDamage = rules.weaponDamage('rifle', true, 5, 'warden');
  assert.equal(Math.ceil(warden.hp / bodyDamage), 28);
  assert.ok(warden.hp - 20 * bodyDamage > 0);
  assert.ok(Math.ceil(warden.hp / headDamage) >= 20);
  assert.ok(Math.ceil(warden.hp / rules.weaponDamage('pistol', false, 5, 'warden')) >= 20);
  assert.ok(headDamage < rules.weaponDamage('rifle', true, 5, 'stalker'));
  for (const [kind, monster] of Object.entries(rules.MONSTERS)) {
    assert.equal(Object.isFrozen(monster), true);
    assert.ok(monster.hp > 0 && monster.radius > 0 && monster.damage > 0);
    assert.ok(monster.chase >= monster.walk && monster.head <= monster.height);
    assert.ok(monster.walk < monster.search && monster.search < monster.chase, `${kind}: search is a brisk patrol between walk and chase`);
    if (kind !== 'warden' && !monster.boss) {
      assert.ok(monster.hp < warden.hp);
      assert.ok(monster.damage < warden.damage);
      assert.ok(monster.walk > warden.walk);
      assert.ok(monster.search > warden.search);
      assert.ok(monster.chase > warden.chase);
    }
  }
  assert.ok(rules.MONSTERS.crawler.height < 1);
});

test('monster visual contract and senses are unchanged by the speed overhaul', () => {
  // visuals.test.js checks meshes against height/radius/head; game.spec.js checks the 68/32 damage values.
  const expected = {
    warden: [28, 68, .58, 2.8, 2.35, 17, 12], stalker: [7, 32, .34, 2.65, 2.12, 11, 11],
    crawler: [4, 19, .43, .9, .55, 8, 8], shrieker: [6, 24, .34, 2.3, 1.9, 15, 16]
  };
  for (const [kind, values] of Object.entries(expected)) {
    const m = rules.MONSTERS[kind];
    assert.deepEqual([m.hp, m.damage, m.radius, m.height, m.head, m.hearing, m.vision], values, kind);
  }
});

test('shared design speeds: faster monsters, a realistic sprinting player and an escapable chase', () => {
  const { PLAYER: player, MONSTERS: monsters } = rules;
  const design = { warden: [1.2, 3.2], stalker: [1.6, 5.5], crawler: [1.9, 6.2], shrieker: [1.4, 4.4] };
  for (const [kind, [walk, chase]] of Object.entries(design)) {
    assert.equal(monsters[kind].walk, walk, `${kind} walk`);
    assert.equal(monsters[kind].chase, chase, `${kind} chase`);
  }
  assert.deepEqual([player.walk, player.run, player.crouch, player.aimWalk], [3, 6.8, 1.5, 2.1]);
  const exhaustedWalk = player.walk * player.exhaustedSpeed;
  for (const [kind, m] of Object.entries(monsters)) {
    assert.ok(player.run > m.chase, `${kind}: a fresh sprint must outrun the sustained chase (escape is possible)`);
    assert.ok(exhaustedWalk < m.chase, `${kind}: an exhausted player must not outwalk a chase (exhaustion is deadly)`);
    assert.ok(player.walk > m.walk, `${kind}: wandering monsters are slower than a walking player`);
    // Linear acceleration from walk to sprint, then a full stamina bar of sprinting.
    const sprint = 1 / player.staminaDrain;
    const lead = player.run * sprint - (player.run - player.walk) * player.sprintAccel / 2 - m.chase * sprint;
    assert.ok(lead > 3, `${kind}: a full stamina bar buys a real lead (${lead.toFixed(2)} m)`);
  }
  const fastest = Math.max(...Object.values(monsters).map(m => m.chase));
  assert.equal(fastest, monsters.crawler.chase);
  for (const key of ['walk', 'search', 'chase']) {
    assert.equal(Math.min(...Object.values(monsters).map(m => m[key])), monsters.warden[key], `warden is slowest at ${key}`);
  }
  for (const key of ['hp', 'damage']) {
    assert.equal(Math.max(...Object.values(monsters).filter(m => !m.boss).map(m => m[key])), monsters.warden[key], `warden has the most ${key}`);
  }
});

test('lunges are short, bounded bursts that threaten walkers without making a fresh sprint futile', () => {
  const { PLAYER: player, MONSTERS: monsters } = rules;
  for (const [kind, m] of Object.entries(monsters)) {
    for (const key of ['lungeRange', 'lungeSpeed', 'lungeTime', 'lungeCooldown']) {
      assert.ok(Number.isFinite(m[key]) && m[key] > 0, `${kind}.${key}`);
    }
    assert.ok(m.lungeRange >= 2 && m.lungeRange <= 5, `${kind}: lunges start only at close range`);
    assert.ok(m.lungeSpeed >= 1.35 && m.lungeSpeed <= 1.6, `${kind}: lunge multiplier`);
    assert.ok(m.lungeTime >= .35 && m.lungeTime <= .5, `${kind}: lunge duration`);
    assert.ok(m.lungeCooldown >= 2.5 && m.lungeCooldown >= 5 * m.lungeTime, `${kind}: lunges are occasional`);
    assert.ok(m.lungeRange > m.radius + .32 + .35, `${kind}: a lunge starts beyond contact reach`);
    assert.ok(m.chase * m.lungeSpeed * m.lungeTime < m.lungeRange, `${kind}: one lunge cannot overshoot its trigger range`);
    assert.ok(m.chase * m.lungeSpeed > player.walk, `${kind}: lunges close on a walking player`);
    // Even lunging at the maximum allowed rate, average pursuit stays below a fresh sprint.
    const duty = m.lungeTime / (m.lungeTime + m.lungeCooldown);
    const sustained = m.chase * (1 + (m.lungeSpeed - 1) * duty);
    assert.ok(sustained < player.run, `${kind}: lunging pursuit ${sustained.toFixed(2)} m/s must stay below ${player.run}`);
  }
  assert.ok(monsters.crawler.chase * monsters.crawler.lungeSpeed > player.run, 'a crawler pounce out-paces a sprint for an instant');
  assert.ok(monsters.warden.chase * monsters.warden.lungeSpeed < player.run, 'the warden cannot lunge down a sprinter');
});

test('player movement constants are frozen, finite and describe a coherent stamina loop', () => {
  const player = rules.PLAYER;
  assert.equal(Object.isFrozen(player), true);
  const keys = ['walk', 'run', 'crouch', 'aimWalk', 'sprintAccel', 'staminaDrain', 'staminaRegenIdle', 'staminaRegenMove',
    'exhaustedRecover', 'exhaustedSpeed', 'jumpCost', 'slideCost', 'slideSpeed', 'slideTime'];
  assert.deepEqual(Object.keys(player).sort(), [...keys].sort());
  for (const key of keys) assert.ok(Number.isFinite(player[key]) && player[key] > 0, key);
  assert.ok(player.crouch < player.aimWalk && player.aimWalk < player.walk && player.walk < player.run);
  assert.ok(player.sprintAccel >= .3 && player.sprintAccel <= .6, 'sprint builds up in about half a second');
  assert.ok(Math.abs(1 / player.staminaDrain - 7) < .01, 'a full bar sprints for about seven seconds');
  assert.ok(Math.abs(1 / player.staminaRegenIdle - 5) < .01, 'standing still refills in about five seconds');
  assert.ok(Math.abs(1 / player.staminaRegenMove - 8) < .01, 'walking refills in about eight seconds');
  assert.ok(player.staminaRegenIdle > player.staminaRegenMove);
  assert.equal(player.exhaustedRecover, .35);
  assert.equal(player.exhaustedSpeed, .85);
  assert.ok(player.exhaustedRecover / player.staminaRegenMove < 3, 'exhaustion is a few seconds, not a stall');
  assert.ok(player.jumpCost < player.slideCost && player.slideCost < player.exhaustedRecover);
  assert.ok(Math.abs(player.slideSpeed / player.run - 1.1) < .02, 'a slide is a short burst above sprint');
  assert.ok(player.slideTime > .3 && player.slideTime < 1);
});

test('body contact blocks crossing without pushing and permits escape from overlaps', () => {
  const body = { x: 0, z: 0, r: .58 }, radius = .32;
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
    const point = distance => ({ x: Math.cos(angle) * distance, z: Math.sin(angle) * distance });
    const from = point(1.2), before = { ...from };
    assert.equal(rules.blocksCircleMove(from, point(.7), radius, body), true);
    assert.equal(rules.blocksCircleMove(from, point(-1.2), radius, body), true, 'swept test catches crossing even with clear endpoints');
    assert.equal(rules.blocksCircleMove(from, point(.91), radius, body), false);
    assert.equal(rules.blocksCircleMove(point(.9), point(.9), radius, body), false);
    assert.equal(rules.blocksCircleMove(point(.7), point(.8), radius, body), false, 'an overlapping actor can retreat');
    assert.equal(rules.blocksCircleMove(point(.7), point(.6), radius, body), true);
    assert.equal(rules.blocksCircleMove(point(0), point(.1), radius, body), false, 'coincident actors can separate without a forced shove');
    assert.deepEqual(from, before, 'collision queries never displace either body');
  }
  assert.equal(rules.blocksCircleMove({x:-1,z:.9}, {x:1,z:.9}, radius, body), false, 'tangent movement can slide past');
  assert.equal(rules.blocksCircleMove({x:-1,z:.89}, {x:1,z:.89}, radius, body), true);
});

test('injury intensity increases monotonically with lost health and reverses with healing', () => {
  assert.equal(rules.injuryLevel(100), 0);
  assert.equal(rules.injuryLevel(0), 1);
  let previous = -1;
  for (let health = 100; health >= 0; health--) {
    const intensity = rules.injuryLevel(health);
    assert.ok(Number.isFinite(intensity) && intensity >= 0 && intensity <= 1);
    assert.ok(intensity > previous, 'every lost health point deepens the corners');
    previous = intensity;
  }
  assert.ok(rules.injuryLevel(32 + 45) < rules.injuryLevel(32));
  assert.equal(rules.injuryLevel(-20), 1);
  for (const health of [130, NaN, Infinity, undefined]) assert.equal(rules.injuryLevel(health), 0);
});

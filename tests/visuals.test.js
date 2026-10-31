'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const THREE = require('three');
const Systems = require('../public/systems.js');

// Geometry/material contracts use shipping Three r128. Pixel buffers are real;
// canvas paths/text and GPU shading are not rasterized by this unit-test harness.
function drawingContext() {
  const image = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  const gradient = () => ({ addColorStop() {} });
  let pixels;
  const text = [];
  return {
    text, createImageData: image,
    getImageData: (_x, _y, w, h) => pixels ? { width: w, height: h, data: pixels.data.slice() } : image(w, h),
    putImageData(value) { pixels = { width: value.width, height: value.height, data: value.data.slice() }; },
    fillRect() {}, strokeRect() {}, fillText(value) { text.push(value); }, beginPath() {},
    moveTo() {}, lineTo() {}, bezierCurveTo() {}, arc() {}, closePath() {}, fill() {},
    stroke() {}, save() {}, restore() {}, translate() {}, rotate() {},
    createLinearGradient: gradient, createRadialGradient: gradient
  };
}

const context = {
  window: {}, document: { createElement: () => {
    const drawing = drawingContext();
    return { width: 0, height: 0, getContext: () => drawing };
  } },
  WeakMap, Map, Set, Math, Float32Array, Uint8ClampedArray, Object, Array
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/visuals.js'), 'utf8'), context);
const V = context.window.HollowVisuals;

function meshCount(root) {
  let count = 0;
  root.traverse(o => { if (o.isMesh) count++; });
  return count;
}

function triangleCount(root) {
  let count = 0;
  root.traverse(o => { if (o.isMesh) count += (o.geometry.index?.count || o.geometry.attributes.position.count) / 3; });
  return count;
}

function assertFiniteGeometry(root) {
  root.traverse(o => {
    if (!o.isMesh) return;
    const geometry = o.geometry;
    assert.ok(geometry.isBufferGeometry);
    for (const [key, attribute] of Object.entries(geometry.attributes)) {
      for (const value of attribute.array) assert.ok(Number.isFinite(value), `${o.name || root.name} ${key} contains a non-finite component`);
      if (key === 'color' || key === 'normal') assert.equal(attribute.count, geometry.attributes.position.count);
    }
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    assert.ok(Number.isFinite(geometry.boundingSphere.radius));
  });
}

test('four articulated creatures preserve the game animation contract at bounded draw counts', () => {
  const counts = { warden: 24, stalker: 14, crawler: 11, shrieker: 15 };
  for (const [kind, max] of Object.entries(counts)) {
    const g = V.makeMonster(THREE, kind), u = g.userData;
    assert.equal(u.kind, kind);
    for (const name of ['legL', 'legR', 'armL', 'armR', 'neck', 'head']) assert.ok(u[name].isGroup, `${kind}.${name}`);
    assert.equal(u.limbs.length, 4);
    assert.ok(u.eyeMat.isMaterial);
    assert.equal(typeof u.glow.intensity, 'number');
    assert.equal(u.phase, 0);
    let lights = 0; g.traverse(o => { if (o.isLight) lights++; });
    assert.equal(lights, 0, 'creatures must not each add a light pass');
    assert.ok(meshCount(g) <= max, `${kind} exceeded its draw-call budget`);
    assert.ok(triangleCount(g) <= 45000, `${kind} exceeded its triangle budget`);
    const contract = {
      warden: [2.70, 0.52, 2.42, 0.27], stalker: [2.92, 0.30, 2.53, 0.44],
      crawler: [1.1, 0.50, 0.82, 0.2], shrieker: [2.98, 0.30, 2.53, 0.44]
    }[kind];
    assert.deepEqual([u.height, u.bodyRadius, u.headHeight, u.stride], contract);
    assert.equal(u.knees.length, kind === 'crawler' ? 0 : 2);
    assert.equal(u.elbows.length, kind === 'crawler' ? 0 : 2);
    for (const limb of u.limbs) assert.equal(limb.parent, g);
    for (const joint of [...u.knees, ...u.elbows]) assert.ok(u.limbs.includes(joint.parent));
    const bounds = new THREE.Box3().setFromObject(g);
    assert.ok(bounds.max.y <= u.height + 0.08, `${kind} visual mesh exceeds declared hitbox height`);
    assert.ok(bounds.min.y > -0.12, `${kind} feet penetrate floor`);
    assertFiniteGeometry(g); V.disposeGroup(g);
  }
});

test('weapon models have independent moving magazines, bolts, and correctly oriented muzzles', () => {
  const muzzle = {};
  for (const kind of ['rifle', 'pistol', 'shotgun']) {
    const g = V.makeWeapon(THREE, kind), u = g.userData;
    assert.equal(u.kind, kind);
    assert.ok(u.magazine.isGroup && u.magazine.parent === g);
    assert.ok(u.bolt.isGroup && u.bolt.parent === g);
    assert.ok(u.muzzleFlash.isMesh && !u.muzzleFlash.visible);
    assert.ok(u.muzzlePosition.z < 0);
    assert.ok(u.muzzleFlash.position.equals(u.muzzlePosition));
    assert.ok(meshCount(g) <= 15);
    muzzle[kind] = -u.muzzlePosition.z;
    assertFiniteGeometry(g); V.disposeGroup(g);
  }
  assert.ok(muzzle.shotgun > muzzle.rifle && muzzle.rifle > muzzle.pistol);
});

test('procedural surface enhancement preserves world transition shader hooks and albedo', () => {
  const albedo = new THREE.Texture(), material = new THREE.MeshStandardMaterial({ map: albedo });
  const hook = () => {};
  material.onBeforeCompile = hook;
  const output = V.enhanceMaterial(THREE, material, { kind: 'wall' });
  assert.equal(output, material);
  assert.equal(material.map, albedo);
  assert.equal(material.onBeforeCompile, hook);
  assert.ok(material.normalMap.isTexture && material.roughnessMap.isTexture);
  assert.ok(material.normalScale.x > 0 && material.normalScale.x < 1);
  material.dispose(); albedo.dispose();
});

test('rooms batch static geometry and keep both central navigation axes clear', () => {
  for (const type of ['infirmary', 'archive', 'generator', 'armory', 'security', 'lounge', 'maintenance']) {
    for (const width of [9, 15]) {
      const room = V.decorateRoom(THREE, { width, depth: 9, type });
      assert.ok(meshCount(room) <= 12, `${type} exceeded the room draw-call budget: ${meshCount(room)}`);
      assert.ok(triangleCount(room) <= 60000, `${type} exceeded its triangle budget`);
      assert.ok(room.userData.colliders.length >= 2);
      for (const c of room.userData.colliders) {
        for (const field of ['x', 'z', 'w', 'd', 'h']) assert.ok(Number.isFinite(c[field]));
        assert.ok(c.w > 0 && c.d > 0 && c.h > 0);
        assert.ok(Math.abs(c.x) - c.w / 2 > 0.65, `${type} blocks the north/south center path`);
        assert.ok(Math.abs(c.z) - c.d / 2 > 0.65, `${type} blocks the east/west center path`);
      }
      assertFiniteGeometry(room); V.disposeGroup(room);
    }
  }
});

test('disposing one asset cannot destroy another asset’s cached resources', () => {
  const first = V.makeMonster(THREE, 'stalker'), second = V.makeMonster(THREE, 'stalker');
  const shared = new Set(); second.traverse(o => { if (o.material?.userData.hollowShared) shared.add(o.material); });
  let sharedDisposals = 0, ownDisposals = 0;
  shared.forEach(m => m.addEventListener('dispose', () => sharedDisposals++));
  first.userData.eyeMat.addEventListener('dispose', () => ownDisposals++);
  V.disposeGroup(first);
  assert.equal(ownDisposals, 1);
  assert.equal(sharedDisposals, 0);
  assertFiniteGeometry(second); V.disposeGroup(second);
  assert.equal(sharedDisposals, 0);
});

test('Blackwater patients have non-emissive eyes, human-scale teeth, and dressed articulated limbs', () => {
  for (const kind of ['warden', 'stalker', 'crawler', 'shrieker']) {
    const g = V.makeMonster(THREE, kind), u = g.userData;
    assert.equal(u.direction, 'Blackwater Ward');
    assert.ok(u.eyeMat.isMeshStandardMaterial);
    assert.equal(u.eyeMat.emissive.getHex(), 0);
    assert.equal(u.eyeMat.toneMapped, true);
    const hsl = u.eyeMat.color.getHSL({});
    assert.ok(hsl.s < 0.18 && hsl.l < 0.25, `${kind} eyes should be muted, not arcade lights`);
    let eyes = 0;
    g.traverse(o => {
      if (!o.isMesh) return;
      assert.ok(o.material.isMeshStandardMaterial, `${kind} must respond to scene lighting`);
      assert.equal(o.material.metalness, 0, 'patients must not wear fantasy metal armor');
      assert.equal(o.material.emissive.getHex(), 0);
      if (o.material === u.eyeMat) {
        eyes++;
        assert.equal(o.parent, u.head, 'no glowing throat or other luminous anatomy');
        const bounds = new THREE.Box3().setFromObject(o), size = bounds.getSize(new THREE.Vector3());
        assert.ok(size.y < 0.025 && size.z < 0.025, 'restrained inset eyes');
      } else {
        assert.ok(o.geometry.attributes.color, 'skin, clothing, and wraps retain batched vertex tints');
      }
    });
    assert.equal(eyes, 1, 'both eyes should share a single head draw');
    for (const limb of u.limbs) {
      const before = new THREE.Box3().setFromObject(limb);
      limb.rotation.x = -0.6;
      const after = new THREE.Box3().setFromObject(limb);
      assert.ok(!before.equals(after), 'clothing and limb meshes must follow their animation joint');
    }
    u.eyeMat.color.set(0x120000);
    u.eyeMat.color.setHex(u.eyeColor);
    assert.equal(u.eyeMat.color.getHex(), u.eyeColor, 'game death/respawn color contract');
    V.disposeGroup(g);
  }
});

function assertClearGeometry(room) {
  room.updateMatrixWorld(true);
  const point = new THREE.Vector3();
  room.traverse(o => {
    if (!o.isMesh) return;
    const positions = o.geometry.attributes.position, index = o.geometry.index;
    const count = index ? index.count : positions.count;
    // Check triangle extents, not only collider metadata or individual vertices:
    // a wide panel can cross a doorway even when its corners miss the center.
    for (let i = 0; i < count; i += 3) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity;
      for (let j = 0; j < 3; j++) {
        point.fromBufferAttribute(positions, index ? index.getX(i + j) : i + j).applyMatrix4(o.matrixWorld);
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z); minY = Math.min(minY, point.y);
        assert.ok(Math.abs(point.x) <= room.userData.width / 2 + 0.01, `${room.name} exceeds room width`);
        assert.ok(Math.abs(point.z) <= room.userData.depth / 2 + 0.01, `${room.name} exceeds room depth`);
        assert.ok(point.y >= -0.01 && point.y <= room.userData.height + 0.01, `${room.name} exceeds floor/ceiling`);
      }
      if (minY >= 2.15) continue; // Architectural overhead services, not walking obstacles.
      assert.ok(maxX < -0.65 || minX > 0.65, `${room.name} triangle crosses north/south axis`);
      assert.ok(maxZ < -0.65 || minZ > 0.65, `${room.name} triangle crosses east/west axis`);
    }
  });
}

test('clinical dressing tells the ward story and actual geometry leaves navigation axes open', () => {
  for (const type of ['infirmary', 'archive', 'generator', 'armory', 'security', 'lounge', 'maintenance']) {
    for (const [width, depth] of [[7, 7], [9, 9], [15, 12]]) {
      const room = V.decorateRoom(THREE, { width, depth, type });
      assert.equal(room.userData.direction, 'Blackwater Ward');
      const dressing = room.userData.dressing;
      for (const kind of ['water damage', 'discarded evidence', 'unclaimed belongings']) {
        assert.ok(dressing.some(item => item.kind === kind), `${type} lacks ${kind}`);
      }
      if (type === 'infirmary') {
        for (const kind of ['stained mattress', 'body-shaped shroud', 'privacy curtain']) {
          const item = dressing.find(item => item.kind === kind);
          assert.ok(item, `infirmary lacks ${kind}`);
          assert.ok(item.bounds.max[0] < -0.65 && item.bounds.max[2] < -0.65);
        }
        const bed = room.userData.colliders.find(c => c.w < 1.3 && c.d > 1.8 && c.h > .5 && c.h < 1.1);
                if (depth >= 8) assert.ok(bed, 'an uncovered bed must remain a vaultable obstacle');
                assert.ok(room.userData.colliders.some(c => c.w < .5 && c.h > 1.9), 'IV poles have separate narrow colliders');
                const curtain = dressing.find(item => item.kind === 'privacy curtain');
        assert.ok(curtain.bounds.max[1] > 2.4 && curtain.bounds.min[1] > 0.4);
      }
      assertClearGeometry(room);
      assert.ok(meshCount(room) <= 12);
      assert.ok(triangleCount(room) <= 60000);
      let lights = 0; room.traverse(o => { if (o.isLight) lights++; });
      assert.equal(lights, 0);
      V.disposeGroup(room);
    }
  }
});

test('room aliases and constrained or invalid dimensions remain bounded and finite', () => {
  for (const type of ['medical', 'power', 'storage', 'control', 'shelter', 'safe', 'unknown']) {
    const room = V.decorateRoom(THREE, { width: 9, depth: 9, type });
    assert.ok(room.userData.colliders.length >= 2);
    assertClearGeometry(room); assertFiniteGeometry(room); V.disposeGroup(room);
  }
  for (const options of [
    { width: 3, depth: 3, height: 2.6 }, { width: 4, depth: 9 },
    { width: 9, depth: 4 }, { width: -20, depth: 0, height: -1 },
    { width: Infinity, depth: NaN, height: Infinity }, { width: 1000, depth: 1000 },
    { width: '9', depth: null, height: '3.2' }
  ]) {
    const room = V.decorateRoom(THREE, { ...options, type: 'medical' });
    assert.ok(room.userData.width <= 40 && room.userData.depth <= 40);
    assert.ok(meshCount(room) <= 12);
    assert.ok(triangleCount(room) <= 60000);
    assertClearGeometry(room); assertFiniteGeometry(room); V.disposeGroup(room);
  }
});

function pixels(map) {
  return map.image.getContext('2d').getImageData(0, 0, map.image.width, map.image.height).data;
}

test('procedural PBR pixels vary deterministically with cached linear normal/roughness maps', () => {
  assert.equal(THREE.REVISION, '128');
  for (const kind of ['wall', 'floor', 'metal', 'skin', 'fabric', 'concrete', 'wood']) {
    const first = V.enhanceMaterial(THREE, new THREE.MeshStandardMaterial(), { kind });
    const second = V.enhanceMaterial(THREE, new THREE.MeshStandardMaterial(), { kind });
    assert.equal(first.normalMap, second.normalMap);
    assert.equal(first.roughnessMap, second.roughnessMap);
    for (const map of [first.normalMap, first.roughnessMap]) {
      assert.equal(map.encoding, THREE.LinearEncoding);
      assert.equal(map.wrapS, THREE.RepeatWrapping);
      assert.equal(map.wrapT, THREE.RepeatWrapping);
      assert.equal(map.userData.hollowShared, true);
      assert.equal(map.image.width, 256);
    }
    const normal = pixels(first.normalMap), roughness = pixels(first.roughnessMap);
    const roughValues = new Set();
    for (let i = 0; i < normal.length; i += 4) {
      const len = Math.hypot(normal[i] / 255 * 2 - 1, normal[i + 1] / 255 * 2 - 1, normal[i + 2] / 255 * 2 - 1);
      assert.ok(Math.abs(len - 1) < 0.015);
      assert.equal(normal[i + 3], 255); assert.equal(roughness[i + 3], 255);
      roughValues.add(roughness[i]);
    }
    assert.ok(roughValues.size > 12, `${kind} has flat roughness`);
    // A fresh module cache with the same Three constructor must generate identical pixels.
    const fresh = { ...context, window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/visuals.js'), 'utf8'), fresh);
    const regenerated = fresh.window.HollowVisuals.enhanceMaterial(THREE, new THREE.MeshStandardMaterial(), { kind });
    assert.deepEqual(pixels(regenerated.normalMap), normal);
    assert.deepEqual(pixels(regenerated.roughnessMap), roughness);
    first.dispose(); second.dispose(); regenerated.dispose();
  }
});

test('ward fabrics carry colored stains and signs identify the facility below the manor', () => {
  const room = V.decorateRoom(THREE, { type: 'infirmary' }), lines = [];
  let foundFabric = false;
  room.traverse(o => {
    if (!o.isMesh || !o.material.map) return;
    lines.push(...o.material.map.image.getContext('2d').text);
    if (o.material.userData.hollowSurface !== 'fabric' || foundFabric) return;
    foundFabric = true;
    const data = pixels(o.material.map), levels = new Set();
    let stained = 0;
    for (let i = 0; i < data.length; i += 4) {
      levels.add(data[i]);
      if (data[i] - data[i + 2] > 5) stained++;
    }
    assert.ok(levels.size > 40 && stained > 1000, 'fabric should have uneven ochre/grey soiling');
    assert.equal(o.material.map.encoding, THREE.sRGBEncoding);
  });
  assert.ok(foundFabric);
  assert.ok(lines.includes('BLACKWATER WARD / BELOW MANOR'));
  assert.ok(lines.includes('DISCHARGES: 00'));
  V.disposeGroup(room);
});

test('ward teardown is idempotent and preserves all cached geometries, materials, and textures', () => {
  for (const make of [() => V.makeMonster(THREE, 'shrieker'), () => V.decorateRoom(THREE, { type: 'infirmary' })]) {
    const first = make(), second = make(), shared = new Set(), owned = new Set();
    first.traverse(o => {
      if (!o.isMesh) return;
      for (const resource of [o.geometry, o.material, o.material.map, o.material.normalMap, o.material.roughnessMap]) {
        if (!resource) continue;
        (resource.userData.hollowShared ? shared : owned).add(resource);
      }
    });
    let sharedDisposals = 0;
    const disposals = new Map();
    shared.forEach(resource => resource.addEventListener('dispose', () => sharedDisposals++));
    owned.forEach(resource => resource.addEventListener('dispose', () => disposals.set(resource, (disposals.get(resource) || 0) + 1)));
    const parent = new THREE.Group(); parent.add(first);
    V.disposeGroup(first); V.disposeGroup(first);
    assert.equal(first.parent, null);
    assert.equal(sharedDisposals, 0);
    assert.ok(owned.size > 0);
    for (const resource of owned) assert.equal(disposals.get(resource), 1);
    assertFiniteGeometry(second); V.disposeGroup(second);
    assert.equal(sharedDisposals, 0);
  }
});

function wardOptions(seed = 42) {
  return { ...Systems.generateMaze(Systems.seeded(seed)), cellSize: Systems.CELL, height: 3.2, seed };
}

function wardSnapshot(group) {
  const meshes = [];
  group.traverse(o => {
    if (o.isMesh) meshes.push({
      matrix: o.matrix.toArray(), index: o.geometry.index && Array.from(o.geometry.index.array),
      attributes: Object.fromEntries(Object.entries(o.geometry.attributes).map(([k, a]) => [k, Array.from(a.array)])),
      color: o.material.color.getHex(), emissive: o.material.emissive.getHex(),
      text: o.material.map?.image.getContext('2d').text
    });
  });
  return JSON.stringify({ meshes, practicals: group.userData.practicals });
}

// Test actual triangle extents, not declared collider/placement metadata. Every
// primitive must fit a corridor cell; only flush floor/wall or overhead detail
// may occupy its volume. Boundary vertices get a small floating-point tolerance.
function assertWardClear(group, options) {
  const { grid, rooms, cellSize: s, height } = options, epsilon = 0.00002;
  const excluded = (x, z) => rooms.some(r =>
    (x >= r.x && x < r.x + r.w && z >= r.z && z < r.z + r.d) || (r.door?.x === x && r.door?.z === z));
  group.updateMatrixWorld(true);
  group.traverse(o => {
    if (!o.isMesh) return;
    const position = o.geometry.attributes.position, index = o.geometry.index;
    for (let i = 0; i < (index?.count || position.count); i += 3) {
      const bounds = new THREE.Box3();
      for (let j = 0; j < 3; j++) bounds.expandByPoint(new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i + j) : i + j).applyMatrix4(o.matrixWorld));
      assert.ok(bounds.min.y >= -epsilon && bounds.max.y <= height + epsilon, 'detail stays between floor and ceiling');
      const x0 = Math.floor((bounds.min.x + bounds.max.x) / (2 * s));
      const z0 = Math.floor((bounds.min.z + bounds.max.z) / (2 * s));
      let safe = false;
      for (let z = z0 - 1; z <= z0 + 1; z++) for (let x = x0 - 1; x <= x0 + 1; x++) {
        if (grid[z]?.[x] !== 0 || excluded(x, z) || x === 0 || z === 0 || z === grid.length - 1 || x === grid[z].length - 1) continue;
        if (bounds.min.x < x * s - epsilon || bounds.max.x > (x + 1) * s + epsilon ||
            bounds.min.z < z * s - epsilon || bounds.max.z > (z + 1) * s + epsilon) continue;
        if (bounds.max.y <= 0.02 || bounds.min.y > 2.65) { safe = true; continue; }
        const flush = 0.08 + epsilon;
        if ((grid[z][x - 1] === 1 && bounds.max.x <= x * s + flush) ||
            (grid[z][x + 1] === 1 && bounds.min.x >= (x + 1) * s - flush) ||
            (grid[z - 1]?.[x] === 1 && bounds.max.z <= z * s + flush) ||
            (grid[z + 1]?.[x] === 1 && bounds.min.z >= (z + 1) * s - flush)) safe = true;
      }
      assert.ok(safe, `corridor obstruction or room intrusion at ${bounds.min.toArray()} / ${bounds.max.toArray()}`);
    }
  });
}

test('corridor dressing stays within ten material draws on structured floorplans without lights or shadows', () => {
  for (const seed of [0, 1, 42]) {
    const options = wardOptions(seed), before = JSON.stringify(options);
    const group = V.decorateWard(THREE, options);
    assert.ok(group.isGroup && group.userData.decoration);
    assert.equal(group.userData.colliders.length, 0);
    assert.equal(JSON.stringify(options), before, 'must not mutate the floorplan');
    assert.ok(meshCount(group) >= 8 && meshCount(group) <= 10);
    const materials = new Set();
    group.traverse(o => {
      assert.ok(!o.isLight);
      if (!o.isMesh) return;
      assert.ok(!Array.isArray(o.material), 'one draw per mesh');
      assert.equal(o.castShadow, false, 'no additional shadow passes');
      assert.ok(o.material.isMeshStandardMaterial);
      materials.add(o.material);
    });
    assert.equal(materials.size, meshCount(group), 'all static details batch by material');
    assertFiniteGeometry(group); assertWardClear(group, options); V.disposeGroup(group);
  }
});

test('working corridor tubes are sparse, pale warm, separated, and match pooled-light metadata', () => {
  const options = wardOptions(), group = V.decorateWard(THREE, options), lamps = group.userData.practicals;
  assert.ok(lamps.length > 0 && lamps.length <= 8);
  let glowing = 0, deadVertices = 0;
  group.traverse(o => {
    if (!o.isMesh) return;
    if (o.material.emissive.getHex() !== 0) {
      glowing++;
      assert.equal(o.material.emissive.getHex(), 0xe6d6b5);
      assert.ok(o.material.emissiveIntensity <= 0.5);
      // One small box/tube per practical; the other tube in its housing is dead.
      assert.equal(o.geometry.attributes.position.count, lamps.length * 36);
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 36) {
        const bounds = new THREE.Box3();
        for (let j = i; j < i + 36; j++) bounds.expandByPoint(new THREE.Vector3().fromBufferAttribute(pos, j));
        const center = bounds.getCenter(new THREE.Vector3());
        assert.ok(lamps.some(l => Math.hypot(l.x - center.x, l.z - center.z) < 0.07));
      }
    } else if (!o.material.map && o.material.color.getHex() !== 0) deadVertices += o.geometry.attributes.position.count;
  });
  assert.equal(glowing, 1);
  assert.ok(deadVertices >= lamps.length * 7 * 36, 'at most one in four fixtures has a surviving tube');
  for (let i = 0; i < lamps.length; i++) {
    const lamp = lamps[i];
    assert.deepEqual(Object.keys(lamp).sort(), ['color', 'phase', 'x', 'z']);
    assert.ok([lamp.x, lamp.z, lamp.phase].every(Number.isFinite));
    assert.equal(lamp.color, 0xe6d6b5);
    assert.ok(lamp.phase >= 0 && lamp.phase < Math.PI * 2);
    for (let j = 0; j < i; j++) assert.ok(Math.hypot(lamp.x - lamps[j].x, lamp.z - lamps[j].z) >= 12);
  }
  V.disposeGroup(group);
});

test('corridor placement and lamp phases are seed-deterministic across disposal and fresh caches', () => {
  const options = wardOptions(), first = V.decorateWard(THREE, options), expected = wardSnapshot(first);
  V.disposeGroup(first);
  const second = V.decorateWard(THREE, options);
  assert.equal(wardSnapshot(second), expected);
  const fresh = { ...context, window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/visuals.js'), 'utf8'), fresh);
  const regenerated = fresh.window.HollowVisuals.decorateWard(THREE, options);
  assert.equal(wardSnapshot(regenerated), expected);
  const different = V.decorateWard(THREE, { ...options, seed: 43 });
  assert.notEqual(wardSnapshot(different), expected);
  V.disposeGroup(second); V.disposeGroup(different); fresh.window.HollowVisuals.disposeGroup(regenerated);
});

test('exit placards follow connected corridor routes rather than pointing through rooms', () => {
  const grid = Array.from({ length: 7 }, () => Array(25).fill(1));
  for (let x = 1; x < 25; x++) grid[2][x] = 0;
  for (let x = 1; x < 24; x++) grid[4][x] = 0; // Disconnected service hall.
  const options = { grid, rooms: [], cellSize: 3, height: 3.2, seed: 12 };
  const group = V.decorateWard(THREE, options);
  let signs = 0;
  group.traverse(o => {
    const lines = o.material?.map?.image.getContext('2d').text || [];
    if (!lines.includes('EVACUATION ROUTE')) return;
    signs++;
    const right = lines.includes('EXIT >'), pos = o.geometry.attributes.position, normal = o.geometry.attributes.normal;
    for (let i = 0; i < pos.count; i++) {
      assert.ok(pos.getZ(i) >= 6 && pos.getZ(i) <= 9, 'only the connected hall has signs');
      // On north/south walls, local right is +/-world X respectively.
      assert.ok((right ? 1 : -1) * normal.getZ(i) > 0.99, 'arrow points east toward the exit');
    }
  });
  assert.ok(signs > 0);
  assertWardClear(group, options); V.disposeGroup(group);
  const blocked = V.decorateWard(THREE, { ...options, rooms: [{ x: 10, z: 2, w: 1, d: 1 }] });
  blocked.traverse(o => {
    if (!(o.material?.map?.image.getContext('2d').text || []).includes('EVACUATION ROUTE')) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) assert.ok(pos.getX(i) > 33, 'route cannot cross excluded room cells');
  });
  V.disposeGroup(blocked);
});

test('corridor teardown disposes owned batches once and preserves bounded shared caches', () => {
  const options = wardOptions(), first = V.decorateWard(THREE, options), second = V.decorateWard(THREE, options);
  const shared = new Set(), owned = new Set();
  first.traverse(o => {
    if (!o.isMesh) return;
    for (const resource of [o.geometry, o.material, o.material.map, o.material.normalMap, o.material.roughnessMap]) {
      if (resource) (resource.userData.hollowShared ? shared : owned).add(resource);
    }
  });
  const disposals = new Map();
  for (const resource of [...shared, ...owned]) resource.addEventListener('dispose', () => disposals.set(resource, (disposals.get(resource) || 0) + 1));
  const parent = new THREE.Group(); parent.add(first);
  V.disposeGroup(first); V.disposeGroup(first);
  assert.equal(first.parent, null);
  assert.ok(owned.size > 0);
  for (const resource of owned) assert.equal(disposals.get(resource), 1);
  for (const resource of shared) assert.equal(disposals.get(resource), undefined);
  for (const seed of [43, 44, 45]) {
    const rebuilt = V.decorateWard(THREE, { ...options, seed });
    rebuilt.traverse(o => {
      if (!o.isMesh) return;
      for (const resource of [o.material, o.material.map, o.material.normalMap, o.material.roughnessMap]) {
        if (resource) assert.ok(shared.has(resource), 'seed must not create new cached materials or maps');
      }
    });
    V.disposeGroup(rebuilt);
  }
  assertFiniteGeometry(second); V.disposeGroup(second);
  for (const resource of shared) assert.equal(disposals.get(resource), undefined);
});

test('empty, room-only, ragged and low-ceiling wards remain safe without overhead obstructions', () => {
  for (const options of [{}, { grid: null }, { grid: [] }, { grid: [[1, 1], [1, 1]] },
    { grid: [[0]], cellSize: NaN }, { grid: [[0]], height: Infinity },
    { grid: [[1, 1, 1], [1, 0, 1], [1, 1, 1]], rooms: [{ x: 1, z: 1, w: 1, d: 1 }] }]) {
    const group = V.decorateWard(THREE, options);
    assert.equal(meshCount(group), 0); assert.equal(group.userData.practicals.length, 0); V.disposeGroup(group);
  }
  for (const s of [0.5, 1.5, 3, 5]) for (const height of [1.5, 2.7, 2.95, 4]) {
    const options = { grid: [[1, 1, 1, 1, 1], [1, 0, 0, 0, 1], [1, 0, 1], [], [1, 1, 1]], rooms: [], cellSize: s, height, seed: 7 };
    const group = V.decorateWard(THREE, options);
    if (height < 2.95) assert.equal(group.userData.practicals.length, 0);
    assert.ok(meshCount(group) <= 10);
    assertFiniteGeometry(group); assertWardClear(group, options); V.disposeGroup(group);
  }
});

test('flashlight owns its switchable optics and disposes that texture without touching caches', () => {
  const light = V.makeFlashlight(THREE), u = light.userData;
  assert.ok(u.lens.isMesh && u.lens.material === u.lensMaterial);
  assert.ok(u.muzzlePosition.z < 0);
  assert.ok(meshCount(light) <= 8);
  let mapDisposals = 0;
  u.lensMaterial.map.addEventListener('dispose', () => mapDisposals++);
  assertFiniteGeometry(light); V.disposeGroup(light); V.disposeGroup(light);
  assert.equal(mapDisposals, 1);
});

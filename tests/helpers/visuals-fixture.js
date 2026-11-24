'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const THREE = require('three');

// Real shipping geometry/collider generation, with only pixel drawing stubbed.
// Navigation tests must follow furniture changes instead of duplicating layouts.
function drawingContext() {
  const image = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  const gradient = () => ({ addColorStop() {} });
  return {
    createImageData: image, getImageData: (_x, _y, w, h) => image(w, h),
    putImageData() {}, fillRect() {}, strokeRect() {}, fillText() {}, beginPath() {},
    moveTo() {}, lineTo() {}, bezierCurveTo() {}, arc() {}, closePath() {}, fill() {},
    stroke() {}, save() {}, restore() {}, translate() {}, rotate() {},
    createLinearGradient: gradient, createRadialGradient: gradient
  };
}
const context = {
  window: {}, document: { createElement: () => ({ width: 0, height: 0, getContext: drawingContext }) },
  WeakMap, Map, Set, Math, Float32Array, Uint8ClampedArray, Object, Array
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/visuals.js'), 'utf8'), context);
const visuals = context.window.HollowVisuals, cache = new Map();

function collidersForRooms(rooms, cellSize = 3) {
  const result = [];
  for (const room of rooms) {
    const width = room.w * cellSize, depth = room.d * cellSize;
    // Rooms above ground (a `look`) are dressed by decorateOutdoorRoom, as in game.js.
    const key = `${room.look ? 'look:' + room.look : room.type}:${width}:${depth}`;
    if (!cache.has(key)) {
      const model = room.look ? visuals.decorateOutdoorRoom(THREE, { width, depth, look: room.look })
        : visuals.decorateRoom(THREE, { width, depth, type: room.type });
      cache.set(key, model.userData.colliders.map(collider => ({ ...collider })));
      visuals.disposeGroup(model);
    }
    const cx = (room.x + room.w / 2) * cellSize, cz = (room.z + room.d / 2) * cellSize;
    for (const collider of cache.get(key)) result.push({ ...collider, x: collider.x + cx, z: collider.z + cz, room: room.id });
  }
  return result;
}

// The grounds of an outdoor floor (rules.FLOORS[index].outdoor), dressed with the options game.js gives decorateGrounds.
function collidersForGrounds(layout, index, seed, cellSize = 3) {
  const rules = require('../../public/systems'), floor = rules.FLOORS[index], W = layout.grid.length;
  const model = visuals.decorateGrounds(THREE, groundsOptions(floor, layout, seed, cellSize, W));
  const colliders = model.userData.colliders.map(collider => ({ ...collider }));
  visuals.disposeGroup(model);
  return colliders;
}
// Mirrors groundsOptions() in game.js (the lobby pedestal and fallen chandelier, the gate approach and the boss's graves).
function groundsOptions(floor, layout, seed, s, W) {
  const avoid = [{ x: (W - 2 + .5) * s, z: (W - 2 + .5) * s, r: 4 }];
  if (floor.boss) avoid.push({ x: (floor.boss.grave[0] + .5) * s, z: (floor.boss.grave[1] + .5) * s, r: 2.6 }, ...floor.boss.summons.map(([x, z]) => ({ x: (x + .5) * s, z: (z + .5) * s, r: 2 })));
  return { grid: layout.grid, cellSize: s, height: 3.2, rooms: layout.rooms, seed, kind: floor.boss ? 'graveyard' : 'garden', avoid,
    centre: floor.fountain ? [(floor.fountain[0] + .5) * s, (floor.fountain[1] + .5) * s] : null, boss: floor.boss || null, gate: [W - 1, W - 2],
    landmarks: { ped: { x: 16.5, z: 7.5 }, chan: { x: 10.5, z: 7.5 } } };
}

module.exports = { collidersForRooms, collidersForGrounds, groundsOptions };

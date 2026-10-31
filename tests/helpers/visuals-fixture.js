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
    const key = `${room.type}:${width}:${depth}`;
    if (!cache.has(key)) {
      const model = visuals.decorateRoom(THREE, { width, depth, type: room.type });
      cache.set(key, model.userData.colliders.map(collider => ({ ...collider })));
      visuals.disposeGroup(model);
    }
    const cx = (room.x + room.w / 2) * cellSize, cz = (room.z + room.d / 2) * cellSize;
    for (const collider of cache.get(key)) result.push({ ...collider, x: collider.x + cx, z: collider.z + cz, room: room.id });
  }
  return result;
}

module.exports = { collidersForRooms };

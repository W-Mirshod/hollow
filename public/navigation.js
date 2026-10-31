/* Renderer-independent swept-disc navigation. World-coordinate paths, no teleporting
   across furniture. Static radius masks/edges are cached; doors are always live. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HollowNavigation = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EPS = 1e-8;
  const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const OPPOSITE = [1, 0, 3, 2, 7, 6, 5, 4];

  class MinHeap {
    constructor() { this.ids = []; this.scores = []; }
    get size() { return this.ids.length; }
    clear() { this.ids.length = this.scores.length = 0; }
    push(id, score) {
      let at = this.ids.length;
      this.ids.push(id); this.scores.push(score);
      while (at > 0) {
        const parent = (at - 1) >> 1;
        if (this.scores[parent] <= score) break;
        this.ids[at] = this.ids[parent]; this.scores[at] = this.scores[parent]; at = parent;
      }
      this.ids[at] = id; this.scores[at] = score;
    }
    pop() {
      const answer = this.ids[0], last = this.ids.pop(), score = this.scores.pop();
      if (!this.ids.length) return answer;
      let at = 0;
      while (at * 2 + 1 < this.ids.length) {
        let child = at * 2 + 1;
        if (child + 1 < this.ids.length && this.scores[child + 1] < this.scores[child]) child++;
        if (this.scores[child] >= score) break;
        this.ids[at] = this.ids[child]; this.scores[at] = this.scores[child]; at = child;
      }
      this.ids[at] = last; this.scores[at] = score;
      return answer;
    }
  }

  function pointSegmentDistance2(x, z, ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az, length2 = dx * dx + dz * dz;
    const t = length2 > EPS ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length2)) : 0;
    const px = ax + t * dx - x, pz = az + t * dz - z;
    return px * px + pz * pz;
  }
  function pointBoxDistance2(x, z, left, top, right, bottom) {
    const dx = Math.max(left - x, 0, x - right), dz = Math.max(top - z, 0, z - bottom);
    return dx * dx + dz * dz;
  }
  function intersectsBox(ax, az, bx, bz, left, top, right, bottom) {
    let enter = 0, leave = 1;
    const dx = bx - ax, dz = bz - az;
    if (Math.abs(dx) < EPS) { if (ax < left || ax > right) return false; }
    else {
      let a = (left - ax) / dx, b = (right - ax) / dx;
      if (a > b) [a, b] = [b, a];
      enter = Math.max(enter, a); leave = Math.min(leave, b);
      if (enter > leave) return false;
    }
    if (Math.abs(dz) < EPS) { if (az < top || az > bottom) return false; }
    else {
      let a = (top - az) / dz, b = (bottom - az) / dz;
      if (a > b) [a, b] = [b, a];
      enter = Math.max(enter, a); leave = Math.min(leave, b);
      if (enter > leave) return false;
    }
    return true;
  }
  function hitsBox(ax, az, bx, bz, radius, left, top, right, bottom) {
    if (Math.max(ax, bx) + radius < left || Math.min(ax, bx) - radius > right ||
        Math.max(az, bz) + radius < top || Math.min(az, bz) - radius > bottom) return false;
    if (intersectsBox(ax, az, bx, bz, left, top, right, bottom)) return true;
    // Exact segment-to-rectangle distance: endpoints against the rectangle, then
    // corners against the segment. This retains clearance around rounded corners.
    const distance2 = Math.min(
      pointBoxDistance2(ax, az, left, top, right, bottom),
      pointBoxDistance2(bx, bz, left, top, right, bottom),
      pointSegmentDistance2(left, top, ax, az, bx, bz),
      pointSegmentDistance2(right, top, ax, az, bx, bz),
      pointSegmentDistance2(left, bottom, ax, az, bx, bz),
      pointSegmentDistance2(right, bottom, ax, az, bx, bz)
    );
    return distance2 < radius * radius - EPS;
  }
  function box(value) {
    if (!value || ![value.x, value.z, value.w, value.d].every(Number.isFinite) || value.w <= 0 || value.d <= 0) return null;
    return { left: value.x - value.w / 2, right: value.x + value.w / 2, top: value.z - value.d / 2, bottom: value.z + value.d / 2 };
  }

  function create(options) {
    options = options || {};
    const grid = options.grid, cell = options.cellSize === undefined ? 3 : options.cellSize;
    if (!Array.isArray(grid) || grid.length < 3 || !Array.isArray(grid[0]) || grid[0].length < 3 ||
        !grid.every(row => Array.isArray(row) && row.length === grid[0].length) || !Number.isFinite(cell) || cell <= 0) {
      throw new TypeError('Navigation needs a rectangular grid and positive cellSize');
    }
    // Half-metre samples for the game's 3m cells retain usable entrance aisles.
    const rows = grid.length, columns = grid[0].length, subdivisions = 6;
    const step = cell / subdivisions, width = columns * cell, depth = rows * cell;
    const nx = columns * subdivisions, nz = rows * subdivisions, count = nx * nz;
    const caches = new Map();
    let boxes = [], circles = [];

    function invalidate() {
      boxes = (Array.isArray(options.props) ? options.props : []).map(box).filter(Boolean);
      circles = (Array.isArray(options.circles) ? options.circles : []).filter(value => value &&
        [value.x, value.z, value.r].every(Number.isFinite) && value.r > 0).map(value => ({ x: value.x, z: value.z, r: value.r }));
      caches.clear();
    }
    invalidate();
    function doorsNow() {
      const values = typeof options.doors === 'function' ? options.doors() : options.doors;
      return (Array.isArray(values) ? values : []).filter(value => value && !value.open).map(box).filter(Boolean);
    }
    function wall(x, z) {
      // Monsters do not leave the world through its exterior doorway/exit cells.
      return x <= 0 || z <= 0 || x >= columns - 1 || z >= rows - 1 || grid[z][x] !== 0;
    }
    function staticClear(ax, az, bx, bz, radius) {
      const left = Math.min(ax, bx) - radius, right = Math.max(ax, bx) + radius;
      const top = Math.min(az, bz) - radius, bottom = Math.max(az, bz) + radius;
      if (left < 0 || top < 0 || right > width || bottom > depth) return false;
      const firstX = Math.floor(left / cell), lastX = Math.floor(right / cell);
      const firstZ = Math.floor(top / cell), lastZ = Math.floor(bottom / cell);
      for (let z = firstZ; z <= lastZ; z++) for (let x = firstX; x <= lastX; x++) {
        if (wall(x, z) && hitsBox(ax, az, bx, bz, radius, x * cell, z * cell, (x + 1) * cell, (z + 1) * cell)) return false;
      }
      for (const b of boxes) if (hitsBox(ax, az, bx, bz, radius, b.left, b.top, b.right, b.bottom)) return false;
      for (const c of circles) {
        const combined = c.r + radius;
        if (pointSegmentDistance2(c.x, c.z, ax, az, bx, bz) < combined * combined - EPS) return false;
      }
      return true;
    }
    function doorsClear(ax, az, bx, bz, radius, doors) {
      for (const b of doors) if (hitsBox(ax, az, bx, bz, radius, b.left, b.top, b.right, b.bottom)) return false;
      return true;
    }
    function allClear(ax, az, bx, bz, radius, doors) {
      return staticClear(ax, az, bx, bz, radius) && doorsClear(ax, az, bx, bz, radius, doors);
    }
    function valid(ax, az, bx, bz, radius) {
      return [ax, az, bx, bz, radius].every(Number.isFinite) && radius > 0 && radius < cell &&
        ax >= 0 && az >= 0 && bx >= 0 && bz >= 0 && ax <= width && bx <= width && az <= depth && bz <= depth;
    }
    function clear(ax, az, bx, bz, radius) {
      return valid(ax, az, bx, bz, radius) && allClear(ax, az, bx, bz, radius, doorsNow());
    }
    const worldX = id => (id % nx + .5) * step;
    const worldZ = id => (((id / nx) | 0) + .5) * step;

    function cacheFor(radius) {
      // Preserve the exact collision radius. Rounding .34 upward, for example,
      // would strand an actor already tangent to a wall at its true radius.
      const key = radius;
      if (caches.has(key)) {
        const entry = caches.get(key); caches.delete(key); caches.set(key, entry); return entry;
      }
      const entry = {
        radius: key, walk: new Uint8Array(count), edgeKnown: new Uint8Array(count), edgeOpen: new Uint8Array(count),
        seen: new Uint32Array(count), closed: new Uint32Array(count), parent: new Int32Array(count),
        costs: new Float64Array(count), generation: 0, heap: new MinHeap()
      };
      for (let id = 0; id < count; id++) {
        const x = worldX(id), z = worldZ(id);
        entry.walk[id] = staticClear(x, z, x, z, key) ? 1 : 0;
      }
      // The game uses three radii; a fourth slot leaves room for other actors.
      if (caches.size >= 4) caches.delete(caches.keys().next().value);
      caches.set(key, entry);
      return entry;
    }
    function staticEdge(entry, from, to, direction) {
      const bit = 1 << direction;
      if (entry.edgeKnown[from] & bit) return !!(entry.edgeOpen[from] & bit);
      const open = staticClear(worldX(from), worldZ(from), worldX(to), worldZ(to), entry.radius);
      entry.edgeKnown[from] |= bit; entry.edgeKnown[to] |= 1 << OPPOSITE[direction];
      if (open) { entry.edgeOpen[from] |= bit; entry.edgeOpen[to] |= 1 << OPPOSITE[direction]; }
      return open;
    }

    function path(sx, sz, tx, tz, radius) {
      if (!valid(sx, sz, tx, tz, radius)) return [];
      const doors = doorsNow();
      if (!allClear(sx, sz, sx, sz, radius, doors)) return [];
      if (allClear(sx, sz, tx, tz, radius, doors)) return [[tx, tz]];
      const entry = cacheFor(radius), r = entry.radius;
      const available = id => entry.walk[id] && doorsClear(worldX(id), worldZ(id), worldX(id), worldZ(id), r, doors);

      function nearby(x, z, reach, connect, limit) {
        const cx = Math.floor(x / step), cz = Math.floor(z / step), range = Math.ceil(reach / step), found = [];
        for (let iz = Math.max(0, cz - range); iz <= Math.min(nz - 1, cz + range); iz++) {
          for (let ix = Math.max(0, cx - range); ix <= Math.min(nx - 1, cx + range); ix++) {
            const id = iz * nx + ix;
            if (!available(id)) continue;
            const px = worldX(id), pz = worldZ(id), distance = Math.hypot(px - x, pz - z);
            if (distance > reach || (connect && !allClear(x, z, px, pz, r, doors))) continue;
            found.push({ id, distance, fromStart: Math.hypot(px - sx, pz - sz) });
          }
        }
        found.sort((a, b) => a.distance - b.distance || a.fromStart - b.fromStart);
        return found.slice(0, limit);
      }

      const starts = nearby(sx, sz, cell, true, 12);
      if (!starts.length) return [];
      const exactGoal = allClear(tx, tz, tx, tz, r, doors);
      let goals;
      if (exactGoal) goals = nearby(tx, tz, cell, true, 12);
      else goals = nearby(tx, tz, cell * 2, false, Infinity);
      if (!goals.length) return [];
      // Keep all nearby alternatives for embedded targets: the geometrically
      // nearest legal node can be on the unreachable side of a divider/door.
      const goalDistances = new Map(goals.map(goal => [goal.id, goal.distance]));
      const minimumGoalDistance = goals[0].distance;
      entry.generation = (entry.generation + 1) >>> 0;
      if (!entry.generation) { entry.seen.fill(0); entry.closed.fill(0); entry.generation = 1; }
      const generation = entry.generation, heap = entry.heap;
      heap.clear();
      const heuristic = id => Math.hypot(worldX(id) - tx, worldZ(id) - tz);
      for (const start of starts) {
        entry.seen[start.id] = generation; entry.costs[start.id] = start.distance; entry.parent[start.id] = -1;
        heap.push(start.id, start.distance + heuristic(start.id));
      }
      let reached = -1, reachedDistance = Infinity, reachedCost = Infinity;
      while (heap.size) {
        const current = heap.pop();
        if (entry.closed[current] === generation) continue;
        entry.closed[current] = generation;
        if (goalDistances.has(current)) {
          if (exactGoal) { reached = current; break; }
          const distance = goalDistances.get(current);
          if (distance < reachedDistance - EPS || (Math.abs(distance - reachedDistance) < EPS && entry.costs[current] < reachedCost)) {
            reached = current; reachedDistance = distance; reachedCost = entry.costs[current];
          }
          if (reachedDistance <= minimumGoalDistance + EPS) break;
        }
        const x = current % nx, z = (current / nx) | 0;
        for (let direction = 0; direction < DIRECTIONS.length; direction++) {
          const [dx, dz] = DIRECTIONS[direction], xx = x + dx, zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= nx || zz >= nz) continue;
          const next = zz * nx + xx;
          if (entry.closed[next] === generation || !available(next) || !staticEdge(entry, current, next, direction) ||
              !doorsClear(worldX(current), worldZ(current), worldX(next), worldZ(next), r, doors)) continue;
          const cost = entry.costs[current] + step * (direction < 4 ? 1 : Math.SQRT2);
          if (entry.seen[next] === generation && cost >= entry.costs[next] - EPS) continue;
          entry.seen[next] = generation; entry.costs[next] = cost; entry.parent[next] = current;
          heap.push(next, cost + heuristic(next));
        }
      }
      if (reached < 0) return [];
      const raw = [];
      for (let id = reached; id >= 0; id = entry.parent[id]) raw.push([worldX(id), worldZ(id)]);
      raw.reverse();
      if (exactGoal && Math.hypot(raw[raw.length - 1][0] - tx, raw[raw.length - 1][1] - tz) > EPS) raw.push([tx, tz]);

      // String-pull the lattice route with the same swept-disc tests as movement.
      // Every first/final connector is checked too; no snapping through furniture.
      const result = [];
      let ax = sx, az = sz, previous = raw[0];
      for (const point of raw) {
        if (!allClear(ax, az, point[0], point[1], r, doors)) {
          if (Math.hypot(previous[0] - ax, previous[1] - az) < EPS) return [];
          result.push(previous); ax = previous[0]; az = previous[1];
          if (!allClear(ax, az, point[0], point[1], r, doors)) return [];
        }
        previous = point;
      }
      if (!result.length || Math.hypot(previous[0] - ax, previous[1] - az) > EPS) result.push(previous);
      return result;
    }
    return Object.freeze({ path, clear, invalidate });
  }

  return Object.freeze({ create });
});

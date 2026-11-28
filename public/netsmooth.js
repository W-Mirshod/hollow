/* Co-op motion smoothing: timestamped snapshots, a playout clock per sender, and interpolation between snapshots.
   No renderer and no DOM. Shared by the browser and tests. All times are seconds. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HollowNet = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  // The shortest signed turn from angle a to angle b.
  function turn(a, b) { return ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI; }

  /* A sender's snapshots are stamped with the sender's own clock. The playout clock answers "which sender time do I
     draw now?": a little behind the newest snapshot, so there are nearly always two snapshots to draw between.
     How far behind is measured, not fixed: one send interval plus how late packets on this link usually arrive.
     - observe(ts, now): a snapshot stamped ts arrived at local time now. False if it is not newer than the last one.
     - time(now): the sender time to draw at local time now. Null until a snapshot has arrived. Call once a frame. */
  function createClock(options) {
    const o = Object.assign({
      minDelay: .04,      // never draw closer than this to the newest snapshot
      maxDelay: .3,       // never hold the picture back further than this, however bad the link
      margin: .01,
      window: 3,          // seconds over which the fastest packet defines "on time"
      samples: 96,        // lateness history (about three seconds of snapshots)
      percentile: .9,     // packets later than this share of the history are ridden out, not waited for
      extrapolate: .1,    // how far past the newest snapshot the picture may run on before it holds
      catchUp: .3,        // the picture may run this much fast to shed delay,
      fallBack: .15,      // and this much slow to gain it,
      snap: 1             // unless it is further out than this: then it jumps
    }, options);
    const lateness = new Float32Array(o.samples), sorted = new Float32Array(o.samples);
    let filled, cursor, sinceSort, late, interval, lastTs, bucketMin, prevMin, bucketAt, base, offset, lastNow, starved;
    function reset() {
      filled = cursor = sinceSort = 0; late = 0; interval = 1 / 30; lastTs = null;
      bucketMin = prevMin = Infinity; bucketAt = 0; base = 0; offset = null; lastNow = null; starved = 0;
    }
    reset();
    function delay() { return clamp(interval + late + o.margin, o.minDelay, o.maxDelay); }
    function observe(ts, now) {
      if (!Number.isFinite(ts) || !Number.isFinite(now)) return false;
      if (lastTs !== null) {
        if (ts <= lastTs) { if (lastTs - ts < 5) return false; reset(); }   // the sender's clock restarted
        else { const gap = ts - lastTs; if (gap < 1) interval += (Math.min(.25, gap) - interval) * .1; }
      }
      // "On time" is the quickest packet of the last few seconds: sender and receiver clocks need not agree, or even
      // tick at quite the same rate.
      const arrival = now - ts;
      if (bucketMin === Infinity && prevMin === Infinity) bucketAt = now;
      else if (now - bucketAt > o.window) { prevMin = bucketMin; bucketMin = Infinity; bucketAt = now; }
      if (arrival < bucketMin) bucketMin = arrival;
      base = Math.min(bucketMin, prevMin);
      lateness[cursor] = Math.min(o.maxDelay, arrival - base); cursor = (cursor + 1) % o.samples; if (filled < o.samples) filled++;
      if (++sinceSort >= 6 || filled < 12) {
        sinceSort = 0;
        for (let i = 0; i < filled; i++) sorted[i] = lateness[i];
        const view = sorted.subarray(0, filled).sort();
        late = view[Math.min(filled - 1, Math.floor(filled * o.percentile))];
      }
      lastTs = ts;
      if (offset === null) offset = base + delay();
      return true;
    }
    function time(now) {
      if (offset === null) return null;
      const dt = lastNow === null ? 0 : clamp(now - lastNow, 0, .25); lastNow = now;
      const want = base + delay(), error = want - offset;
      if (Math.abs(error) > o.snap) offset = want;
      else offset += clamp(error, -o.catchUp * dt, o.fallBack * dt);
      let t = now - offset;
      // Nothing new has come: run on a moment, then hold there and catch up smoothly once snapshots return, rather
      // than freeze and jump.
      const limit = lastTs + o.extrapolate;
      if (t > limit) { t = limit; offset = now - limit; starved = Math.min(1, starved + dt); } else starved = 0;
      return t;
    }
    return {
      observe, time, reset,
      get delay() { return offset === null ? 0 : offset - base; },
      get target() { return delay(); },
      get interval() { return interval; },
      get late() { return late; },
      get newest() { return lastTs; },
      get starved() { return starved > 0; }
    };
  }

  /* The last snapshots of one moving thing: where it was (x, z, height y), which way it faced (yaw, pitch).
     - push(ts, x, z, yaw, y, pitch): false if ts is not newer than the newest held.
     - sample(ts, out, extrapolate): writes x, z, y, yaw, pitch for sender time ts into out. False if empty.
     A step longer than `jump` metres between two snapshots is a teleport (a new round, a respawn): it is shown as a
     cut at its own time, never as a slide. */
  function createTrack(options) {
    const o = Object.assign({ capacity: 24, jump: 5 }, options), n = o.capacity;
    const T = new Float64Array(n), X = new Float32Array(n), Z = new Float32Array(n), Y = new Float32Array(n);
    const A = new Float32Array(n), P = new Float32Array(n), C = new Uint8Array(n);
    let head = -1, count = 0;
    const at = back => (head - back + n * 2) % n;
    function reset() { head = -1; count = 0; }
    function push(ts, x, z, yaw, y, pitch) {
      if (!Number.isFinite(ts) || !Number.isFinite(x) || !Number.isFinite(z)) return false;
      if (count && ts <= T[head]) return false;
      const cut = count && Math.hypot(x - X[head], z - Z[head]) > o.jump ? 1 : 0;
      head = (head + 1) % n; if (count < n) count++;
      T[head] = ts; X[head] = x; Z[head] = z; A[head] = Number.isFinite(yaw) ? yaw : 0; Y[head] = Number.isFinite(y) ? y : 0;
      P[head] = Number.isFinite(pitch) ? pitch : 0; C[head] = cut;
      return true;
    }
    function copy(i, out) { out.x = X[i]; out.z = Z[i]; out.y = Y[i]; out.yaw = A[i]; out.pitch = P[i]; return true; }
    function sample(ts, out, extrapolate) {
      if (!count) return false;
      const newest = head;
      if (ts >= T[newest]) {
        copy(newest, out);
        const ahead = Math.min(ts - T[newest], extrapolate || 0);
        if (ahead > 0 && count > 1 && !C[newest]) {
          const prev = at(1), span = T[newest] - T[prev];
          if (span > 1e-4 && span < .3) {
            const k = ahead / span;
            out.x += (X[newest] - X[prev]) * k; out.z += (Z[newest] - Z[prev]) * k;
          }
        }
        return true;
      }
      for (let back = 1; back < count; back++) {
        const a = at(back);
        if (ts < T[a]) continue;
        const b = at(back - 1);
        if (C[b]) return copy(a, out);
        const k = (ts - T[a]) / (T[b] - T[a]);
        out.x = X[a] + (X[b] - X[a]) * k; out.z = Z[a] + (Z[b] - Z[a]) * k; out.y = Y[a] + (Y[b] - Y[a]) * k;
        out.yaw = A[a] + turn(A[a], A[b]) * k; out.pitch = P[a] + (P[b] - P[a]) * k;
        return true;
      }
      return copy(at(count - 1), out);
    }
    return { push, sample, reset, get size() { return count; }, get newest() { return count ? T[head] : null; } };
  }

  // Frame-rate independent ease toward a target: the share of the gap to close in dt seconds at `rate` per second.
  function ease(rate, dt) { return dt > 0 ? 1 - Math.exp(-rate * dt) : 0; }

  return { createClock, createTrack, turn, ease };
});

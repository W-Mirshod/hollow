'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Net = require('../public/netsmooth.js');

function seeded(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// A survivor runs a 3 m circle at 4 m/s. Snapshots leave at `hz` and arrive in order (as on one TCP stream) after
// `base` seconds plus up to `jitter`, with an occasional stall. The receiver draws at 60 frames a second.
function link({ hz = 30, base = .09, jitter = .02, stallChance = 0, stall = 0, seconds = 20, seed = 7, clockSkew = 1234.5 }) {
  const random = seeded(seed), packets = [];
  let due = 0;
  for (let i = 0; i < seconds * hz; i++) {
    const sent = i / hz;
    let arrive = sent + base + random() * jitter;
    if (random() < stallChance) arrive += stall;
    due = Math.max(due, arrive);
    packets.push({ ts: sent + clockSkew, sent, arrive: due });
  }
  return packets;
}
const truth = t => ({ x: Math.sin(t * 4 / 3) * 3, z: Math.cos(t * 4 / 3) * 3 });

// Returns how evenly the drawn survivor moves (the spread of its frame-to-frame speed over its mean speed: 0 is
// perfectly even), how far it runs behind, and the largest single-frame step.
function play(packets, draw, seconds, from = 3) {
  const speeds = [], behind = [];
  let next = 0, last = null, biggest = 0;
  for (let f = 0; f < seconds * 60; f++) {
    const now = f / 60;
    const arrived = [];
    while (next < packets.length && packets[next].arrive <= now) arrived.push(packets[next++]);
    const p = draw(arrived, now, 1 / 60);
    if (p && last && now > from) {
      const step = Math.hypot(p.x - last.x, p.z - last.z);
      speeds.push(step * 60); biggest = Math.max(biggest, step);
      // behind: the truth time whose position is closest to the drawn one, searched back from now
      let best = Infinity, lag = 0;
      for (let d = 0; d <= .6; d += .005) { const q = truth(now - d), e = Math.hypot(q.x - p.x, q.z - p.z); if (e < best) { best = e; lag = d; } }
      behind.push(lag);
    }
    if (p) last = { x: p.x, z: p.z };
  }
  const mean = speeds.reduce((s, v) => s + v, 0) / speeds.length;
  const spread = Math.sqrt(speeds.reduce((s, v) => s + (v - mean) ** 2, 0) / speeds.length);
  return { unevenness: spread / mean, mean, behind: behind.reduce((s, v) => s + v, 0) / behind.length, biggest };
}

// What the game did before: slide toward the latest snapshot, 22 per second.
function chase() {
  const pos = { x: 0, z: 0 }; let raw = null, seen = false;
  return (arrived, now, dt) => {
    for (const p of arrived) raw = truth(p.sent);
    if (!raw) return null;
    if (!seen) { seen = true; pos.x = raw.x; pos.z = raw.z; }
    const k = Math.min(1, dt * 22); pos.x += (raw.x - pos.x) * k; pos.z += (raw.z - pos.z) * k;
    return pos;
  };
}
// What it does now: playout clock, interpolation between snapshots, a light ease on top.
function smooth(stats) {
  const clock = Net.createClock(), track = Net.createTrack(), out = {}, pos = { x: 0, z: 0 }; let seen = false;
  return (arrived, now, dt) => {
    for (const p of arrived) if (clock.observe(p.ts, now)) { const q = truth(p.sent); track.push(p.ts, q.x, q.z, 0, 0, 0); }
    const t = clock.time(now);
    if (t === null || !track.sample(t, out, .1)) return null;
    if (!seen) { seen = true; pos.x = out.x; pos.z = out.z; }
    const k = Net.ease(30, dt); pos.x += (out.x - pos.x) * k; pos.z += (out.z - pos.z) * k;
    if (stats) stats.delay = clock.delay;
    return pos;
  };
}

test('a survivor seen over a clean link moves evenly, and no further behind than before', () => {
  const old15 = play(link({ hz: 15, jitter: .004 }), chase(), 20);
  const now30 = play(link({ hz: 30, jitter: .004 }), smooth(), 20);
  assert.ok(old15.unevenness > .25, `the old slide judders at the packet rate (${old15.unevenness.toFixed(3)})`);
  assert.ok(now30.unevenness < .03, `the drawn speed is even (${now30.unevenness.toFixed(3)})`);
  assert.ok(Math.abs(now30.mean - 4) < .1, `and it is the survivor's real speed (${now30.mean.toFixed(2)} m/s)`);
  assert.ok(now30.behind < old15.behind + .02, `no later than before (${now30.behind.toFixed(3)} s against ${old15.behind.toFixed(3)} s)`);
});

test('jitter is absorbed: the picture waits just long enough for late packets', () => {
  const stats = {};
  const jittery = link({ hz: 30, base: .12, jitter: .07, seed: 3 });
  const before = play(jittery, chase(), 20), after = play(jittery, smooth(stats), 20);
  assert.ok(after.unevenness < .08, `even under 70 ms of jitter (${after.unevenness.toFixed(3)})`);
  assert.ok(after.unevenness < before.unevenness / 4, `far steadier than the old slide (${before.unevenness.toFixed(3)})`);
  assert.ok(stats.delay > .07 && stats.delay < .16, `the wait grew to cover the jitter and no more (${stats.delay.toFixed(3)} s)`);
});

test('a calm link is not held back for the sake of a rare stall', () => {
  const stats = {};
  const stalls = link({ hz: 30, base: .1, jitter: .01, stallChance: .01, stall: .3, seed: 11, seconds: 30 });
  const after = play(stalls, smooth(stats), 30), before = play(stalls, chase(), 30);
  assert.ok(stats.delay < .09, `the wait stays short (${stats.delay.toFixed(3)} s)`);
  assert.ok(after.biggest < .35, `no jump after a stall: the largest step in one frame is ${after.biggest.toFixed(2)} m`);
  assert.ok(after.unevenness < before.unevenness, 'and steadier than the old slide through the same stalls');
});

test('the clock needs no agreement between the two machines, and follows a link that changes', () => {
  const clock = Net.createClock();
  assert.equal(clock.time(0), null, 'nothing to draw before the first snapshot');
  // sender clock is 5000 s ahead and ticks 0.1% fast; the path takes 80 ms, then 200 ms
  let now = 0, ts = 5000, worst = 0;
  for (let i = 0; i < 600; i++) {
    now = i / 30 + (i < 150 ? .08 : .2); ts = 5000 + i / 30 * 1.001; clock.observe(ts, now); clock.time(now);
    worst = Math.max(worst, clock.delay);
  }
  assert.ok(worst <= .3 + 1e-9, `the wait never passes its ceiling while the link settles (${worst.toFixed(3)} s)`);
  assert.ok(clock.delay >= .04 && clock.delay < .07, `and returns to a short one on the slower path (${clock.delay.toFixed(3)} s)`);
  assert.equal(clock.observe(ts, now), false, 'a repeated snapshot is refused');
  assert.equal(clock.observe(ts - .5, now), false, 'and so is an older one');
  assert.equal(clock.observe(12, now), true, 'a sender whose clock restarted is taken up again');
});

test('with nothing arriving the picture runs on briefly, holds, and then catches up without a jump', () => {
  const clock = Net.createClock(), track = Net.createTrack(), out = {};
  let now = 0;
  for (let i = 0; i < 60; i++) { now = i / 30; clock.observe(now, now + .05); track.push(now, i / 30 * 3, 0, 0, 0, 0); clock.time(now + .05); }
  const newest = track.newest;
  let t = 0;
  for (let f = 0; f < 60; f++) t = clock.time(now + .05 + f / 60);
  assert.ok(Math.abs(t - (newest + .1)) < 1e-6, 'held one tenth of a second past the newest snapshot');
  assert.ok(clock.starved);
  track.sample(t, out, .1);
  assert.ok(Math.abs(out.x - (newest + .1) * 3) < .02, 'having run on at its last speed');
  // snapshots return, a second late
  const resume = now + 1.05; let prev = t, fastest = 0;
  for (let f = 0; f < 240; f++) {
    const local = resume + f / 60;
    if (f % 2 === 0) { const s = newest + (f / 2 + 1) / 30 + 1; clock.observe(s, local); track.push(s, s * 3, 0, 0, 0, 0); }
    const drawn = clock.time(local);
    fastest = Math.max(fastest, (drawn - prev) * 60); prev = drawn;
  }
  assert.ok(fastest <= 1.31, `time runs at most 30% fast while catching up (${fastest.toFixed(2)}x)`);
  assert.ok(clock.delay < .07, 'and the delay is shed again');
});

test('a track interpolates position and facing, cuts on a teleport, and refuses stale snapshots', () => {
  const track = Net.createTrack(), out = {};
  assert.equal(track.sample(1, out), false);
  assert.equal(track.push(1, 0, 0, 3, 0, .2), true);
  assert.equal(track.push(1.1, 2, 4, -3, 1, .4), true);
  assert.equal(track.push(1.1, 9, 9, 0, 0, 0), false, 'not newer');
  assert.equal(track.push(NaN, 1, 1, 0, 0, 0), false);
  track.sample(1.05, out);
  assert.ok(Math.abs(out.x - 1) < 1e-5 && Math.abs(out.z - 2) < 1e-5 && Math.abs(out.y - .5) < 1e-5 && Math.abs(out.pitch - .3) < 1e-5);
  assert.ok(Math.abs(Math.abs(out.yaw) - Math.PI) < .15, 'facing turns the short way round, through pi');
  track.sample(0, out); assert.equal(out.x, 0, 'before the oldest snapshot: the oldest');
  track.sample(1.15, out, .1); assert.ok(Math.abs(out.x - 3) < 1e-4, 'past the newest: carried on at the last velocity');
  track.sample(9, out, .1); assert.ok(Math.abs(out.x - 4) < 1e-4, 'but no further than the allowance');
  track.sample(9, out, 0); assert.equal(out.x, 2, 'and not at all without one');
  track.push(1.2, 40, 40, 0, 0, 0);
  track.sample(1.19, out); assert.equal(out.x, 2, 'a teleport is not a slide:');
  track.sample(1.2, out); assert.equal(out.x, 40, 'it is a cut at its own time');
  track.sample(1.25, out, .1); assert.equal(out.x, 40, 'and nothing is carried on from it');
  for (let i = 0; i < 100; i++) track.push(4 + i, i, 0, 0, 0, 0);
  assert.equal(track.size, 24, 'old snapshots fall out');
  track.reset(); assert.equal(track.size, 0);
});

test('ease closes the same share of a gap whatever the frame rate', () => {
  const one = 1 - Net.ease(30, 1 / 30), two = (1 - Net.ease(30, 1 / 60)) ** 2;
  assert.ok(Math.abs(one - two) < 1e-9);
  assert.equal(Net.ease(30, 0), 0);
});

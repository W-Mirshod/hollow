'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { WebSocket } = require('ws');
const { createGameServer } = require('../server');
const source = fs.readFileSync(path.join(__dirname, '../public/bridge.js'), 'utf8');

async function flush() { for (let index = 0; index < 20; index++) await Promise.resolve(); }

function clock() {
  let now = 0, next = 1;
  const timers = new Map();
  return {
    timers,
    setTimeout(callback, delay = 0) { const id = next++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async tick(duration = 0) {
      const target = now + duration;
      for (let iterations = 0; iterations < 10000; iterations++) {
        await flush();
        const due = [...timers].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) { now = target; await flush(); return; }
        const [id, task] = due;
        timers.delete(id);
        now = task.at;
        task.callback();
      }
      throw new Error('Timer loop did not settle');
    }
  };
}

function response(rows, status = 200, retryAfter = 0) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => retryAfter }, json: async () => rows };
}

function harness() {
  const timer = clock(), sockets = [], requests = [], handlers = new Map(), stored = new Map();
  let fetchHandler = async () => response([]);
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(value) { if (this.readyState !== 1) throw new Error('Socket is not open'); this.sent.push(JSON.parse(value)); }
    open() { this.readyState = 1; this.onopen?.({}); }
    fail() { this.onerror?.({}); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
    message(value) { this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) }); }
  }
  const context = {
    URL, AbortController, TextEncoder, console, WebSocket: FakeSocket,
    location: new URL('https://game.example/hollow/'),
    localStorage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
    fetch: (url, options) => { requests.push({ url, options }); return fetchHandler(url, options); },
    setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout,
    addEventListener: (name, handler) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); }
  };
  context.window = context;
  vm.runInNewContext(source, context, { timeout: 1000, filename: 'bridge.js' });
  return {
    timer, sockets, requests, context,
    use: name => context.claude.use(name),
    fetchWith: handler => { fetchHandler = handler; },
    dispatch: name => { for (const handler of handlers.get(name) || []) handler({}); }
  };
}

async function join(h, name = 'hollow-test', peers = []) {
  const room = await h.use('room');
  const pending = room.join(name);
  await flush();
  const socket = h.sockets[h.sockets.length - 1];
  if (socket.readyState !== 1) socket.open();
  await flush();
  socket.message({ t: 'joined', room: name, peer: 'local-peer', peers });
  const api = await pending;
  await h.timer.tick(0);
  return { room, api, socket };
}

test('scoreboard errors leave loading state, recover, share cached snapshots, and stop when unsubscribed', async () => {
  const h = harness();
  h.fetchWith(async () => { throw new Error('offline'); });
  const db = await h.use('db'), snapshots = [], errors = [];
  const unsubscribe = db.collection('scores').onSnapshot(snapshot => snapshots.push(snapshot), failure => errors.push(failure));
  await flush();
  assert.equal(errors.length, 1);
  assert.equal(snapshots.length, 0);
  h.fetchWith(async () => response([{ uid: 'player_001', name: 'Explorer', time: 50 }]));
  await h.timer.tick(8000);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].docs[0].data().name, 'Explorer');
  assert.equal(Object.isFrozen(snapshots[0].docs[0].data()), true);
  const cached = [];
  const unsubscribeSecond = db.collection('scores').onSnapshot(snapshot => cached.push(snapshot));
  await h.timer.tick(0);
  assert.equal(cached[0], snapshots[0]);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].url, 'https://game.example/hollow/api/scores');
  unsubscribe();
  unsubscribeSecond();
  assert.equal(h.timer.timers.size, 0);
});

test('scoreboard polling is non-overlapping, abortable and query limits are independent', async () => {
  const h = harness();
  let finish;
  h.fetchWith((url, options) => new Promise((resolve, reject) => {
    finish = resolve;
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const db = await h.use('db'), one = [], two = [];
  const stopOne = db.collection('scores').limit(1).onSnapshot(snapshot => one.push(snapshot));
  const stopTwo = db.collection('scores').limit(2).onSnapshot(snapshot => two.push(snapshot));
  assert.equal(h.requests.length, 1);
  finish(response([{ uid: 'player_001' }, { uid: 'player_002' }, { uid: 'player_003' }]));
  await flush();
  assert.equal(one[0].docs.length, 1);
  assert.equal(two[0].docs.length, 2);
  await h.timer.tick(8000);
  assert.equal(h.requests.length, 2);
  stopOne();
  stopTwo();
  assert.equal(h.requests[1].options.signal.aborted, true);
  await flush();
  assert.equal(h.timer.timers.size, 0);
});

test('HTTP request timeouts notify scoreboard subscribers and posting preserves error details', async () => {
  const h = harness();
  h.fetchWith((url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timed out')))));
  const db = await h.use('db'), errors = [];
  const stop = db.collection('scores').onSnapshot(() => {}, failure => errors.push(failure));
  await h.timer.tick(8000);
  assert.equal(errors.length, 1);
  stop();
  h.fetchWith(async () => response({ error: 'slow down' }, 429, 3));
  await assert.rejects(db.collection('scores').doc('not-the-local-user').set({ name: 'Explorer', time: 50, kills: 8 }), failure => {
    assert.equal(failure.code, 'rate_limited');
    assert.equal(failure.status, 429);
    assert.equal(failure.retryAfter, 3);
    return true;
  });
  const sent = JSON.parse(h.requests[h.requests.length - 1].options.body);
  assert.equal(sent.uid, await (await h.use('user')).id());
  assert.equal(h.timer.timers.size, 0);
});

test('concurrent joins wait for the server acknowledgement and use one WebSocket', async () => {
  const h = harness(), room = await h.use('room');
  let settled = false;
  const first = room.join('same-room').then(api => { settled = true; return api; });
  const second = room.join('same-room');
  await flush();
  assert.equal(h.sockets.length, 1);
  const socket = h.sockets[0];
  assert.equal(socket.url, 'wss://game.example/hollow/ws');
  socket.open();
  await flush();
  assert.equal(socket.sent.filter(message => message.t === 'join').length, 1);
  assert.equal(settled, false);
  socket.message({ t: 'joined', room: 'same-room', peer: 'our-peer', peers: [] });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(a.connected(), true);
  assert.equal(room.connected(), true);
  await h.timer.tick(0);
  assert.equal(h.timer.timers.size, 0);
});

test('opening retries once, then rejects; an old socket cannot wipe a newer connection', async () => {
  const h = harness(), room = await h.use('room');
  const pending = room.join('retry-room');
  await flush();
  const old = h.sockets[0];
  old.close();
  await h.timer.tick(350);
  assert.equal(h.sockets.length, 2);
  const current = h.sockets[1];
  current.open();
  await flush();
  current.message({ t: 'joined', room: 'retry-room', peer: 'new-peer', peers: [] });
  const api = await pending;
  old.close();
  assert.equal(api.connected(), true);
  await api.presence({ x: 5 });
  assert.equal(current.sent[current.sent.length - 1].pr.x, 5);

  const failed = harness(), failingRoom = await failed.use('room');
  const rejection = assert.rejects(failingRoom.join('offline'), failure => failure.code === 'upstream_error');
  await flush();
  failed.sockets[0].fail();
  await failed.timer.tick(350);
  failed.sockets[1].fail();
  await rejection;
  await failed.timer.tick(30000);
  assert.equal(failed.sockets.length, 2);
  assert.equal(failed.timer.timers.size, 0);
});

test('connection and room-join timeouts are bounded and clean up timers and subscriptions', async () => {
  const stalled = harness(), room = await stalled.use('room');
  const rejection = assert.rejects(room.join('stalled'), failure => failure.code === 'upstream_error');
  await stalled.timer.tick(12350);
  await rejection;
  assert.equal(stalled.sockets.length, 2);
  assert.equal(stalled.timer.timers.size, 0);

  const h = harness(), secondRoom = await h.use('room');
  const timedOut = assert.rejects(secondRoom.join('no-reply'), failure => failure.code === 'upstream_error');
  await flush();
  const socket = h.sockets[0];
  socket.open();
  await flush();
  await h.timer.tick(10000);
  await timedOut;
  assert.equal(socket.sent[socket.sent.length - 1].t, 'leave');
  assert.equal(h.timer.timers.size, 0);
  // A delayed acknowledgement for an abandoned join must release its server seat.
  socket.message({ t: 'joined', room: 'no-reply', peer: 'old-peer', peers: [] });
  assert.equal(socket.sent.filter(message => message.t === 'leave').length, 2);
});

test('disconnect publishes an empty peer snapshot, an error and connection false, then allows a fresh join', async () => {
  const h = harness();
  const { api, socket } = await join(h, 'active-room', [{ peer: 'partner', pr: { role: 'guest' } }]);
  const snapshots = [], errors = [], connections = [];
  api.onPeers(change => snapshots.push(change), failure => errors.push(failure));
  api.onConnection(value => connections.push(value));
  await h.timer.tick(0);
  assert.equal(snapshots[0].peers.length, 2);
  assert.deepEqual(connections, [true]);
  socket.close();
  await h.timer.tick(0);
  assert.equal(snapshots[snapshots.length - 1].peers.length, 1);
  assert.equal(errors.length, 1);
  assert.deepEqual(connections, [true, false]);
  assert.equal(api.connected(), false);
  await assert.rejects(api.presence({ x: 1 }), failure => failure.code === 'upstream_error');
  const fresh = await join(h, 'new-room');
  assert.equal(h.sockets.length, 2);
  socket.close();
  assert.equal(fresh.api.connected(), true);
});

test('presence patches preserve prior fields, delete nulls, isolate mutable inputs and reject oversized UTF-8', async () => {
  const h = harness();
  const { api, socket } = await join(h);
  const points = [1, 2, 3];
  await api.presence({ name: 'Explorer', points });
  points[0] = 999;
  await api.presence({ name: null, hp: 80 });
  const latest = socket.sent[socket.sent.length - 1];
  assert.deepEqual(latest.pr, { points: [1, 2, 3], hp: 80 });
  assert.equal(api.peers()[0].presence.hp, 80);
  const count = socket.sent.length;
  await assert.rejects(api.presence({ unicode: '界'.repeat(1500) }), failure => failure.code === 'invalid_presence');
  await assert.rejects(api.presence([]), failure => failure.code === 'invalid_presence');
  const circular = {}; circular.self = circular;
  await assert.rejects(api.presence(circular), failure => failure.code === 'invalid_presence');
  assert.equal(socket.sent.length, count);
  assert.equal(api.peers()[0].presence.unicode, undefined);
});

test('room-full replies and malformed messages are contained, and unsubscribe removes error callbacks', async () => {
  const h = harness();
  const { api, socket, room } = await join(h);
  let callbacks = 0, errors = 0;
  const unsubscribe = api.onPeers(() => { callbacks++; }, () => { errors++; });
  await h.timer.tick(0);
  socket.message('{not JSON');
  socket.message(null);
  socket.message({ t: 'peer', room: 'hollow-test', peer: 'bad-peer', pr: [] });
  assert.equal(api.peers().length, 1);
  const full = assert.rejects(room.join('full-room'), failure => failure.code === 'limit_reached');
  await flush();
  socket.message({ t: 'full', room: 'full-room' });
  await full;
  await h.timer.tick(0);
  unsubscribe();
  socket.close();
  await h.timer.tick(0);
  assert.equal(callbacks, 1);
  assert.equal(errors, 0);
  assert.equal(h.timer.timers.size, 0);
  await assert.rejects(room.join('../invalid'), failure => failure.code === 'invalid_room');
});

test('leaving clears listeners and pagehide closes the transport without an automatic round restart', async () => {
  const h = harness();
  const { api, socket } = await join(h);
  let calls = 0;
  api.onPeers(() => { calls++; });
  api.onConnection(() => { calls++; });
  await api.leave();
  await h.timer.tick(0);
  assert.equal(socket.sent[socket.sent.length - 1].t, 'leave');
  assert.equal(api.connected(), false);
  const afterLeave = calls;
  socket.message({ t: 'peer', room: 'hollow-test', peer: 'late', pr: {} });
  await h.timer.tick(0);
  assert.equal(calls, afterLeave);
  h.dispatch('pagehide');
  await h.timer.tick(10000);
  assert.equal(socket.readyState, 3);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.timer.timers.size, 0);
});

test('two independent browser bridges exchange the expanded co-op protocol and scoreboard through a real server', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hollow-bridge-integration-'));
  const app = createGameServer({ dataDir: directory, scoreCooldownMs: 0 });
  const address = await app.listen(0, '127.0.0.1');
  const contexts = [];
  t.after(async () => {
    for (const context of contexts) context.dispatch('pagehide');
    await app.close();
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  function browser() {
    const storage = new Map(), handlers = new Map();
    const context = {
      URL, AbortController, TextEncoder, WebSocket, fetch, setTimeout, clearTimeout, console,
      location: new URL(`http://127.0.0.1:${address.port}/`),
      localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
      addEventListener: (name, handler) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); }
    };
    context.window = context;
    context.dispatch = name => { for (const handler of handlers.get(name) || []) handler({}); };
    vm.runInNewContext(source, context, { timeout: 1000 });
    contexts.push(context);
    return context;
  }
  function waitForPeers(api, predicate) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Live bridge presence timed out')); }, 3000);
      const unsubscribe = api.onPeers(change => {
        if (!predicate(change.peers)) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(change.peers);
      }, failure => { clearTimeout(timeout); unsubscribe(); reject(failure); });
    });
  }
  const first = browser(), second = browser();
  const hostRoom = await first.claude.use('room'), guestRoom = await second.claude.use('room');
  const [host, guest] = await Promise.all([hostRoom.join('hollow-live'), guestRoom.join('hollow-live')]);
  const packet = {
    v: 2, nm: '界'.repeat(18), role: 'host', gn: 3, ph: 'play', seed: 71823, mc: 12, el: 124.6,
    p: [18.5, 63.4, 1.57, .1, 0, 0, .8, 1, 1, 87, 2], al: 1, out: 0, sh: 32,
    tk: Array.from({ length: 20 }, (_, index) => index),
    mon: Array.from({ length: 12 }, (_, index) => [20 + index, 30 + index, 1.2, index % 3, 28 - index]),
    doors: [[0, 1, 100], [1, 0, 80], [0, 1, 95], [0, 0, 0]], fuses: ['fuse-a', 'fuse-b'], power: 0, ack: 11
  };
  packet.loot = ['infirmary:medical', 'archive:fuse', 'refuge-a:medical', 'generator:fuse', 'armory:supplies', 'refuge-b:medical', 'refuge-c:medical', 'laboratory:fuse', 'refuge-d:medical', 'stores:supplies'];
  packet.grants = packet.loot.filter(id => !id.endsWith(':fuse')).map(id => ({ id, type: id.split(':')[1] }))
    .concat(Array.from({ length: 12 }, (_, index) => ({ id: `ammo:${index}`, type: 'ammo' })));
  assert.equal(packet.grants.length, 19, 'all finite room supplies and ammunition can be granted in a round');
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) < 4096);
  const receivedHost = waitForPeers(guest, peers => peers.some(peer => !peer.isMe && peer.presence.mon?.length === 12));
  await host.presence(packet);
  const snapshot = await receivedHost;
  const hostData = snapshot.find(peer => !peer.isMe).presence;
  assert.equal(hostData.seed, packet.seed);
  assert.equal(hostData.doors[0][1], 1);
  assert.equal(hostData.p[6], .8);
  assert.equal(hostData.grants.length, 19);
  assert.equal(hostData.loot.length, 10);
  const actions = Array.from({ length: 12 }, (_, index) => ({ n: index + 12, type: 'door', id: 'refuge-a', action: 'close' }));
  const receivedGuest = waitForPeers(host, peers => peers.some(peer => !peer.isMe && peer.presence.actions?.length === 12));
  await guest.presence({ v: 2, role: 'guest', gn: 3, dm: Array(12).fill(1.35), actions });
  assert.equal((await receivedGuest).find(peer => !peer.isMe).presence.dm[11], 1.35);
  const db = await first.claude.use('db');
  await db.collection('scores').doc().set({ name: 'Live explorer', time: 75.5, kills: 12 });
  const remoteDB = await second.claude.use('db');
  const scores = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { stop(); reject(new Error('Live scoreboard timed out')); }, 3000);
    const stop = remoteDB.collection('scores').onSnapshot(value => { clearTimeout(timeout); stop(); resolve(value); }, failure => { clearTimeout(timeout); stop(); reject(failure); });
  });
  assert.equal(scores.docs[0].data().kills, 12);
  const departed = waitForPeers(host, peers => peers.length === 1);
  await guest.leave();
  await departed;
  await host.leave();
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createGameServer } = require('../server');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hollow-server-test-'));
  const publicDir = path.join(directory, 'public');
  const dataDir = path.join(directory, 'data');
  await fs.mkdir(publicDir);
  await fs.mkdir(dataDir);
  await fs.mkdir(path.join(publicDir, 'assets'));
  await Promise.all([
    fs.writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>Hollow fixture</title>'),
    fs.writeFile(path.join(publicDir, 'styles.css'), 'body { color: white; }'),
    fs.writeFile(path.join(publicDir, 'game.js'), 'window.fixture = true;'),
    fs.writeFile(path.join(publicDir, 'assets', 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>'),
    fs.writeFile(path.join(directory, 'private.txt'), 'not a public asset'),
    fs.symlink(path.join(directory, 'private.txt'), path.join(publicDir, 'escape.txt'))
  ]);
  if (options.initialScores !== undefined) {
    await fs.writeFile(path.join(dataDir, 'scores.json'), typeof options.initialScores === 'string' ? options.initialScores : JSON.stringify(options.initialScores));
  }
  const errors = [];
  const configuration = { publicDir, dataDir, scoreCooldownMs: 0, logError: error => errors.push(error), ...options };
  const app = createGameServer(configuration);
  const apps = [app];
  const address = await app.listen(0, '127.0.0.1');
  t.after(async () => {
    for (const item of apps) await item.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const request = (pathname, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: address.port, path: pathname, method, agent: false,
      headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers }
    }, res => {
      let result = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { result += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: result, json: () => JSON.parse(result) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
  return {
    app, request, errors, dataDir, configuration, apps,
    wsURL: `ws://127.0.0.1:${address.port}/ws`,
    score: (body, headers) => request('/api/scores', { method: 'POST', body, headers })
  };
}

async function client(t, url, options = {}) {
  const socket = new WebSocket(url, options);
  const messages = [];
  const waiters = [];
  socket.on('error', () => {});
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex(waiter => waiter.predicate(message));
    if (index < 0) messages.push(message);
    else {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  const closed = new Promise(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  t.after(() => {
    for (const waiter of waiters) clearTimeout(waiter.timer);
    socket.terminate();
  });
  await once(socket, 'open');
  return {
    socket, closed,
    send: message => socket.send(JSON.stringify(message)),
    take(predicate = () => true) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error('Timed out waiting for a WebSocket message'));
        }, 2500);
        waiters.push(waiter);
      });
    },
    async join(room) {
      socket.send(JSON.stringify({ t: 'join', room }));
      return this.take(message => message.room === room && (message.t === 'joined' || message.t === 'full'));
    }
  };
}

const validScore = { uid: 'player_001', name: 'Explorer', time: 120.5, kills: 12 };

test('serves local HTML, JS, CSS, nested assets and the pinned Three.js runtime', async t => {
  const f = await fixture(t);
  for (const [pathname, mime, text] of [
    ['/', 'text/html', 'Hollow fixture'],
    ['/index.html', 'text/html', 'Hollow fixture'],
    ['/styles.css?version=2', 'text/css', 'color: white'],
    ['/game.js', 'text/javascript', 'window.fixture'],
    ['/assets/mark.svg', 'image/svg+xml', '<svg']
  ]) {
    const response = await f.request(pathname);
    assert.equal(response.status, 200, pathname);
    assert.ok(response.headers['content-type'].startsWith(mime), pathname);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.ok(response.body.includes(text));
  }
  const vendor = await f.request('/vendor/three.min.js');
  assert.equal(vendor.status, 200);
  assert.match(vendor.headers['content-type'], /^text\/javascript/);
  const vendorContext = {};
  vm.runInNewContext(vendor.body, vendorContext, { timeout: 1000 });
  assert.equal(vendorContext.THREE.REVISION, '128');
  assert.ok(vendor.body.length > 500000);
  assert.equal(vendor.headers['cache-control'], 'public, max-age=86400');
  assert.equal((await f.request('/vendor/ws/index.js')).status, 404);
  assert.equal((await f.request('/favicon.ico')).status, 204);
});

test('unversioned assets revalidate with ETag and HEAD requests contain no body', async t => {
  const f = await fixture(t);
  const first = await f.request('/game.js');
  assert.equal(first.headers['cache-control'], 'no-cache');
  assert.ok(first.headers.etag);
  const cached = await f.request('/game.js', { headers: { 'If-None-Match': first.headers.etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.body, '');
  const weak = await f.request('/game.js', { headers: { 'If-None-Match': 'W/' + first.headers.etag } });
  assert.equal(weak.status, 304);
  const head = await f.request('/game.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], first.headers['content-length']);
  const health = await f.request('/health');
  assert.equal(health.body, 'ok');
  assert.equal(health.headers['cache-control'], 'no-store');
});

test('rejects traversal, escaping symlinks, hidden files and malformed URLs without crashing', async t => {
  const f = await fixture(t);
  for (const pathname of ['/../private.txt', '/%2e%2e/private.txt', '/..%2fprivate.txt', '/escape.txt', '/.env', '/vendor/../server.js']) {
    const response = await f.request(pathname);
    assert.equal(response.status, 403, pathname);
    assert.ok(!response.body.includes('not a public asset'));
  }
  for (const pathname of ['/%', '/%E0%A4%A', '/%00file', '/%2e%2e%5cprivate.txt', '//malformed.test/file', 'http://malformed.test/']) {
    assert.equal((await f.request(pathname)).status, 400, pathname);
  }
  assert.equal((await f.request('/server.js')).status, 404);
  assert.equal((await f.request('/package.json')).status, 404);
  assert.equal((await f.request('/missing')).status, 404);
  assert.equal((await f.request('/health')).status, 200);
  assert.deepEqual(f.errors, []);
});

test('advertises supported methods for assets and API', async t => {
  const f = await fixture(t);
  const asset = await f.request('/game.js', { method: 'POST' });
  assert.equal(asset.status, 405);
  assert.equal(asset.headers.allow, 'GET, HEAD');
  const api = await f.request('/api/scores', { method: 'DELETE' });
  assert.equal(api.status, 405);
  assert.equal(api.headers.allow, 'GET, HEAD, POST');
  const head = await f.request('/api/scores', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], '2');
});

test('scoreboard sanitizes names, keeps the best time and supports twelve kills', async t => {
  const f = await fixture(t);
  const initial = await f.score({ ...validScore, name: '  Alice\t \u0000 Pilot  ', time: 60.06 });
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.json(), { ok: true, best: 60.1 });
  let records = (await f.request('/api/scores')).json();
  assert.equal(records[0].name, 'Alice Pilot');
  assert.equal(records[0].kills, 12);
  assert.ok(records[0].at > 0);
  const slower = await f.score({ ...validScore, name: 'Renamed', time: 100, kills: 0 });
  assert.equal(slower.json().best, 60.1);
  records = (await f.request('/api/scores')).json();
  assert.equal(records[0].name, 'Renamed');
  assert.equal(records[0].kills, 12);
  await f.score({ ...validScore, time: 55.11, kills: 100 });
  await f.score({ ...validScore, uid: 'player_002', time: 40, kills: -3 });
  records = (await f.request('/api/scores')).json();
  assert.deepEqual(records.map(record => [record.uid, record.time, record.kills]), [['player_002', 40, 0], ['player_001', 55.1, 12]]);
});

test('invalid, oversized and malformed score submissions cannot damage the board', async t => {
  const f = await fixture(t);
  const invalid = [
    null, [], {}, { ...validScore, uid: 'short' }, { ...validScore, uid: '<bad-player>' },
    { ...validScore, name: 'a' }, { ...validScore, name: {} }, { ...validScore, time: 14.99 },
    { ...validScore, time: 7200.01 }, { ...validScore, time: 'Infinity' }, { ...validScore, kills: 'invalid' }
  ];
  for (const body of invalid) assert.equal((await f.score(body)).status, 400, JSON.stringify(body));
  assert.equal((await f.score('{')).status, 400);
  assert.equal((await f.score('x'.repeat(4096))).status, 413);
  assert.deepEqual((await f.request('/api/scores')).json(), []);
  assert.equal((await f.request('/health')).status, 200);
});

test('prototype-like player IDs are ordinary, isolated records', async t => {
  const f = await fixture(t);
  assert.equal((await f.score({ ...validScore, uid: '__proto__' })).status, 200);
  assert.equal((await f.score({ ...validScore, uid: 'constructor', time: 110 })).status, 200);
  const records = (await f.request('/api/scores')).json();
  assert.deepEqual(records.map(record => record.uid), ['constructor', '__proto__']);
  assert.equal({}.time, undefined);
});

test('score cooldown cannot be bypassed with untrusted forwarded headers', async t => {
  const f = await fixture(t, { scoreCooldownMs: 5000 });
  assert.equal((await f.score(validScore, { 'X-Forwarded-For': '192.0.2.1' })).status, 200);
  const limited = await f.score({ ...validScore, uid: 'player_002' }, { 'X-Forwarded-For': '192.0.2.2' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.ok(Number(limited.headers['retry-after']) <= 5);
  assert.equal((await f.request('/api/scores')).json().length, 1);
});

test('explicit trusted-proxy mode recognizes separate client IPs', async t => {
  const f = await fixture(t, { scoreCooldownMs: 5000, trustProxy: true });
  assert.equal((await f.score(validScore, { 'X-Forwarded-For': '192.0.2.1' })).status, 200);
  assert.equal((await f.score({ ...validScore, uid: 'player_002' }, { 'X-Forwarded-For': '192.0.2.2' })).status, 200);
});

test('shutdown flushes pending scores atomically and a new server reloads them', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, index) => f.score({ ...validScore, uid: `player_${String(index).padStart(3, '0')}`, time: 30 + index })));
  await f.app.close();
  await f.app.close();
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'scores.json'), 'utf8'));
  assert.equal(Object.keys(saved).length, 20);
  assert.equal(saved.player_000.time, 30);
  await assert.rejects(fs.stat(path.join(f.dataDir, 'scores.json.tmp')), { code: 'ENOENT' });
  const second = createGameServer(f.configuration);
  f.apps.push(second);
  const address = await second.listen(0, '127.0.0.1');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/scores`);
  assert.equal((await response.json()).length, 20);
});

test('startup ignores corrupt records and returns at most the fastest 100 scores', async t => {
  const initialScores = Object.fromEntries(Array.from({ length: 105 }, (_, index) => [`player_${String(index).padStart(3, '0')}`, { name: 'Explorer', time: 30 + index, kills: 12, at: 1 }]));
  initialScores.bad_record = { name: 'Bad', time: 'wrong' };
  initialScores.null_record = null;
  const f = await fixture(t, { initialScores });
  const records = (await f.request('/api/scores')).json();
  assert.equal(records.length, 100);
  assert.equal(records[0].time, 30);
  assert.equal(records[99].time, 129);
});

test('an unreadable scoreboard does not crash startup or erase the original file', async t => {
  const f = await fixture(t, { initialScores: '{broken json' });
  assert.deepEqual((await f.request('/api/scores')).json(), []);
  assert.equal(f.errors.length, 1);
  await f.app.close();
  assert.equal(await fs.readFile(path.join(f.dataDir, 'scores.json'), 'utf8'), '{broken json');
});

test('WebSocket join, presence snapshot, duplicate join, leave and disconnect preserve state', async t => {
  const f = await fixture(t);
  const alice = await client(t, f.wsURL);
  const bob = await client(t, f.wsURL);
  const joinedAlice = await alice.join('hollow-abcd');
  assert.equal(joinedAlice.t, 'joined');
  assert.deepEqual(joinedAlice.peers, []);
  alice.send({ t: 'presence', room: 'hollow-abcd', pr: { name: 'Alice', x: 4 } });
  await alice.join('hollow-abcd'); // Acts as an ordering barrier; must not erase presence.
  const joinedBob = await bob.join('hollow-abcd');
  assert.deepEqual(joinedBob.peers, [{ peer: joinedAlice.peer, pr: { name: 'Alice', x: 4 } }]);
  assert.equal((await alice.take(message => message.t === 'peer')).peer, joinedBob.peer);
  bob.send({ t: 'presence', room: 'hollow-abcd', pr: { x: 8, hp: 100 } });
  assert.deepEqual((await alice.take(message => message.t === 'peer' && message.pr.x === 8)).pr, { x: 8, hp: 100 });
  bob.send({ t: 'leave', room: 'hollow-abcd' });
  assert.equal((await alice.take(message => message.t === 'left')).peer, joinedBob.peer);
  await bob.join('hollow-abcd');
  bob.socket.close();
  assert.equal((await alice.take(message => message.t === 'left')).peer, joinedBob.peer);
  await bob.closed;
  alice.send({ t: 'leave', room: 'hollow-abcd' });
  await alice.join('ordering-barrier');
  assert.equal(f.app.rooms.has('hollow-abcd'), false);
});

test('rooms reject fifth peers, release seats, and cap subscriptions per connection', async t => {
  const f = await fixture(t);
  const clients = await Promise.all(Array.from({ length: 5 }, () => client(t, f.wsURL)));
  for (let index = 0; index < 4; index++) assert.equal((await clients[index].join('shared-room')).t, 'joined');
  assert.equal((await clients[4].join('shared-room')).t, 'full');
  clients[3].send({ t: 'leave', room: 'shared-room' });
  await clients[0].take(message => message.t === 'left');
  assert.equal((await clients[4].join('shared-room')).t, 'joined');
  assert.equal((await clients[0].join('second-room')).t, 'joined');
  const capped = await clients[0].join('third-room');
  assert.equal(capped.t, 'full');
  assert.equal(capped.code, 'room_limit');
  assert.equal(f.app.rooms.has('third-room'), false);
  clients[0].send({ t: 'leave', room: 'second-room' });
  assert.equal((await clients[0].join('third-room')).t, 'joined');
});

test('global room bound allows joining an existing room without allocating another', async t => {
  const f = await fixture(t, { maxRooms: 1 });
  const alice = await client(t, f.wsURL);
  const bob = await client(t, f.wsURL);
  await alice.join('room-one');
  const capped = await bob.join('room-two');
  assert.equal(capped.code, 'server_busy');
  assert.equal((await bob.join('room-one')).t, 'joined');
  assert.equal(f.app.rooms.size, 1);
});

test('invalid rooms and nonmember, array or oversized presence are not stored or relayed', async t => {
  const f = await fixture(t);
  const alice = await client(t, f.wsURL);
  const bob = await client(t, f.wsURL);
  alice.send({ t: 'join', room: '../invalid' });
  const joined = await alice.join('valid-room');
  assert.equal(f.app.rooms.size, 1);
  alice.send({ t: 'presence', room: 'valid-room', pr: { hp: 95 } });
  alice.send({ t: 'presence', room: 'valid-room', pr: ['not', 'an', 'object'] });
  alice.send({ t: 'presence', room: 'valid-room', pr: { huge: 'x'.repeat(5000) } });
  await alice.join('valid-room');
  bob.send({ t: 'presence', room: 'valid-room', pr: { hp: 0 } });
  const snapshot = await bob.join('valid-room');
  assert.deepEqual(snapshot.peers, [{ peer: joined.peer, pr: { hp: 95 } }]);
});

test('malformed messages, payload-limit errors and protocol errors cannot crash the process', async t => {
  const f = await fixture(t);
  const malformed = await client(t, f.wsURL);
  malformed.socket.send('{not json');
  assert.deepEqual(await malformed.take(), { t: 'error', code: 'invalid_message' });
  malformed.socket.send(Buffer.from('binary is not a room message'));
  assert.equal((await malformed.join('still-connected')).t, 'joined');
  malformed.socket.send('x'.repeat(9000));
  assert.equal((await malformed.closed).code, 1009);
  const protocol = await client(t, f.wsURL);
  // Reserved opcode 3, masked empty payload: deliberately invalid WebSocket frame.
  protocol.socket._socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
  assert.equal((await protocol.closed).code, 1002);
  assert.equal((await f.request('/health')).body, 'ok');
  const survivor = await client(t, f.wsURL);
  assert.equal((await survivor.join('survived')).t, 'joined');
});

test('heartbeat removes clients that no longer pong', async t => {
  const f = await fixture(t, { heartbeatMs: 50 });
  const silent = await client(t, f.wsURL, { autoPong: false });
  await silent.join('quiet-room');
  const serverClosed = once([...f.app.wss.clients][0], 'close');
  const closed = await Promise.race([
    silent.closed,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('heartbeat did not evict silent client')), 2000);
      timer.unref();
      silent.closed.then(() => clearTimeout(timer));
    })
  ]);
  assert.equal(closed.code, 1006);
  await serverClosed;
  assert.equal(f.app.rooms.size, 0);
  assert.equal((await f.request('/health')).status, 200);
});

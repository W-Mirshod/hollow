'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
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
  for (const [pathname, text] of [
    ['/vendor/three/build/three.webgpu.js', "from './three.core.js'"],
    ['/vendor/three/build/three.tsl.js', "from './three.core.js'"],
    ['/vendor/three/build/three.core.js', "const REVISION = '187'"],
    ['/vendor/three/addons/tsl/display/BloomNode.js', "from 'three/webgpu'"]
  ]) {
    const vendor = await f.request(pathname);
    assert.equal(vendor.status, 200, pathname);
    assert.match(vendor.headers['content-type'], /^text\/javascript/, pathname);
    assert.equal(vendor.headers['cache-control'], 'public, max-age=86400', pathname);
    assert.equal(vendor.headers['x-content-type-options'], 'nosniff', pathname);
    assert.ok(vendor.body.includes(text), pathname);
  }
  const core = await f.request('/vendor/three/build/three.core.js');
  assert.ok(core.body.length > 500000);
  const coreModule = await import('data:text/javascript;base64,' + Buffer.from(core.body).toString('base64'));
  assert.equal(coreModule.REVISION, '187');
  const revalidated = await f.request('/vendor/three/build/three.core.js', { headers: { 'If-None-Match': core.headers.etag } });
  assert.equal(revalidated.status, 304);
  assert.equal((await f.request('/vendor/three.min.js')).status, 404);
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

// Raw bytes and headers (the fixture's request() decodes text).
function fetchRaw(f, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: new URL(f.wsURL).port, path: pathname, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}
const decode = response => response.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(response.body)
  : response.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(response.body) : response.body;
const threeVersion = JSON.parse(require('node:fs').readFileSync(path.join(path.dirname(require.resolve('three/webgpu')), '..', 'package.json'), 'utf8')).version;

test('index.html stamps local assets with one content version; versioned URLs are compressed and cached forever', async t => {
  const f = await fixture(t);
  const publicDir = f.configuration.publicDir, script = 'window.fixture = true;\n'.repeat(200);
  await Promise.all([
    fs.writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>Hollow fixture</title><link rel="stylesheet" href="styles.css">' +
      '<script type="importmap">{"imports":{"three/webgpu":"./vendor/three/build/three.webgpu.js"}}</script>' +
      '<link rel="modulepreload" href="vendor/three/build/three.core.js"><script src="game.js"></script>' +
      '<script type="module" src="boot.mjs"></script><script src="https://cdn.example/x.js"></script><a href="#top">top</a>' +
      '<!-- bodies under 1 KB are sent uncompressed -->'.repeat(30)),
    fs.writeFile(path.join(publicDir, 'boot.mjs'), 'export {};'),
    fs.writeFile(path.join(publicDir, 'game.js'), script),
    fs.writeFile(path.join(publicDir, 'styles.css'), '@font-face { src: url("fonts/a.woff2") format("woff2"); } body { background: url(data:image/png;base64,AAAA); }')
  ]);

  const index = await fetchRaw(f, '/', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(index.status, 200);
  assert.equal(index.headers['content-encoding'], 'br');
  assert.equal(index.headers['cache-control'], 'no-cache', 'index.html always revalidates');
  const html = decode(index).toString();
  const version = (html.match(/game\.js\?v=([\w-]+)"/) || [])[1];
  assert.ok(version, html);
  for (const ref of [`href="styles.css?v=${version}"`, `src="boot.mjs?v=${version}"`, `"./vendor/three@${threeVersion}/build/three.webgpu.js"`,
    `href="vendor/three@${threeVersion}/build/three.core.js"`, 'src="https://cdn.example/x.js"', 'href="#top"']) assert.ok(html.includes(ref), ref);

  // The current version is cached forever, compressed by the client's preference; any other spelling revalidates.
  const forever = await fetchRaw(f, `/game.js?v=${version}`, { 'Accept-Encoding': 'gzip, br' });
  assert.equal(forever.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(forever.headers['content-encoding'], 'br');
  assert.equal(forever.headers.vary, 'Accept-Encoding');
  assert.match(forever.headers.etag, /-br"$/);
  assert.ok(forever.body.length < script.length / 10);
  assert.equal(decode(forever).toString(), script);
  for (const [accept, encoding] of [['gzip', 'gzip'], ['br;q=0, gzip', 'gzip'], ['identity', undefined], [undefined, undefined]]) {
    const response = await fetchRaw(f, `/game.js?v=${version}`, accept ? { 'Accept-Encoding': accept } : {});
    assert.equal(response.headers['content-encoding'], encoding, String(accept));
    assert.equal(Number(response.headers['content-length']), response.body.length);
    assert.equal(decode(response).toString(), script, String(accept));
  }
  const revalidated = await fetchRaw(f, `/game.js?v=${version}`, { 'Accept-Encoding': 'gzip', 'If-None-Match': forever.headers.etag });
  assert.equal(revalidated.status, 304, 'one validator covers every encoding of a body');
  assert.equal(revalidated.body.length, 0);
  assert.equal((await fetchRaw(f, '/game.js?v=stale')).headers['cache-control'], 'no-cache');

  // A versioned stylesheet stamps its fonts to match; data URLs and the unversioned file are left alone.
  const css = decode(await fetchRaw(f, `/styles.css?v=${version}`)).toString();
  assert.ok(css.includes(`url("fonts/a.woff2?v=${version}")`) && css.includes('url(data:image/png;base64,AAAA)'), css);
  assert.ok(decode(await fetchRaw(f, '/styles.css')).toString().includes('url("fonts/a.woff2")'));

  // three.js is versioned by its package: the pinned version is immutable, another one revalidates.
  const vendor = await fetchRaw(f, `/vendor/three@${threeVersion}/build/three.core.js`, { 'Accept-Encoding': 'br' });
  assert.equal(vendor.status, 200);
  assert.equal(vendor.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.ok(decode(vendor).toString().includes("const REVISION = '187'"));
  assert.equal((await fetchRaw(f, '/vendor/three@0.0.1/build/three.core.js')).headers['cache-control'], 'no-cache');
  assert.equal((await fetchRaw(f, `/vendor/three@${threeVersion}/build/three.module.js`)).status, 404);

  // Changing any public file changes the version (rechecked at most once a second), and the old one stops being cached.
  await new Promise(resolve => setTimeout(resolve, 1100));
  await fs.writeFile(path.join(publicDir, 'game.js'), script + '// changed\n');
  const next = (decode(await fetchRaw(f, '/')).toString().match(/game\.js\?v=([\w-]+)"/) || [])[1];
  assert.ok(next && next !== version);
  assert.equal((await fetchRaw(f, `/game.js?v=${version}`)).headers['cache-control'], 'no-cache');
  const fresh = await fetchRaw(f, `/game.js?v=${next}`);
  assert.equal(fresh.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.ok(decode(fresh).toString().endsWith('// changed\n'));
  assert.deepEqual(f.errors, []);
});

test('the scoreboard answers unchanged polls with 304 and a new ETag after every change', async t => {
  const initialScores = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`player_${String(index).padStart(3, '0')}`, { name: 'Explorer', time: 30 + index, kills: 12, at: 1 }]));
  const f = await fixture(t, { initialScores });
  const first = await fetchRaw(f, '/api/scores', { 'Accept-Encoding': 'gzip' });
  assert.equal(first.status, 200);
  assert.equal(first.headers['cache-control'], 'no-cache');
  assert.equal(first.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(decode(first)).length, 30);
  const plain = await fetchRaw(f, '/api/scores');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(JSON.parse(plain.body).length, 30);
  const unchanged = await fetchRaw(f, '/api/scores', { 'If-None-Match': first.headers.etag });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body.length, 0);
  // A slower run by a listed player changes nothing: the board still answers 304.
  assert.equal((await f.score(validScore)).status, 200);
  assert.equal((await fetchRaw(f, '/api/scores', { 'If-None-Match': first.headers.etag })).status, 304);
  assert.equal((await f.score({ ...validScore, uid: 'newcomer_01' })).status, 200);
  const changed = await fetchRaw(f, '/api/scores', { 'If-None-Match': first.headers.etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, plain.headers.etag);
  assert.ok(JSON.parse(changed.body).some(run => run.uid === 'newcomer_01'));
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

test('vendor routes expose only the pinned Three.js modules and reject traversal', async t => {
  const f = await fixture(t);
  for (const pathname of [
    '/vendor/three/build/three.cjs', '/vendor/three/build/three.module.js', '/vendor/three/build/nested/three.core.js',
    '/vendor/three/build', '/vendor/three/package.json', '/vendor/three/src/Three.js', '/vendor/three/addons/Addons',
    '/vendor/three/addons/tsl/display/BloomNode.mjs', '/vendor/three/addons/.hidden.js', '/vendor/three/addons/tsl/./display/BloomNode.js',
    '/vendor/three/addons/tsl//display/BloomNode.js', '/vendor/three/addons/tsl/display/Missing.js'
  ]) {
    const response = await f.request(pathname);
    assert.equal(response.status, 404, pathname);
    assert.ok(!response.body.includes('three'), pathname);
  }
  for (const pathname of [
    '/vendor/three/addons/../../package.json', '/vendor/three/addons/%2e%2e/%2e%2e/package.json',
    '/vendor/three/addons/..%2f..%2f..%2f..%2fserver.js', '/vendor/three/build/../package.json'
  ]) {
    const response = await f.request(pathname);
    assert.equal(response.status, 403, pathname);
    assert.ok(!response.body.includes('"version"') && !response.body.includes('createGameServer'), pathname);
  }
  assert.equal((await f.request('/vendor/three/addons/tsl/display/BloomNode.js', { method: 'HEAD' })).status, 200);
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
  assert.deepEqual(initial.json(), { ok: true, improved: true, best: { escaped: true, time: 60.1, score: 0, kills: 12 } });
  let records = (await f.request('/api/scores')).json();
  assert.equal(records[0].name, 'Alice Pilot');
  assert.equal(records[0].kills, 12);
  assert.ok(records[0].at > 0);
  // Without the newer fields a submission is a solo escape, as older clients sent.
  assert.deepEqual([records[0].mode, records[0].escaped, records[0].score, records[0].partner], ['solo', true, 0, '']);
  const slower = await f.score({ ...validScore, name: 'alice PILOT', time: 100, kills: 0 });
  assert.equal(slower.json().improved, false);
  assert.equal(slower.json().best.time, 60.1);
  records = (await f.request('/api/scores')).json();
  assert.equal(records.length, 1, 'a change of letter case is the same player');
  assert.equal(records[0].name, 'alice PILOT');
  assert.equal(records[0].kills, 12);
  await f.score({ ...validScore, name: 'Alice Pilot', time: 55.11, kills: 100 });
  await f.score({ ...validScore, uid: 'player_002', time: 40, kills: -3 });
  records = (await f.request('/api/scores')).json();
  assert.deepEqual(records.map(record => [record.uid, record.time, record.kills]), [['player_002', 40, 0], ['player_001', 55.1, 12]]);
  // Another name on the same browser is another player and keeps its own entry.
  await f.score({ ...validScore, name: 'Sibling', time: 300, kills: 1 });
  records = (await f.request('/api/scores')).json();
  assert.deepEqual(records.map(record => [record.uid, record.name, record.time]), [['player_002', 'Explorer', 40], ['player_001', 'Alice Pilot', 55.1], ['player_001', 'Sibling', 300]]);
});

test('runs that end in the ward and co-op runs are recorded for every player', async t => {
  const f = await fixture(t);
  const coop = { mode: 'coop', escaped: false };
  for (const run of [
    { ...coop, uid: 'player_001', name: 'Host', partner: 'Guest', time: 8.04, kills: 2, score: 290 },
    { ...coop, uid: 'player_002', name: 'Guest', partner: ' Host\u0007 ', time: 30, kills: 1, score: 150 },
    { uid: 'player_001', name: 'Host', partner: 'Nobody', time: 200, kills: 3, score: 450 },
    { uid: 'player_003', name: 'Loner', escaped: false, time: 300, kills: 2, score: 290 }
  ]) assert.equal((await f.score(run)).json().improved, true, run.name);
  let records = (await f.request('/api/scores')).json();
  // Escapes first, then the highest score, then the longer survival.
  assert.deepEqual(records.map(record => [record.name, record.mode, record.escaped, record.score, record.time]), [
    ['Host', 'solo', true, 450, 200], ['Loner', 'solo', false, 290, 300], ['Host', 'coop', false, 290, 8], ['Guest', 'coop', false, 150, 30]
  ]);
  assert.deepEqual(records.map(record => [record.partner, record.kills]), [['', 3], ['', 2], ['Guest', 2], ['Host', 1]]);
  const worse = await f.score({ ...coop, uid: 'player_001', name: 'Host', partner: 'Guest', time: 900, kills: 0, score: 100 });
  assert.deepEqual(worse.json(), { ok: true, improved: false, best: { escaped: false, time: 8, score: 290, kills: 2 } });
  // Getting out beats any run that ended inside, whatever its score.
  const escaped = await f.score({ ...coop, uid: 'player_001', name: 'Host', partner: 'Guest', escaped: true, time: 500, kills: 0, score: 0 });
  assert.deepEqual(escaped.json(), { ok: true, improved: true, best: { escaped: true, time: 500, score: 0, kills: 0 } });
  records = (await f.request('/api/scores')).json();
  assert.deepEqual(records.slice(0, 2).map(record => [record.name, record.mode, record.time]), [['Host', 'solo', 200], ['Host', 'coop', 500]]);
  assert.equal(records.length, 4);
  // Scores are whole points within bounds; a run that ends inside may be short.
  await f.score({ uid: 'player_004', name: 'Quick', escaped: false, time: 3, score: 2e9 });
  await f.score({ uid: 'player_005', name: 'Unlucky', escaped: false, time: 0, score: -40 });
  records = (await f.request('/api/scores')).json();
  assert.deepEqual(records.filter(record => ['Quick', 'Unlucky'].includes(record.name)).map(record => [record.name, record.score, record.time]), [['Quick', 1000000, 3], ['Unlucky', 0, 0]]);
});

test('invalid, oversized and malformed score submissions cannot damage the board', async t => {
  const f = await fixture(t);
  const invalid = [
    null, [], {}, { ...validScore, uid: 'short' }, { ...validScore, uid: '<bad-player>' },
    { ...validScore, name: 'a' }, { ...validScore, name: {} }, { ...validScore, time: 14.99 },
    { ...validScore, time: 7200.01 }, { ...validScore, time: 'Infinity' }, { ...validScore, kills: 'invalid' },
    { ...validScore, mode: 'versus' }, { ...validScore, mode: ['coop'] }, { ...validScore, escaped: 'yes' }, { ...validScore, escaped: 1 },
    { ...validScore, score: 'lots' }, { ...validScore, escaped: false, time: -1 }, { ...validScore, escaped: false, time: 7200.01 }
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
  assert.equal(saved['player_000|solo|explorer'].time, 30);
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

test('older per-browser score files load as solo escapes alongside newer records', async t => {
  const f = await fixture(t, { initialScores: {
    player_001: { name: 'Veteran', time: 50, kills: 3, at: 1 },
    'player_002|coop|guest': { uid: 'player_002', name: 'Guest', mode: 'coop', partner: 'Host', escaped: false, time: 20, kills: 1, score: 120, at: 2 },
    'not a uid|coop|x': { name: 'No identity', mode: 'coop', escaped: false, time: 20, score: 5 },
    player_003: { name: 'Lost', mode: 'coop', escaped: false, time: 'soon' },
    player_004: { name: 'Odd mode', mode: 'arena', time: 90 }
  } });
  const records = (await f.request('/api/scores')).json();
  assert.deepEqual(records, [
    { uid: 'player_001', name: 'Veteran', mode: 'solo', partner: '', escaped: true, time: 50, kills: 3, score: 0, at: 1 },
    { uid: 'player_002', name: 'Guest', mode: 'coop', partner: 'Host', escaped: false, time: 20, kills: 1, score: 120, at: 2 }
  ]);
  await f.score({ uid: 'player_001', name: 'Veteran', time: 45, kills: 4, score: 150 });
  await f.app.close();
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'scores.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['player_001|solo|veteran', 'player_002|coop|guest']);
  assert.equal(saved['player_001|solo|veteran'].score, 150);
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

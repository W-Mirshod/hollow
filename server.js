// The Hollow: local game assets, co-op presence and a persistent community board.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const { randomBytes } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const UID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const THREE_BUILD = new Set(['three.webgpu.js', 'three.tsl.js', 'three.core.js']);
const THREE_ADDON_RE = /^\/vendor\/three\/addons\/((?:[A-Za-z0-9_-]+\/){0,8}[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.js)$/;
const MAX_KILLS = 12;
const MAX_SCORE = 1000000;
const MODES = new Set(['solo', 'coop']);
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.ktx2': 'image/ktx2', '.bin': 'application/octet-stream'
});

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function cleanName(value) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18)
    : '';
}

// Escapes rank above runs that ended in the ward; then higher score, then the faster escape or the
// longer survival, then the earlier run. public/game.js sorts the board with the same order.
function compareRuns(a, b) {
  return (b.escaped - a.escaped) || (b.score - a.score) || (a.escaped ? a.time - b.time : b.time - a.time) || (a.at - b.at);
}

// One best run is kept per browser identity, mode and (case-insensitive) player name, so players who
// share a browser and both co-op partners each keep their own entry.
function recordKey(run) {
  return run.uid + '|' + run.mode + '|' + run.name.toLowerCase();
}

// A run as submitted or saved; missing fields describe the original solo escape. Returns null if invalid.
function cleanRun(uid, record, at) {
  if (!UID_RE.test(uid) || !record || typeof record !== 'object' || Array.isArray(record)) return null;
  const name = cleanName(record.name);
  const mode = record.mode == null ? 'solo' : record.mode;
  const escaped = record.escaped == null ? true : record.escaped;
  const time = Number(record.time);
  const kills = record.kills == null ? 0 : Number(record.kills);
  const score = record.score == null ? 0 : Number(record.score);
  if (name.length < 2 || !MODES.has(mode) || typeof escaped !== 'boolean' || !Number.isFinite(time) ||
    time < (escaped ? 15 : 0) || time > 7200 || !Number.isFinite(kills) || !Number.isFinite(score)) return null;
  return {
    uid, name, mode, partner: mode === 'coop' ? cleanName(record.partner) : '', escaped,
    time: Math.round(time * 10) / 10,
    kills: Math.max(0, Math.min(MAX_KILLS, Math.floor(kills))),
    score: Math.max(0, Math.min(MAX_SCORE, Math.floor(score))),
    at
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        reject(new RequestError(413, 'request too large'));
        req.resume();
      } else chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
    req.on('aborted', () => reject(new RequestError(400, 'request aborted')));
  });
}

function send(req, res, status, type, body, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...extraHeaders
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function json(req, res, status, body, headers) {
  send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(body), headers);
}

function requestPath(req) {
  // Check the original path before URL normalization can conceal ../ segments.
  const raw = String(req.url || '');
  if (!raw.startsWith('/') || raw.startsWith('//')) throw new RequestError(400, 'bad URL');
  let pathname;
  try { pathname = decodeURIComponent(raw.split(/[?#]/, 1)[0]); }
  catch { throw new RequestError(400, 'bad URL'); }
  if (/[\u0000-\u001f\u007f\\]/.test(pathname)) throw new RequestError(400, 'bad URL');
  if (pathname.split('/').some(segment => segment === '..')) throw new RequestError(403, 'forbidden');
  return pathname.replace(/\/+$/, '') || '/';
}

function createGameServer(options = {}) {
  const publicDir = path.resolve(options.publicDir || path.join(__dirname, 'public'));
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data'));
  const scoresFile = path.join(dataDir, 'scores.json');
  const threeBuildDir = path.dirname(require.resolve('three/webgpu'));
  const threeAddonDir = path.join(threeBuildDir, '..', 'examples', 'jsm');
  const scoreCooldownMs = options.scoreCooldownMs ?? 3000;
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === '1';
  const maxRoomsPerConnection = options.maxRoomsPerConnection ?? 2;
  const maxRooms = options.maxRooms ?? 1024;
  const logError = options.logError || (error => console.error('[hollow]', error.message));
  const scores = Object.create(null);
  const lastPost = new Map();
  const rooms = new Map();
  let saveTimer = null;
  let dirty = false;
  let writes = Promise.resolve();
  let closePromise = null;

  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const saved = JSON.parse(fs.readFileSync(scoresFile, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [key, record] of Object.entries(saved)) {
        if (!record || typeof record !== 'object') continue;
        // Older files were keyed by browser identity alone and held solo escapes.
        const uid = typeof record.uid === 'string' ? record.uid : key;
        const run = cleanRun(uid, { ...record, kills: Number(record.kills) || 0, score: Number(record.score) || 0 },
          Number.isFinite(Number(record.at)) ? Number(record.at) : 0);
        if (!run) continue;
        const id = recordKey(run);
        if (!scores[id] || compareRuns(run, scores[id]) < 0) scores[id] = run;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') logError(new Error('Scoreboard could not be loaded; the original file was left untouched.'));
  }

  function persistScores() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty) return writes;
    dirty = false;
    const snapshot = JSON.stringify(scores);
    // Serialize writes: a slow older rename must not overwrite a newer score.
    writes = writes.catch(() => {}).then(async () => {
      const temporaryFile = scoresFile + '.tmp';
      try {
        await fs.promises.writeFile(temporaryFile, snapshot, { mode: 0o600 });
        await fs.promises.rename(temporaryFile, scoresFile);
      } catch (error) {
        dirty = true;
        throw error;
      }
    });
    return writes;
  }

  function scheduleSave() {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistScores().catch(logError), 250);
    saveTimer.unref();
  }

  function topScores() {
    return Object.values(scores).sort(compareRuns).slice(0, 100);
  }

  function requestIP(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return trustProxy && isIP(forwarded) ? forwarded : (req.socket.remoteAddress || 'unknown');
  }

  // Only the pinned Three.js ES module build and its addons are exposed from node_modules.
  function vendorAsset(pathname) {
    if (pathname.startsWith('/vendor/three/build/')) {
      const name = pathname.slice('/vendor/three/build/'.length);
      return THREE_BUILD.has(name) ? { file: path.join(threeBuildDir, name), root: threeBuildDir } : null;
    }
    const addon = THREE_ADDON_RE.exec(pathname);
    return addon ? { file: path.join(threeAddonDir, addon[1]), root: threeAddonDir } : null;
  }

  async function serveAsset(req, res, pathname) {
    const isVendor = pathname.startsWith('/vendor/three/');
    const vendor = isVendor ? vendorAsset(pathname) : null;
    if (isVendor && !vendor) throw new RequestError(404, 'not found');
    const relative = pathname === '/' ? '/index.html' : pathname;
    if (!isVendor && relative.split('/').some(segment => segment.startsWith('.'))) {
      throw new RequestError(403, 'forbidden');
    }
    const candidate = isVendor ? vendor.file : path.resolve(publicDir, '.' + relative);
    if (!isVendor && !candidate.startsWith(publicDir + path.sep)) throw new RequestError(403, 'forbidden');
    let filename;
    let stats;
    try {
      filename = await fs.promises.realpath(candidate);
      // Public symlinks are permitted only when their destination stays public; vendor files never leave their root.
      const allowedRoot = await fs.promises.realpath(isVendor ? vendor.root : publicDir);
      if (!filename.startsWith(allowedRoot + path.sep)) throw isVendor ? new RequestError(404, 'not found') : new RequestError(403, 'forbidden');
      stats = await fs.promises.stat(filename);
      if (!stats.isFile()) throw new RequestError(404, 'not found');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new RequestError(404, 'not found');
      throw error;
    }
    const etag = `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': isVendor ? 'public, max-age=86400' : 'no-cache',
      'ETag': etag,
      'Last-Modified': stats.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin'
    };
    const ifNoneMatch = String(req.headers['if-none-match'] || '');
    if (ifNoneMatch.split(/\s*,\s*/).some(tag => tag === etag || tag === '*' || tag === 'W/' + etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': stats.size });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filename);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = requestPath(req);
      if (pathname === '/api/scores') {
        if (req.method === 'GET' || req.method === 'HEAD') return json(req, res, 200, topScores());
        if (req.method !== 'POST') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD, POST' });
        const ip = requestIP(req);
        const now = Date.now();
        const previous = lastPost.get(ip);
        if (previous !== undefined && now - previous < scoreCooldownMs) {
          return json(req, res, 429, { error: 'slow down' }, { 'Retry-After': Math.ceil((scoreCooldownMs - now + previous) / 1000) });
        }
        if (lastPost.size >= 10000 && !lastPost.has(ip)) lastPost.delete(lastPost.keys().next().value);
        lastPost.set(ip, now);
        let body;
        try { body = JSON.parse(await readBody(req, 2048)); }
        catch (error) { throw error instanceof RequestError ? error : new RequestError(400, 'bad request'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'invalid score');
        const run = cleanRun(typeof body.uid === 'string' ? body.uid : '', body, now);
        if (!run) throw new RequestError(400, 'invalid score');
        const id = recordKey(run);
        const current = scores[id];
        const improved = !current || compareRuns(run, current) < 0;
        if (improved) scores[id] = run;
        else if (current.name !== run.name) current.name = run.name;
        scheduleSave();
        const best = scores[id];
        return json(req, res, 200, { ok: true, improved, best: { escaped: best.escaped, time: best.time, score: best.score, kills: best.kills } });
      }
      if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) return send(req, res, 200, 'text/plain; charset=utf-8', 'ok');
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
      if (pathname === '/favicon.ico') return send(req, res, 204, 'image/x-icon', '');
      await serveAsset(req, res, pathname);
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500;
      if (status === 500) logError(error);
      if (res.headersSent) res.destroy();
      else json(req, res, status, { error: status === 500 ? 'server error' : error.message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;

  // Wire format is unchanged: join -> joined/full, presence -> peer, leave -> left.
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024, perMessageDeflate: false });

  function out(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 256 * 1024) { ws.terminate(); return; }
    try { ws.send(JSON.stringify(message), error => { if (error) ws.terminate(); }); }
    catch { ws.terminate(); }
  }

  function leave(ws, roomName) {
    const room = rooms.get(roomName);
    ws.rooms.delete(roomName);
    if (!room || !room.delete(ws.peerId)) return;
    for (const member of room.values()) out(member.ws, { t: 'left', room: roomName, peer: ws.peerId });
    if (!room.size) rooms.delete(roomName);
  }

  wss.on('connection', ws => {
    ws.peerId = 'p' + randomBytes(9).toString('hex');
    ws.rooms = new Set();
    ws.alive = true;
    ws.budget = 60;
    ws.budgetAt = Date.now();
    ws.on('pong', () => { ws.alive = true; });
    // Protocol and payload-limit errors belong to this client, not the process.
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => {
      const now = Date.now();
      ws.budget = Math.min(120, ws.budget + (now - ws.budgetAt) * 0.06);
      ws.budgetAt = now;
      if (ws.budget < 1) return;
      ws.budget -= 1;
      let message;
      try { if (isBinary) return; message = JSON.parse(raw.toString()); }
      catch { return out(ws, { t: 'error', code: 'invalid_message' }); }
      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.room !== 'string' || !ROOM_RE.test(message.room)) return;
      if (message.t === 'join') {
        let room = rooms.get(message.room);
        if (!ws.rooms.has(message.room) && ws.rooms.size >= maxRoomsPerConnection) return out(ws, { t: 'full', room: message.room, code: 'room_limit' });
        if (!room && rooms.size >= maxRooms) return out(ws, { t: 'full', room: message.room, code: 'server_busy' });
        if (room && !room.has(ws.peerId) && room.size >= 4) return out(ws, { t: 'full', room: message.room });
        if (!room) { room = new Map(); rooms.set(message.room, room); }
        const alreadyJoined = room.has(ws.peerId);
        if (!alreadyJoined) room.set(ws.peerId, { ws, pr: {} });
        ws.rooms.add(message.room);
        out(ws, {
          t: 'joined', room: message.room, peer: ws.peerId,
          peers: [...room].filter(([id]) => id !== ws.peerId).map(([peer, member]) => ({ peer, pr: member.pr }))
        });
        if (!alreadyJoined) for (const [id, member] of room) if (id !== ws.peerId) out(member.ws, { t: 'peer', room: message.room, peer: ws.peerId, pr: {} });
      } else if (message.t === 'presence') {
        const room = rooms.get(message.room);
        if (!room || !room.has(ws.peerId) || !message.pr || typeof message.pr !== 'object' || Array.isArray(message.pr)) return;
        try { if (Buffer.byteLength(JSON.stringify(message.pr)) > 4096) return; }
        catch { return; }
        room.get(ws.peerId).pr = message.pr;
        for (const [id, member] of room) if (id !== ws.peerId) out(member.ws, { t: 'peer', room: message.room, peer: ws.peerId, pr: message.pr });
      } else if (message.t === 'leave') leave(ws, message.room);
    });
    ws.on('close', () => { for (const roomName of [...ws.rooms]) leave(ws, roomName); });
  });
  wss.on('error', logError);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      try { ws.ping(); } catch { ws.terminate(); }
    }
  }, options.heartbeatMs ?? 20000);
  heartbeat.unref();
  const sweep = setInterval(() => {
    const cutoff = Date.now() - Math.max(scoreCooldownMs, 60000);
    for (const [ip, at] of lastPost) if (at < cutoff) lastPost.delete(ip);
  }, 60000);
  sweep.unref();

  function listen(port = process.env.PORT === undefined ? 3077 : Number(process.env.PORT), host = process.env.HOST || '127.0.0.1') {
    return new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(server.address()); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  function close() {
    if (closePromise) return closePromise;
    clearInterval(heartbeat);
    clearInterval(sweep);
    clearTimeout(saveTimer);
    for (const ws of wss.clients) ws.terminate();
    closePromise = (async () => {
      const deadline = setTimeout(() => server.closeAllConnections?.(), 5000);
      deadline.unref();
      try {
        await Promise.all([
          new Promise(resolve => wss.close(resolve)),
          new Promise((resolve, reject) => {
            if (!server.listening) return resolve();
            server.close(error => error ? reject(error) : resolve());
            server.closeIdleConnections?.();
          })
        ]);
        // A request already in flight may have submitted a score while closing.
        await persistScores();
      } finally { clearTimeout(deadline); }
    })();
    return closePromise;
  }

  return { server, wss, rooms, listen, close };
}

if (require.main === module) {
  const app = createGameServer();
  app.listen().then(address => {
    console.log(`The Hollow is running on http://${address.address}:${address.port}`);
  }).catch(async error => {
    console.error('[hollow] Could not start:', error.message);
    process.exitCode = 1;
    await app.close();
  });
  const shutdown = () => app.close().catch(error => {
    console.error('[hollow] Could not save scoreboard:', error.message);
    process.exitCode = 1;
  });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

module.exports = { createGameServer };

/**
 * SHADOWSTRIKE relay server.
 *
 * Run with `npm run server`. It serves three things:
 *
 *   /ws       the WebSocket endpoint matches run over,
 *   /health   a JSON status probe for a load balancer,
 *   /         the built client, when `dist/` exists.
 *
 * That last one means a single `npm run build && npm run server` produces a
 * complete, self-hosted game on one port — no reverse proxy to configure and
 * nothing to explain to someone who just wants to play with a friend.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { Lobby } from './rooms.js';

const PROTOCOL_VERSION = 3;
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');

/** Messages a client may send while not in a match. */
const LOBBY_MESSAGES = new Set(['hello', 'queue', 'cancel', 'ping', 'leave']);

/** Messages forwarded verbatim to the opponent. */
const RELAYED_MESSAGES = new Set(['snap', 'hit', 'round', 'chat']);

/** Anything larger than this is not a legitimate game message. */
const MAX_MESSAGE_BYTES = 16 * 1024;

const lobby = new Lobby();

// --- static file serving ----------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, version: PROTOCOL_VERSION, ...lobby.stats() }));
    return;
  }

  // Resolve inside dist and refuse anything that escapes it. Path traversal is
  // the one way a static file server becomes a security problem.
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const candidate = join(DIST, normalize(requested).replace(/^(\.\.[/\\])+/, ''));
  if (!candidate.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(candidate);
    const file = info.isDirectory() ? join(candidate, 'index.html') : candidate;
    const body = await readFile(file);
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      // Hashed asset names make long caching safe; index.html must not be cached.
      'cache-control': file.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
      // getUserMedia and the WASM backend both want a properly isolated context.
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'credentialless',
    });
    res.end(body);
  } catch {
    // Single-page app: unknown paths fall back to index.html when it exists.
    try {
      const body = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        'SHADOWSTRIKE relay is running.\n' +
          'Build the client with `npm run build` to serve it from here.\n',
      );
    }
  }
}

const httpServer = createServer((req, res) => {
  serveStatic(req, res).catch((error) => {
    console.error('static handler failed', error);
    if (!res.headersSent) res.writeHead(500);
    res.end('Internal error');
  });
});

// --- websocket --------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (socket, request) => {
  const player = lobby.add(socket);
  const address = request.socket.remoteAddress ?? 'unknown';
  console.log(`[+] ${player.id} from ${address} (${lobby.onlineCount} online)`);

  player.send({
    t: 'welcome',
    version: PROTOCOL_VERSION,
    id: player.id,
    online: lobby.onlineCount,
  });

  socket.on('message', (raw) => {
    player.lastSeen = Date.now();

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message.t !== 'string') return;

    handleMessage(player, message);
  });

  socket.on('close', () => {
    console.log(`[-] ${player.id} (${lobby.onlineCount - 1} online)`);
    lobby.remove(player);
  });

  socket.on('error', (error) => {
    console.warn(`socket error for ${player.id}:`, error.message);
  });

  socket.on('pong', () => {
    player.lastSeen = Date.now();
  });
});

function handleMessage(player, message) {
  // In-match traffic is the hot path and is forwarded without inspection.
  if (RELAYED_MESSAGES.has(message.t)) {
    if (!player.match) return;
    player.match.relay(player, message);
    return;
  }

  if (!LOBBY_MESSAGES.has(message.t) && message.t !== 'ready') return;

  switch (message.t) {
    case 'hello': {
      if (message.version !== PROTOCOL_VERSION) {
        player.send({
          t: 'error',
          code: 'version',
          message: 'Версия клиента не совпадает с сервером.',
        });
        player.socket.close(4001, 'protocol version');
        return;
      }
      // Names are shown to another human; keep them short and single-line.
      player.name = String(message.name ?? 'Боец')
        .replace(/[\r\n\t]/g, ' ')
        .trim()
        .slice(0, 20) || 'Боец';
      break;
    }

    case 'queue': {
      if (player.match) return;
      const match = lobby.queue(player, message.character, message.room);
      if (match) {
        console.log(`[=] match ${match.id}: ${match.players.map((p) => p.name).join(' vs ')}`);
      }
      break;
    }

    case 'cancel':
      lobby.dequeue(player);
      break;

    case 'ready': {
      if (!player.match) return;
      player.ready = true;
      if (player.match.tryStart()) {
        console.log(`[>] match ${player.match.id} started`);
      }
      break;
    }

    case 'ping':
      player.send({ t: 'pong', c: message.c, s: Date.now() });
      break;

    case 'leave': {
      if (player.match) {
        const match = player.match;
        lobby.matches.delete(match.id);
        match.end('quit', player);
      }
      lobby.dequeue(player);
      break;
    }
  }
}

// --- upkeep -----------------------------------------------------------------

const sweepTimer = setInterval(() => {
  lobby.sweep();
}, 5000);

// A WebSocket that dies without a close frame — a laptop lid closing, a phone
// losing signal — is only detectable by a ping that never comes back.
const heartbeatTimer = setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    try {
      client.ping();
    } catch {
      // Collected by the next sweep.
    }
  }
}, 8000);

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down`);
  clearInterval(sweepTimer);
  clearInterval(heartbeatTimer);
  for (const client of wss.clients) {
    try {
      client.close(1001, 'server shutting down');
    } catch {
      // Ignore.
    }
  }
  wss.close(() => {
    httpServer.close(() => process.exit(0));
  });
  // Do not hang forever on a stuck socket.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

httpServer.listen(PORT, HOST, () => {
  console.log(`SHADOWSTRIKE relay listening on http://${HOST}:${PORT}`);
  console.log(`  websocket  ws://${HOST}:${PORT}/ws`);
  console.log(`  health     http://${HOST}:${PORT}/health`);
});

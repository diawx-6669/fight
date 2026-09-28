#!/usr/bin/env node
/**
 * End-to-end check of the relay server.
 *
 * Opens two WebSocket clients, puts them in the same room, and verifies the
 * full handshake: welcome → queue → matched → ready → start → relay both ways
 * → leave. Exits non-zero on the first thing that does not happen.
 *
 *   npm run server        # in one terminal
 *   npm run net:check     # in another
 *
 * This exists because the netcode's failure mode is silence: a mistake in the
 * pairing logic does not throw, it just leaves two players waiting forever.
 */

import { WebSocket } from 'ws';

const URL = process.env.NET_URL ?? 'ws://127.0.0.1:8787/ws';
const PROTOCOL_VERSION = 3;
const ROOM = 'TEST7';
const TIMEOUT_MS = 8000;

const failures = [];
let passed = 0;

function check(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

class TestClient {
  constructor(name) {
    this.name = name;
    this.socket = new WebSocket(URL);
    this.received = [];
    this.waiters = [];

    this.socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.received.push(message);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].predicate(message)) {
          this.waiters[i].resolve(message);
          this.waiters.splice(i, 1);
        }
      }
    });
  }

  open() {
    return new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  /** Resolves with the first message matching `predicate`, or rejects on timeout. */
  expect(predicate, label) {
    const already = this.received.find(predicate);
    if (already) return Promise.resolve(already);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${this.name}: timed out waiting for ${label}`));
      }, TIMEOUT_MS);

      this.waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }

  close() {
    this.socket.close();
  }
}

async function main() {
  console.log(`Checking relay at ${URL}`);

  const a = new TestClient('A');
  const b = new TestClient('B');

  await Promise.all([a.open(), b.open()]);
  console.log('  ✓ both sockets open');
  passed++;

  const welcomeA = await a.expect((m) => m.t === 'welcome', 'welcome');
  const welcomeB = await b.expect((m) => m.t === 'welcome', 'welcome');
  check(welcomeA.version === PROTOCOL_VERSION, 'server speaks the expected protocol version');
  check(typeof welcomeA.id === 'string' && welcomeA.id !== welcomeB.id, 'each client gets a distinct id');

  a.send({ t: 'hello', version: PROTOCOL_VERSION, name: 'Игрок А' });
  b.send({ t: 'hello', version: PROTOCOL_VERSION, name: 'Игрок Б' });

  // A opens the room, B joins it.
  a.send({ t: 'queue', character: 'kai', room: ROOM });
  const queued = await a.expect((m) => m.t === 'queued', 'queued');
  check(queued.room === ROOM, 'room code is echoed back to its creator');

  b.send({ t: 'queue', character: 'rei', room: ROOM });

  const matchedA = await a.expect((m) => m.t === 'matched', 'matched');
  const matchedB = await b.expect((m) => m.t === 'matched', 'matched');

  check(matchedA.matchId === matchedB.matchId, 'both clients land in the same match');
  check(matchedA.seed === matchedB.seed, 'both clients get the same RNG seed');
  check(matchedA.arena === matchedB.arena, 'both clients get the same arena');
  check(matchedA.slot !== matchedB.slot, 'clients get opposite slots');
  check(matchedA.opponent.character === 'rei', 'A sees B’s character');
  check(matchedB.opponent.character === 'kai', 'B sees A’s character');
  check(matchedA.opponent.name === 'Игрок Б', 'names survive the round trip');

  // Both ready → start.
  a.send({ t: 'ready' });
  b.send({ t: 'ready' });
  const startA = await a.expect((m) => m.t === 'start', 'start');
  const startB = await b.expect((m) => m.t === 'start', 'start');
  check(startA.at === startB.at, 'both clients get the same start time');
  check(startA.at > Date.now() - 1000, 'start time is in the near future');

  // Relay, A → B.
  a.send({ t: 'hit', mv: 'cross', dmg: 62, x: 1.2, y: 1.4, zn: 'head', sv: 0.8, blk: false, cmb: 2 });
  const relayed = await b.expect((m) => m.t === 'relay' && m.m?.t === 'hit', 'relayed hit');
  check(relayed.m.dmg === 62 && relayed.m.mv === 'cross', 'hit payload arrives intact');

  // Relay, B → A, with a pose snapshot.
  b.send({
    t: 'snap', f: 120, x: 2.5, y: 0, vx: -1, vy: 0, fc: -1, st: 'idle', mv: '', mf: 0,
    hp: 880, sp: 90, mt: 30, fl: 1, gh: 140, p: Array.from({ length: 32 }, (_, i) => i / 10),
  });
  const snap = await a.expect((m) => m.t === 'relay' && m.m?.t === 'snap', 'relayed snapshot');
  check(snap.m.hp === 880 && snap.m.p.length === 32, 'snapshot payload arrives intact');

  // Ping round trip.
  const sentAt = Date.now();
  a.send({ t: 'ping', c: sentAt });
  const pong = await a.expect((m) => m.t === 'pong', 'pong');
  check(pong.c === sentAt, 'pong echoes the client clock');
  check(typeof pong.s === 'number', 'pong carries the server clock');

  // A leaves; B must be told rather than left hanging.
  a.send({ t: 'leave' });
  const left = await b.expect((m) => m.t === 'left', 'opponent-left notice');
  check(left.reason === 'quit', 'disconnect is reported as a quit');

  a.close();
  b.close();
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n${failures.length} check(s) failed.`);
      process.exit(1);
    }
    console.log(`\nAll ${passed} relay checks passed.`);
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\nRelay check failed: ${error.message}`);
    process.exit(1);
  });

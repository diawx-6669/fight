/**
 * Rooms and matchmaking.
 *
 * The server is a relay, not a simulation. It pairs players, forwards their
 * messages to each other, and notices when one of them goes away. It never
 * looks inside a snapshot and never has an opinion about who won — that
 * follows from the split-authority model the protocol describes.
 *
 * Keeping it this dumb has a real benefit beyond simplicity: the server costs
 * almost nothing to run, and a match's latency is one hop rather than a
 * simulation tick plus two hops.
 */

import { randomUUID } from 'node:crypto';

const ARENAS = [
  'dusk-temple',
  'rain-rooftops',
  'frozen-pass',
  'blossom-court',
  'ash-desert',
  'void',
];

/** No 0/O or 1/I — these codes get read aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A player disappears if nothing is heard from them for this long. */
const CLIENT_TIMEOUT_MS = 20_000;

/** How long an unmatched room code is held open. */
const ROOM_TTL_MS = 10 * 60 * 1000;

export class Player {
  constructor(socket, id) {
    this.socket = socket;
    this.id = id;
    this.name = 'Боец';
    this.character = 'kai';
    this.lastSeen = Date.now();
    this.match = null;
    this.queuedAt = 0;
    this.room = '';
    this.ready = false;
  }

  send(message) {
    if (this.socket.readyState !== 1) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // A socket that fails to write is already gone; the sweep will collect it.
    }
  }

  get opponent() {
    if (!this.match) return null;
    return this.match.players.find((player) => player !== this) ?? null;
  }
}

export class Match {
  constructor(a, b) {
    this.id = randomUUID().slice(0, 8);
    this.seed = randomUUID();
    this.players = [a, b];
    this.arena = ARENAS[Math.floor(Math.random() * ARENAS.length)];
    this.startedAt = 0;
    a.match = this;
    b.match = this;
    a.ready = false;
    b.ready = false;
  }

  slotOf(player) {
    return this.players[0] === player ? 0 : 1;
  }

  notifyMatched() {
    for (const player of this.players) {
      const opponent = player.opponent;
      player.send({
        t: 'matched',
        matchId: this.id,
        seed: this.seed,
        slot: this.slotOf(player),
        arena: this.arena,
        opponent: {
          name: opponent?.name ?? 'Соперник',
          character: opponent?.character ?? 'kai',
        },
      });
    }
  }

  /** Both sides have loaded; send the shared start time. */
  tryStart() {
    if (this.startedAt > 0) return false;
    if (!this.players.every((player) => player.ready)) return false;
    // A second of lead time absorbs the difference between the two clients'
    // clocks and gives both a moment to finish loading their models.
    this.startedAt = Date.now() + 1000;
    for (const player of this.players) player.send({ t: 'start', at: this.startedAt });
    return true;
  }

  relay(from, message) {
    const opponent = from.opponent;
    if (!opponent) return;
    opponent.send({ t: 'relay', m: message });
  }

  end(reason, except = null) {
    for (const player of this.players) {
      if (player !== except) player.send({ t: 'left', reason });
      player.match = null;
      player.ready = false;
    }
  }
}

export class Lobby {
  constructor() {
    /** @type {Map<string, Player>} */
    this.players = new Map();
    /** @type {Player[]} */
    this.publicQueue = [];
    /** @type {Map<string, { player: Player, createdAt: number }>} */
    this.rooms = new Map();
    /** @type {Map<string, Match>} */
    this.matches = new Map();
  }

  get onlineCount() {
    return this.players.size;
  }

  add(socket) {
    const id = randomUUID().slice(0, 8);
    const player = new Player(socket, id);
    this.players.set(id, player);
    return player;
  }

  remove(player) {
    this.players.delete(player.id);
    this.dequeue(player);

    if (player.match) {
      const match = player.match;
      this.matches.delete(match.id);
      match.end('quit', player);
    }
  }

  dequeue(player) {
    const index = this.publicQueue.indexOf(player);
    if (index >= 0) this.publicQueue.splice(index, 1);

    if (player.room) {
      const room = this.rooms.get(player.room);
      if (room && room.player === player) this.rooms.delete(player.room);
      player.room = '';
    }
  }

  /**
   * Puts a player into matchmaking.
   *
   * A blank code means public matchmaking. A code that nobody is waiting in
   * creates the room and returns it to be shared; a code someone *is* waiting
   * in pairs them immediately.
   */
  queue(player, character, code) {
    this.dequeue(player);
    player.character = typeof character === 'string' ? character.slice(0, 24) : 'kai';
    player.queuedAt = Date.now();

    if (code) {
      const normalized = String(code).toUpperCase().slice(0, 5);
      const waiting = this.rooms.get(normalized);

      if (waiting && waiting.player !== player && waiting.player.socket.readyState === 1) {
        this.rooms.delete(normalized);
        return this.pair(waiting.player, player);
      }

      player.room = normalized;
      this.rooms.set(normalized, { player, createdAt: Date.now() });
      player.send({ t: 'queued', position: 1, room: normalized });
      return null;
    }

    const partner = this.publicQueue.shift();
    if (partner && partner !== player && partner.socket.readyState === 1) {
      return this.pair(partner, player);
    }

    this.publicQueue.push(player);
    player.send({ t: 'queued', position: this.publicQueue.length, room: '' });
    return null;
  }

  /** Creates a fresh room code that is not already taken. */
  createRoomCode() {
    for (let attempt = 0; attempt < 24; attempt++) {
      let code = '';
      for (let i = 0; i < 5; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    // Astronomically unlikely; fall back to something guaranteed unique.
    return randomUUID().slice(0, 5).toUpperCase();
  }

  pair(a, b) {
    this.dequeue(a);
    this.dequeue(b);
    const match = new Match(a, b);
    this.matches.set(match.id, match);
    match.notifyMatched();
    return match;
  }

  /** Drops timed-out players and stale rooms. Called on an interval. */
  sweep() {
    const now = Date.now();

    for (const player of [...this.players.values()]) {
      if (player.socket.readyState > 1) {
        this.remove(player);
        continue;
      }
      if (now - player.lastSeen > CLIENT_TIMEOUT_MS) {
        if (player.match) {
          const match = player.match;
          this.matches.delete(match.id);
          match.end('timeout', player);
        }
        try {
          player.socket.close(4000, 'timeout');
        } catch {
          // Already closing.
        }
        this.remove(player);
      }
    }

    for (const [code, room] of this.rooms) {
      if (now - room.createdAt > ROOM_TTL_MS || room.player.socket.readyState !== 1) {
        this.rooms.delete(code);
      }
    }

    // Public queue entries whose sockets died.
    this.publicQueue = this.publicQueue.filter((player) => player.socket.readyState === 1);
  }

  stats() {
    return {
      online: this.players.size,
      queued: this.publicQueue.length,
      rooms: this.rooms.size,
      matches: this.matches.size,
    };
  }
}

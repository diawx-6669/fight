import { createLogger } from '@/core/logger';
import { EventBus } from '@/core/events';
import { clamp } from '@/core/math';
import {
  decode,
  encode,
  PROTOCOL_VERSION,
  SNAPSHOT_HZ,
  type ClientMessage,
  type HitMessage,
  type MatchedMessage,
  type RoundMessage,
  type ServerMessage,
  type SnapshotMessage,
} from './protocol';

const log = createLogger('net');

/**
 * The network client.
 *
 * A thin, reconnecting WebSocket wrapper with one piece of real logic: a
 * *latency estimator* built from ping round-trips, which the sync layer uses to
 * decide how far behind live to render the opponent.
 *
 * Everything else here is about failing gracefully. A dropped connection
 * mid-match must not leave the player staring at a frozen opponent with no
 * explanation, so the client distinguishes "connection lost, retrying" from
 * "the opponent quit" and says which.
 */

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'queued'
  | 'matched'
  | 'playing'
  | 'reconnecting'
  | 'failed';

export interface NetEvents {
  state: { state: ConnectionState };
  queued: { position: number; room: string };
  matched: MatchedMessage;
  start: { at: number };
  snapshot: SnapshotMessage;
  hit: HitMessage;
  round: RoundMessage;
  chat: { id: number };
  opponentLeft: { reason: string };
  error: { code: string; message: string };
}

export interface NetClientOptions {
  /** WebSocket URL; defaults to the page origin with the `/ws` path. */
  url?: string;
  playerName: string;
}

const MAX_RECONNECT_ATTEMPTS = 5;

export class NetClient {
  readonly events = new EventBus<NetEvents>();

  private socket: WebSocket | null = null;
  private url: string;
  private playerName: string;

  private connectionState: ConnectionState = 'idle';
  private reconnectAttempts = 0;
  private reconnectTimer = 0;

  /** Smoothed round-trip time in milliseconds. */
  private rtt = 80;
  private pingTimer = 0;
  private snapshotTimer = 0;

  /** Offset between this client's clock and the server's, in milliseconds. */
  private clockOffset = 0;

  /** Pending outgoing messages, flushed once connected. */
  private readonly outbox: ClientMessage[] = [];

  /** Set once matched, so a reconnect can rejoin rather than requeue. */
  private currentMatch: MatchedMessage | null = null;
  private intentionalClose = false;

  constructor(options: NetClientOptions) {
    this.playerName = options.playerName;
    this.url = options.url ?? defaultUrl();
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  get latency(): number {
    return this.rtt;
  }

  /** One-way latency estimate — half the round trip. */
  get oneWay(): number {
    return this.rtt / 2;
  }

  get match(): MatchedMessage | null {
    return this.currentMatch;
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  setName(name: string): void {
    this.playerName = name;
  }

  // --- lifecycle ------------------------------------------------------------

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    this.intentionalClose = false;
    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    log.info(`connecting to ${this.url}`);

    try {
      this.socket = new WebSocket(this.url);
    } catch (error) {
      log.error('socket construction failed', error);
      this.fail('connect-failed', 'Не удалось открыть соединение');
      return;
    }

    this.socket.addEventListener('open', this.onOpen);
    this.socket.addEventListener('message', this.onMessage);
    this.socket.addEventListener('close', this.onClose);
    this.socket.addEventListener('error', this.onSocketError);
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.currentMatch = null;
    this.send({ t: 'leave' });
    this.socket?.close(1000, 'client left');
    this.socket = null;
    this.setState('idle');
  }

  private readonly onOpen = (): void => {
    log.info('connected');
    this.reconnectAttempts = 0;
    this.setState('connected');
    this.sendImmediate({ t: 'hello', version: PROTOCOL_VERSION, name: this.playerName });

    // Flush anything queued while offline.
    for (const message of this.outbox) this.sendImmediate(message);
    this.outbox.length = 0;
  };

  private readonly onMessage = (event: MessageEvent): void => {
    if (typeof event.data !== 'string') return;
    const message = decode(event.data) as ServerMessage | null;
    if (!message) {
      log.onceWarn('bad-message', 'received a malformed message');
      return;
    }
    this.handle(message);
  };

  private readonly onClose = (event: CloseEvent): void => {
    this.socket = null;
    if (this.intentionalClose) return;

    log.warn(`connection closed (${event.code})`);
    // A match in progress is worth fighting for; an idle connection is not.
    if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      // Exponential backoff, capped — a server that is down stays down.
      this.reconnectTimer = Math.min(0.5 * Math.pow(2, this.reconnectAttempts), 8);
      this.setState('reconnecting');
    } else {
      this.fail('disconnected', 'Соединение потеряно');
    }
  };

  private readonly onSocketError = (): void => {
    log.warn('socket error');
  };

  private fail(code: string, message: string): void {
    this.setState('failed');
    this.events.emit('error', { code, message });
  }

  private setState(state: ConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.events.emit('state', { state });
  }

  // --- messaging ------------------------------------------------------------

  private sendImmediate(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(encode(message));
    } catch (error) {
      log.warn('send failed', error);
    }
  }

  /** Sends now, or queues until the connection is back. */
  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendImmediate(message);
      return;
    }
    // Snapshots are worthless by the time a reconnect completes; drop them
    // rather than replaying a stale position the moment the socket opens.
    if (message.t === 'snap') return;
    if (this.outbox.length < 64) this.outbox.push(message);
  }

  private handle(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        if (message.version !== PROTOCOL_VERSION) {
          this.fail(
            'version',
            'Версия игры не совпадает с сервером. Обнови страницу.',
          );
          return;
        }
        log.info(`welcomed as ${message.id}, ${message.online} online`);
        break;

      case 'queued':
        this.setState('queued');
        this.events.emit('queued', { position: message.position, room: message.room });
        break;

      case 'matched':
        this.currentMatch = message;
        this.setState('matched');
        this.events.emit('matched', message);
        break;

      case 'start':
        this.setState('playing');
        this.events.emit('start', { at: message.at });
        break;

      case 'relay':
        this.handleRelay(message.m);
        break;

      case 'pong': {
        const now = performance.now();
        const sample = now - message.c;
        // Heavy smoothing: a single slow packet should not move the estimate.
        this.rtt += (sample - this.rtt) * 0.2;
        // Assume symmetric latency to line the clocks up.
        this.clockOffset = message.s + sample / 2 - now;
        break;
      }

      case 'left':
        this.currentMatch = null;
        this.setState('connected');
        this.events.emit('opponentLeft', { reason: message.reason });
        break;

      case 'error':
        this.events.emit('error', { code: message.code, message: message.message });
        break;
    }
  }

  /** Messages forwarded from the opponent. */
  private handleRelay(message: ClientMessage): void {
    switch (message.t) {
      case 'snap':
        this.events.emit('snapshot', message);
        break;
      case 'hit':
        this.events.emit('hit', message);
        break;
      case 'round':
        this.events.emit('round', message);
        break;
      case 'chat':
        this.events.emit('chat', { id: message.id });
        break;
      case 'leave':
        this.events.emit('opponentLeft', { reason: 'quit' });
        break;
      default:
        break;
    }
  }

  // --- per-frame ------------------------------------------------------------

  /** Call each frame. Drives reconnection, pings and the snapshot cadence. */
  update(dt: number): boolean {
    if (this.reconnectTimer > 0) {
      this.reconnectTimer -= dt;
      if (this.reconnectTimer <= 0) this.connect();
    }

    if (!this.isConnected) return false;

    this.pingTimer -= dt;
    if (this.pingTimer <= 0) {
      this.pingTimer = 2;
      this.sendImmediate({ t: 'ping', c: performance.now() });
    }

    this.snapshotTimer -= dt;
    if (this.snapshotTimer <= 0) {
      this.snapshotTimer = 1 / SNAPSHOT_HZ;
      return true;
    }
    return false;
  }

  /** Approximate server time, for lining up round starts. */
  serverNow(): number {
    return performance.now() + this.clockOffset;
  }

  // --- match actions --------------------------------------------------------

  queue(character: string, room = ''): void {
    this.send({ t: 'queue', character, room: room.toUpperCase() });
  }

  cancelQueue(): void {
    this.send({ t: 'cancel' });
    this.setState('connected');
  }

  ready(): void {
    this.send({ t: 'ready' });
  }

  sendSnapshot(snapshot: Omit<SnapshotMessage, 't'>): void {
    this.send({ t: 'snap', ...snapshot });
  }

  sendHit(hit: Omit<HitMessage, 't'>): void {
    this.send({ t: 'hit', ...hit });
  }

  sendRound(kind: 'ko' | 'end', loser: number): void {
    this.send({ t: 'round', kind, loser });
  }

  sendChat(id: number): void {
    this.send({ t: 'chat', id: clamp(Math.round(id), 0, 15) });
  }

  dispose(): void {
    this.intentionalClose = true;
    this.socket?.close();
    this.socket = null;
    this.events.clear();
  }
}

/** Derives the socket URL from the page, honouring an explicit env override. */
function defaultUrl(): string {
  const configured = import.meta.env?.VITE_NET_URL;
  if (configured) return configured;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // In development the Vite dev server is on 5173 and the game server on 8787;
  // in production both sit behind the same origin.
  const host = import.meta.env?.DEV ? `${location.hostname}:8787` : location.host;
  return `${protocol}//${host}/ws`;
}

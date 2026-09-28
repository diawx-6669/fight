/**
 * The wire protocol.
 *
 * ## Why this shape
 *
 * The obvious architecture for an online fighting game is deterministic
 * lockstep with rollback: both machines run the same simulation from the same
 * inputs, and a desync is impossible by construction. That is the right answer
 * when inputs are button presses.
 *
 * It is the wrong answer here. This game's input is a *pose*: 33 landmarks of
 * floating-point data per frame, arriving at a rate that depends on how fast
 * the player's laptop can run a neural network. Two machines will never produce
 * bit-identical pose streams, so a lockstep simulation would desync on the
 * first punch, every time.
 *
 * So the model is **split authority**: each client simulates its own fighter
 * and is the authority on that fighter's position, pose and health. Hits are
 * reported by the attacker and *applied by the defender* — A tells B "I hit
 * you with a cross for 62", B applies it to itself and its next snapshot
 * carries the new health, which A then displays.
 *
 * The consequence is that a determined cheater can lie about their own health.
 * For a game two friends play in front of their webcams, that is an acceptable
 * trade for a netcode that works at all; a ranked mode would move the
 * simulation server-side.
 *
 * ## Rate
 *
 * Snapshots go out at 20 Hz and are interpolated on the far side. Discrete
 * events (a hit, a jump) are sent immediately and never dropped, because a
 * missed hit event is a missed hit.
 */

export const PROTOCOL_VERSION = 3;

/** Snapshots per second. */
export const SNAPSHOT_HZ = 20;

/** Rig joints sent per snapshot, in the order `RIG_JOINTS` declares them. */
export const POSE_JOINT_COUNT = 16;

// --- client → server --------------------------------------------------------

export interface HelloMessage {
  t: 'hello';
  version: number;
  name: string;
}

export interface QueueMessage {
  t: 'queue';
  character: string;
  /** Empty for public matchmaking, or a room code for playing with a friend. */
  room: string;
}

export interface CancelMessage {
  t: 'cancel';
}

export interface ReadyMessage {
  t: 'ready';
}

/** Periodic state of the sender's own fighter. */
export interface SnapshotMessage {
  t: 'snap';
  /** Sender's simulation tick. */
  f: number;
  /** Position and velocity. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** `1` or `-1`. */
  fc: number;
  /** Fighter state name. */
  st: string;
  /** Current move id, or empty. */
  mv: string;
  /** Frame within the move. */
  mf: number;
  /** Resources. */
  hp: number;
  sp: number;
  mt: number;
  /** Held posture flags, packed into a bitfield. */
  fl: number;
  /** Guard height, quantised to a byte. */
  gh: number;
  /**
   * Rig pose: 32 numbers, x/y per joint, quantised to two decimals.
   * Roughly 190 bytes of JSON, which at 20 Hz is under 4 KB/s.
   */
  p: number[];
}

/** Flags packed into `SnapshotMessage.fl`. */
export const SnapFlags = {
  Guarding: 1 << 0,
  Crouching: 1 << 1,
  Airborne: 1 << 2,
} as const;

/** A hit the sender believes they landed. Applied by the receiver. */
export interface HitMessage {
  t: 'hit';
  /** Move id. */
  mv: string;
  /** Final damage the attacker calculated. */
  dmg: number;
  /** Contact point, for the receiver's effects. */
  x: number;
  y: number;
  /** `head` | `torso` | `limb`. */
  zn: string;
  /** Severity for effects, `[0, 1]`. */
  sv: number;
  /** Whether the receiver's guard stopped it, per the attacker's view. */
  blk: boolean;
  /** Combo count on the attacker's side. */
  cmb: number;
}

/** Round bookkeeping, sent by whichever client detects it first. */
export interface RoundMessage {
  t: 'round';
  /** `ko` when a fighter is down, `end` when the match is over. */
  kind: 'ko' | 'end';
  /** Slot that lost the round, or `-1`. */
  loser: number;
}

export interface PingMessage {
  t: 'ping';
  /** Sender's clock in milliseconds. */
  c: number;
}

export interface ChatMessage {
  t: 'chat';
  /** One of a fixed set of taunts; free text is not carried. */
  id: number;
}

export interface LeaveMessage {
  t: 'leave';
}

export type ClientMessage =
  | HelloMessage
  | QueueMessage
  | CancelMessage
  | ReadyMessage
  | SnapshotMessage
  | HitMessage
  | RoundMessage
  | PingMessage
  | ChatMessage
  | LeaveMessage;

// --- server → client --------------------------------------------------------

export interface WelcomeMessage {
  t: 'welcome';
  version: number;
  id: string;
  /** Number of players currently online, for the lobby. */
  online: number;
}

export interface QueuedMessage {
  t: 'queued';
  /** Place in the queue, 1-based. */
  position: number;
  /** Room code to share, when one was requested. */
  room: string;
}

export interface MatchedMessage {
  t: 'matched';
  matchId: string;
  /** Shared RNG seed, so both sides generate identical arenas. */
  seed: string;
  /** Which fighter slot this client controls. */
  slot: 0 | 1;
  arena: string;
  opponent: {
    name: string;
    character: string;
  };
}

/** Both sides are loaded; start the countdown. */
export interface StartMessage {
  t: 'start';
  /** Server time the match begins, for a rough shared clock. */
  at: number;
}

export interface RelayMessage {
  t: 'relay';
  /** The opponent's message, forwarded verbatim. */
  m: ClientMessage;
}

export interface PongMessage {
  t: 'pong';
  /** Echo of the client's clock. */
  c: number;
  /** Server clock at reply time. */
  s: number;
}

export interface OpponentLeftMessage {
  t: 'left';
  reason: 'quit' | 'timeout' | 'error';
}

export interface ErrorMessage {
  t: 'error';
  code: string;
  message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | QueuedMessage
  | MatchedMessage
  | StartMessage
  | RelayMessage
  | PongMessage
  | OpponentLeftMessage
  | ErrorMessage;

// --- encoding ---------------------------------------------------------------

/**
 * Quantises a float to two decimal places.
 *
 * Positions are in metres, so two decimals is a centimetre — far finer than
 * anything visible, and it cuts the JSON size of a pose roughly in half
 * compared with full float precision.
 */
export function quantize(value: number): number {
  return Math.round(value * 100) / 100;
}

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

/**
 * Parses a message, returning `null` rather than throwing.
 *
 * Everything arriving over this socket is data from another machine, and a
 * malformed frame must never take down a match in progress.
 */
export function decode(raw: string): ClientMessage | ServerMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof (parsed as { t?: unknown }).t !== 'string') return null;
    return parsed as ClientMessage | ServerMessage;
  } catch {
    return null;
  }
}

/** Generates a short, unambiguous room code. */
export function generateRoomCode(random: () => number = Math.random): string {
  // No 0/O or 1/I: these get read aloud over voice chat.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += alphabet[Math.floor(random() * alphabet.length)];
  }
  return code;
}

export function isValidRoomCode(code: string): boolean {
  return /^[A-HJ-NP-Z2-9]{5}$/.test(code.toUpperCase());
}

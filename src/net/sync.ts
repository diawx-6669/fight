import { clamp, damp, lerp } from '@/core/math';
import type { Fighter, FighterState } from '@/game/fighter';
import { MOVES } from '@/game/moves';
import { RIG_JOINTS } from '@/game/rig';
import type { Technique } from '@/vision/motion/types';
import { POSE_JOINT_COUNT, quantize, SnapFlags, type SnapshotMessage } from './protocol';

/**
 * Turning snapshots into motion.
 *
 * Snapshots arrive 20 times a second over a link with 30–150ms of latency and
 * real jitter. Applied directly, the opponent would teleport between poses
 * twenty times a second, which looks worse than no netcode at all.
 *
 * The fix is the standard one: **render the opponent slightly in the past**.
 * Snapshots go into a small buffer, and the renderer reads the buffer at
 * `now - interpolationDelay`, interpolating between the two snapshots that
 * straddle that moment. The cost is that the opponent is displayed about
 * 100ms behind reality; the benefit is that they move smoothly.
 *
 * 100ms sounds fatal for a fighting game and would be, in a game where both
 * simulations must agree. Here they do not: each side owns its own fighter,
 * and hits are reported rather than recomputed. The opponent being 100ms stale
 * changes *when you see* their punch, not whether it lands.
 */

/** How far behind live to render, in seconds. Two snapshots' worth. */
const BASE_DELAY = 0.1;

/** Snapshots retained. At 20 Hz this is a second of history. */
const BUFFER_SIZE = 20;

interface TimedSnapshot {
  snapshot: SnapshotMessage;
  /** Local receive time in seconds. */
  receivedAt: number;
}

export class RemoteFighterSync {
  private readonly buffer: TimedSnapshot[] = [];
  private clock = 0;

  /** Extra delay added when the link is jittery. */
  private adaptiveDelay = BASE_DELAY;

  /** Seconds since the last snapshot, for the "connection lost" indicator. */
  private sinceLastSnapshot = 0;

  /** Smoothed inter-arrival gap, used to detect a struggling link. */
  private arrivalGap = 1 / 20;

  get isStale(): boolean {
    return this.sinceLastSnapshot > 1.2;
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }

  get delay(): number {
    return this.adaptiveDelay;
  }

  push(snapshot: SnapshotMessage): void {
    const gap = this.sinceLastSnapshot;
    this.sinceLastSnapshot = 0;

    if (gap > 0 && gap < 1) {
      this.arrivalGap += (gap - this.arrivalGap) * 0.15;
      // A link delivering snapshots erratically needs a deeper buffer. Cap it,
      // because past ~250ms the opponent stops feeling present at all.
      const wanted = clamp(this.arrivalGap * 2.2, BASE_DELAY, 0.25);
      this.adaptiveDelay += (wanted - this.adaptiveDelay) * 0.1;
    }

    // Out-of-order delivery happens; insert rather than assume append.
    const entry: TimedSnapshot = { snapshot, receivedAt: this.clock };
    let index = this.buffer.length;
    while (index > 0 && this.buffer[index - 1].snapshot.f > snapshot.f) index--;
    this.buffer.splice(index, 0, entry);

    while (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
  }

  /**
   * Advances the interpolation clock and writes the result into `fighter`.
   * Returns `false` when there is nothing to show yet.
   */
  update(fighter: Fighter, dt: number): boolean {
    this.clock += dt;
    this.sinceLastSnapshot += dt;

    if (this.buffer.length === 0) return false;

    const target = this.clock - this.adaptiveDelay;

    // Find the pair of snapshots straddling the target time.
    let older: TimedSnapshot | null = null;
    let newer: TimedSnapshot | null = null;
    for (let i = 0; i < this.buffer.length; i++) {
      const entry = this.buffer[i];
      if (entry.receivedAt <= target) older = entry;
      else {
        newer = entry;
        break;
      }
    }

    if (!older) {
      // The buffer has not filled to the delay yet: show the oldest thing we
      // have rather than nothing.
      older = this.buffer[0];
    }

    if (!newer) {
      // Nothing newer than the target — the link has stalled. Hold the last
      // known pose rather than extrapolating into nonsense.
      applySnapshot(fighter, older.snapshot, older.snapshot, 0, dt);
      return true;
    }

    const span = newer.receivedAt - older.receivedAt;
    const t = span > 1e-4 ? clamp((target - older.receivedAt) / span, 0, 1) : 0;
    applySnapshot(fighter, older.snapshot, newer.snapshot, t, dt);

    // Drop snapshots that are now behind the interpolation window.
    while (this.buffer.length > 2 && this.buffer[1].receivedAt < target) this.buffer.shift();

    return true;
  }

  reset(): void {
    this.buffer.length = 0;
    this.sinceLastSnapshot = 0;
    this.adaptiveDelay = BASE_DELAY;
  }
}

/** Writes an interpolated snapshot pair onto a fighter. */
function applySnapshot(
  fighter: Fighter,
  from: SnapshotMessage,
  to: SnapshotMessage,
  t: number,
  dt: number,
): void {
  fighter.x = lerp(from.x, to.x, t);
  fighter.y = lerp(from.y, to.y, t);
  fighter.vx = lerp(from.vx, to.vx, t);
  fighter.vy = lerp(from.vy, to.vy, t);
  // Facing is a discrete flip, not something to interpolate through zero.
  fighter.facing = to.fc >= 0 ? 1 : -1;
  fighter.rig.facing = fighter.facing;

  // Resources take the newer value outright: a health bar that eases between
  // two values hides exactly the moment the player wants to see.
  fighter.health = to.hp;
  fighter.stamina = to.sp;
  fighter.meter = to.mt;

  fighter.state = to.st as FighterState;
  fighter.moveFrame = to.mf;
  fighter.move = to.mv ? (MOVES[to.mv as Technique] ?? null) : null;

  fighter.guarding = (to.fl & SnapFlags.Guarding) !== 0;
  fighter.crouching = (to.fl & SnapFlags.Crouching) !== 0;
  fighter.guardHeight = to.gh / 255;

  // The rig is interpolated joint by joint, then nudged rather than snapped —
  // a remote fighter that eases into each pose reads as alive, and hides the
  // seam between snapshots.
  const joints = fighter.rig.joints;
  const count = Math.min(POSE_JOINT_COUNT, RIG_JOINTS.length);
  for (let i = 0; i < count; i++) {
    const name = RIG_JOINTS[i];
    const fx = from.p[i * 2] ?? 0;
    const fy = from.p[i * 2 + 1] ?? 0;
    const tx = to.p[i * 2] ?? fx;
    const ty = to.p[i * 2 + 1] ?? fy;
    const targetX = lerp(fx, tx, t);
    const targetY = lerp(fy, ty, t);
    const joint = joints[name];
    joint.set(damp(joint.x, targetX, 0.025, dt), damp(joint.y, targetY, 0.025, dt));
  }

  fighter.boxes.syncHurtboxes(fighter.rig);
}

/** Packs a local fighter into a snapshot payload. */
export function buildSnapshot(fighter: Fighter, frame: number): Omit<SnapshotMessage, 't'> {
  const pose: number[] = [];
  const count = Math.min(POSE_JOINT_COUNT, RIG_JOINTS.length);
  for (let i = 0; i < count; i++) {
    const joint = fighter.rig.joints[RIG_JOINTS[i]];
    pose.push(quantize(joint.x), quantize(joint.y));
  }

  let flags = 0;
  if (fighter.guarding) flags |= SnapFlags.Guarding;
  if (fighter.crouching) flags |= SnapFlags.Crouching;
  if (fighter.isAirborne) flags |= SnapFlags.Airborne;

  return {
    f: frame,
    x: quantize(fighter.x),
    y: quantize(fighter.y),
    vx: quantize(fighter.vx),
    vy: quantize(fighter.vy),
    fc: fighter.facing,
    st: fighter.state,
    mv: fighter.move?.id ?? '',
    mf: fighter.moveFrame,
    hp: Math.round(fighter.health),
    sp: Math.round(fighter.stamina),
    mt: Math.round(fighter.meter),
    fl: flags,
    gh: Math.round(clamp(fighter.guardHeight, 0, 1) * 255),
    p: pose,
  };
}

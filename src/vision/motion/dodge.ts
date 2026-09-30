import { clamp, remapClamped } from '@/core/math';
import { NumericRing } from '@/core/pool';
import {
  action,
  type ActionEvent,
  type MotionContext,
  type MotionDetector,
  type MotionState,
} from './types';

/**
 * Dodge detection.
 *
 * `MotionState.lean` already carries *how far* the player is slipped, which is
 * what the renderer and the hitbox offsets use. This detector answers a
 * different question: did the player just **commit** to a slip?
 *
 * The distinction matters for the i-frame window. A fighter leaning gradually
 * out of the way should not be invulnerable — that would let a player simply
 * stand tilted forever. A sharp, fast slip earns a brief window where strikes
 * whiff, and that window is the whole reward loop of defensive play.
 *
 * So the trigger is on *lean velocity* crossing a threshold, not on lean
 * magnitude, with a direction change required before it can fire again.
 */

/** Body-units per second of shoulder displacement that counts as committed. */
const SLIP_SPEED = 2.2;

/** How far the slip must ultimately reach, so a fast twitch does not count. */
const MIN_LEAN = 0.3;

const COOLDOWN = 0.42;

export class DodgeDetector implements MotionDetector {
  readonly name = 'dodge';

  private previousLean = 0;
  private leanVelocity = 0;
  private readonly velocityWindow = new NumericRing(5);

  private cooldown = 0;
  /** Direction of the last dodge; the next must differ or the lean must settle. */
  private lastDirection: -1 | 0 | 1 = 0;
  private settled = true;
  private hasPrevious = false;
  /** Пик скорости качка, не дотянувшего до порога, — одна запись на попытку. */
  private subPeak = 0;
  private subDirection: -1 | 1 = 1;

  update(context: MotionContext, state: MotionState): ActionEvent | null {
    const { dt, sensitivity, skeleton, calibration } = context;

    this.cooldown = Math.max(0, this.cooldown - dt);

    if (!skeleton.present) {
      this.reset();
      return null;
    }

    const lean = state.lean;

    if (!this.hasPrevious) {
      this.previousLean = lean;
      this.hasPrevious = true;
      return null;
    }

    this.leanVelocity = dt > 0 ? (lean - this.previousLean) / dt : 0;
    this.previousLean = lean;
    this.velocityWindow.push(this.leanVelocity);

    // Returning near centre re-arms the detector, so a player can slip left,
    // come back, and slip left again.
    if (Math.abs(lean) < MIN_LEAN * 0.5) {
      this.settled = true;
      this.lastDirection = 0;
    }

    if (this.cooldown > 0 || !this.settled) return null;

    const threshold = SLIP_SPEED / sensitivity;
    const speed = Math.abs(this.leanVelocity);
    const direction: -1 | 1 = this.leanVelocity > 0 ? 1 : -1;
    if (speed < threshold) {
      // Одна запись на попытку, в её конце: раньше каждый кадр качка писал
      // свою ошибку, и одно движение корпусом считалось за пять.
      if (speed > threshold * 0.4 && (this.subPeak === 0 || direction === this.subDirection)) {
        if (speed > this.subPeak) {
          this.subPeak = speed;
          this.subDirection = direction;
        }
      } else if (this.subPeak > 0) {
        const side = this.subDirection > 0 ? 'right' : 'left';
        context.mistakes.note(
          'dodgeTooSmall', side, this.subPeak / threshold, context.now,
          action({
            kind: 'dodge',
            side,
            power: 0.6,
            angle: this.subDirection > 0 ? 0 : Math.PI,
            confidence: clamp(skeleton.confidence, 0.2, 1),
            timestamp: context.now,
          }),
        );
        this.subPeak = 0;
      }
      return null;
    }
    this.subPeak = 0;

    // A slip that reverses immediately is a wobble, not a dodge.
    if (direction === this.lastDirection) return null;

    // The lean must be heading somewhere meaningful, not just moving fast
    // through the centre on the way back from the other side.
    const projected = lean + this.leanVelocity * 0.12;
    if (Math.abs(projected) < MIN_LEAN) {
      context.mistakes.note('dodgeTooSmall', 'none', Math.abs(projected) / MIN_LEAN, context.now);
      return null;
    }

    this.cooldown = COOLDOWN;
    this.lastDirection = direction;
    this.settled = false;

    return action({
      kind: 'dodge',
      side: direction > 0 ? 'right' : 'left',
      power: remapClamped(speed, threshold, threshold * 2.4, 0.5, 1),
      angle: direction > 0 ? 0 : Math.PI,
      confidence: clamp(skeleton.confidence * (1 - calibration.noiseFloor * 2), 0.2, 1),
      timestamp: context.now,
    });
  }

  reset(): void {
    this.previousLean = 0;
    this.leanVelocity = 0;
    this.velocityWindow.clear();
    this.cooldown = 0;
    this.lastDirection = 0;
    this.settled = true;
    this.hasPrevious = false;
    this.subPeak = 0;
  }
}

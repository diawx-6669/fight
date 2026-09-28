import { clamp, remapClamped } from '@/core/math';
import { Ema, Hysteresis } from '../filters';
import { Joint } from '../skeleton';
import {
  action,
  type ActionEvent,
  type MotionContext,
  type MotionDetector,
  type MotionState,
} from './types';

/**
 * Guard and parry.
 *
 * Blocking is the one input that must never, ever misfire in either direction.
 * A guard that drops for two frames while the player is holding it perfectly
 * still costs them the round; a guard that latches on while they are trying to
 * punch makes the game unplayable.
 *
 * So the signal is built from three independent pieces of evidence, each of
 * which is weak alone:
 *   - wrists are raised towards the head,
 *   - wrists are drawn in towards the centre line,
 *   - elbows are tucked rather than flared.
 *
 * Their weighted sum goes through a hysteresis gate with a generous dwell.
 * The result is a guard that survives tracking noise and does not flicker.
 *
 * A parry is a *deliberate outward sweep from inside a guard* — a distinct,
 * fast motion that cannot happen by accident while simply holding the hands up.
 */

const PARRY_SPEED = 2.4;
const PARRY_COOLDOWN = 0.5;

export class GuardDetector implements MotionDetector {
  readonly name = 'guard';

  private readonly guardSignal = new Ema(0.05);
  private readonly heightSignal = new Ema(0.08);
  // 0.09s dwell: long enough to reject a hand passing through guard position
  // on its way somewhere, short enough that a deliberate block feels instant.
  private readonly guardGate = new Hysteresis(0.55, 0.34, 0.09);

  private previousWristX = { left: 0, right: 0 };
  private parryCooldown = 0;
  private hasPrevious = false;

  update(context: MotionContext, state: MotionState): ActionEvent | null {
    const { skeleton, dt, sensitivity, calibration } = context;

    this.parryCooldown = Math.max(0, this.parryCooldown - dt);

    if (!skeleton.present) {
      state.guarding = false;
      state.guardHeight = 0;
      this.hasPrevious = false;
      return null;
    }

    const leftWrist = skeleton.at(Joint.LeftWrist);
    const rightWrist = skeleton.at(Joint.RightWrist);
    const leftElbow = skeleton.at(Joint.LeftElbow);
    const rightElbow = skeleton.at(Joint.RightElbow);
    const nose = skeleton.at(Joint.Nose);
    const leftShoulder = skeleton.at(Joint.LeftShoulder);
    const rightShoulder = skeleton.at(Joint.RightShoulder);

    const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
    const headY = Math.max(nose.y, shoulderY + 0.4);

    // --- evidence 1: height -------------------------------------------------
    // Wrists between the shoulders and the head score highest.
    const wristY = (leftWrist.y + rightWrist.y) / 2;
    const heightScore = remapClamped(wristY, shoulderY - 0.35, headY, 0, 1);

    // --- evidence 2: how tucked in the hands are ---------------------------
    // A guard draws the hands towards the centre line; a punch sends them away.
    const spread = (Math.abs(leftWrist.x) + Math.abs(rightWrist.x)) / 2;
    const tuckScore = remapClamped(spread, 1.05, 0.35, 0, 1);

    // --- evidence 3: elbow position ----------------------------------------
    // Elbows down and in, not chicken-winged out to the sides.
    const elbowSpread = (Math.abs(leftElbow.x) + Math.abs(rightElbow.x)) / 2;
    const elbowScore = remapClamped(elbowSpread, 0.95, 0.45, 0, 1);

    // Height is the dominant cue; the other two mostly reject false positives.
    const raw = heightScore * 0.5 + tuckScore * 0.32 + elbowScore * 0.18;

    // Visibility gate: a guard inferred from wrists the model cannot see is a
    // guess, and guessing here loses rounds.
    const visibility = Math.min(leftWrist.visibility, rightWrist.visibility);
    const gated = visibility < 0.45 ? raw * 0.35 : raw;

    const smoothed = this.guardSignal.push(gated, dt);
    const guarding = this.guardGate.update(smoothed * sensitivity, dt);

    state.guarding = guarding;
    state.guardHeight = this.heightSignal.push(heightScore, dt);

    // --- parry --------------------------------------------------------------

    let event: ActionEvent | null = null;

    if (this.hasPrevious && guarding && this.parryCooldown === 0 && dt > 0) {
      const leftSpeed = (leftWrist.x - this.previousWristX.left) / dt;
      const rightSpeed = (rightWrist.x - this.previousWristX.right) / dt;

      // Outward means away from the centre line: the left hand sweeping further
      // left, the right hand further right.
      const leftOutward = -leftSpeed;
      const rightOutward = rightSpeed;
      const threshold = PARRY_SPEED / sensitivity;

      if (leftOutward > threshold || rightOutward > threshold) {
        const side = leftOutward > rightOutward ? 'left' : 'right';
        const speed = Math.max(leftOutward, rightOutward);
        this.parryCooldown = PARRY_COOLDOWN;
        event = action({
          kind: 'parry',
          side,
          power: remapClamped(speed, threshold, threshold * 2.6, 0.5, 1),
          confidence: clamp(visibility * (1 - calibration.noiseFloor * 2), 0.2, 1),
          timestamp: context.now,
        });
      }
    }

    this.previousWristX.left = leftWrist.x;
    this.previousWristX.right = rightWrist.x;
    this.hasPrevious = true;

    return event;
  }

  reset(): void {
    this.guardSignal.reset();
    this.heightSignal.reset();
    this.guardGate.reset(false);
    this.parryCooldown = 0;
    this.hasPrevious = false;
  }
}

import { clamp, distance, remapClamped } from '@/core/math';
import { NumericRing } from '@/core/pool';
import { Joint } from '../skeleton';
import {
  action,
  type ActionEvent,
  type MotionContext,
  type MotionDetector,
  type MotionState,
  type StrikeHeight,
  type Technique,
} from './types';

/**
 * Punch detection.
 *
 * The naive approach — "fire when the wrist moves fast" — produces a game that
 * punches every time you scratch your nose. What actually distinguishes a
 * punch is a *ballistic extension*: the wrist accelerates away from the
 * shoulder, the elbow straightens, and then it all stops. Three phases.
 *
 * So each arm runs a tiny state machine:
 *
 *   idle ──(radial speed crosses threshold)──▶ extending
 *   extending ──(speed peaks and starts to fall)──▶ fire, then recovering
 *   recovering ──(arm folds back, or timeout)──▶ idle
 *
 * Firing on the *peak* rather than on full extension matters: it puts the hit
 * at the moment the player perceives impact, around 60ms earlier than lockout,
 * and that 60ms is the difference between "instant" and "laggy".
 */

type Phase = 'idle' | 'extending' | 'recovering';

interface ArmTracker {
  readonly side: 'left' | 'right';
  phase: Phase;
  /** Distance from shoulder to wrist, body units. */
  reach: number;
  previousReach: number;
  /** Rate of change of `reach`, body units per second. */
  radialSpeed: number;
  peakSpeed: number;
  /** Where the wrist was when the extension began, for measuring the arc. */
  startX: number;
  startY: number;
  startExtension: number;
  phaseElapsed: number;
  cooldown: number;
  /** Short history of radial speed, to confirm a peak rather than a blip. */
  speedHistory: NumericRing;
}

function createArm(side: 'left' | 'right'): ArmTracker {
  return {
    side,
    phase: 'idle',
    reach: 0,
    previousReach: 0,
    radialSpeed: 0,
    peakSpeed: 0,
    startX: 0,
    startY: 0,
    startExtension: 0,
    phaseElapsed: 0,
    cooldown: 0,
    speedHistory: new NumericRing(6),
  };
}

/** Radial speed, in body-units per second, that starts an extension. */
const LAUNCH_SPEED = 2.6;

/** Below this the extension is treated as finished. */
const SETTLE_SPEED = 0.7;

/** A strike that has not resolved in this long was not a punch. */
const MAX_EXTENSION_TIME = 0.42;

/** Minimum gap between punches from the same arm, seconds. */
const ARM_COOLDOWN = 0.22;

/** How far the wrist must actually travel, as a fraction of calibrated reach. */
const MIN_TRAVEL_RATIO = 0.3;

export class PunchDetector implements MotionDetector {
  readonly name = 'punch';

  private readonly arms: ArmTracker[] = [createArm('left'), createArm('right')];

  /** Populated so the renderer can draw a trail on the arm that is mid-punch. */
  readonly activeArms = { left: 0, right: 0 };

  update(context: MotionContext, state: MotionState): ActionEvent | null {
    const { skeleton, dt } = context;
    if (!skeleton.present) {
      this.reset();
      return null;
    }

    let fired: ActionEvent | null = null;
    for (const arm of this.arms) {
      const event = this.updateArm(arm, context, state);
      // At most one action leaves the detector per frame. If both arms peak on
      // the same frame the stronger one wins and the other is dropped rather
      // than queued — a simultaneous double punch is not a move in this game.
      if (event && (!fired || event.power > fired.power)) fired = event;
    }
    return fired;
  }

  private updateArm(
    arm: ArmTracker,
    context: MotionContext,
    state: MotionState,
  ): ActionEvent | null {
    const { skeleton, calibration, dt, sensitivity } = context;

    const shoulderId = arm.side === 'left' ? Joint.LeftShoulder : Joint.RightShoulder;
    const wristId = arm.side === 'left' ? Joint.LeftWrist : Joint.RightWrist;
    const elbowId = arm.side === 'left' ? Joint.LeftElbow : Joint.RightElbow;

    const shoulder = skeleton.at(shoulderId);
    const wrist = skeleton.at(wristId);
    const elbow = skeleton.at(elbowId);

    arm.cooldown = Math.max(0, arm.cooldown - dt);

    // An arm the model cannot see reliably must not throw punches — an
    // occluded wrist snapping back into view reads as an enormous velocity.
    const visibility = Math.min(shoulder.visibility, wrist.visibility, elbow.visibility);
    if (visibility < 0.5) {
      arm.phase = 'idle';
      arm.speedHistory.clear();
      this.activeArms[arm.side] = 0;
      return null;
    }

    arm.previousReach = arm.reach;
    arm.reach = distance(shoulder.x, shoulder.y, wrist.x, wrist.y);
    arm.radialSpeed = dt > 0 ? (arm.reach - arm.previousReach) / dt : 0;
    arm.speedHistory.push(arm.radialSpeed);

    const extension = skeleton.armExtension(arm.side);
    // Thresholds scale with sensitivity and with how far the player is standing:
    // a distant player produces smaller body-space velocities.
    const launchThreshold = (LAUNCH_SPEED / sensitivity) * (1 + calibration.noiseFloor * 3);

    switch (arm.phase) {
      case 'idle': {
        if (arm.cooldown > 0) break;
        // Guarding is a held pose, not a punch; a player adjusting their guard
        // must not be charged for it.
        if (state.guarding && arm.radialSpeed < launchThreshold * 1.4) break;

        if (arm.radialSpeed > launchThreshold) {
          arm.phase = 'extending';
          arm.phaseElapsed = 0;
          arm.peakSpeed = arm.radialSpeed;
          arm.startX = wrist.x;
          arm.startY = wrist.y;
          arm.startExtension = extension;
        }
        break;
      }

      case 'extending': {
        arm.phaseElapsed += dt;
        arm.peakSpeed = Math.max(arm.peakSpeed, arm.radialSpeed);
        this.activeArms[arm.side] = clamp(arm.radialSpeed / launchThreshold, 0, 1.5);

        const decelerating = arm.radialSpeed < arm.peakSpeed * 0.55;
        const stalled = arm.radialSpeed < SETTLE_SPEED;
        const timedOut = arm.phaseElapsed > MAX_EXTENSION_TIME;

        if (!decelerating && !stalled && !timedOut) break;

        const event = this.resolve(arm, context, wrist.x, wrist.y, extension, shoulder.y);
        arm.phase = 'recovering';
        arm.phaseElapsed = 0;
        arm.cooldown = ARM_COOLDOWN / Math.max(sensitivity, 0.5);
        return event;
      }

      case 'recovering': {
        arm.phaseElapsed += dt;
        this.activeArms[arm.side] *= 0.82;
        // Back to idle once the arm folds again or enough time passes that the
        // player has clearly stopped, whichever comes first.
        if (extension < 0.55 || arm.phaseElapsed > 0.3) {
          arm.phase = 'idle';
          arm.speedHistory.clear();
          this.activeArms[arm.side] = 0;
        }
        break;
      }
    }

    return null;
  }

  private resolve(
    arm: ArmTracker,
    context: MotionContext,
    wristX: number,
    wristY: number,
    extension: number,
    shoulderY: number,
  ): ActionEvent | null {
    const { calibration, sensitivity, now } = context;

    const travelX = wristX - arm.startX;
    const travelY = wristY - arm.startY;
    const travel = Math.hypot(travelX, travelY);

    // Reject twitches: the hand must actually have gone somewhere.
    const minTravel = calibration.reachForward * MIN_TRAVEL_RATIO * (1 / sensitivity);
    if (travel < minTravel) return null;

    // Reject flails: a punch ends straighter than it started.
    const extensionGain = extension - arm.startExtension;
    if (extensionGain < 0.08 && extension < 0.62) return null;

    const power = remapClamped(
      arm.peakSpeed,
      LAUNCH_SPEED * 0.9,
      LAUNCH_SPEED * 3.4,
      0.35,
      1,
    );

    const angle = Math.atan2(travelY, travelX);
    const technique = classifyPunch(arm.side, travelX, travelY, extension, wristY, shoulderY);
    const height = punchHeight(wristY, shoulderY);

    // Confidence blends how clean the extension was with how good the tracking
    // is overall; the combat layer uses it to scale chip damage on marginal hits.
    const cleanliness = clamp(extension * 0.6 + clamp(extensionGain * 2, 0, 1) * 0.4, 0, 1);
    const confidence = clamp(cleanliness * (1 - calibration.noiseFloor * 2), 0.2, 1);

    return action({
      kind: 'punch',
      technique,
      side: arm.side,
      height,
      power,
      angle,
      confidence,
      timestamp: now,
    });
  }

  reset(): void {
    for (const arm of this.arms) {
      arm.phase = 'idle';
      arm.peakSpeed = 0;
      arm.phaseElapsed = 0;
      arm.cooldown = 0;
      arm.speedHistory.clear();
    }
    this.activeArms.left = 0;
    this.activeArms.right = 0;
  }
}

/**
 * Picks the technique from the shape of the arc.
 *
 * `travelX`/`travelY` are in body units, y-up, x pointing to the player's right.
 * The lead hand throws jabs, the rear hand throws crosses — in a mirrored
 * orthodox stance that maps onto left and right respectively.
 */
function classifyPunch(
  side: 'left' | 'right',
  travelX: number,
  travelY: number,
  extension: number,
  wristY: number,
  shoulderY: number,
): Technique {
  const horizontal = Math.abs(travelX);
  const vertical = travelY;

  // Rising hard from below the shoulder with a bent arm: uppercut.
  if (vertical > horizontal * 1.1 && vertical > 0.28 && wristY < shoulderY + 0.25) {
    return 'uppercut';
  }

  // Coming down from above: overhead.
  if (vertical < -horizontal * 1.2 && vertical < -0.3 && wristY > shoulderY) {
    return 'overhead';
  }

  // Wide lateral arc that never fully straightens: hook.
  if (horizontal > 0.32 && extension < 0.82) {
    return 'hook';
  }

  // Straight punches: the lead hand is faster and lighter.
  return side === 'left' ? 'jab' : 'cross';
}

function punchHeight(wristY: number, shoulderY: number): StrikeHeight {
  if (wristY > shoulderY + 0.18) return 'high';
  if (wristY < shoulderY - 0.55) return 'low';
  return 'mid';
}

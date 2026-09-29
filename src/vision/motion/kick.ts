import { clamp, distance, remapClamped } from '@/core/math';
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
 * Kick detection.
 *
 * Kicks share the punch detector's ballistic-extension idea but need two extra
 * safeguards, because legs are the noisiest thing MediaPipe tracks:
 *
 * 1. **A supporting leg.** A real kick has one foot planted. Requiring the
 *    other ankle to stay near the floor line kills almost every false positive
 *    from walking, shifting weight, or the model briefly swapping the legs.
 *
 * 2. **Height gate.** The kicking foot must actually leave the ground by a
 *    meaningful fraction of the player's own leg length.
 *
 * Kick height then selects the technique, which is also what the opponent's
 * block has to match: a low kick beats a high guard.
 */

type Phase = 'idle' | 'extending' | 'recovering';

interface LegTracker {
  readonly side: 'left' | 'right';
  phase: Phase;
  reach: number;
  previousReach: number;
  radialSpeed: number;
  peakSpeed: number;
  peakHeight: number;
  startX: number;
  startY: number;
  phaseElapsed: number;
  cooldown: number;
}

function createLeg(side: 'left' | 'right'): LegTracker {
  return {
    side,
    phase: 'idle',
    reach: 0,
    previousReach: 0,
    radialSpeed: 0,
    peakSpeed: 0,
    peakHeight: 0,
    startX: 0,
    startY: 0,
    phaseElapsed: 0,
    cooldown: 0,
  };
}

/** Legs are heavier and slower than arms, so the launch bar sits lower. */
const LAUNCH_SPEED = 1.9;
const SETTLE_SPEED = 0.55;
const MAX_EXTENSION_TIME = 0.55;
const LEG_COOLDOWN = 0.36;

/** The foot must rise this far above its resting height, in body units. */
const MIN_LIFT = 0.42;

export class KickDetector implements MotionDetector {
  readonly name = 'kick';

  private readonly legs: LegTracker[] = [createLeg('left'), createLeg('right')];
  readonly activeLegs = { left: 0, right: 0 };

  update(context: MotionContext, state: MotionState): ActionEvent | null {
    const { skeleton } = context;
    if (!skeleton.present) {
      this.reset();
      return null;
    }

    // No legs in frame, no kicks. Guessing from an inferred hip would produce
    // phantom kicks every time the player shifted their weight, which is far
    // worse than the technique simply being unavailable and said so in the UI.
    if (!skeleton.legsVisible) {
      // Говорим об этом только когда человек явно пытался ударить ногой —
      // иначе игрок, сидящий по пояс в кадре, получал бы эту подсказку
      // постоянно, хотя играет руками и всем доволен.
      if (Math.abs(state.lean) > 0.35 || state.crouch > 0.3) {
        context.mistakes.note('legsHidden', 'none', 0.5, context.now);
      }
      this.reset();
      return null;
    }

    // Both feet in the air means the player is jumping, not kicking.
    if (state.airborne) {
      for (const leg of this.legs) leg.phase = 'idle';
      return null;
    }

    let fired: ActionEvent | null = null;
    for (const leg of this.legs) {
      const event = this.updateLeg(leg, context);
      if (event && (!fired || event.power > fired.power)) fired = event;
    }
    return fired;
  }

  private updateLeg(leg: LegTracker, context: MotionContext): ActionEvent | null {
    const { skeleton, calibration, dt, sensitivity } = context;

    const hipId = leg.side === 'left' ? Joint.LeftHip : Joint.RightHip;
    const kneeId = leg.side === 'left' ? Joint.LeftKnee : Joint.RightKnee;
    const ankleId = leg.side === 'left' ? Joint.LeftAnkle : Joint.RightAnkle;
    const otherAnkleId = leg.side === 'left' ? Joint.RightAnkle : Joint.LeftAnkle;

    const hip = skeleton.at(hipId);
    const knee = skeleton.at(kneeId);
    const ankle = skeleton.at(ankleId);
    const otherAnkle = skeleton.at(otherAnkleId);

    leg.cooldown = Math.max(0, leg.cooldown - dt);

    const visibility = Math.min(hip.visibility, knee.visibility, ankle.visibility);
    if (visibility < 0.45) {
      leg.phase = 'idle';
      this.activeLegs[leg.side] = 0;
      return null;
    }

    leg.previousReach = leg.reach;
    leg.reach = distance(hip.x, hip.y, ankle.x, ankle.y);
    leg.radialSpeed = dt > 0 ? (leg.reach - leg.previousReach) / dt : 0;

    // Height of this ankle above the resting floor, in body units. The floor
    // sits `standingHipY` below the hips when the player stands normally.
    const restingAnkleY = -calibration.standingHipY;
    const lift = ankle.y - restingAnkleY;
    const otherLift = otherAnkle.y - restingAnkleY;

    const launchThreshold = LAUNCH_SPEED / sensitivity;

    switch (leg.phase) {
      case 'idle': {
        if (leg.cooldown > 0) break;
        // The other foot must be planted — that is what makes it a kick.
        if (otherLift > MIN_LIFT * 0.55) break;
        if (leg.radialSpeed > launchThreshold || lift > MIN_LIFT * 0.7) {
          leg.phase = 'extending';
          leg.phaseElapsed = 0;
          leg.peakSpeed = Math.max(leg.radialSpeed, 0);
          leg.peakHeight = lift;
          leg.startX = ankle.x;
          leg.startY = ankle.y;
        }
        break;
      }

      case 'extending': {
        leg.phaseElapsed += dt;
        leg.peakSpeed = Math.max(leg.peakSpeed, leg.radialSpeed);
        leg.peakHeight = Math.max(leg.peakHeight, lift);
        this.activeLegs[leg.side] = clamp(leg.radialSpeed / launchThreshold, 0, 1.5);

        const decelerating = leg.radialSpeed < leg.peakSpeed * 0.5;
        const stalled = leg.radialSpeed < SETTLE_SPEED;
        const timedOut = leg.phaseElapsed > MAX_EXTENSION_TIME;
        const planted = lift < MIN_LIFT * 0.4;

        if (!decelerating && !stalled && !timedOut && !planted) break;

        const event = this.resolve(leg, context, ankle.x, ankle.y, hip.y);
        leg.phase = 'recovering';
        leg.phaseElapsed = 0;
        leg.cooldown = LEG_COOLDOWN / Math.max(sensitivity, 0.5);
        return event;
      }

      case 'recovering': {
        leg.phaseElapsed += dt;
        this.activeLegs[leg.side] *= 0.8;
        if (lift < MIN_LIFT * 0.45 || leg.phaseElapsed > 0.4) {
          leg.phase = 'idle';
          this.activeLegs[leg.side] = 0;
        }
        break;
      }
    }

    return null;
  }

  private resolve(
    leg: LegTracker,
    context: MotionContext,
    ankleX: number,
    ankleY: number,
    hipY: number,
  ): ActionEvent | null {
    const { calibration, sensitivity, now } = context;

    // Did the foot actually leave the ground?
    const needLift = (MIN_LIFT / sensitivity) * (1 + calibration.noiseFloor * 2);
    if (leg.peakHeight < needLift) {
      context.mistakes.note('kickTooLow', leg.side, leg.peakHeight / needLift, now);
      return null;
    }

    const travelX = ankleX - leg.startX;
    const travelY = ankleY - leg.startY;
    const travel = Math.hypot(travelX, travelY);
    if (travel < 0.25) {
      context.mistakes.note('kickTooSlow', leg.side, travel / 0.25, now);
      return null;
    }

    const power = remapClamped(leg.peakSpeed, LAUNCH_SPEED * 0.8, LAUNCH_SPEED * 3, 0.45, 1);
    const angle = Math.atan2(travelY, travelX);

    const technique = classifyKick(leg.peakHeight, ankleY, hipY, travelX, travelY);
    const height = kickHeight(technique);

    const confidence = clamp(
      remapClamped(leg.peakHeight, MIN_LIFT, calibration.standingHipY * 0.7, 0.45, 1) *
        (1 - calibration.noiseFloor * 2),
      0.2,
      1,
    );

    return action({
      kind: 'kick',
      technique,
      side: leg.side,
      height,
      power,
      angle,
      confidence,
      timestamp: now,
    });
  }

  reset(): void {
    for (const leg of this.legs) {
      leg.phase = 'idle';
      leg.peakSpeed = 0;
      leg.peakHeight = 0;
      leg.phaseElapsed = 0;
      leg.cooldown = 0;
    }
    this.activeLegs.left = 0;
    this.activeLegs.right = 0;
  }
}

function classifyKick(
  peakHeight: number,
  ankleY: number,
  hipY: number,
  travelX: number,
  travelY: number,
): Technique {
  // Foot at or above hip level is a head kick.
  if (ankleY > hipY - 0.1) return 'highKick';

  // A knee comes up sharply without the ankle travelling far forward.
  if (peakHeight > 0.9 && Math.abs(travelX) < 0.3 && travelY > 0.5) return 'kneeStrike';

  // A push kick drives mostly horizontally at belly height.
  if (Math.abs(travelX) > Math.abs(travelY) * 1.5 && peakHeight > 0.7) return 'pushKick';

  if (peakHeight < 0.75) return 'lowKick';
  return 'midKick';
}

function kickHeight(technique: Technique): StrikeHeight {
  switch (technique) {
    case 'highKick':
      return 'high';
    case 'lowKick':
      return 'low';
    default:
      return 'mid';
  }
}

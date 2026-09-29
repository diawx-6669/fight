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
 * Jump, crouch, weave and footwork — the continuous half of the body input.
 *
 * These are deliberately one module rather than four, because they are all
 * measurements of the same thing: where the hips are relative to where they
 * rest. Splitting them apart meant three copies of the same floor-tracking
 * code disagreeing with each other about whether the player was airborne.
 *
 * The floor line itself drifts: players wander, chairs get kicked, the camera
 * gets bumped. So the resting hip height is continuously re-estimated from a
 * slow-moving average that only updates while the player is *not* doing
 * anything vertical — otherwise a long crouch teaches the game that crouching
 * is the new standing.
 */

export class LocomotionDetector implements MotionDetector {
  readonly name = 'locomotion';

  /** Slowly adapting estimate of the resting hip height, in body units. */
  private restingHipY = 2.1;
  private restingHipInitialised = false;

  /** Slowly adapting estimate of the player's neutral horizontal position. */
  private restingCenterX = 0.5;

  private hipVelocity = 0;
  private previousHipY = 0;

  private readonly crouchSignal = new Ema(0.06);
  private readonly leanSignal = new Ema(0.07);
  private readonly advanceSignal = new Ema(0.14);

  private readonly airGate = new Hysteresis(0.5, 0.28, 0.03);
  private readonly crouchGate = new Hysteresis(0.42, 0.26, 0.05);

  private airborneFor = 0;
  private jumpEmitted = false;
  private peakAirHeight = 0;
  private crouchWasHeld = false;

  update(context: MotionContext, state: MotionState): ActionEvent | null {
    const { skeleton, calibration, dt, sensitivity } = context;

    if (!skeleton.present) {
      state.quality = 0;
      return null;
    }

    state.quality = skeleton.confidence;

    // --- vertical ----------------------------------------------------------

    // Vertical reference, in body units.
    //
    // With legs in frame this is hip height above the floor line — both terms
    // from the same frame, so camera distance cancels out. Without legs there
    // is no floor to measure against, so shoulder height within the frame
    // stands in: it moves the same way when the player rises or drops, and
    // dividing by torso length keeps it scale-free just the same.
    const hipAboveFloor = skeleton.legsVisible
      ? (skeleton.floorY - skeleton.hipY) / skeleton.torsoLength
      : (1 - skeleton.shoulderY) / skeleton.torsoLength;

    if (!this.restingHipInitialised) {
      this.restingHipY = hipAboveFloor;
      this.restingHipInitialised = true;
      this.previousHipY = hipAboveFloor;
    }

    this.hipVelocity = dt > 0 ? (hipAboveFloor - this.previousHipY) / dt : 0;
    this.previousHipY = hipAboveFloor;

    const delta = hipAboveFloor - this.restingHipY;

    // Normalise so a tall player and a short player need the same
    // *proportional* movement. The calibrated standing height only means
    // anything when the floor was visible; otherwise a fixed reference tuned
    // for shoulder travel does the job.
    const scale = skeleton.legsVisible ? Math.max(calibration.standingHipY, 0.8) : 1.2;
    const rise = clamp(delta / (scale * 0.22), 0, 2);
    const drop = clamp(-delta / (scale * 0.3), 0, 2);

    const airborne = this.airGate.update(rise * sensitivity, dt);
    const crouchRaw = this.crouchSignal.push(drop, dt);
    const crouching = this.crouchGate.update(crouchRaw * sensitivity, dt);

    state.airborne = airborne;
    state.crouch = airborne ? 0 : clamp(crouchRaw, 0, 1);

    // Попытка, не дошедшая до порога. Гистерезисная защёлка открывается около
    // единицы, поэтому «больше половины, но не сработало» — это ровно тот
    // случай, когда человек присел или подпрыгнул, а игра промолчала.
    const riseSignal = rise * sensitivity;
    if (!airborne && riseSignal > 0.45 && this.hipVelocity > 0) {
      context.mistakes.note('jumpTooLow', 'none', riseSignal, context.now);
    }
    const crouchSignal = crouchRaw * sensitivity;
    if (!crouching && crouchSignal > 0.45) {
      context.mistakes.note('crouchTooShallow', 'none', crouchSignal, context.now);
    }

    let event: ActionEvent | null = null;

    if (airborne) {
      this.airborneFor += dt;
      this.peakAirHeight = Math.max(this.peakAirHeight, rise);
      state.airHeight = clamp(rise, 0, 1);

      // Fire the jump once, on the way *up*, so the fighter leaves the ground
      // at the same moment the player does rather than at the apex.
      if (!this.jumpEmitted && this.hipVelocity > 0) {
        this.jumpEmitted = true;
        event = action({
          kind: 'jump',
          power: remapClamped(rise, 0.5, 1.4, 0.4, 1),
          confidence: clamp(skeleton.confidence, 0.3, 1),
          timestamp: context.now,
        });
      }
    } else {
      if (this.airborneFor > 0) {
        this.airborneFor = 0;
        this.jumpEmitted = false;
        this.peakAirHeight = 0;
      }
      state.airHeight = 0;

      // Only learn a new resting height while the player is settled, and learn
      // it slowly — this is the drift correction, not a tracking loop.
      if (!crouching && Math.abs(this.hipVelocity) < 0.6) {
        this.restingHipY += (hipAboveFloor - this.restingHipY) * clamp(dt * 0.35, 0, 0.1);
      }
    }

    // Emit a discrete crouch event on the leading edge so the simulation can
    // trigger a duck animation; the held state stays in `state.crouch`.
    if (crouching && !this.crouchWasHeld && !airborne && !event) {
      event = action({
        kind: 'crouch',
        power: clamp(crouchRaw, 0.3, 1),
        confidence: clamp(skeleton.confidence, 0.3, 1),
        timestamp: context.now,
      });
    }
    this.crouchWasHeld = crouching;

    // --- lateral -----------------------------------------------------------

    // Weave: the shoulders moving sideways *relative to the hips* is a slip.
    // Measuring absolute shoulder position instead would read a sidestep as a
    // dodge, which makes the fighter duck every time the player shuffles.
    const shoulderOffset =
      (skeleton.shoulderX - skeleton.hipX) / Math.max(skeleton.torsoLength, 1e-4);
    const lean = this.leanSignal.push(clamp(shoulderOffset * 1.6 * sensitivity, -1.6, 1.6), dt);
    state.lean = clamp(lean, -1, 1);

    // --- footwork ----------------------------------------------------------

    // Stepping left/right in the room drives advance/retreat. The neutral
    // centre drifts with the player so they are not pinned to one floor tile.
    this.restingCenterX += (skeleton.hipX - this.restingCenterX) * clamp(dt * 0.12, 0, 0.05);
    const centerOffset = (skeleton.hipX - this.restingCenterX) / 0.2;
    const advance = this.advanceSignal.push(clamp(centerOffset, -1.4, 1.4), dt);
    state.advance = clamp(advance, -1, 1);

    const leftAnkle = skeleton.at(Joint.LeftAnkle);
    const rightAnkle = skeleton.at(Joint.RightAnkle);
    state.stance = clamp(Math.abs(leftAnkle.x - rightAnkle.x) / 1.2, 0, 1.5);

    return event;
  }

  /** Emitted separately so the dodge detector can consume the same lean signal. */
  get currentLean(): number {
    return this.leanSignal.current;
  }

  reset(): void {
    this.restingHipInitialised = false;
    this.hipVelocity = 0;
    this.airborneFor = 0;
    this.jumpEmitted = false;
    this.peakAirHeight = 0;
    this.crouchWasHeld = false;
    this.crouchSignal.reset();
    this.leanSignal.reset();
    this.advanceSignal.reset();
    this.airGate.reset(false);
    this.crouchGate.reset(false);
  }
}

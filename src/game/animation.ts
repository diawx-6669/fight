import { clamp, lerp, smootherstep, smoothstep, TAU } from '@/core/math';
import { Rng } from '@/core/rng';
import type { Technique } from '@/vision/motion/types';
import { GROUND_Y } from './constants';
import type { Fighter } from './fighter';
import { moveDuration } from './moves';
import { FighterRig } from './rig';

/**
 * Procedural animation for fighters with no camera behind them.
 *
 * The AI and remote opponents need a body, and hand-authoring keyframes for
 * ten techniques was never an option here. Instead the animator poses the same
 * rig the player drives, from the same *reach and angle* description that
 * retargeting produces — which means an AI punch and a player punch are built
 * out of identical parts and read as the same language on screen.
 *
 * Everything is driven by one of three curves:
 *   - **breathing**: slow sine on the chest and shoulders, always running,
 *   - **cycles**: walk and guard sway, phase-locked to velocity,
 *   - **strikes**: an asymmetric ease — fast out, slow back — keyed off the
 *     move's own frame data, so a 4-frame jab really does snap and a 14-frame
 *     high kick really does wind up.
 */

/** Where a limb should reach, in polar form: how far, at what angle. */
interface LimbTarget {
  /** `[0, 1]` fraction of full limb length. */
  extension: number;
  /** Radians from horizontal-forward; positive is up. */
  angle: number;
}

interface AnimationPose {
  torsoLean: number;
  crouch: number;
  weave: number;
  headTilt: number;
  armL: LimbTarget;
  armR: LimbTarget;
  legL: LimbTarget;
  legR: LimbTarget;
}

function pose(): AnimationPose {
  return {
    torsoLean: 0,
    crouch: 0,
    weave: 0,
    headTilt: 0,
    armL: { extension: 0.42, angle: 0.5 },
    armR: { extension: 0.36, angle: 0.62 },
    legL: { extension: 0.94, angle: -1.35 },
    legR: { extension: 0.94, angle: -1.78 },
  };
}

/**
 * The fighting stance every animation returns to. Slightly bladed, hands up,
 * weight back — the pose a person actually stands in when someone might hit
 * them.
 */
const GUARD_POSE: AnimationPose = {
  torsoLean: 0.14,
  crouch: 0.16,
  weave: 0,
  headTilt: -0.06,
  armL: { extension: 0.44, angle: 0.44 },
  armR: { extension: 0.34, angle: 0.66 },
  legL: { extension: 0.93, angle: -1.22 },
  legR: { extension: 0.93, angle: -1.92 },
};

/** Per-technique keyframes: where the striking limb goes at full extension. */
interface StrikeShape {
  limb: 'armL' | 'armR' | 'legL' | 'legR';
  /** Peak extension of the striking limb. */
  extension: number;
  /** Angle at peak. */
  angle: number;
  /** Angle it winds up to before the strike. */
  windupAngle: number;
  /** Extension during the wind-up. */
  windupExtension: number;
  /** How far the torso rotates into the strike. */
  torso: number;
  /** How much the body drops. */
  crouch: number;
  /** Lateral shift of the chest, for hooks. */
  weave: number;
}

const STRIKE_SHAPES: Record<Technique, StrikeShape | null> = {
  none: null,
  jab: {
    limb: 'armL',
    extension: 0.99,
    angle: 0.08,
    windupAngle: 0.42,
    windupExtension: 0.4,
    torso: 0.06,
    crouch: 0.02,
    weave: 0.01,
  },
  cross: {
    limb: 'armR',
    extension: 1,
    angle: 0.04,
    windupAngle: 0.6,
    windupExtension: 0.32,
    torso: 0.22,
    crouch: 0.05,
    weave: 0.03,
  },
  hook: {
    limb: 'armL',
    extension: 0.86,
    angle: 0.22,
    windupAngle: 1.1,
    windupExtension: 0.36,
    torso: 0.3,
    crouch: 0.06,
    weave: 0.07,
  },
  uppercut: {
    limb: 'armR',
    extension: 0.88,
    angle: 1.24,
    windupAngle: -0.5,
    windupExtension: 0.3,
    torso: -0.2,
    crouch: 0.42,
    weave: 0.02,
  },
  overhead: {
    limb: 'armR',
    extension: 0.96,
    angle: -0.42,
    windupAngle: 1.5,
    windupExtension: 0.52,
    torso: 0.3,
    crouch: 0.08,
    weave: 0.02,
  },
  lowKick: {
    limb: 'legR',
    extension: 0.96,
    angle: -0.95,
    windupAngle: -1.7,
    windupExtension: 0.62,
    torso: 0.18,
    crouch: 0.14,
    weave: 0.02,
  },
  midKick: {
    limb: 'legR',
    extension: 0.99,
    angle: -0.28,
    windupAngle: -1.6,
    windupExtension: 0.58,
    torso: 0.26,
    crouch: 0.1,
    weave: 0.04,
  },
  highKick: {
    limb: 'legL',
    extension: 1,
    angle: 0.36,
    windupAngle: -1.5,
    windupExtension: 0.54,
    torso: 0.34,
    crouch: 0.06,
    weave: 0.06,
  },
  pushKick: {
    limb: 'legR',
    extension: 1,
    angle: -0.38,
    windupAngle: -1.45,
    windupExtension: 0.5,
    torso: 0.2,
    crouch: 0.12,
    weave: 0.02,
  },
  kneeStrike: {
    limb: 'legR',
    extension: 0.62,
    angle: -0.1,
    windupAngle: -1.6,
    windupExtension: 0.72,
    torso: 0.24,
    crouch: 0.16,
    weave: 0.02,
  },
};

export class FighterAnimator {
  private readonly current = pose();
  private readonly target = pose();
  private readonly rng: Rng;

  private time = 0;
  private walkPhase = 0;
  /** Random per-fighter offset so two fighters never breathe in lockstep. */
  private readonly breathOffset: number;
  private readonly breathRate: number;

  /** Set when a hit lands, driving the recoil curve. */
  private recoil = 0;
  private recoilDirection = 1;

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.breathOffset = this.rng.range(0, TAU);
    this.breathRate = this.rng.range(0.55, 0.8);
  }

  /** Called when the fighter takes a hit, to kick off the flinch. */
  onHit(severity: number, fromLeft: boolean): void {
    this.recoil = clamp(severity, 0.2, 1);
    this.recoilDirection = fromLeft ? 1 : -1;
  }

  /** Advances the animation and writes the result into `rig`. */
  update(fighter: Fighter, rig: FighterRig, dt: number): void {
    this.time += dt;
    this.recoil = Math.max(0, this.recoil - dt * 3.2);

    this.buildTarget(fighter);

    // Different parts of the body settle at different rates. Limbs snap;
    // the torso follows. Doing this in one blend makes everything feel rubbery.
    const limbRate = fighter.state === 'attacking' ? 0.62 : 0.24;
    const torsoRate = 0.18;

    this.current.torsoLean = approach(this.current.torsoLean, this.target.torsoLean, torsoRate, dt);
    this.current.crouch = approach(this.current.crouch, this.target.crouch, torsoRate, dt);
    this.current.weave = approach(this.current.weave, this.target.weave, torsoRate, dt);
    this.current.headTilt = approach(this.current.headTilt, this.target.headTilt, torsoRate, dt);

    approachLimb(this.current.armL, this.target.armL, limbRate, dt);
    approachLimb(this.current.armR, this.target.armR, limbRate, dt);
    approachLimb(this.current.legL, this.target.legL, limbRate, dt);
    approachLimb(this.current.legR, this.target.legR, limbRate, dt);

    this.writeToRig(fighter, rig);
  }

  private buildTarget(fighter: Fighter): void {
    const target = this.target;
    copyPose(GUARD_POSE, target);

    // --- breathing ---------------------------------------------------------
    const breath = Math.sin(this.time * this.breathRate * TAU + this.breathOffset);
    target.torsoLean += breath * 0.018;
    target.armL.angle += breath * 0.035;
    target.armR.angle += breath * 0.03;
    target.crouch += breath * 0.012;

    // --- locomotion --------------------------------------------------------
    const speed = Math.abs(fighter.vx);
    if (speed > 0.15 && !fighter.isAirborne) {
      this.walkPhase += speed * 1.5 * (1 / 60);
      const cycle = Math.sin(this.walkPhase * TAU);
      const lift = Math.max(0, cycle);
      const lift2 = Math.max(0, -cycle);
      const intensity = clamp(speed / 3.2, 0, 1);

      target.legL.angle += (cycle * 0.3) * intensity;
      target.legL.extension -= lift * 0.16 * intensity;
      target.legR.angle -= (cycle * 0.3) * intensity;
      target.legR.extension -= lift2 * 0.16 * intensity;

      // Arms counter-swing, which is most of what sells a walk.
      target.armL.angle -= cycle * 0.12 * intensity;
      target.armR.angle += cycle * 0.12 * intensity;
      target.torsoLean += Math.sign(fighter.vx) * fighter.facing * 0.06 * intensity;
    }

    // --- airborne ----------------------------------------------------------
    if (fighter.isAirborne) {
      const rising = fighter.vy > 0;
      // Tuck on the way up, reach on the way down — the classic jump arc.
      target.legL.extension = rising ? 0.62 : 0.92;
      target.legR.extension = rising ? 0.58 : 0.9;
      target.legL.angle = rising ? -0.9 : -1.4;
      target.legR.angle = rising ? -1.1 : -1.5;
      target.armL.angle += 0.3;
      target.armR.angle += 0.24;
      target.crouch = rising ? 0.3 : 0.05;
    }

    // --- guarding ----------------------------------------------------------
    if (fighter.guarding) {
      const height = clamp(fighter.guardHeight, 0, 1);
      target.armL.extension = 0.34;
      target.armR.extension = 0.3;
      target.armL.angle = lerp(0.3, 0.95, height);
      target.armR.angle = lerp(0.42, 1.05, height);
      target.torsoLean += 0.05;
      target.crouch += 0.08;
    }

    if (fighter.crouching) {
      target.crouch = Math.max(target.crouch, 0.72);
      target.torsoLean += 0.12;
    }

    // --- states ------------------------------------------------------------
    switch (fighter.state) {
      case 'attacking':
        this.applyStrike(fighter, target);
        break;

      case 'hitstun':
      case 'blockstun': {
        const t = clamp(fighter.stateFrame / 14, 0, 1);
        const flinch = (1 - t) * this.recoil;
        target.torsoLean -= flinch * 0.5 * this.recoilDirection;
        target.headTilt -= flinch * 0.6 * this.recoilDirection;
        target.armL.extension = lerp(target.armL.extension, 0.28, flinch);
        target.armR.extension = lerp(target.armR.extension, 0.26, flinch);
        target.crouch += flinch * 0.16;
        break;
      }

      case 'guardBreak': {
        const t = clamp(fighter.stateFrame / 42, 0, 1);
        const stagger = Math.sin(t * TAU * 2) * (1 - t);
        target.torsoLean = -0.4 + stagger * 0.2;
        target.armL.angle = -0.6;
        target.armR.angle = -0.7;
        target.armL.extension = 0.7;
        target.armR.extension = 0.68;
        target.crouch = 0.1;
        break;
      }

      case 'knockdown': {
        const t = smoothstep(0, 24, fighter.stateFrame);
        // Fold towards the floor. The torso lean does most of the work; the
        // rig's own ground clamp keeps the limbs from sinking through.
        target.torsoLean = lerp(target.torsoLean, -1.25, t);
        target.crouch = lerp(target.crouch, 0.95, t);
        target.armL = { extension: 0.8, angle: -0.5 };
        target.armR = { extension: 0.76, angle: -0.7 };
        target.legL = { extension: 0.7, angle: -0.6 };
        target.legR = { extension: 0.66, angle: -0.5 };
        break;
      }

      case 'getup': {
        const t = smootherstep(0, 26, fighter.stateFrame);
        target.torsoLean = lerp(-1.1, GUARD_POSE.torsoLean, t);
        target.crouch = lerp(0.9, GUARD_POSE.crouch, t);
        break;
      }

      case 'victory': {
        const t = clamp(fighter.stateFrame / 60, 0, 1);
        const flourish = Math.sin(this.time * 1.6) * 0.1;
        target.torsoLean = lerp(GUARD_POSE.torsoLean, -0.08, t);
        target.armL = { extension: lerp(0.44, 0.72, t), angle: lerp(0.44, 1.5 + flourish, t) };
        target.armR = { extension: lerp(0.34, 0.5, t), angle: lerp(0.66, 0.9, t) };
        target.crouch = lerp(GUARD_POSE.crouch, 0.04, t);
        break;
      }

      case 'defeat': {
        const t = smoothstep(0, 40, fighter.stateFrame);
        target.torsoLean = lerp(GUARD_POSE.torsoLean, -1.3, t);
        target.crouch = lerp(GUARD_POSE.crouch, 0.98, t);
        target.armL = { extension: 0.84, angle: lerp(0.44, -0.9, t) };
        target.armR = { extension: 0.8, angle: lerp(0.66, -1, t) };
        break;
      }

      default:
        break;
    }
  }

  /** Shapes the striking limb from the move's own frame data. */
  private applyStrike(fighter: Fighter, target: AnimationPose): void {
    const move = fighter.move;
    if (!move) return;
    const shape = STRIKE_SHAPES[move.id];
    if (!shape) return;

    const total = moveDuration(move);
    const frame = fighter.moveFrame;
    const activeEnd = move.startup + move.active;

    let extension: number;
    let angle: number;
    let phase: number;

    if (frame < move.startup) {
      // Wind-up: ease *into* the loaded position, decelerating, so the strike
      // reads as gathering rather than twitching.
      phase = move.startup <= 0 ? 1 : frame / move.startup;
      const eased = smootherstep(0, 1, phase);
      extension = lerp(0.36, shape.windupExtension, eased);
      angle = lerp(GUARD_POSE[shape.limb].angle, shape.windupAngle, eased);
    } else if (frame < activeEnd) {
      // Strike: near-instant. This is the only part of the animation that is
      // allowed to be abrupt, and it is what makes contact feel violent.
      phase = move.active <= 0 ? 1 : (frame - move.startup) / move.active;
      const eased = 1 - Math.pow(1 - phase, 3);
      extension = lerp(shape.windupExtension, shape.extension, eased);
      angle = lerp(shape.windupAngle, shape.angle, eased);
    } else {
      // Recovery: slow return to guard.
      phase = (frame - activeEnd) / Math.max(1, total - activeEnd);
      const eased = smootherstep(0, 1, clamp(phase, 0, 1));
      extension = lerp(shape.extension, GUARD_POSE[shape.limb].extension, eased);
      angle = lerp(shape.angle, GUARD_POSE[shape.limb].angle, eased);
    }

    const limb = target[shape.limb];
    limb.extension = extension;
    limb.angle = angle;

    // The whole body commits, not just the limb. Torso rotation during the
    // active frames is most of why a cross looks heavier than a jab.
    const commitment =
      frame < move.startup
        ? smootherstep(0, 1, frame / Math.max(1, move.startup)) * 0.6
        : frame < activeEnd
          ? 1
          : 1 - smootherstep(0, 1, clamp(phase, 0, 1));

    target.torsoLean += shape.torso * commitment;
    target.crouch += shape.crouch * commitment;
    target.weave += shape.weave * commitment * fighter.facing;
    target.headTilt += shape.torso * commitment * 0.3;

    // The off-limb pulls back as the strike goes out — the counter-motion a
    // real body needs for balance, and a huge readability win on screen.
    if (shape.limb === 'armL') {
      target.armR.extension = lerp(target.armR.extension, 0.24, commitment);
      target.armR.angle = lerp(target.armR.angle, 0.9, commitment);
    } else if (shape.limb === 'armR') {
      target.armL.extension = lerp(target.armL.extension, 0.26, commitment);
      target.armL.angle = lerp(target.armL.angle, 0.85, commitment);
    } else if (shape.limb === 'legL') {
      target.legR.extension = 0.98;
      target.legR.angle = -1.6;
      target.armL.angle -= commitment * 0.5;
    } else {
      target.legL.extension = 0.98;
      target.legL.angle = -1.5;
      target.armR.angle -= commitment * 0.5;
    }
  }

  /** Converts the polar pose into world-space IK targets on the rig. */
  private writeToRig(fighter: Fighter, rig: FighterRig): void {
    const current = this.current;

    rig.torsoLean = current.torsoLean;
    rig.crouch = clamp(current.crouch, 0, 1);
    rig.weave = current.weave * rig.proportions.scale;
    rig.headTilt = current.headTilt;
    rig.facing = fighter.facing;

    rig.buildTorso(fighter.x, fighter.y);

    const armLength = (rig.length('upperArm') + rig.length('forearm')) * 0.99;
    const legLength = (rig.length('thigh') + rig.length('shin')) * 0.99;

    placeLimb(rig, 'armL', current.armL, armLength);
    placeLimb(rig, 'armR', current.armR, armLength);
    placeLimb(rig, 'legL', current.legL, legLength);
    placeLimb(rig, 'legR', current.legR, legLength);

    // Keep planted feet on the floor. Without this, every pose that happens to
    // aim a leg slightly downwards buries it in the ground.
    if (!fighter.isAirborne && fighter.state !== 'knockdown') {
      clampFootToGround(rig, 'L', fighter.y);
      clampFootToGround(rig, 'R', fighter.y);
    }
  }
}

function placeLimb(
  rig: FighterRig,
  limb: 'armL' | 'armR' | 'legL' | 'legR',
  target: LimbTarget,
  length: number,
): void {
  const isArm = limb === 'armL' || limb === 'armR';
  const side = limb.endsWith('L') ? 'L' : 'R';
  const root = isArm
    ? side === 'L'
      ? rig.joints.shoulderL
      : rig.joints.shoulderR
    : side === 'L'
      ? rig.joints.hipL
      : rig.joints.hipR;

  const distance = clamp(target.extension, 0.1, 1.02) * length;
  const x = root.x + Math.cos(target.angle) * distance * rig.facing;
  const y = root.y + Math.sin(target.angle) * distance;

  if (isArm) rig.placeArm(side, x, y);
  else rig.placeLeg(side, x, y);
}

function clampFootToGround(rig: FighterRig, side: 'L' | 'R', groundY: number): void {
  const foot = side === 'L' ? rig.joints.footL : rig.joints.footR;
  if (foot.y >= groundY + GROUND_Y) return;
  const hip = side === 'L' ? rig.joints.hipL : rig.joints.hipR;
  rig.placeLeg(side, foot.x, groundY);
  void hip;
}

function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * clamp(rate * dt * 60, 0, 1);
}

function approachLimb(current: LimbTarget, target: LimbTarget, rate: number, dt: number): void {
  current.extension = approach(current.extension, target.extension, rate, dt);
  current.angle = approach(current.angle, target.angle, rate, dt);
}

function copyPose(from: AnimationPose, to: AnimationPose): void {
  to.torsoLean = from.torsoLean;
  to.crouch = from.crouch;
  to.weave = from.weave;
  to.headTilt = from.headTilt;
  to.armL = { ...from.armL };
  to.armR = { ...from.armR };
  to.legL = { ...from.legL };
  to.legR = { ...from.legR };
}

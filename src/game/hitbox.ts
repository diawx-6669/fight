import { clamp } from '@/core/math';
import type { Vec2 } from '@/core/vec2';
import type { FighterRig } from './rig';

/**
 * Collision volumes.
 *
 * Boxes would be the traditional choice, but this game samples its hitboxes
 * from a rig that the *player's own limbs* are driving, and a rectangle around
 * a swinging arm is a poor fit — it is far too generous at the elbow and far
 * too mean at the knuckles. Capsules follow the limb, so a punch connects
 * where the fist is and nowhere else.
 *
 * Hurtboxes are built the same way, from the same rig, which produces a
 * property that is unusual and very satisfying in play: **ducking works because
 * you ducked**. Nobody scripted a crouch hurtbox; the head circle simply moved
 * down with the player's head.
 */

/** A line segment with a radius: the swept volume of a limb. */
export interface Capsule {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  radius: number;
}

export interface Circle {
  x: number;
  y: number;
  radius: number;
}

export function capsule(ax = 0, ay = 0, bx = 0, by = 0, radius = 0.1): Capsule {
  return { ax, ay, bx, by, radius };
}

/** Squared distance from a point to a segment — the primitive everything uses. */
function pointSegmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq < 1e-9 ? 0 : clamp((apx * abx + apy * aby) / lengthSq, 0, 1);
  const cx = ax + abx * t - px;
  const cy = ay + aby * t - py;
  return cx * cx + cy * cy;
}

/** Shortest squared distance between two segments. */
function segmentSegmentDistanceSq(
  a: Capsule,
  b: Capsule,
): number {
  // Four point-to-segment tests bound the true distance for non-intersecting
  // segments, and intersecting segments are caught by the sign test below.
  const d1 = pointSegmentDistanceSq(a.ax, a.ay, b.ax, b.ay, b.bx, b.by);
  const d2 = pointSegmentDistanceSq(a.bx, a.by, b.ax, b.ay, b.bx, b.by);
  const d3 = pointSegmentDistanceSq(b.ax, b.ay, a.ax, a.ay, a.bx, a.by);
  const d4 = pointSegmentDistanceSq(b.bx, b.by, a.ax, a.ay, a.bx, a.by);
  const best = Math.min(d1, d2, d3, d4);

  // Proper intersection means distance zero, which the endpoint tests miss.
  if (segmentsIntersect(a, b)) return 0;
  return best;
}

function segmentsIntersect(a: Capsule, b: Capsule): boolean {
  const d1x = a.bx - a.ax;
  const d1y = a.by - a.ay;
  const d2x = b.bx - b.ax;
  const d2y = b.by - b.ay;
  const denominator = d1x * d2y - d1y * d2x;
  if (Math.abs(denominator) < 1e-9) return false;
  const sx = b.ax - a.ax;
  const sy = b.ay - a.ay;
  const t = (sx * d2y - sy * d2x) / denominator;
  const u = (sx * d1y - sy * d1x) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

export function capsulesOverlap(a: Capsule, b: Capsule): boolean {
  const combined = a.radius + b.radius;
  return segmentSegmentDistanceSq(a, b) <= combined * combined;
}

export function capsuleCircleOverlap(c: Capsule, circle: Circle): boolean {
  const combined = c.radius + circle.radius;
  return (
    pointSegmentDistanceSq(circle.x, circle.y, c.ax, c.ay, c.bx, c.by) <= combined * combined
  );
}

/** Midpoint of the overlap, used to place impact sparks convincingly. */
export function capsuleContactPoint(a: Capsule, b: Capsule, out: { x: number; y: number }): void {
  // Close enough for a visual effect: the midpoint of the two segment centres,
  // biased towards the attacking capsule's tip where the fist actually is.
  const tipX = a.bx;
  const tipY = a.by;
  const otherMidX = (b.ax + b.bx) / 2;
  const otherMidY = (b.ay + b.by) / 2;
  out.x = tipX * 0.65 + otherMidX * 0.35;
  out.y = tipY * 0.65 + otherMidY * 0.35;
}

/**
 * The full set of volumes a fighter presents each frame.
 * Rebuilt in place from the rig — never allocated during a match.
 */
export class FighterBoxes {
  /** Torso, from hips to neck. The main target. */
  readonly torso: Capsule = capsule();
  /** Head. Hits here do bonus damage and a heavier hitstop. */
  readonly head: Circle = { x: 0, y: 0, radius: 0.15 };
  /** Legs, so low kicks have something to connect with. */
  readonly legL: Capsule = capsule();
  readonly legR: Capsule = capsule();
  /** Arms, which only matter as a blocking surface. */
  readonly armL: Capsule = capsule();
  readonly armR: Capsule = capsule();

  /** The active attacking volume, valid only during a move's active frames. */
  readonly strike: Capsule = capsule();
  strikeActive = false;

  /** Rebuilds every hurtbox from the current rig pose. */
  syncHurtboxes(rig: FighterRig): void {
    const scale = rig.proportions.scale;
    const j = rig.joints;

    this.torso.ax = j.hip.x;
    this.torso.ay = j.hip.y;
    this.torso.bx = j.neck.x;
    this.torso.by = j.neck.y;
    this.torso.radius = 0.19 * scale;

    this.head.x = j.head.x;
    this.head.y = j.head.y;
    this.head.radius = rig.headRadius * 0.82;

    this.legL.ax = j.hipL.x;
    this.legL.ay = j.hipL.y;
    this.legL.bx = j.footL.x;
    this.legL.by = j.footL.y;
    this.legL.radius = 0.11 * scale;

    this.legR.ax = j.hipR.x;
    this.legR.ay = j.hipR.y;
    this.legR.bx = j.footR.x;
    this.legR.by = j.footR.y;
    this.legR.radius = 0.11 * scale;

    this.armL.ax = j.shoulderL.x;
    this.armL.ay = j.shoulderL.y;
    this.armL.bx = j.handL.x;
    this.armL.by = j.handL.y;
    this.armL.radius = 0.09 * scale;

    this.armR.ax = j.shoulderR.x;
    this.armR.ay = j.shoulderR.y;
    this.armR.bx = j.handR.x;
    this.armR.by = j.handR.y;
    this.armR.radius = 0.09 * scale;
  }

  /**
   * Builds the attacking capsule from the striking limb.
   *
   * The capsule runs from the joint *before* the striking limb to the limb
   * itself — knuckles to elbow for a punch — so a fully extended arm reaches
   * further than a folded one, exactly as it should.
   */
  syncStrike(rig: FighterRig, limb: 'leftHand' | 'rightHand' | 'leftFoot' | 'rightFoot' | 'body', reach: number, height: number): void {
    const j = rig.joints;
    const scale = rig.proportions.scale;

    let rootJoint: Vec2;
    let tipJoint: Vec2;

    switch (limb) {
      case 'leftHand':
        rootJoint = j.elbowL;
        tipJoint = j.handL;
        break;
      case 'rightHand':
        rootJoint = j.elbowR;
        tipJoint = j.handR;
        break;
      case 'leftFoot':
        rootJoint = j.kneeL;
        tipJoint = j.footL;
        break;
      case 'rightFoot':
        rootJoint = j.kneeR;
        tipJoint = j.footR;
        break;
      default:
        rootJoint = j.hip;
        tipJoint = j.chest;
        break;
    }

    // Extend slightly past the fist so the hitbox covers the knuckles rather
    // than stopping at the wrist joint.
    const dx = tipJoint.x - rootJoint.x;
    const dy = tipJoint.y - rootJoint.y;
    const length = Math.hypot(dx, dy) || 1;
    const overshoot = 0.1 * scale;

    this.strike.ax = rootJoint.x;
    this.strike.ay = rootJoint.y;
    this.strike.bx = tipJoint.x + (dx / length) * overshoot;
    this.strike.by = tipJoint.y + (dy / length) * overshoot;
    // The move's declared reach acts as a floor on the capsule radius, so a
    // long-range technique stays threatening even if the player's own arm was
    // tracked short that frame.
    this.strike.radius = clamp(height * 0.5, 0.12, 0.3) * scale + reach * 0.02;
    this.strikeActive = true;
  }

  clearStrike(): void {
    this.strikeActive = false;
  }

  /** Whether an attacking capsule connects with any of these hurtboxes. */
  hitBy(strike: Capsule): 'head' | 'torso' | 'limb' | null {
    if (capsuleCircleOverlap(strike, this.head)) return 'head';
    if (capsulesOverlap(strike, this.torso)) return 'torso';
    if (
      capsulesOverlap(strike, this.legL) ||
      capsulesOverlap(strike, this.legR) ||
      capsulesOverlap(strike, this.armL) ||
      capsulesOverlap(strike, this.armR)
    ) {
      return 'limb';
    }
    return null;
  }
}

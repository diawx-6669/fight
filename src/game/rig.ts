import { clamp, damp, lerp } from '@/core/math';
import { Vec2 } from '@/core/vec2';
import { HIP_HEIGHT } from './constants';

/**
 * The fighter's skeleton in world space.
 *
 * This is where the whole concept lives or dies. The player's body drives this
 * rig directly, joint by joint, every frame — the fighter is not playing a
 * canned "punch animation" that happens to be triggered by a punch, it is
 * *wearing the player's arm*. Hitboxes are then sampled from the rig's actual
 * hand and foot positions, which means a short jab really does have less reach
 * than a fully committed cross, because the player's arm really was shorter.
 *
 * All positions are metres in world space. The rig is authored facing +x and
 * mirrored through `facing` when the fighter turns around.
 */

export const RIG_JOINTS = [
  'hip',
  'chest',
  'neck',
  'head',
  'shoulderL',
  'elbowL',
  'handL',
  'shoulderR',
  'elbowR',
  'handR',
  'hipL',
  'kneeL',
  'footL',
  'hipR',
  'kneeR',
  'footR',
] as const;

export type RigJoint = (typeof RIG_JOINTS)[number];

/** Bone lengths in metres for a 1.8 m fighter, scaled per character. */
export interface RigProportions {
  /** Hip to chest. */
  spine: number;
  /** Chest to neck. */
  neck: number;
  /** Neck to head centre. */
  head: number;
  /** Half the shoulder span. */
  shoulderWidth: number;
  upperArm: number;
  forearm: number;
  /** Half the hip span. */
  hipWidth: number;
  thigh: number;
  shin: number;
  /** Overall multiplier applied to every length above. */
  scale: number;
}

export const DEFAULT_PROPORTIONS: RigProportions = {
  spine: 0.42,
  neck: 0.14,
  head: 0.16,
  shoulderWidth: 0.2,
  upperArm: 0.32,
  forearm: 0.31,
  hipWidth: 0.12,
  thigh: 0.45,
  shin: 0.44,
  scale: 1,
};

export function scaleProportions(base: RigProportions, scale: number): RigProportions {
  return { ...base, scale };
}

/**
 * Two-bone inverse kinematics in the plane.
 *
 * Given a root, a target and two bone lengths, finds the middle joint. `bendSign`
 * picks which of the two mirror solutions to use — elbows bend backwards,
 * knees bend forwards, and getting that wrong turns a fighter into a spider.
 */
export function solveTwoBoneIk(
  rootX: number,
  rootY: number,
  targetX: number,
  targetY: number,
  boneA: number,
  boneB: number,
  bendSign: number,
  out: Vec2,
): void {
  let dx = targetX - rootX;
  let dy = targetY - rootY;
  let dist = Math.hypot(dx, dy);

  const maxReach = boneA + boneB;
  const minReach = Math.abs(boneA - boneB);

  if (dist < 1e-5) {
    // Degenerate: target sits on the root. Point the limb straight down.
    dx = 0;
    dy = -1;
    dist = 1;
  }

  // Clamp the target into the reachable annulus. Slightly under the true limit
  // so the limb never locks perfectly straight, which reads as stiff.
  const clamped = clamp(dist, minReach + 1e-4, maxReach * 0.999);
  const nx = dx / dist;
  const ny = dy / dist;

  // Law of cosines for the distance from root to the middle joint's projection.
  const cosAngle = clamp((clamped * clamped + boneA * boneA - boneB * boneB) / (2 * clamped * boneA), -1, 1);
  const along = boneA * cosAngle;
  const perpendicular = boneA * Math.sqrt(Math.max(0, 1 - cosAngle * cosAngle)) * bendSign;

  out.x = rootX + nx * along - ny * perpendicular;
  out.y = rootY + ny * along + nx * perpendicular;
}

/** A single frame of rig state, in world space. */
export class FighterRig {
  readonly joints: Record<RigJoint, Vec2> = Object.fromEntries(
    RIG_JOINTS.map((name) => [name, new Vec2()]),
  ) as Record<RigJoint, Vec2>;

  /** `+1` facing right, `-1` facing left. */
  facing = 1;

  /** Body proportions in use. */
  proportions: RigProportions = { ...DEFAULT_PROPORTIONS };

  /** Torso tilt in radians; positive leans forward in the facing direction. */
  torsoLean = 0;

  /** Where the fighter's head is pointing, for the gaze highlight. */
  headTilt = 0;

  /** `0` standing, `1` fully crouched — affects hip height and knee bend. */
  crouch = 0;

  /** Lateral weave in metres, applied to the chest but not the hips. */
  weave = 0;

  /** Hip height above the ground in metres, before crouch. */
  hipHeight = HIP_HEIGHT;

  private readonly scratch = new Vec2();

  length(name: keyof Omit<RigProportions, 'scale'>): number {
    return this.proportions[name] * this.proportions.scale;
  }

  /**
   * Rebuilds the torso chain from the fighter's root position and posture.
   * Limbs are then placed by `placeArm` / `placeLeg` from IK targets.
   */
  buildTorso(rootX: number, rootY: number): void {
    const crouchDrop = this.crouch * 0.34 * this.proportions.scale;
    const hipY = rootY + this.hipHeight * this.proportions.scale - crouchDrop;

    const hip = this.joints.hip;
    hip.set(rootX, hipY);

    // Leaning rotates the spine around the hips rather than translating it, so
    // a weave shifts the head a long way while the feet stay planted.
    const lean = this.torsoLean;
    const spine = this.length('spine') * (1 - this.crouch * 0.12);
    const sin = Math.sin(lean);
    const cos = Math.cos(lean);

    const chest = this.joints.chest;
    chest.set(hip.x + sin * spine * this.facing + this.weave, hip.y + cos * spine);

    const neckLength = this.length('neck');
    const neck = this.joints.neck;
    neck.set(chest.x + sin * neckLength * this.facing, chest.y + cos * neckLength);

    const headLength = this.length('head');
    const headAngle = lean + this.headTilt;
    const head = this.joints.head;
    head.set(
      neck.x + Math.sin(headAngle) * headLength * this.facing,
      neck.y + Math.cos(headAngle) * headLength,
    );

    // Shoulders and hips sit on either side of the spine. Viewed from the side
    // they separate only slightly — enough to read as depth, not enough to
    // look like the fighter is turning to face the camera.
    const shoulderOffset = this.length('shoulderWidth') * 0.35;
    this.joints.shoulderL.set(chest.x - shoulderOffset * this.facing, chest.y - 0.02);
    this.joints.shoulderR.set(chest.x + shoulderOffset * this.facing, chest.y);

    const hipOffset = this.length('hipWidth') * 0.4;
    this.joints.hipL.set(hip.x - hipOffset * this.facing, hip.y);
    this.joints.hipR.set(hip.x + hipOffset * this.facing, hip.y);
  }

  /** Places an arm so the hand lands on the target, solving for the elbow. */
  placeArm(side: 'L' | 'R', targetX: number, targetY: number): void {
    const shoulder = side === 'L' ? this.joints.shoulderL : this.joints.shoulderR;
    const elbow = side === 'L' ? this.joints.elbowL : this.joints.elbowR;
    const hand = side === 'L' ? this.joints.handL : this.joints.handR;

    // Elbows bend away from the direction of travel — behind the arm.
    const bend = -this.facing;
    solveTwoBoneIk(
      shoulder.x,
      shoulder.y,
      targetX,
      targetY,
      this.length('upperArm'),
      this.length('forearm'),
      bend,
      this.scratch,
    );
    elbow.copyFrom(this.scratch);

    // Re-derive the hand from the solved elbow so the forearm keeps its length
    // even when the target was out of reach and got clamped.
    const dx = targetX - elbow.x;
    const dy = targetY - elbow.y;
    const dist = Math.hypot(dx, dy) || 1;
    const forearm = this.length('forearm');
    hand.set(elbow.x + (dx / dist) * forearm, elbow.y + (dy / dist) * forearm);
  }

  /** Places a leg so the foot lands on the target, solving for the knee. */
  placeLeg(side: 'L' | 'R', targetX: number, targetY: number): void {
    const hip = side === 'L' ? this.joints.hipL : this.joints.hipR;
    const knee = side === 'L' ? this.joints.kneeL : this.joints.kneeR;
    const foot = side === 'L' ? this.joints.footL : this.joints.footR;

    // Knees bend forward, the opposite way to elbows.
    const bend = this.facing;
    solveTwoBoneIk(
      hip.x,
      hip.y,
      targetX,
      targetY,
      this.length('thigh'),
      this.length('shin'),
      bend,
      this.scratch,
    );
    knee.copyFrom(this.scratch);

    const dx = targetX - knee.x;
    const dy = targetY - knee.y;
    const dist = Math.hypot(dx, dy) || 1;
    const shin = this.length('shin');
    foot.set(knee.x + (dx / dist) * shin, knee.y + (dy / dist) * shin);
  }

  /** Copies another rig's joints — used to interpolate between network snapshots. */
  copyFrom(other: FighterRig): void {
    for (const name of RIG_JOINTS) this.joints[name].copyFrom(other.joints[name]);
    this.facing = other.facing;
    this.torsoLean = other.torsoLean;
    this.headTilt = other.headTilt;
    this.crouch = other.crouch;
    this.weave = other.weave;
    this.hipHeight = other.hipHeight;
  }

  /** Blends towards another rig — smooths out network jitter and AI transitions. */
  blendTowards(other: FighterRig, t: number): void {
    for (const name of RIG_JOINTS) this.joints[name].lerpTo(other.joints[name], t);
    this.torsoLean = lerp(this.torsoLean, other.torsoLean, t);
    this.headTilt = lerp(this.headTilt, other.headTilt, t);
    this.crouch = lerp(this.crouch, other.crouch, t);
    this.weave = lerp(this.weave, other.weave, t);
  }

  /** Frame-rate independent smoothing towards another rig. */
  dampTowards(other: FighterRig, halfLife: number, dt: number): void {
    for (const name of RIG_JOINTS) {
      const from = this.joints[name];
      const to = other.joints[name];
      from.set(damp(from.x, to.x, halfLife, dt), damp(from.y, to.y, halfLife, dt));
    }
    this.torsoLean = damp(this.torsoLean, other.torsoLean, halfLife, dt);
    this.headTilt = damp(this.headTilt, other.headTilt, halfLife, dt);
    this.crouch = damp(this.crouch, other.crouch, halfLife, dt);
    this.weave = damp(this.weave, other.weave, halfLife, dt);
  }

  /** World position of the limb that carries a hitbox. */
  limbPosition(limb: 'leftHand' | 'rightHand' | 'leftFoot' | 'rightFoot' | 'body'): Vec2 {
    switch (limb) {
      case 'leftHand':
        return this.joints.handL;
      case 'rightHand':
        return this.joints.handR;
      case 'leftFoot':
        return this.joints.footL;
      case 'rightFoot':
        return this.joints.footR;
      default:
        return this.joints.chest;
    }
  }

  /** Vertical extent of the body, for the hurtbox and the camera framing. */
  get topY(): number {
    return this.joints.head.y + this.length('head') * 0.8;
  }

  get bottomY(): number {
    return Math.min(this.joints.footL.y, this.joints.footR.y);
  }

  /** Approximate head radius in metres, for headshot detection. */
  get headRadius(): number {
    return this.length('head') * 0.92;
  }
}

/** A neutral fighting stance, used before any pose data arrives. */
export function applyNeutralStance(rig: FighterRig, rootX: number, rootY: number): void {
  rig.torsoLean = 0.1;
  rig.crouch = 0.12;
  rig.weave = 0;
  rig.buildTorso(rootX, rootY);

  const s = rig.proportions.scale;
  const chest = rig.joints.chest;

  // Hands up in a loose guard, lead hand slightly forward.
  rig.placeArm('L', chest.x + 0.3 * s * rig.facing, chest.y + 0.16 * s);
  rig.placeArm('R', chest.x + 0.16 * s * rig.facing, chest.y + 0.2 * s);

  // Feet in a bladed stance: lead foot forward, rear foot back and turned out.
  rig.placeLeg('L', rootX + 0.26 * s * rig.facing, rootY);
  rig.placeLeg('R', rootX - 0.3 * s * rig.facing, rootY);
}

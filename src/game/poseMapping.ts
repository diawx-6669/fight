import { clamp, damp } from '@/core/math';
import type { CalibrationProfile } from '@/vision/calibration';
import { Joint, type Skeleton } from '@/vision/skeleton';
import type { MotionState } from '@/vision/motion/types';
import { FighterRig } from './rig';

/**
 * Retargeting: the player's body → the fighter's body.
 *
 * Two coordinate systems have to be reconciled here, and they disagree about
 * almost everything.
 *
 * The camera sees the player **face on**. Their punch travels *towards the
 * lens*, which in image space barely moves the wrist at all — it mostly
 * changes its apparent size and depth, both of which MediaPipe estimates
 * poorly.
 *
 * The game shows the fighter **side on**. A punch has to travel a long way
 * horizontally across the screen or it does not read as a punch.
 *
 * The bridge is to stop thinking in positions and start thinking in *reach*.
 * However the player extends their arm — forward at the camera, out to the
 * side, anywhere in between — what matters is how far the hand got from the
 * shoulder, and at what vertical angle. Those two numbers survive the
 * projection intact, and they are enough to drive a convincing side-on arm.
 *
 * Reach is then normalised against the player's *own* calibrated maximum, so
 * "arm fully extended" means the same thing for every body and every distance
 * from the camera. This is the single most important detail in the file: without
 * it, tall players punch through the opponent and short players cannot reach.
 */

export interface RetargetOptions {
  /** How hard to smooth the rig towards the pose, as a half-life in seconds. */
  smoothing?: number;
  /**
   * How much of the player's motion reaches the fighter, `[0, 1]`.
   * Dropped towards 0 while a fighter is stunned so hitstun still reads.
   */
  influence?: number;
}

/** Scratch targets, reused so retargeting allocates nothing per frame. */
const target = { x: 0, y: 0 };

/**
 * Drives `rig` from a live vision skeleton.
 *
 * `rootX`/`rootY` are the fighter's world position; the rig is built around
 * them so the simulation stays in charge of *where* the fighter is while the
 * camera is in charge of *what it is doing*.
 */
export function retargetToRig(
  rig: FighterRig,
  skeleton: Skeleton,
  motion: MotionState,
  calibration: CalibrationProfile,
  rootX: number,
  rootY: number,
  options: RetargetOptions = {},
): void {
  const influence = clamp(options.influence ?? 1, 0, 1);

  // --- posture -------------------------------------------------------------

  // The player's torso lean maps onto the fighter's, but is amplified: a
  // barely visible 8° weave on camera has to read as a real slip on screen.
  const leanTarget = clamp(motion.lean * 0.42 + skeleton.torsoLean * 0.55, -0.6, 0.6) * influence;
  rig.torsoLean = leanTarget;

  rig.crouch = clamp(motion.crouch, 0, 1) * influence;

  // Weave shifts the chest laterally without moving the feet — this is what
  // makes a slip look like a slip rather than a sidestep.
  rig.weave = clamp(motion.lean, -1, 1) * 0.16 * rig.proportions.scale * influence;

  // Head tilt follows the nose relative to the shoulders, which gives the
  // silhouette a surprising amount of personality for one number.
  const nose = skeleton.at(Joint.Nose);
  rig.headTilt = clamp((nose.x - skeleton.at(Joint.LeftShoulder).x * 0.5) * 0.2, -0.35, 0.35);

  rig.buildTorso(rootX, rootY);

  // --- arms ----------------------------------------------------------------

  // The player's left arm drives the fighter's left arm. Because the vision
  // skeleton is already mirrored, this stays intuitive: raise your left hand,
  // the fighter's left hand goes up.
  retargetArm(rig, skeleton, calibration, 'L', influence);
  retargetArm(rig, skeleton, calibration, 'R', influence);

  // --- legs ----------------------------------------------------------------

  retargetLeg(rig, skeleton, calibration, 'L', rootX, rootY, influence);
  retargetLeg(rig, skeleton, calibration, 'R', rootX, rootY, influence);
}

function retargetArm(
  rig: FighterRig,
  skeleton: Skeleton,
  calibration: CalibrationProfile,
  side: 'L' | 'R',
  influence: number,
): void {
  const shoulderId = side === 'L' ? Joint.LeftShoulder : Joint.RightShoulder;
  const wristId = side === 'L' ? Joint.LeftWrist : Joint.RightWrist;

  const shoulder = skeleton.at(shoulderId);
  const wrist = skeleton.at(wristId);

  const dx = wrist.x - shoulder.x;
  const dy = wrist.y - shoulder.y;
  // Depth is the least reliable axis MediaPipe produces, so it is folded in at
  // reduced weight rather than trusted outright — but it is what distinguishes
  // a straight punch at the camera from a hand simply held out in front.
  const dz = (wrist.z - shoulder.z) * 0.55;

  // Horizontal reach in the player's transverse plane, collapsed onto the
  // fighter's single forward axis.
  const horizontal = Math.hypot(dx, dz);
  const reach = Math.hypot(horizontal, dy);

  // Normalise against this player's own measured maximum.
  const maxReach = Math.max(calibration.reachForward, 0.5);
  const extension = clamp(reach / maxReach, 0, 1.05);

  const armLength = (rig.length('upperArm') + rig.length('forearm')) * 0.99;
  const distance = extension * armLength;

  // Vertical angle survives the projection; horizontal sign does not, so the
  // arm always extends in the facing direction.
  const angle = Math.atan2(dy, Math.max(horizontal, 1e-4));

  const shoulderJoint = side === 'L' ? rig.joints.shoulderL : rig.joints.shoulderR;
  target.x = shoulderJoint.x + Math.cos(angle) * distance * rig.facing;
  target.y = shoulderJoint.y + Math.sin(angle) * distance;

  if (influence < 1) {
    // Blend towards a neutral guard so a stunned fighter's arms sag rather
    // than freezing mid-punch.
    const guardX = shoulderJoint.x + 0.24 * rig.proportions.scale * rig.facing;
    const guardY = shoulderJoint.y + 0.14 * rig.proportions.scale;
    target.x = guardX + (target.x - guardX) * influence;
    target.y = guardY + (target.y - guardY) * influence;
  }

  rig.placeArm(side, target.x, target.y);
}

function retargetLeg(
  rig: FighterRig,
  skeleton: Skeleton,
  calibration: CalibrationProfile,
  side: 'L' | 'R',
  rootX: number,
  rootY: number,
  influence: number,
): void {
  const hipId = side === 'L' ? Joint.LeftHip : Joint.RightHip;
  const ankleId = side === 'L' ? Joint.LeftAnkle : Joint.RightAnkle;

  const hip = skeleton.at(hipId);
  const ankle = skeleton.at(ankleId);

  const dx = ankle.x - hip.x;
  const dy = ankle.y - hip.y;
  const dz = (ankle.z - hip.z) * 0.5;

  const horizontal = Math.hypot(dx, dz);
  const reach = Math.hypot(horizontal, dy);

  // Leg length in body units comes from calibration: it is the hip height above
  // the floor while standing, which is exactly a straight leg.
  const maxReach = Math.max(calibration.standingHipY, 1);
  const extension = clamp(reach / maxReach, 0, 1.02);

  const legLength = (rig.length('thigh') + rig.length('shin')) * 0.99;
  const distance = extension * legLength;

  // Legs hang down, so the angle is measured from straight down. A foot level
  // with the hip is a high kick; a foot below it is standing.
  const angle = Math.atan2(dy, Math.max(horizontal, 1e-4));

  const hipJoint = side === 'L' ? rig.joints.hipL : rig.joints.hipR;
  target.x = hipJoint.x + Math.cos(angle) * distance * rig.facing;
  target.y = hipJoint.y + Math.sin(angle) * distance;

  // A planted foot must stay planted. Without this the fighter's feet drift
  // through the floor whenever the player's ankles are partly occluded.
  const planted = target.y < rootY + 0.06 * rig.proportions.scale;
  if (planted) {
    target.y = rootY;
    // Keep the stance width sane even when tracking is noisy.
    const offset = clamp(target.x - rootX, -0.5, 0.5);
    target.x = rootX + offset;
  }

  if (influence < 1) {
    const restX = rootX + (side === 'L' ? 0.22 : -0.26) * rig.proportions.scale * rig.facing;
    target.x = restX + (target.x - restX) * influence;
    target.y = rootY + (target.y - rootY) * influence;
  }

  rig.placeLeg(side, target.x, target.y);
}

/**
 * Applies temporal smoothing between a freshly retargeted rig and the one on
 * screen. The vision pipeline runs at 20–45 Hz while the renderer runs at 60+,
 * so without this the fighter visibly steps between poses.
 */
export function smoothRig(
  displayed: FighterRig,
  fresh: FighterRig,
  dt: number,
  halfLife = 0.035,
): void {
  displayed.facing = fresh.facing;
  displayed.proportions = fresh.proportions;
  displayed.hipHeight = fresh.hipHeight;
  displayed.dampTowards(fresh, halfLife, dt);
}

/**
 * Nudges a rig towards a pose over time — used for remote players, where
 * snapshots arrive every ~50ms and need to be interpolated into motion.
 */
export function advanceTowards(rig: FighterRig, goal: FighterRig, dt: number, rate = 0.06): void {
  rig.dampTowards(goal, rate, dt);
  rig.facing = goal.facing;
  rig.torsoLean = damp(rig.torsoLean, goal.torsoLean, rate, dt);
}

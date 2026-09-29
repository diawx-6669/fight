import { clamp, jointAngle } from '@/core/math';

/**
 * The game's internal body model.
 *
 * MediaPipe hands back 33 landmarks in normalized image space, which is the
 * wrong coordinate system for gameplay: step towards the camera and every
 * value changes even though you did not move relative to your own body.
 *
 * `Skeleton` re-expresses the pose in *body space* — origin at the hip centre,
 * one unit = the player's own torso length — so thresholds like "the wrist
 * travelled 0.6 body-lengths forward" mean the same thing for a tall adult
 * standing far back and a child standing close.
 */

/** MediaPipe Pose landmark indices, named. */
export const Joint = {
  Nose: 0,
  LeftEyeInner: 1,
  LeftEye: 2,
  LeftEyeOuter: 3,
  RightEyeInner: 4,
  RightEye: 5,
  RightEyeOuter: 6,
  LeftEar: 7,
  RightEar: 8,
  MouthLeft: 9,
  MouthRight: 10,
  LeftShoulder: 11,
  RightShoulder: 12,
  LeftElbow: 13,
  RightElbow: 14,
  LeftWrist: 15,
  RightWrist: 16,
  LeftPinky: 17,
  RightPinky: 18,
  LeftIndex: 19,
  RightIndex: 20,
  LeftThumb: 21,
  RightThumb: 22,
  LeftHip: 23,
  RightHip: 24,
  LeftKnee: 25,
  RightKnee: 26,
  LeftAnkle: 27,
  RightAnkle: 28,
  LeftHeel: 29,
  RightHeel: 30,
  LeftFootIndex: 31,
  RightFootIndex: 32,
} as const;

export type JointId = (typeof Joint)[keyof typeof Joint];

export const JOINT_COUNT = 33;

/** Bones, for drawing the debug overlay and the calibration silhouette. */
export const BONES: ReadonlyArray<readonly [JointId, JointId]> = [
  [Joint.LeftShoulder, Joint.RightShoulder],
  [Joint.LeftShoulder, Joint.LeftElbow],
  [Joint.LeftElbow, Joint.LeftWrist],
  [Joint.RightShoulder, Joint.RightElbow],
  [Joint.RightElbow, Joint.RightWrist],
  [Joint.LeftShoulder, Joint.LeftHip],
  [Joint.RightShoulder, Joint.RightHip],
  [Joint.LeftHip, Joint.RightHip],
  [Joint.LeftHip, Joint.LeftKnee],
  [Joint.LeftKnee, Joint.LeftAnkle],
  [Joint.RightHip, Joint.RightKnee],
  [Joint.RightKnee, Joint.RightAnkle],
  [Joint.LeftAnkle, Joint.LeftHeel],
  [Joint.LeftHeel, Joint.LeftFootIndex],
  [Joint.RightAnkle, Joint.RightHeel],
  [Joint.RightHeel, Joint.RightFootIndex],
];

export interface Landmark {
  x: number;
  y: number;
  z: number;
  /** MediaPipe's confidence that the joint is visible, `[0, 1]`. */
  visibility: number;
}

function makeLandmark(): Landmark {
  return { x: 0, y: 0, z: 0, visibility: 0 };
}

/**
 * A single frame of body-space pose data plus the derived measurements the
 * motion detectors care about. Reused in place every frame — never retained.
 */
export class Skeleton {
  /** Body-space joints: hip centre at origin, +x right, +y up, +z toward camera. */
  readonly joints: Landmark[] = Array.from({ length: JOINT_COUNT }, makeLandmark);

  /** Image-space joints in `[0, 1]`, kept for drawing the camera overlay. */
  readonly raw: Landmark[] = Array.from({ length: JOINT_COUNT }, makeLandmark);

  /** Timestamp of the camera frame this pose came from, in milliseconds. */
  timestamp = 0;

  /** True once a pose has been seen; false while the player is out of frame. */
  present = false;

  /**
   * Whether MediaPipe returned a pose at all this frame.
   *
   * Distinct from `present`: the model can find a person and this class can
   * still reject the frame for lacking a usable reference. The UI needs to
   * tell those two apart, because the advice is opposite — "step into frame"
   * versus "step back so your hips are visible".
   */
  hasLandmarks = false;

  /** Mean visibility of the hips and shoulders, which body space is built on. */
  anchorVisibility = 0;

  /**
   * True when the hips were not visible and had to be inferred.
   *
   * This is the common case, not an edge case: most people play in front of a
   * laptop on a desk, where the camera sees head, shoulders and arms and
   * nothing below the ribs. Requiring a full body made the game unplayable for
   * them, so upper-body tracking is a first-class mode — punches, guard,
   * parries and slips all work from it. Only kicks genuinely need legs.
   */
  upperBodyOnly = false;

  /** True when knees and ankles are visible enough to drive kicks. */
  legsVisible = false;

  /** Mean visibility over the joints that matter for combat. */
  confidence = 0;

  // --- derived measurements ------------------------------------------------

  /** Hip centre in image space — the player's position on screen. */
  hipX = 0.5;
  hipY = 0.5;

  /** Shoulder centre in image space. */
  shoulderX = 0.5;
  shoulderY = 0.4;

  /** Distance from hip centre to shoulder centre in image units. The scale. */
  torsoLength = 0.25;

  /** Shoulder width in image units — used to estimate how square-on the player is. */
  shoulderWidth = 0.2;

  /** Torso lean: signed radians from vertical, positive = leaning right. */
  torsoLean = 0;

  /**
   * How side-on the player is, `0` = fully facing the camera, `1` = profile.
   * Derived from shoulder width relative to torso length.
   */
  profileness = 0;

  /** Approximate standing height in image units (ankle to eye). */
  standingHeight = 0.6;

  /** Vertical position of the lower of the two ankles, in image units. */
  floorY = 1;

  /** Horizontal gap between the ankles, normalised by torso length. */
  stanceWidth = 0;

  /** Centre of mass in body units, weighted towards the torso. */
  comX = 0;
  comY = 0;

  reset(): void {
    this.present = false;
    this.hasLandmarks = false;
    this.anchorVisibility = 0;
    this.upperBodyOnly = false;
    this.legsVisible = false;
    this.confidence = 0;
    for (let i = 0; i < JOINT_COUNT; i++) {
      this.joints[i].visibility = 0;
      this.raw[i].visibility = 0;
    }
  }

  /** Convenience accessor with bounds safety. */
  at(id: JointId): Landmark {
    return this.joints[id];
  }

  rawAt(id: JointId): Landmark {
    return this.raw[id];
  }

  /** Interior angle at a joint, in body space. */
  angleAt(a: JointId, b: JointId, c: JointId): number {
    const ja = this.joints[a];
    const jb = this.joints[b];
    const jc = this.joints[c];
    return jointAngle(ja.x, ja.y, jb.x, jb.y, jc.x, jc.y);
  }

  /** `0` = elbow fully bent, `1` = arm locked out. */
  armExtension(side: 'left' | 'right'): number {
    const shoulder = side === 'left' ? Joint.LeftShoulder : Joint.RightShoulder;
    const elbow = side === 'left' ? Joint.LeftElbow : Joint.RightElbow;
    const wrist = side === 'left' ? Joint.LeftWrist : Joint.RightWrist;
    const angle = this.angleAt(shoulder, elbow, wrist);
    // A "straight" arm reads around 165°, not 180° — people do not lock out.
    return clamp((angle - 0.9) / (2.88 - 0.9), 0, 1);
  }

  /** `0` = knee fully bent, `1` = leg straight. */
  legExtension(side: 'left' | 'right'): number {
    const hip = side === 'left' ? Joint.LeftHip : Joint.RightHip;
    const knee = side === 'left' ? Joint.LeftKnee : Joint.RightKnee;
    const ankle = side === 'left' ? Joint.LeftAnkle : Joint.RightAnkle;
    const angle = this.angleAt(hip, knee, ankle);
    return clamp((angle - 1.05) / (2.9 - 1.05), 0, 1);
  }

  /** Mean visibility over the joints listed, ignoring the rest. */
  visibilityOf(ids: readonly JointId[]): number {
    let sum = 0;
    for (const id of ids) sum += this.joints[id].visibility;
    return ids.length === 0 ? 0 : sum / ids.length;
  }
}

/**
 * Torso length as a multiple of shoulder width.
 *
 * Used to place a hip that the camera cannot see. On adult proportions the
 * hip-to-shoulder span runs about 1.25 shoulder widths; it varies between
 * bodies, but calibration normalises everything downstream against the
 * player's own measured reach, so the constant only has to be close.
 */
export const TORSO_PER_SHOULDER = 1.25;

/** Joints that matter when only the upper body is in frame. */
export const UPPER_BODY_JOINTS: readonly JointId[] = [
  Joint.LeftShoulder,
  Joint.RightShoulder,
  Joint.LeftElbow,
  Joint.RightElbow,
  Joint.LeftWrist,
  Joint.RightWrist,
];

/** Joints the game refuses to run without — arms, torso and legs. */
export const CORE_JOINTS: readonly JointId[] = [
  Joint.LeftShoulder,
  Joint.RightShoulder,
  Joint.LeftElbow,
  Joint.RightElbow,
  Joint.LeftWrist,
  Joint.RightWrist,
  Joint.LeftHip,
  Joint.RightHip,
  Joint.LeftKnee,
  Joint.RightKnee,
];

/**
 * Converts a raw MediaPipe landmark array into body space, in place.
 *
 * `mirrored` flips x so the on-screen fighter moves the same way the player
 * sees themselves move in the preview — without it, raising your right arm
 * raises the fighter's left and the game feels broken within two seconds.
 */
export function buildSkeleton(
  skeleton: Skeleton,
  landmarks: ReadonlyArray<{ x: number; y: number; z: number; visibility?: number }>,
  timestamp: number,
  mirrored: boolean,
): boolean {
  if (landmarks.length < JOINT_COUNT) {
    skeleton.reset();
    return false;
  }

  skeleton.timestamp = timestamp;
  skeleton.hasLandmarks = true;

  // 1. Copy into image space, applying the mirror and flipping y so that
  //    "up" is positive — image coordinates grow downward, bodies do not.
  for (let i = 0; i < JOINT_COUNT; i++) {
    const source = landmarks[i];
    const target = skeleton.raw[i];
    target.x = mirrored ? 1 - source.x : source.x;
    target.y = source.y;
    target.z = mirrored ? -source.z : source.z;
    target.visibility = source.visibility ?? 1;
  }

  const raw = skeleton.raw;
  const leftHip = raw[Joint.LeftHip];
  const rightHip = raw[Joint.RightHip];
  const leftShoulder = raw[Joint.LeftShoulder];
  const rightShoulder = raw[Joint.RightShoulder];
  const nose = raw[Joint.Nose];

  // Shoulders are the one thing this cannot work without: they define both the
  // scale and the direction of "up" for the whole body space.
  const shoulderVisibility = (leftShoulder.visibility + rightShoulder.visibility) / 2;
  const hipVisibility = (leftHip.visibility + rightHip.visibility) / 2;
  skeleton.anchorVisibility = (shoulderVisibility + hipVisibility) / 2;

  if (shoulderVisibility < 0.4) {
    skeleton.present = false;
    skeleton.confidence = shoulderVisibility;
    return false;
  }

  skeleton.shoulderX = (leftShoulder.x + rightShoulder.x) / 2;
  skeleton.shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
  skeleton.shoulderWidth = Math.hypot(
    leftShoulder.x - rightShoulder.x,
    leftShoulder.y - rightShoulder.y,
  );

  const hipsVisible = hipVisibility >= 0.45;
  skeleton.upperBodyOnly = !hipsVisible;

  if (hipsVisible) {
    skeleton.hipX = (leftHip.x + rightHip.x) / 2;
    skeleton.hipY = (leftHip.y + rightHip.y) / 2;
    const torso = Math.hypot(
      skeleton.shoulderX - skeleton.hipX,
      skeleton.shoulderY - skeleton.hipY,
    );
    // Guard against a degenerate torso when the player is nearly edge-on.
    skeleton.torsoLength = Math.max(torso, 0.04);
  } else {
    // --- infer the hip ----------------------------------------------------
    //
    // Scale comes from shoulder width, floored by the head-to-shoulder span.
    // A player turned side-on collapses their apparent shoulder width towards
    // zero, which would send the inferred torso — and every threshold derived
    // from it — to infinity; the head span barely changes with rotation and
    // stops that happening.
    const headSpan = Math.hypot(nose.x - skeleton.shoulderX, nose.y - skeleton.shoulderY);
    const estimated = Math.max(
      skeleton.shoulderWidth * TORSO_PER_SHOULDER,
      headSpan * 2.2,
    );
    skeleton.torsoLength = clamp(estimated, 0.05, 0.6);

    // The hip sits straight down the body's own axis, which is perpendicular
    // to the shoulder line — not straight down the image, or every head tilt
    // would read as a lean.
    const axisX = rightShoulder.x - leftShoulder.x;
    const axisY = rightShoulder.y - leftShoulder.y;
    const axisLength = Math.hypot(axisX, axisY) || 1;

    let downX = -axisY / axisLength;
    let downY = axisX / axisLength;
    // Of the two perpendiculars, take the one pointing away from the head.
    if (downX * (skeleton.shoulderX - nose.x) + downY * (skeleton.shoulderY - nose.y) < 0) {
      downX = -downX;
      downY = -downY;
    }

    skeleton.hipX = skeleton.shoulderX + downX * skeleton.torsoLength;
    skeleton.hipY = skeleton.shoulderY + downY * skeleton.torsoLength;
  }

  // 2. Rotate into body space so leaning does not read as translation.
  //    The torso axis becomes +y.
  const axisX = skeleton.shoulderX - skeleton.hipX;
  const axisY = skeleton.hipY - skeleton.shoulderY; // y-up
  skeleton.torsoLean = Math.atan2(axisX, Math.max(axisY, 1e-4));

  const scale = 1 / skeleton.torsoLength;
  for (let i = 0; i < JOINT_COUNT; i++) {
    const source = raw[i];
    const target = skeleton.joints[i];
    target.x = (source.x - skeleton.hipX) * scale;
    target.y = (skeleton.hipY - source.y) * scale;
    target.z = source.z * scale;
    target.visibility = source.visibility;
  }

  // 3. Derived measurements, all in body units.
  const ratio = skeleton.shoulderWidth / skeleton.torsoLength;
  // A square-on stance reads ~0.95 shoulder-widths per torso length; a full
  // profile collapses towards 0.25. Anything outside that is noise.
  skeleton.profileness = clamp(1 - (ratio - 0.28) / (0.95 - 0.28), 0, 1);

  const leftAnkle = raw[Joint.LeftAnkle];
  const rightAnkle = raw[Joint.RightAnkle];
  const leftKnee = raw[Joint.LeftKnee];
  const rightKnee = raw[Joint.RightKnee];

  skeleton.legsVisible =
    Math.min(leftKnee.visibility, rightKnee.visibility) > 0.5 &&
    Math.min(leftAnkle.visibility, rightAnkle.visibility) > 0.45;

  if (skeleton.legsVisible) {
    skeleton.floorY = Math.max(leftAnkle.y, rightAnkle.y);
    skeleton.standingHeight = Math.max(skeleton.floorY - nose.y, 0.1);
    skeleton.stanceWidth = Math.abs(leftAnkle.x - rightAnkle.x) * scale;
  } else {
    // No floor to measure against. Project one from the hip so anything that
    // still reads it gets a plausible number rather than a stale one.
    skeleton.floorY = skeleton.hipY + skeleton.torsoLength * 2.1;
    skeleton.standingHeight = Math.max(skeleton.floorY - nose.y, 0.1);
    skeleton.stanceWidth = 0.5;
  }

  // Centre of mass: the torso carries most of the weight, so a simple weighted
  // blend of hips and shoulders tracks balance better than a joint average.
  skeleton.comX = (skeleton.joints[Joint.LeftShoulder].x + skeleton.joints[Joint.RightShoulder].x) * 0.2;
  skeleton.comY = (skeleton.joints[Joint.LeftShoulder].y + skeleton.joints[Joint.RightShoulder].y) * 0.25;

  skeleton.confidence = skeleton.visibilityOf(
    skeleton.upperBodyOnly ? UPPER_BODY_JOINTS : CORE_JOINTS,
  );
  skeleton.present = true;
  return true;
}

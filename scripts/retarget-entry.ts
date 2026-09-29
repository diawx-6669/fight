/**
 * Headless entry point for `retarget-check.mjs`.
 *
 * Bundled by esbuild so the camera→rig chain can be driven from Node. Nothing
 * in this path touches the DOM, which is exactly why it is worth testing this
 * way: it is the code every real player runs and the browser smoke test never
 * reaches, because without a webcam the game uses the animator instead.
 */

import { DEFAULT_CALIBRATION } from '@/vision/calibration';
import { buildSkeleton, Skeleton } from '@/vision/skeleton';
import { createMotionState } from '@/vision/motion/types';
import { retargetToRig, smoothRig } from '@/game/poseMapping';
import { FighterRig, RIG_JOINTS } from '@/game/rig';

export interface RetargetResult {
  present: boolean;
  upperBodyOnly: boolean;
  joints: { name: string; x: number; y: number }[];
}

export function runRetarget(
  landmarks: { x: number; y: number; z: number; visibility?: number }[],
): RetargetResult {
  const skeleton = new Skeleton();
  const present = buildSkeleton(skeleton, landmarks, 1000, true);

  const motion = createMotionState();
  motion.quality = skeleton.confidence;

  const fresh = new FighterRig();
  const displayed = new FighterRig();

  if (!present) {
    return { present: false, upperBodyOnly: skeleton.upperBodyOnly, joints: [] };
  }

  // Two passes: the second exercises the smoothing path, where a non-finite
  // value from the first would spread into every joint and stay there.
  for (let i = 0; i < 2; i++) {
    retargetToRig(fresh, skeleton, motion, DEFAULT_CALIBRATION, 0, 0, { influence: 1 });
    smoothRig(displayed, fresh, 1 / 60);
  }

  return {
    present: true,
    upperBodyOnly: skeleton.upperBodyOnly,
    joints: RIG_JOINTS.map((name) => ({
      name,
      x: displayed.joints[name].x,
      y: displayed.joints[name].y,
    })),
  };
}

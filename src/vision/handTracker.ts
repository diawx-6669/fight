import { createLogger } from '@/core/logger';
import { Vector3Filter } from './filters';
import { createHandLandmarker, type HandLandmarkerInstance, type LoadProgress } from './mediapipe';

const log = createLogger('vision');

/**
 * Hand tracking, used exclusively for menu navigation.
 *
 * During a fight the body tracker is in charge and this one is off — running
 * both at once roughly doubles inference cost for no gameplay benefit, since
 * nobody navigates a menu mid-combo.
 */

/** MediaPipe Hand landmark indices, named. */
export const HandJoint = {
  Wrist: 0,
  ThumbCmc: 1,
  ThumbMcp: 2,
  ThumbIp: 3,
  ThumbTip: 4,
  IndexMcp: 5,
  IndexPip: 6,
  IndexDip: 7,
  IndexTip: 8,
  MiddleMcp: 9,
  MiddlePip: 10,
  MiddleDip: 11,
  MiddleTip: 12,
  RingMcp: 13,
  RingPip: 14,
  RingDip: 15,
  RingTip: 16,
  PinkyMcp: 17,
  PinkyPip: 18,
  PinkyDip: 19,
  PinkyTip: 20,
} as const;

export const HAND_JOINT_COUNT = 21;

/** Bones for the debug overlay and the on-screen hand ghost. */
export const HAND_BONES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export interface HandPoint {
  x: number;
  y: number;
  z: number;
}

export interface HandFrame {
  /** Landmarks in mirrored image space, `[0, 1]`. */
  readonly points: HandPoint[];
  /** Which hand the model thinks this is, after mirroring is accounted for. */
  handedness: 'left' | 'right';
  /** Model confidence in the handedness call. */
  score: number;
  present: boolean;
}

function emptyHand(): HandFrame {
  return {
    points: Array.from({ length: HAND_JOINT_COUNT }, () => ({ x: 0, y: 0, z: 0 })),
    handedness: 'right',
    score: 0,
    present: false,
  };
}

export interface HandTrackerOptions {
  numHands?: number;
  hz?: number;
  mirrored?: boolean;
  onProgress?: LoadProgress;
}

export class HandTracker {
  private landmarker: HandLandmarkerInstance | null = null;
  private loading: Promise<void> | null = null;

  private clock = 0;
  private lastDetectAt = 0;
  private lastFrameTime = 0;
  private intervalMs: number;

  private readonly filters: Vector3Filter[][] = [];

  /** Index 0 is the hand the model saw first, not a fixed left/right slot. */
  readonly hands: HandFrame[] = [];

  mirrored: boolean;
  enabled = true;

  private readonly numHands: number;
  private readonly onProgress?: LoadProgress;

  constructor(options: HandTrackerOptions = {}) {
    this.numHands = options.numHands ?? 2;
    this.mirrored = options.mirrored ?? true;
    this.intervalMs = 1000 / (options.hz ?? 24);
    this.onProgress = options.onProgress;

    for (let h = 0; h < this.numHands; h++) {
      this.hands.push(emptyHand());
      this.filters.push(
        Array.from(
          { length: HAND_JOINT_COUNT },
          // Fingertips must feel immediate — a laggy cursor is unusable — but
          // the palm can be smoothed hard to keep the cursor from wobbling.
          () => new Vector3Filter({ minCutoff: 2.4, beta: 0.06 }),
        ),
      );
    }
  }

  get isReady(): boolean {
    return this.landmarker !== null;
  }

  /** The most confident visible hand, or `null` when none is in frame. */
  get primary(): HandFrame | null {
    let best: HandFrame | null = null;
    for (const hand of this.hands) {
      if (!hand.present) continue;
      if (!best || hand.score > best.score) best = hand;
    }
    return best;
  }

  setRate(hz: number): void {
    this.intervalMs = 1000 / Math.max(5, hz);
  }

  async init(): Promise<void> {
    if (this.landmarker) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      this.landmarker = await createHandLandmarker({
        numHands: this.numHands,
        onProgress: this.onProgress,
      });
    })();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  update(video: HTMLVideoElement, now: number): boolean {
    if (!this.enabled || !this.landmarker) return false;
    if (video.readyState < 2 || video.videoWidth === 0) return false;
    if (now - this.lastDetectAt < this.intervalMs) return false;

    const dt = this.lastFrameTime === 0 ? 1 / 24 : (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;
    this.lastDetectAt = now;
    this.clock = Math.max(this.clock + 1, Math.round(now));

    let result;
    try {
      result = this.landmarker.detectForVideo(video, this.clock);
    } catch (error) {
      log.onceWarn('hand-detect-failed', 'hand inference failed', error);
      return false;
    }

    const detected = result.landmarks ?? [];
    for (let h = 0; h < this.hands.length; h++) {
      const hand = this.hands[h];
      const landmarks = detected[h];

      if (!landmarks || landmarks.length < HAND_JOINT_COUNT) {
        hand.present = false;
        hand.score = 0;
        continue;
      }

      const filters = this.filters[h];
      for (let i = 0; i < HAND_JOINT_COUNT; i++) {
        const point = landmarks[i];
        const x = this.mirrored ? 1 - point.x : point.x;
        const filtered = filters[i].filter(x, point.y, point.z ?? 0, dt);
        hand.points[i].x = filtered.x;
        hand.points[i].y = filtered.y;
        hand.points[i].z = filtered.z;
      }

      const category = result.handedness?.[h]?.[0];
      // MediaPipe labels handedness in *camera* space. Once the image is
      // mirrored the player's right hand appears on the right, so the label
      // must flip too or the UI hints tell the player the wrong thing.
      const label = category?.categoryName === 'Left' ? 'left' : 'right';
      hand.handedness = this.mirrored ? (label === 'left' ? 'right' : 'left') : label;
      hand.score = category?.score ?? 0.5;
      hand.present = true;
    }

    return true;
  }

  reset(): void {
    for (const filters of this.filters) for (const filter of filters) filter.reset();
    for (const hand of this.hands) {
      hand.present = false;
      hand.score = 0;
    }
    this.lastFrameTime = 0;
  }

  dispose(): void {
    this.landmarker?.close();
    this.landmarker = null;
    this.reset();
  }
}

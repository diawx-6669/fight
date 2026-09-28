import { createLogger } from '@/core/logger';
import { Vector3Filter } from './filters';
import { buildSkeleton, JOINT_COUNT, Skeleton } from './skeleton';
import { createPoseLandmarker, type LoadProgress, type ModelKey, type PoseLandmarkerInstance } from './mediapipe';

const log = createLogger('vision');

/**
 * Drives pose inference and turns it into a clean, stable `Skeleton`.
 *
 * Two details here are load-bearing:
 *
 * 1. **Throttling.** Inference is the single most expensive thing the game
 *    does. Running it every animation frame starves the renderer and the frame
 *    rate collapses, so it runs at its own rate (20–60 Hz by quality tier)
 *    while the game keeps drawing at full speed.
 *
 * 2. **Monotonic timestamps.** `detectForVideo` throws if a timestamp ever
 *    goes backwards, and `video.currentTime` does exactly that after a seek or
 *    a stream restart. We keep our own strictly increasing clock.
 */

export interface PoseTrackerOptions {
  model?: ModelKey;
  /** Target inference rate in Hz. */
  hz?: number;
  /** Mirror the pose so the fighter matches what the player sees. */
  mirrored?: boolean;
  onProgress?: LoadProgress;
}

export interface PoseTrackerStats {
  /** Actual achieved inference rate, smoothed. */
  hz: number;
  /** Milliseconds spent inside the last `detectForVideo` call. */
  inferenceMs: number;
  /** Frames where no body was found, since the last reset. */
  missedFrames: number;
  /** Consecutive frames without a body — drives the "step into frame" prompt. */
  lostStreak: number;
}

export class PoseTracker {
  private landmarker: PoseLandmarkerInstance | null = null;
  private readonly filters: Vector3Filter[] = [];

  /** Strictly increasing timestamp handed to MediaPipe. */
  private clock = 0;
  private lastDetectAt = 0;
  private lastFrameTime = 0;
  private intervalMs: number;

  readonly skeleton = new Skeleton();
  readonly stats: PoseTrackerStats = { hz: 0, inferenceMs: 0, missedFrames: 0, lostStreak: 0 };

  mirrored: boolean;
  /** Set false to pause inference without tearing the model down. */
  enabled = true;

  private readonly model: ModelKey;
  private readonly onProgress?: LoadProgress;
  private loading: Promise<void> | null = null;

  constructor(options: PoseTrackerOptions = {}) {
    this.model = options.model ?? 'poseLite';
    this.mirrored = options.mirrored ?? true;
    this.intervalMs = 1000 / (options.hz ?? 30);
    this.onProgress = options.onProgress;

    // Hands move fastest and need to stay crisp; hips barely move and benefit
    // from heavy smoothing. One filter per joint, tuned by body region below.
    for (let i = 0; i < JOINT_COUNT; i++) {
      this.filters.push(new Vector3Filter(filterProfileFor(i)));
    }
  }

  get isReady(): boolean {
    return this.landmarker !== null;
  }

  setRate(hz: number): void {
    this.intervalMs = 1000 / Math.max(5, hz);
  }

  /** Loads the model. Safe to call repeatedly; the work happens once. */
  async init(): Promise<void> {
    if (this.landmarker) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      this.landmarker = await createPoseLandmarker({
        model: this.model,
        numPoses: 1,
        onProgress: this.onProgress,
      });
    })();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /**
   * Runs inference if enough time has passed. Returns `true` when a fresh pose
   * was produced this call, so the caller knows whether to advance detectors.
   */
  update(video: HTMLVideoElement, now: number): boolean {
    if (!this.enabled || !this.landmarker) return false;
    if (video.readyState < 2 || video.videoWidth === 0) return false;
    if (now - this.lastDetectAt < this.intervalMs) return false;

    const dt = this.lastFrameTime === 0 ? 1 / 30 : (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;
    this.lastDetectAt = now;

    // Keep our own clock: never repeat, never go backwards.
    this.clock = Math.max(this.clock + 1, Math.round(now));

    const start = performance.now();
    let result;
    try {
      result = this.landmarker.detectForVideo(video, this.clock);
    } catch (error) {
      log.onceWarn('detect-failed', 'pose inference failed', error);
      return false;
    }
    this.stats.inferenceMs = performance.now() - start;

    const instantHz = dt > 0 ? 1 / dt : 0;
    this.stats.hz += (instantHz - this.stats.hz) * 0.1;

    const landmarks = result.landmarks?.[0];
    if (!landmarks || landmarks.length < JOINT_COUNT) {
      this.stats.missedFrames++;
      this.stats.lostStreak++;
      // Hold the last good skeleton for a few frames: MediaPipe drops the odd
      // frame on motion blur, and blanking the fighter for 30ms looks broken.
      if (this.stats.lostStreak > 6) this.skeleton.present = false;
      return false;
    }

    this.stats.lostStreak = 0;

    // Smooth in image space, before the body-space transform, so that the
    // normalisation itself does not amplify jitter.
    const smoothed = new Array<{ x: number; y: number; z: number; visibility: number }>(
      JOINT_COUNT,
    );
    for (let i = 0; i < JOINT_COUNT; i++) {
      const point = landmarks[i];
      const filtered = this.filters[i].filter(point.x, point.y, point.z ?? 0, dt);
      smoothed[i] = {
        x: filtered.x,
        y: filtered.y,
        z: filtered.z,
        visibility: point.visibility ?? 1,
      };
    }

    return buildSkeleton(this.skeleton, smoothed, now, this.mirrored);
  }

  /** Clears filter state — call when the camera changes or the player recalibrates. */
  reset(): void {
    for (const filter of this.filters) filter.reset();
    this.skeleton.reset();
    this.stats.lostStreak = 0;
    this.stats.missedFrames = 0;
    this.lastFrameTime = 0;
  }

  dispose(): void {
    this.landmarker?.close();
    this.landmarker = null;
    this.reset();
  }
}

/**
 * Per-joint filter tuning.
 *
 * `beta` is the responsiveness knob: high on the hands so a jab is not smeared
 * into a push, low on the hips so the fighter's stance does not shimmer.
 */
function filterProfileFor(jointIndex: number): { minCutoff: number; beta: number } {
  // Wrists, hands and fingers — the fastest things on a body.
  if (
    (jointIndex >= 15 && jointIndex <= 22) ||
    jointIndex === 31 ||
    jointIndex === 32
  ) {
    return { minCutoff: 1.9, beta: 0.05 };
  }
  // Elbows, knees, ankles — fast but heavier.
  if ((jointIndex >= 13 && jointIndex <= 14) || (jointIndex >= 25 && jointIndex <= 30)) {
    return { minCutoff: 1.6, beta: 0.03 };
  }
  // Head and face — only used for aiming the silhouette's gaze.
  if (jointIndex <= 10) {
    return { minCutoff: 1.0, beta: 0.008 };
  }
  // Shoulders and hips — the reference frame; stability beats speed.
  return { minCutoff: 0.9, beta: 0.006 };
}

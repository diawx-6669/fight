import { createLogger } from '@/core/logger';

const log = createLogger('vision');

/**
 * Lazy loader for the MediaPipe Tasks Vision runtime.
 *
 * The WASM bundle and the two `.task` models together weigh several megabytes,
 * which is far too much to block the title screen on. Everything here is
 * fetched on demand — the first time the player actually starts a fight or
 * opens gesture control — and cached for the rest of the session.
 *
 * Model assets can come from three places, tried in order:
 *   1. `?models=<url>` on the page, for testing a mirror.
 *   2. `/models/` next to the app, if the project ran `npm run fetch:models`.
 *   3. Google's public model CDN.
 *
 * The local option matters because plenty of networks block the Google CDN,
 * and a fighting game that refuses to start is not much of a fighting game.
 */

export const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm';
export const MODEL_CDN = 'https://storage.googleapis.com/mediapipe-models';

export const MODEL_PATHS = {
  poseLite: 'pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  poseFull: 'pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  poseHeavy: 'pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
  hand: 'hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
} as const;

export type ModelKey = keyof typeof MODEL_PATHS;

/** Progress callbacks let the boot splash say something truthful. */
export type LoadProgress = (stage: string, ratio: number) => void;

function modelBase(): string {
  const override = new URLSearchParams(location.search).get('models');
  if (override) return override.replace(/\/$/, '');
  return MODEL_CDN;
}

const localBase = new URL('models/', document.baseURI).href;

/**
 * Resolves a model URL, preferring a locally hosted copy when one exists.
 * A `HEAD` that fails for any reason simply falls through to the CDN.
 */
async function resolveModelUrl(key: ModelKey): Promise<string> {
  const filename = MODEL_PATHS[key].split('/').pop()!;
  const local = `${localBase}${filename}`;
  try {
    const response = await fetch(local, { method: 'HEAD', cache: 'force-cache' });
    if (response.ok) {
      log.info(`using local model for ${key}`);
      return local;
    }
  } catch {
    // Local copy absent — expected in the default checkout.
  }
  return `${modelBase()}/${MODEL_PATHS[key]}`;
}

type TasksVision = typeof import('@mediapipe/tasks-vision');
type FilesetResolverType = Awaited<ReturnType<TasksVision['FilesetResolver']['forVisionTasks']>>;

let modulePromise: Promise<TasksVision> | null = null;
let filesetPromise: Promise<FilesetResolverType> | null = null;

/** Imports the Tasks Vision module exactly once. */
export function loadTasksVision(): Promise<TasksVision> {
  if (!modulePromise) {
    log.info('loading @mediapipe/tasks-vision');
    modulePromise = import('@mediapipe/tasks-vision');
  }
  return modulePromise;
}

/** Resolves the WASM fileset exactly once. */
export async function loadFileset(): Promise<FilesetResolverType> {
  if (!filesetPromise) {
    filesetPromise = (async () => {
      const { FilesetResolver } = await loadTasksVision();
      log.info('resolving vision wasm fileset');
      return FilesetResolver.forVisionTasks(WASM_CDN);
    })();
  }
  return filesetPromise;
}

export type Delegate = 'GPU' | 'CPU';

export interface LandmarkerRequest {
  model: ModelKey;
  delegate: Delegate;
}

/**
 * Builds a PoseLandmarker. Falls back from GPU to CPU automatically, because
 * WebGL-backed inference fails outright on some Linux/Firefox combinations and
 * a slower tracker beats no tracker.
 */
export async function createPoseLandmarker(options: {
  model?: ModelKey;
  numPoses?: number;
  delegate?: Delegate;
  onProgress?: LoadProgress;
}) {
  const { PoseLandmarker } = await loadTasksVision();
  const fileset = await loadFileset();
  const modelKey = options.model ?? 'poseLite';
  options.onProgress?.('модель тела', 0.4);
  const modelAssetPath = await resolveModelUrl(modelKey);

  const build = (delegate: Delegate) =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO',
      numPoses: options.numPoses ?? 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.55,
      outputSegmentationMasks: false,
    });

  const preferred = options.delegate ?? 'GPU';
  try {
    const landmarker = await build(preferred);
    options.onProgress?.('модель тела', 1);
    log.info(`pose landmarker ready (${modelKey}, ${preferred})`);
    return landmarker;
  } catch (error) {
    if (preferred === 'CPU') throw error;
    log.warn('GPU delegate failed for pose, retrying on CPU', error);
    const landmarker = await build('CPU');
    options.onProgress?.('модель тела', 1);
    return landmarker;
  }
}

/** Builds a HandLandmarker with the same GPU→CPU fallback. */
export async function createHandLandmarker(options: {
  numHands?: number;
  delegate?: Delegate;
  onProgress?: LoadProgress;
}) {
  const { HandLandmarker } = await loadTasksVision();
  const fileset = await loadFileset();
  options.onProgress?.('модель рук', 0.4);
  const modelAssetPath = await resolveModelUrl('hand');

  const build = (delegate: Delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO',
      numHands: options.numHands ?? 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

  const preferred = options.delegate ?? 'GPU';
  try {
    const landmarker = await build(preferred);
    options.onProgress?.('модель рук', 1);
    log.info(`hand landmarker ready (${preferred})`);
    return landmarker;
  } catch (error) {
    if (preferred === 'CPU') throw error;
    log.warn('GPU delegate failed for hands, retrying on CPU', error);
    const landmarker = await build('CPU');
    options.onProgress?.('модель рук', 1);
    return landmarker;
  }
}

export type PoseLandmarkerInstance = Awaited<ReturnType<typeof createPoseLandmarker>>;
export type HandLandmarkerInstance = Awaited<ReturnType<typeof createHandLandmarker>>;

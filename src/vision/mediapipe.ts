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
 * Both the runtime and the models are looked for next to the app first, and
 * only then on a public CDN:
 *   1. `?models=<url>` on the page, for testing a mirror.
 *   2. `wasm/` and `models/` beside `index.html`, put there at build time by
 *      `npm run sync:runtime` and `npm run fetch:models`.
 *   3. jsDelivr and Google's model CDN.
 *
 * The order matters more than it looks. When those CDNs are unreachable — and
 * they are blocked on a great many networks — the camera still opens and the
 * preview still shows the player, so the game looks like it is working while
 * recognising precisely nothing. Serving both from our own origin removes the
 * single most common reason for this game to appear broken.
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

const localModelBase = new URL('models/', document.baseURI).href;
const localWasmBase = new URL('wasm/', document.baseURI).href;

/**
 * Asks whether a file really is served from our own origin.
 *
 * A bare `response.ok` is not enough to answer that. A dev server answers any
 * unknown path with `index.html` and a cheerful 200, so a missing model would
 * be "found", then handed to the loader, which would try to parse a web page
 * as a neural network and fail with something unreadable. Checking that the
 * answer is not HTML costs nothing and turns that into a clean fallback.
 */
async function servedLocally(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD', cache: 'force-cache' });
    if (!response.ok) return false;
    const type = response.headers.get('content-type') ?? '';
    return !type.includes('text/html');
  } catch {
    // Absent, or blocked — either way, use the CDN.
    return false;
  }
}

/** Resolves a model URL, preferring a locally hosted copy when one exists. */
async function resolveModelUrl(key: ModelKey): Promise<string> {
  const filename = MODEL_PATHS[key].split('/').pop()!;
  const local = `${localModelBase}${filename}`;
  if (await servedLocally(local)) {
    log.info(`using local model for ${key}`);
    return local;
  }
  log.warn(`no local copy of ${key}; falling back to the model CDN`);
  return `${modelBase()}/${MODEL_PATHS[key]}`;
}

/**
 * Resolves the directory the WASM runtime is loaded from.
 *
 * Probing one file is enough: the three variants ship together or not at all.
 */
async function resolveWasmBase(): Promise<string> {
  if (await servedLocally(`${localWasmBase}vision_wasm_internal.js`)) {
    log.info('using local wasm runtime');
    // MediaPipe appends its own filenames, and dislikes a trailing slash.
    return localWasmBase.replace(/\/$/, '');
  }
  log.warn('no local wasm runtime; falling back to the CDN');
  return WASM_CDN;
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
      const base = await resolveWasmBase();
      log.info(`resolving vision wasm fileset from ${base}`);
      return FilesetResolver.forVisionTasks(base);
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

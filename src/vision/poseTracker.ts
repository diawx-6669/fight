import { createLogger } from '@/core/logger';
import { Vector3Filter } from './filters';
import { buildSkeleton, JOINT_COUNT, Skeleton } from './skeleton';
import { createPoseLandmarker, type LoadProgress, type ModelKey, type PoseLandmarkerInstance } from './mediapipe';
import type { WorkerResponse } from './poseWorker';

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

/**
 * Доля кадра, которую модели разрешено занимать: интервал между прогонами не
 * меньше стоимости прогона, умноженной на это число.
 */
const INFERENCE_HEADROOM = 2.2;

/** Сколько ждём готовности воркера, прежде чем откатиться на синхронный путь. */
const WORKER_INIT_TIMEOUT_MS = 20000;

/**
 * Ширина кадра, уходящего в модель.
 *
 * Модель работает на своём внутреннем масштабе, так что больше этого не даёт
 * точности — только цену копирования.
 */
const GRAB_WIDTH = 480;

export class PoseTracker {
  private landmarker: PoseLandmarkerInstance | null = null;
  private readonly filters: Vector3Filter[] = [];

  /** Strictly increasing timestamp handed to MediaPipe. */
  private clock = 0;
  private lastDetectAt = 0;
  private lastFrameTime = 0;
  private requestedIntervalMs: number;

  /** Сглаженная стоимость одного прогона модели, миллисекунды. */
  private smoothedInferenceMs = 0;

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
    this.requestedIntervalMs = 1000 / (options.hz ?? 30);
    this.onProgress = options.onProgress;

    // Hands move fastest and need to stay crisp; hips barely move and benefit
    // from heavy smoothing. One filter per joint, tuned by body region below.
    for (let i = 0; i < JOINT_COUNT; i++) {
      this.filters.push(new Vector3Filter(filterProfileFor(i)));
    }
  }

  // --- воркер ---------------------------------------------------------------

  private worker: Worker | null = null;
  private workerReady = false;
  /** Кадр уже в пути: два сразу отдавать нельзя, очередь только растёт. */
  private frameInFlight = false;
  /** Пришёл ли новый результат с прошлого опроса. */
  private freshResult = false;
  private pendingLandmarks: { x: number; y: number; z: number; visibility?: number }[] | null = null;
  private pendingAt = 0;
  /** Холст, через который кадр видео превращается в передаваемый битмап. */
  private grab: HTMLCanvasElement | null = null;

  get isReady(): boolean {
    return this.landmarker !== null || this.workerReady;
  }

  /**
   * Пытается поднять воркер. Возвращает `false`, если не вышло.
   *
   * Неудача здесь не ошибка: старые браузеры без `createImageBitmap`, окружения
   * без модульных воркеров, блокировка воркеров политикой безопасности — всё
   * это встречается, и во всех случаях синхронный путь остаётся рабочим.
   * Игра будет дёргаться сильнее, но она будет.
   */
  async initWorker(): Promise<boolean> {
    if (this.workerReady) return true;
    if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') return false;

    try {
      const { resolveWorkerAssets } = await import('./mediapipe');
      const assets = await resolveWorkerAssets(this.model);

      // Классический воркер: MediaPipe грузит свой WASM через `importScripts`,
      // которого в модульном воркере нет.
      const worker = new Worker(new URL('./poseWorker.ts', import.meta.url));
      const ready = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), WORKER_INIT_TIMEOUT_MS);
        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
          const message = event.data;
          if (message.type === 'ready') {
            clearTimeout(timeout);
            log.info(`pose worker ready (${message.delegate})`);
            resolve(true);
            return;
          }
          if (message.type === 'error') {
            clearTimeout(timeout);
            log.warn(`pose worker failed: ${message.message}`);
            resolve(false);
          }
        };
        worker.onerror = (event) => {
          clearTimeout(timeout);
          // Сообщение из воркера — единственный способ узнать, почему он не
          // поднялся: исключение внутри него наружу не всплывает.
          log.warn(`pose worker errored: ${event.message ?? 'без сообщения'}`);
          resolve(false);
        };
      });

      worker.postMessage({
        type: 'init',
        wasmBase: assets.wasmBase,
        modelUrl: assets.modelUrl,
        delegate: 'GPU',
      });

      if (!(await ready)) {
        worker.terminate();
        return false;
      }

      // Дальше воркер только отвечает результатами.
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.onWorkerMessage(event.data);
      this.worker = worker;
      this.workerReady = true;
      return true;
    } catch (error) {
      log.warn('pose worker unavailable', error);
      return false;
    }
  }

  private onWorkerMessage(message: WorkerResponse): void {
    if (message.type === 'error') {
      log.onceWarn('worker-detect', `pose worker: ${message.message}`);
      this.frameInFlight = false;
      return;
    }
    if (message.type !== 'result') return;

    this.frameInFlight = false;
    this.noteCost(message.cost);
    this.pendingLandmarks = message.landmarks;
    this.pendingAt = message.timestamp;
    this.freshResult = true;
  }

  /**
   * Отдаёт кадр воркеру и забирает готовый результат.
   *
   * Ровно один кадр в полёте. Очередь здесь была бы худшим из решений: модель
   * медленнее камеры, очередь растёт, и игрок видит свои движения с секундной
   * задержкой, которая только копится.
   */
  private pumpWorker(video: HTMLVideoElement, now: number): boolean {
    let produced = false;

    if (this.freshResult) {
      this.freshResult = false;
      produced = this.applyLandmarks(this.pendingLandmarks, this.pendingAt || now);
    }

    if (!this.frameInFlight && now - this.lastDetectAt >= this.intervalMs) {
      this.lastDetectAt = now;
      this.sendFrame(video, now);
    }

    return produced;
  }

  private sendFrame(video: HTMLVideoElement, now: number): void {
    const worker = this.worker;
    if (!worker) return;

    // Кадр сначала уменьшается на холсте, и только потом уходит в воркер.
    // Передача битмапа бесплатна, а вот его размер — нет: модель всё равно
    // ужмёт картинку внутри себя, так что отдавать ей полный кадр значит
    // платить за копирование пикселей, которые будут выброшены.
    const width = GRAB_WIDTH;
    const height = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * width));

    if (!this.grab) this.grab = document.createElement('canvas');
    if (this.grab.width !== width || this.grab.height !== height) {
      this.grab.width = width;
      this.grab.height = height;
    }
    const ctx = this.grab.getContext('2d');
    if (!ctx) return;

    try {
      ctx.drawImage(video, 0, 0, width, height);
    } catch {
      return;
    }

    this.frameInFlight = true;
    createImageBitmap(this.grab)
      .then((bitmap) => {
        worker.postMessage({ type: 'frame', bitmap, timestamp: now }, [bitmap]);
      })
      .catch(() => {
        this.frameInFlight = false;
      });
  }

  setRate(hz: number): void {
    this.requestedIntervalMs = 1000 / Math.max(5, hz);
  }

  /**
   * Как часто на самом деле можно звать модель.
   *
   * Запрошенная частота — это пожелание, а не факт. Инференс идёт в том же
   * потоке, что и отрисовка, и если один прогон стоит 60 мс, то просьба
   * повторять его каждые 22 мс не даёт 45 Гц — она даёт игру, которая стоит
   * в инференсе почти всё время и дёргается. Ровно так это и выглядит со
   * стороны: «иногда вообще лагает».
   *
   * Поэтому нижняя граница интервала следует за измеренной стоимостью:
   * модель получает примерно 45% кадра, остальное остаётся игре. На быстрой
   * машине множитель ни на что не влияет, на медленной — сам опускает частоту
   * распознавания до той, которую машина тянет, вместо того чтобы просаживать
   * всё подряд.
   */
  private get intervalMs(): number {
    return Math.max(this.requestedIntervalMs, this.smoothedInferenceMs * INFERENCE_HEADROOM);
  }

  /**
   * Поднимает распознавание. Безопасно звать повторно — работа делается раз.
   *
   * Сначала воркер, и только если он не поднялся — модель на главном потоке.
   * Порядок важен: если оба пути заработают, мы получим две копии модели в
   * памяти и один заблокированный поток вдобавок.
   */
  async init(): Promise<void> {
    if (this.landmarker || this.workerReady) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      if (await this.initWorker()) return;
      log.warn('falling back to inference on the main thread');

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
    if (!this.enabled) return false;
    if (video.readyState < 2 || video.videoWidth === 0) return false;

    // Путь через воркер: кадр уходит в другой поток, результат забирается
    // тогда, когда он готов. Главный поток здесь никогда не ждёт.
    if (this.worker) return this.pumpWorker(video, now);

    if (!this.landmarker) return false;
    if (now - this.lastDetectAt < this.intervalMs) return false;

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
    this.noteCost(performance.now() - start);

    return this.applyLandmarks(result.landmarks?.[0] ?? null, now);
  }

  /** Учитывает стоимость прогона — по ней темпируется частота. */
  private noteCost(cost: number): void {
    this.stats.inferenceMs = cost;
    // Экспоненциальное сглаживание: один залипший кадр не должен обрушивать
    // частоту распознавания на следующую секунду, а устойчивое подорожание —
    // должно.
    this.smoothedInferenceMs = this.smoothedInferenceMs === 0
      ? cost
      : this.smoothedInferenceMs * 0.85 + cost * 0.15;
  }

  /**
   * Превращает точки модели в скелет.
   *
   * Общее для обоих путей: считает воркер или главный поток — дальше всё
   * одинаково, и сглаживание с телесными координатами живут в одном месте.
   */
  private applyLandmarks(
    landmarks: { x: number; y: number; z: number; visibility?: number }[] | null,
    now: number,
  ): boolean {
    const dt = this.lastFrameTime === 0 ? 1 / 30 : (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    const instantHz = dt > 0 ? 1 / dt : 0;
    this.stats.hz += (instantHz - this.stats.hz) * 0.1;

    if (!landmarks || landmarks.length < JOINT_COUNT) {
      this.stats.missedFrames++;
      this.stats.lostStreak++;
      this.skeleton.hasLandmarks = false;
      this.skeleton.anchorVisibility = 0;
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
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    this.frameInFlight = false;
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

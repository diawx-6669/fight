/// <reference lib="webworker" />

/**
 * Распознавание позы в отдельном потоке.
 *
 * Это ответ на единственную жалобу, которую нельзя было закрыть настройками
 * качества: игра дёргается. `detectForVideo` — синхронный вызов, и пока модель
 * считает, главный поток стоит. При стоимости прогона в пятьдесят миллисекунд
 * это значит, что каждые несколько кадров игра замирает на три кадра подряд —
 * ровно то, что человек описывает словами «иногда вообще лагает». Никакое
 * понижение качества картинки этого не лечит, потому что виновата не картинка.
 *
 * Здесь тот же вызов живёт в воркере. Главный поток отдаёт кадр и продолжает
 * рисовать; ответ приходит, когда придёт. Платим за это одним кадром задержки —
 * для игры, где важна плавность, обмен выгодный: задержку в шестнадцать
 * миллисекунд человек не замечает, а замирание на пятьдесят замечает всегда.
 *
 * Воркер намеренно ничего не знает про игру. Он получает картинку, возвращает
 * точки, и вся интерпретация — скелет, телесные координаты, детекторы —
 * остаётся на главном потоке, где её можно отлаживать обычными средствами.
 */

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

export interface InitMessage {
  type: 'init';
  /** Каталог с WASM-рантаймом — резолвится на главном потоке. */
  wasmBase: string;
  /** Полный URL файла модели. */
  modelUrl: string;
  delegate: 'GPU' | 'CPU';
}

export interface FrameMessage {
  type: 'frame';
  bitmap: ImageBitmap;
  timestamp: number;
}

export type WorkerRequest = InitMessage | FrameMessage;

export interface ReadyMessage {
  type: 'ready';
  delegate: 'GPU' | 'CPU';
}

export interface ResultMessage {
  type: 'result';
  /** 33 точки, или `null`, если человек не найден. */
  landmarks: { x: number; y: number; z: number; visibility: number }[] | null;
  timestamp: number;
  /** Сколько миллисекунд занял прогон — главный поток по нему темпирует. */
  cost: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type WorkerResponse = ReadyMessage | ResultMessage | ErrorMessage;

let landmarker: PoseLandmarker | null = null;

/**
 * Собственные часы для `detectForVideo`.
 *
 * MediaPipe требует строго возрастающих отметок и молча отдаёт мусор на
 * повторяющихся. Часы главного потока сюда не годятся: сообщения могут прийти
 * с одинаковым миллисекундным штампом.
 */
let clock = 0;

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === 'init') {
    await init(message);
    return;
  }

  if (message.type === 'frame') {
    detect(message);
  }
};

async function init(message: InitMessage): Promise<void> {
  try {
    const fileset = await FilesetResolver.forVisionTasks(message.wasmBase);

    const build = (delegate: 'GPU' | 'CPU') =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: message.modelUrl, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.55,
        outputSegmentationMasks: false,
      });

    // Тот же переход GPU → CPU, что и на главном потоке: в воркере он даже
    // нужнее, потому что WebGL здесь доступен не везде.
    let delegate = message.delegate;
    try {
      landmarker = await build(delegate);
    } catch {
      delegate = 'CPU';
      landmarker = await build('CPU');
    }

    post({ type: 'ready', delegate });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

function detect(message: FrameMessage): void {
  const bitmap = message.bitmap;

  if (!landmarker) {
    bitmap.close();
    return;
  }

  const start = performance.now();
  try {
    clock = Math.max(clock + 1, Math.round(message.timestamp));
    const result = landmarker.detectForVideo(bitmap, clock);
    const points = result.landmarks?.[0];

    post({
      type: 'result',
      // Точки копируются в простые объекты: то, что отдаёт MediaPipe, не
      // переживает структурного клонирования как есть.
      landmarks: points
        ? points.map((p) => ({
            x: p.x,
            y: p.y,
            z: p.z ?? 0,
            visibility: p.visibility ?? 0,
          }))
        : null,
      timestamp: message.timestamp,
      cost: performance.now() - start,
    });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    // Битмап обязан закрыться в любом случае: он держит память кадра, и
    // утечка здесь копится по тридцать раз в секунду.
    bitmap.close();
  }
}

function post(message: WorkerResponse): void {
  scope.postMessage(message);
}

import { createLogger } from '@/core/logger';

const log = createLogger('vision');

/**
 * Webcam acquisition and lifecycle.
 *
 * Everything the game knows about the player comes through here, so this
 * module is deliberately paranoid: it reports precise, actionable errors
 * (the browser's `NotAllowedError` alone tells a player nothing), it can swap
 * cameras mid-session, and it releases tracks aggressively because a camera
 * light that stays on after the tab is backgrounded is a real trust problem.
 */

export type CameraErrorKind =
  | 'insecure-context'
  | 'unsupported'
  | 'permission-denied'
  | 'no-device'
  | 'device-busy'
  | 'overconstrained'
  | 'unknown';

export class CameraError extends Error {
  constructor(
    readonly kind: CameraErrorKind,
    message: string,
    readonly hint: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

const ERROR_TABLE: Record<string, { kind: CameraErrorKind; message: string; hint: string }> = {
  NotAllowedError: {
    kind: 'permission-denied',
    message: 'Доступ к камере запрещён',
    hint: 'Нажми на иконку камеры в адресной строке и разреши доступ, затем обнови страницу.',
  },
  PermissionDeniedError: {
    kind: 'permission-denied',
    message: 'Доступ к камере запрещён',
    hint: 'Разреши доступ к камере в настройках сайта и обнови страницу.',
  },
  NotFoundError: {
    kind: 'no-device',
    message: 'Камера не найдена',
    hint: 'Подключи веб-камеру и обнови страницу.',
  },
  DevicesNotFoundError: {
    kind: 'no-device',
    message: 'Камера не найдена',
    hint: 'Подключи веб-камеру и обнови страницу.',
  },
  NotReadableError: {
    kind: 'device-busy',
    message: 'Камера занята другим приложением',
    hint: 'Закрой Zoom, Skype, OBS или другую вкладку, которая держит камеру.',
  },
  TrackStartError: {
    kind: 'device-busy',
    message: 'Камера занята другим приложением',
    hint: 'Закрой приложения, использующие камеру, и попробуй снова.',
  },
  OverconstrainedError: {
    kind: 'overconstrained',
    message: 'Камера не поддерживает запрошенный режим',
    hint: 'Выбери другое разрешение в настройках.',
  },
};

function toCameraError(error: unknown): CameraError {
  const name = error instanceof Error ? error.name : '';
  const entry = ERROR_TABLE[name];
  if (entry) return new CameraError(entry.kind, entry.message, entry.hint, error);
  return new CameraError(
    'unknown',
    'Не удалось включить камеру',
    'Проверь, что камера подключена и не занята другим приложением.',
    error,
  );
}

export interface CameraOptions {
  /** Requested capture width. The browser may hand back something else. */
  width?: number;
  height?: number;
  frameRate?: number;
  deviceId?: string;
  /** `user` = selfie camera, `environment` = rear camera on phones. */
  facingMode?: 'user' | 'environment';
}

export interface CameraInfo {
  readonly deviceId: string;
  readonly label: string;
}

export const DEFAULT_CAMERA_OPTIONS: Required<Omit<CameraOptions, 'deviceId'>> = {
  width: 960,
  height: 540,
  frameRate: 30,
  facingMode: 'user',
};

export class Camera {
  private stream: MediaStream | null = null;
  private currentOptions: CameraOptions = {};

  /** Actual capture size, filled in once the stream starts. */
  width = 0;
  height = 0;

  constructor(readonly video: HTMLVideoElement) {}

  get isActive(): boolean {
    return this.stream !== null && this.video.readyState >= 2;
  }

  get aspect(): number {
    return this.height > 0 ? this.width / this.height : 16 / 9;
  }

  get deviceId(): string | undefined {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId;
  }

  /** Requests the stream, attaches it to the video element and waits for frames. */
  async start(options: CameraOptions = {}): Promise<void> {
    if (!window.isSecureContext) {
      throw new CameraError(
        'insecure-context',
        'Нужно защищённое соединение',
        'Открой игру по https:// или с localhost — браузер не даёт камеру по http.',
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError(
        'unsupported',
        'Браузер не поддерживает захват видео',
        'Попробуй свежий Chrome, Edge, Firefox или Safari.',
      );
    }

    this.stop();
    const merged = { ...DEFAULT_CAMERA_OPTIONS, ...options };
    this.currentOptions = merged;

    const video: MediaTrackConstraints = {
      width: { ideal: merged.width },
      height: { ideal: merged.height },
      frameRate: { ideal: merged.frameRate },
    };
    // `deviceId` and `facingMode` conflict; an explicit pick always wins.
    if (options.deviceId) video.deviceId = { exact: options.deviceId };
    else video.facingMode = merged.facingMode;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (error) {
      // An exact deviceId that has since been unplugged throws; retry loosely
      // rather than dead-ending the player on a stale saved setting.
      if (options.deviceId && error instanceof Error && error.name === 'OverconstrainedError') {
        log.warn('saved camera unavailable, falling back to default device');
        return this.start({ ...options, deviceId: undefined });
      }
      throw toCameraError(error);
    }

    this.stream = stream;
    this.video.srcObject = stream;
    this.video.playsInline = true;
    this.video.muted = true;

    await this.waitForMetadata();
    try {
      await this.video.play();
    } catch (error) {
      // Autoplay policy: a muted, playsinline video is normally allowed, but
      // if it is not the caller can retry from a user gesture.
      log.warn('video.play() rejected', error);
    }

    const settings = stream.getVideoTracks()[0]?.getSettings() ?? {};
    this.width = this.video.videoWidth || settings.width || merged.width;
    this.height = this.video.videoHeight || settings.height || merged.height;

    log.info(`camera started ${this.width}x${this.height} @ ${settings.frameRate ?? '?'}fps`);
  }

  private waitForMetadata(): Promise<void> {
    if (this.video.readyState >= 1 && this.video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(
          new CameraError(
            'unknown',
            'Камера не отдала изображение',
            'Попробуй переподключить камеру или выбрать другую в настройках.',
          ),
        );
      }, 10_000);

      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(
          new CameraError(
            'unknown',
            'Ошибка видеопотока',
            'Переподключи камеру и попробуй снова.',
          ),
        );
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        this.video.removeEventListener('loadedmetadata', onReady);
        this.video.removeEventListener('error', onError);
      };

      this.video.addEventListener('loadedmetadata', onReady, { once: true });
      this.video.addEventListener('error', onError, { once: true });
    });
  }

  /** Lists available cameras. Labels are blank until permission is granted once. */
  async listDevices(): Promise<CameraInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((device) => device.kind === 'videoinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Камера ${index + 1}`,
        }));
    } catch (error) {
      log.warn('enumerateDevices failed', error);
      return [];
    }
  }

  async switchTo(deviceId: string): Promise<void> {
    await this.start({ ...this.currentOptions, deviceId });
  }

  stop(): void {
    if (!this.stream) return;
    for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
    this.video.srcObject = null;
    log.info('camera stopped');
  }
}

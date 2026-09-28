import { createLogger } from '@/core/logger';
import { EventBus } from '@/core/events';
import { Camera, CameraError, type CameraInfo } from './camera';
import { Calibrator, loadCalibration, saveCalibration, type CalibrationProfile } from './calibration';
import { GestureRecognizer, type GestureState } from './gestures';
import { HandTracker } from './handTracker';
import { PoseTracker } from './poseTracker';
import { MotionAnalyzer } from './motion/analyzer';
import type { ActionEvent, MotionState } from './motion/types';
import type { Skeleton } from './skeleton';

const log = createLogger('vision');

/**
 * The single façade the rest of the game talks to.
 *
 * Everything camera-shaped lives behind this class: acquisition, two models,
 * six detectors, calibration and gestures. The game asks for a *mode* and gets
 * back either body actions or a hand cursor, and never has to think about
 * inference scheduling or which model is currently loaded.
 *
 * Running only what the current screen needs is the whole point. Pose and hand
 * inference each cost real milliseconds, and running both during a fight would
 * halve the frame rate to power a cursor nobody is looking at.
 */

export type VisionMode = 'off' | 'pose' | 'hands' | 'both';

export interface VisionEvents {
  /** A discrete body action — punch, kick, jump, dodge. */
  action: ActionEvent;
  /** Camera started successfully. */
  ready: { width: number; height: number };
  /** Something went wrong; the payload is player-facing. */
  error: { title: string; hint: string };
  /** The player left or re-entered the camera's view. */
  presence: { present: boolean };
  /** Calibration finished and a profile is available. */
  calibrated: CalibrationProfile;
}

export interface VisionStatus {
  mode: VisionMode;
  cameraActive: boolean;
  poseReady: boolean;
  handsReady: boolean;
  /** Player is visible and trackable. */
  present: boolean;
  /** Tracking confidence, `[0, 1]`. */
  quality: number;
  /** Achieved pose inference rate. */
  hz: number;
  /** Milliseconds of the last inference. */
  inferenceMs: number;
}

export interface VisionOptions {
  video: HTMLVideoElement;
  /** Called with human-readable progress while models download. */
  onProgress?: (stage: string, ratio: number) => void;
}

export class VisionSystem {
  readonly events = new EventBus<VisionEvents>();
  readonly camera: Camera;
  readonly pose: PoseTracker;
  readonly hands: HandTracker;
  readonly analyzer: MotionAnalyzer;
  readonly gestures: GestureRecognizer;
  readonly calibrator = new Calibrator();

  private mode: VisionMode = 'off';
  private wasPresent = false;
  private calibrating = false;
  private lastGestureTick = 0;
  private readonly drained: ActionEvent[] = [];

  readonly status: VisionStatus = {
    mode: 'off',
    cameraActive: false,
    poseReady: false,
    handsReady: false,
    present: false,
    quality: 0,
    hz: 0,
    inferenceMs: 0,
  };

  constructor(private readonly options: VisionOptions) {
    this.camera = new Camera(options.video);
    this.pose = new PoseTracker({ onProgress: options.onProgress });
    this.hands = new HandTracker({ onProgress: options.onProgress });
    this.analyzer = new MotionAnalyzer({ calibration: loadCalibration() });
    this.gestures = new GestureRecognizer();
  }

  get skeleton(): Skeleton {
    return this.pose.skeleton;
  }

  get motion(): MotionState {
    return this.analyzer.state;
  }

  get gesture(): GestureState {
    return this.gestures.state;
  }

  get calibration(): CalibrationProfile {
    return this.analyzer.calibration;
  }

  /** Starts the camera. Safe to call again; a running camera is left alone. */
  async startCamera(deviceId?: string): Promise<boolean> {
    if (this.camera.isActive && !deviceId) return true;
    try {
      await this.camera.start(deviceId ? { deviceId } : {});
      this.status.cameraActive = true;
      this.events.emit('ready', { width: this.camera.width, height: this.camera.height });
      return true;
    } catch (error) {
      this.status.cameraActive = false;
      const cameraError =
        error instanceof CameraError
          ? error
          : new CameraError('unknown', 'Ошибка камеры', 'Попробуй перезагрузить страницу.', error);
      log.error(cameraError.message, cameraError.cause ?? '');
      this.events.emit('error', { title: cameraError.message, hint: cameraError.hint });
      return false;
    }
  }

  /**
   * Switches which models run. Loading happens on demand, so the first fight
   * pays for the pose model and the first gesture menu pays for the hand model.
   */
  async setMode(mode: VisionMode): Promise<void> {
    if (this.mode === mode) return;
    log.info(`vision mode ${this.mode} → ${mode}`);
    this.mode = mode;
    this.status.mode = mode;

    const needsPose = mode === 'pose' || mode === 'both';
    const needsHands = mode === 'hands' || mode === 'both';

    this.pose.enabled = needsPose;
    this.hands.enabled = needsHands;

    // Running both halves the budget each gets, so each model's rate is cut.
    if (mode === 'both') {
      this.pose.setRate(24);
      this.hands.setRate(18);
    } else {
      this.pose.setRate(this.preferredPoseHz);
      this.hands.setRate(24);
    }

    const work: Promise<void>[] = [];
    if (needsPose && !this.pose.isReady) work.push(this.pose.init());
    if (needsHands && !this.hands.isReady) work.push(this.hands.init());

    if (work.length > 0) {
      try {
        await Promise.all(work);
      } catch (error) {
        log.error('model load failed', error);
        this.events.emit('error', {
          title: 'Не удалось загрузить модель распознавания',
          hint: 'Проверь интернет-соединение и обнови страницу.',
        });
        return;
      }
    }

    this.status.poseReady = this.pose.isReady;
    this.status.handsReady = this.hands.isReady;
    this.pose.reset();
    this.hands.reset();
    this.analyzer.reset();
    this.gestures.resetDwell();
  }

  private preferredPoseHz = 30;

  /** Applies the quality tier's inference budget. */
  setPoseRate(hz: number): void {
    this.preferredPoseHz = hz;
    if (this.mode !== 'both') this.pose.setRate(hz);
  }

  setMirrored(mirrored: boolean): void {
    this.pose.mirrored = mirrored;
    this.hands.mirrored = mirrored;
    this.pose.reset();
    this.hands.reset();
  }

  setSensitivity(value: number): void {
    this.analyzer.setSensitivity(value);
  }

  /** Call once per render frame. Cheap when nothing is due. */
  update(now: number): void {
    if (!this.camera.isActive || this.mode === 'off') return;

    const video = this.options.video;

    if (this.pose.enabled && this.pose.update(video, now)) {
      const skeleton = this.pose.skeleton;

      if (this.calibrating) {
        // While calibrating the detectors stay quiet: the player is following
        // instructions, not fighting, and every reach would read as a punch.
        const dt = 1 / Math.max(this.pose.stats.hz, 10);
        if (this.calibrator.update(skeleton, dt)) this.completeCalibration();
      } else {
        this.analyzer.update(skeleton);
        this.drained.length = 0;
        this.analyzer.drain(this.drained);
        for (const event of this.drained) this.events.emit('action', event);
      }

      this.status.quality = this.analyzer.state.quality;
      this.updatePresence(skeleton.present);
    }

    if (this.hands.enabled && this.hands.update(video, now)) {
      const dt = this.lastGestureTick === 0 ? 1 / 24 : (now - this.lastGestureTick) / 1000;
      this.lastGestureTick = now;
      this.gestures.update(this.hands.primary, Math.min(dt, 0.2));
      if (!this.pose.enabled) this.updatePresence(this.gestures.state.present);
    }

    this.status.hz = this.pose.stats.hz;
    this.status.inferenceMs = this.pose.stats.inferenceMs;
  }

  private updatePresence(present: boolean): void {
    this.status.present = present;
    if (present === this.wasPresent) return;
    this.wasPresent = present;
    this.events.emit('presence', { present });
  }

  // --- calibration ---------------------------------------------------------

  startCalibration(): void {
    this.calibrating = true;
    this.analyzer.flush();
    this.calibrator.start();
  }

  cancelCalibration(): void {
    this.calibrating = false;
    this.calibrator.cancel();
  }

  get isCalibrating(): boolean {
    return this.calibrating;
  }

  private completeCalibration(): void {
    this.calibrating = false;
    const profile = this.calibrator.profile;
    if (!profile) return;
    saveCalibration(profile);
    this.analyzer.setCalibration(profile);
    this.events.emit('calibrated', profile);
  }

  // --- lifecycle -----------------------------------------------------------

  listCameras(): Promise<CameraInfo[]> {
    return this.camera.listDevices();
  }

  /** Pauses inference without releasing the camera — used when the tab hides. */
  suspend(): void {
    this.pose.enabled = false;
    this.hands.enabled = false;
  }

  resume(): void {
    this.pose.enabled = this.mode === 'pose' || this.mode === 'both';
    this.hands.enabled = this.mode === 'hands' || this.mode === 'both';
    this.pose.reset();
    this.hands.reset();
    this.analyzer.reset();
  }

  dispose(): void {
    this.camera.stop();
    this.pose.dispose();
    this.hands.dispose();
    this.events.clear();
    this.status.cameraActive = false;
  }
}

export * from './skeleton';
export * from './motion/types';
export { CameraError } from './camera';
export type { CameraInfo } from './camera';
export type { CalibrationProfile, CalibrationState } from './calibration';
export { assessFraming } from './calibration';
export type { GestureState } from './gestures';

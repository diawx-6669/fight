import { clamp, mean, standardDeviation } from '@/core/math';
import { load, save, StorageKeys } from '@/core/storage';
import { createLogger } from '@/core/logger';
import { Joint, type Skeleton } from './skeleton';

const log = createLogger('vision');

/**
 * Calibration.
 *
 * Detection thresholds cannot be universal. A player standing two metres back
 * in a cramped room produces a punch that travels a third of the pixels of the
 * same punch thrown close to the lens; someone with limited shoulder mobility
 * throws a hook that never reaches the "textbook" extension.
 *
 * So the game spends eight seconds measuring *this* player in *this* room and
 * stores a profile that every detector scales its thresholds by. It is the
 * difference between "the game ignores half my punches" and "it just works".
 */

export interface CalibrationProfile {
  /** Schema version, so an old stored profile is discarded rather than trusted. */
  version: number;

  /** Median torso length in image units — the player's distance from the camera. */
  torsoLength: number;

  /** Resting wrist height in body units (negative = below the hips). */
  restWristY: number;

  /** Resting horizontal wrist offset from the body centre line. */
  restWristX: number;

  /** Highest reach the player demonstrated, in body units above the hips. */
  reachUp: number;

  /** Furthest the wrist got from the shoulder, in body units. The punch scale. */
  reachForward: number;

  /** Hip height above the floor line while standing, in body units. */
  standingHipY: number;

  /** How much the pose jitters at rest — high values mean poor lighting. */
  noiseFloor: number;

  /** Horizontal centre of the play area in image space. */
  centerX: number;

  /** Vertical floor line in image space. Used to place the fighter's feet. */
  floorY: number;

  /** Overall confidence in the calibration, `[0, 1]`. */
  quality: number;

  /** When it was captured, so the UI can offer to redo a stale profile. */
  capturedAt: number;
}

export const CALIBRATION_VERSION = 2;

/**
 * A neutral default that lets someone play immediately without calibrating.
 * It assumes an average adult, roughly two metres from a laptop camera.
 */
export const DEFAULT_CALIBRATION: CalibrationProfile = {
  version: CALIBRATION_VERSION,
  torsoLength: 0.22,
  restWristY: -0.75,
  restWristX: 0.62,
  reachUp: 1.85,
  reachForward: 1.55,
  standingHipY: 2.1,
  noiseFloor: 0.012,
  centerX: 0.5,
  floorY: 0.98,
  quality: 0.5,
  capturedAt: 0,
};

export type CalibrationStage =
  | 'idle'
  | 'framing'
  | 'rest'
  | 'reach'
  | 'stance'
  | 'done'
  | 'failed';

export interface CalibrationState {
  stage: CalibrationStage;
  /** Progress through the current stage, `[0, 1]`. */
  progress: number;
  /** Instruction to show the player, in Russian. */
  prompt: string;
  /** Extra hint line, or empty. */
  hint: string;
  /** Set when the stage failed, explaining why. */
  problem: string;
}

/** Seconds each measuring stage runs for. */
const STAGE_DURATION: Record<CalibrationStage, number> = {
  idle: 0,
  framing: 0, // framing waits for the player, it is not timed
  rest: 2.5,
  reach: 3.5,
  stance: 2.5,
  done: 0,
  failed: 0,
};

/**
 * Runs the calibration flow. Feed it a skeleton every vision frame; read
 * `state` for the UI and `profile` once `stage === 'done'`.
 */
export class Calibrator {
  readonly state: CalibrationState = {
    stage: 'idle',
    progress: 0,
    prompt: '',
    hint: '',
    problem: '',
  };

  private elapsed = 0;
  private framingHeldFor = 0;

  // Sample buffers, one per measurement.
  private torsoSamples: number[] = [];
  private wristYSamples: number[] = [];
  private wristXSamples: number[] = [];
  private hipXSamples: number[] = [];
  private floorSamples: number[] = [];
  private hipHeightSamples: number[] = [];
  private reachUpPeak = 0;
  private reachForwardPeak = 0;

  private result: CalibrationProfile | null = null;

  get profile(): CalibrationProfile | null {
    return this.result;
  }

  start(): void {
    this.reset();
    this.state.stage = 'framing';
    this.state.prompt = 'Встань так, чтобы тебя было видно целиком';
    this.state.hint = 'Отойди на 2–3 шага от камеры';
  }

  cancel(): void {
    this.reset();
  }

  private reset(): void {
    this.elapsed = 0;
    this.framingHeldFor = 0;
    this.torsoSamples = [];
    this.wristYSamples = [];
    this.wristXSamples = [];
    this.hipXSamples = [];
    this.floorSamples = [];
    this.hipHeightSamples = [];
    this.reachUpPeak = 0;
    this.reachForwardPeak = 0;
    this.result = null;
    this.state.stage = 'idle';
    this.state.progress = 0;
    this.state.problem = '';
  }

  /** Advances the flow. Returns `true` when calibration has just finished. */
  update(skeleton: Skeleton, dt: number): boolean {
    switch (this.state.stage) {
      case 'framing':
        return this.updateFraming(skeleton, dt);
      case 'rest':
        return this.updateRest(skeleton, dt);
      case 'reach':
        return this.updateReach(skeleton, dt);
      case 'stance':
        return this.updateStance(skeleton, dt);
      default:
        return false;
    }
  }

  // --- stages --------------------------------------------------------------

  private updateFraming(skeleton: Skeleton, dt: number): boolean {
    const framing = assessFraming(skeleton);
    this.state.hint = framing.hint;
    this.state.problem = framing.ok ? '' : framing.hint;

    if (!framing.ok) {
      this.framingHeldFor = 0;
      this.state.progress = 0;
      return false;
    }

    // Require a full second of good framing so the player has actually settled
    // rather than passing through a valid pose on the way somewhere else.
    this.framingHeldFor += dt;
    this.state.progress = clamp(this.framingHeldFor / 1, 0, 1);
    if (this.framingHeldFor >= 1) this.enter('rest');
    return false;
  }

  private updateRest(skeleton: Skeleton, dt: number): boolean {
    if (!skeleton.present) return false;
    this.elapsed += dt;
    this.state.progress = clamp(this.elapsed / STAGE_DURATION.rest, 0, 1);

    this.torsoSamples.push(skeleton.torsoLength);
    this.hipXSamples.push(skeleton.hipX);
    this.floorSamples.push(skeleton.floorY);

    const leftWrist = skeleton.at(Joint.LeftWrist);
    const rightWrist = skeleton.at(Joint.RightWrist);
    this.wristYSamples.push((leftWrist.y + rightWrist.y) / 2);
    this.wristXSamples.push((Math.abs(leftWrist.x) + Math.abs(rightWrist.x)) / 2);

    if (this.elapsed >= STAGE_DURATION.rest) this.enter('reach');
    return false;
  }

  private updateReach(skeleton: Skeleton, dt: number): boolean {
    if (!skeleton.present) return false;
    this.elapsed += dt;
    this.state.progress = clamp(this.elapsed / STAGE_DURATION.reach, 0, 1);

    const leftWrist = skeleton.at(Joint.LeftWrist);
    const rightWrist = skeleton.at(Joint.RightWrist);
    const leftShoulder = skeleton.at(Joint.LeftShoulder);
    const rightShoulder = skeleton.at(Joint.RightShoulder);

    this.reachUpPeak = Math.max(this.reachUpPeak, leftWrist.y, rightWrist.y);

    const leftReach = Math.hypot(leftWrist.x - leftShoulder.x, leftWrist.y - leftShoulder.y);
    const rightReach = Math.hypot(rightWrist.x - rightShoulder.x, rightWrist.y - rightShoulder.y);
    this.reachForwardPeak = Math.max(this.reachForwardPeak, leftReach, rightReach);

    if (this.elapsed >= STAGE_DURATION.reach) this.enter('stance');
    return false;
  }

  private updateStance(skeleton: Skeleton, dt: number): boolean {
    if (!skeleton.present) return false;
    this.elapsed += dt;
    this.state.progress = clamp(this.elapsed / STAGE_DURATION.stance, 0, 1);

    this.floorSamples.push(skeleton.floorY);
    // Hip height above the floor, in body units — the reference the jump and
    // crouch detectors measure against.
    const hipAboveFloor = (skeleton.floorY - skeleton.hipY) / skeleton.torsoLength;
    this.hipHeightSamples.push(hipAboveFloor);

    if (this.elapsed >= STAGE_DURATION.stance) {
      this.finish();
      return true;
    }
    return false;
  }

  private enter(stage: CalibrationStage): void {
    this.state.stage = stage;
    this.state.progress = 0;
    this.state.problem = '';
    this.elapsed = 0;

    switch (stage) {
      case 'rest':
        this.state.prompt = 'Стой спокойно, руки вдоль тела';
        this.state.hint = 'Замеряю твою нейтральную стойку';
        break;
      case 'reach':
        this.state.prompt = 'Вытяни руки вверх и в стороны';
        this.state.hint = 'Покажи максимальный размах — это твоя дальность удара';
        break;
      case 'stance':
        this.state.prompt = 'Встань в боевую стойку';
        this.state.hint = 'Ноги на ширине плеч, кулаки у лица';
        break;
      case 'done':
        this.state.prompt = 'Готово';
        this.state.hint = '';
        break;
      default:
        break;
    }
  }

  private finish(): void {
    const torsoLength = median(this.torsoSamples);

    if (this.torsoSamples.length < 10 || torsoLength <= 0.02) {
      this.state.stage = 'failed';
      this.state.prompt = 'Не удалось откалиброваться';
      this.state.problem = 'Камера почти не видела тебя. Проверь свет и встань дальше.';
      log.warn('calibration failed: insufficient samples');
      return;
    }

    // Jitter of the torso length while standing still is the cleanest proxy we
    // have for tracking quality: it should be near zero for a still player.
    const noiseFloor = standardDeviation(this.torsoSamples) / Math.max(torsoLength, 1e-4);

    const profile: CalibrationProfile = {
      version: CALIBRATION_VERSION,
      torsoLength,
      restWristY: median(this.wristYSamples),
      restWristX: median(this.wristXSamples),
      // Clamp against the defaults: a player who did not follow the reach
      // instruction would otherwise end up with thresholds nothing can hit.
      reachUp: clamp(this.reachUpPeak, 1.1, 3),
      reachForward: clamp(this.reachForwardPeak, 0.9, 2.6),
      standingHipY: clamp(median(this.hipHeightSamples), 1.2, 3.4),
      noiseFloor: clamp(noiseFloor, 0.002, 0.2),
      centerX: clamp(median(this.hipXSamples), 0.15, 0.85),
      floorY: clamp(median(this.floorSamples), 0.4, 1.2),
      quality: 0,
      capturedAt: Date.now(),
    };

    // Quality: good tracking is a steady torso, a reach that looks like a real
    // human's, and a body that filled a sensible part of the frame.
    const steadiness = clamp(1 - profile.noiseFloor / 0.06, 0, 1);
    const reachSanity = clamp((profile.reachForward - 0.9) / 0.7, 0, 1);
    const framing = clamp((profile.torsoLength - 0.1) / 0.16, 0, 1);
    profile.quality = clamp(steadiness * 0.5 + reachSanity * 0.3 + framing * 0.2, 0, 1);

    this.result = profile;
    this.enter('done');
    log.info('calibration complete', profile);
  }
}

// --- framing checks --------------------------------------------------------

export interface FramingAssessment {
  ok: boolean;
  hint: string;
  /** `-1` too close, `0` good, `1` too far. */
  distance: number;
}

/**
 * Checks whether the player is usable in frame, with a hint aimed at the one
 * thing most worth fixing rather than a list of complaints.
 */
export function assessFraming(skeleton: Skeleton): FramingAssessment {
  if (!skeleton.present) {
    return { ok: false, hint: 'Тебя не видно — встань перед камерой', distance: 0 };
  }
  if (skeleton.confidence < 0.5) {
    return { ok: false, hint: 'Плохо видно — добавь света в комнате', distance: 0 };
  }

  const hipX = skeleton.hipX;
  if (hipX < 0.15) return { ok: false, hint: 'Сместись правее — ты у края кадра', distance: 0 };
  if (hipX > 0.85) return { ok: false, hint: 'Сместись левее — ты у края кадра', distance: 0 };

  // Upper-body play is supported, not a failure state. Most people sit at a
  // laptop where the camera never sees below the ribs, and refusing to start
  // until they find a room where their feet fit in frame is how a camera game
  // gets uninstalled. Kicks need legs; everything else does not.
  if (!skeleton.legsVisible) {
    if (skeleton.shoulderWidth > 0.42) {
      return { ok: false, hint: 'Слишком близко — сделай шаг назад', distance: -1 };
    }
    if (skeleton.shoulderWidth < 0.06) {
      return { ok: false, hint: 'Слишком далеко — подойди ближе', distance: 1 };
    }
    return {
      ok: true,
      hint: 'Вижу верх тела — этого хватит. Для ударов ногами отойди дальше',
      distance: 0,
    };
  }

  if (skeleton.torsoLength > 0.34) {
    return { ok: false, hint: 'Слишком близко — сделай шаг назад', distance: -1 };
  }
  if (skeleton.torsoLength < 0.08) {
    return { ok: false, hint: 'Слишком далеко — подойди ближе', distance: 1 };
  }

  return { ok: true, hint: 'Отлично, видно целиком', distance: 0 };
}

// --- persistence -----------------------------------------------------------

export function loadCalibration(): CalibrationProfile {
  const stored = load<CalibrationProfile | null>(StorageKeys.calibration, null);
  // A profile from an older schema describes measurements that no longer mean
  // the same thing, so it is thrown away rather than migrated.
  if (!stored || stored.version !== CALIBRATION_VERSION) return { ...DEFAULT_CALIBRATION };
  return { ...DEFAULT_CALIBRATION, ...stored };
}

export function saveCalibration(profile: CalibrationProfile): void {
  save(StorageKeys.calibration, profile);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  // Median rather than mean: a single frame where MediaPipe guessed wildly
  // would otherwise drag the whole calibration with it.
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export { mean };

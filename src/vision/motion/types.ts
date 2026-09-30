import type { CalibrationProfile } from '../calibration';
import type { Skeleton } from '../skeleton';
import type { MistakeCode, MistakeLog } from './coach';

/**
 * The contract between "what the camera saw" and "what the fighter does".
 *
 * Everything downstream of this file is ordinary game code that knows nothing
 * about cameras, and everything upstream knows nothing about fighting. This
 * boundary is what lets the same simulation be driven by a keyboard in the
 * training room and by a body in a real match.
 */

export type ActionKind =
  | 'punch'
  | 'kick'
  | 'jump'
  | 'crouch'
  | 'dodge'
  | 'block'
  | 'parry';

export type Side = 'left' | 'right' | 'none';

/** Where on the opponent the strike lands, which decides what blocks it. */
export type StrikeHeight = 'high' | 'mid' | 'low';

/** The specific technique recognised, used to pick the animation and frame data. */
export type Technique =
  | 'jab'
  | 'cross'
  | 'hook'
  | 'uppercut'
  | 'overhead'
  | 'lowKick'
  | 'midKick'
  | 'highKick'
  | 'pushKick'
  | 'kneeStrike'
  | 'none';

/** A discrete thing the player did, emitted once at the moment of commitment. */
export interface ActionEvent {
  kind: ActionKind;
  technique: Technique;
  side: Side;
  height: StrikeHeight;
  /** Normalised strength, `[0, 1]`, from measured limb speed against calibration. */
  power: number;
  /** Direction of travel in body space, radians. 0 = forward, PI/2 = up. */
  angle: number;
  /** How sure the detector is, `[0, 1]`. Low-confidence hits do chip damage only. */
  confidence: number;
  /** Camera-frame timestamp in milliseconds. */
  timestamp: number;
}

/**
 * Continuous body state, sampled every frame rather than fired as an event.
 * Blocking, crouching and leaning are *held*, not *thrown*.
 */
export interface MotionState {
  /** Hands are up in a guard. */
  guarding: boolean;
  /** How high the guard sits: `0` = belt, `1` = covering the head. */
  guardHeight: number;
  /** `0` = standing tall, `1` = fully crouched. */
  crouch: number;
  /** Lateral weave, `-1` = slipped left, `+1` = slipped right. */
  lean: number;
  /** Feet are off the floor. */
  airborne: boolean;
  /** Normalised air time, `0` on the ground, peaking at `1` at the apex. */
  airHeight: number;
  /**
   * Stepping intent relative to the opponent, `-1` = backing off, `+1` =
   * closing in. From the camera this is a step *towards* the lens (forward)
   * or away from it (back) — the direction a person means by "go forward".
   */
  advance: number;
  /**
   * Сдвиг по комнате вбок, в *экранных* координатах: `+1` — шаг вправо, как
   * его видит сам игрок в зеркальном превью. Отдельно от `advance`, потому
   * что «вправо» — это «вперёд» только пока боец стоит слева. После
   * перепрыгивания противника тот же шаг должен уводить назад.
   */
  stepX: number;
  /** How wide the stance is relative to the calibrated neutral. */
  stance: number;
  /** Overall trust in the reading, `[0, 1]`. Drops when the player leaves frame. */
  quality: number;
}

export function createMotionState(): MotionState {
  return {
    guarding: false,
    guardHeight: 0,
    crouch: 0,
    lean: 0,
    airborne: false,
    airHeight: 0,
    advance: 0,
    stepX: 0,
    stance: 0,
    quality: 0,
  };
}

/** What every detector receives on each vision frame. */
export interface MotionContext {
  readonly skeleton: Skeleton;
  /**
   * Куда детектор пишет, почему он *не* сработал.
   *
   * Передаётся всем, потому что иначе каждый отказ пришлось бы возвращать
   * наружу отдельным каналом, а отказов у одного только удара семь штук.
   */
  readonly mistakes: MistakeLog;
  readonly calibration: CalibrationProfile;
  /** Seconds since the previous vision frame. */
  readonly dt: number;
  /** Camera-frame timestamp in milliseconds. */
  readonly now: number;
  /**
   * Global sensitivity, `0.5` (hard to trigger) to `1.5` (very twitchy).
   * Multiplies every detector's threshold so one slider tunes the whole feel.
   */
  readonly sensitivity: number;
  /**
   * Автоподстройка: на это число делятся пороги.
   *
   * Отдельно от `sensitivity`, хотя множитель по сути тот же. Чувствительность
   * выставил человек, и трогать её игра не вправе; помощь игра назначила себе
   * сама, и смешивать их значило бы незаметно переписывать чужую настройку.
   */
  readonly assist: number;
  /**
   * Ошибки, которые повторились столько раз, что игра перестала их считать
   * ошибками (см. `forgive.ts`). Детектор непрерывного состояния — присед —
   * читает это и сам опускает планку: событием его не заменишь, его держат.
   */
  readonly forgiven: ReadonlySet<MistakeCode>;
}

/** A detector emits zero or one action per frame and may update shared state. */
export interface MotionDetector {
  readonly name: string;
  update(context: MotionContext, state: MotionState): ActionEvent | null;
  reset(): void;
}

/** Convenience factory so detectors do not repeat the default fields. */
export function action(partial: Partial<ActionEvent> & Pick<ActionEvent, 'kind'>): ActionEvent {
  return {
    technique: 'none',
    side: 'none',
    height: 'mid',
    power: 0.5,
    angle: 0,
    confidence: 1,
    timestamp: 0,
    ...partial,
  };
}

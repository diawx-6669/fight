/**
 * Headless-вход для `punch-check.mjs`.
 *
 * Гоняет настоящий детектор удара по синтетической последовательности кадров:
 * никакого DOM, никакой камеры. Именно этот путь проходит каждый живой игрок,
 * и именно его нельзя проверить из браузерного теста — без вебкамеры игра
 * уходит на процедурную анимацию и детектор не трогает вовсе.
 */

import { DEFAULT_CALIBRATION, type CalibrationProfile } from '@/vision/calibration';
import { buildSkeleton, Skeleton } from '@/vision/skeleton';
import { MotionAnalyzer } from '@/vision/motion/analyzer';
import type { ActionEvent } from '@/vision/motion/types';
import type { MistakeCode } from '@/vision/motion/coach';

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface PunchRunResult {
  /** Насколько игра облегчила себе пороги, в процентах. */
  assistPercent: number;
  /** Какие ошибки игра простила. */
  forgiven: MistakeCode[];
  actions: { kind: string; technique: string; side: string; power: number }[];
  mistakes: { code: MistakeCode; count: number }[];
  hint: { code: MistakeCode; title: string; fix: string; progress: number } | null;
  quality: number;
  /** Самый сильный «шаг» за прогон: к камере/от неё и вбок. */
  maxAdvance: number;
  minAdvance: number;
  maxStepX: number;
  upperBodyOnly: boolean;
  torsoLength: number;
}

/**
 * Прогоняет кадры через скелет и анализатор.
 *
 * `frames` — последовательность наборов ландмарок, по 33 на кадр, с шагом
 * `stepMs`. Детекторы берут dt из отметок времени скелета, а не из часов
 * рендера, поэтому шаг здесь задаёт реальную скорость движения.
 */
export function runPunch(
  frames: Landmark[][],
  options: {
    stepMs?: number;
    sensitivity?: number;
    calibration?: Partial<CalibrationProfile>;
    /** Зафиксировать автоподстройку на этом уровне — для прямого сравнения. */
    assist?: number;
    /** `false` — выключить режим прощения, чтобы мерить сами пороги. */
    forgive?: boolean;
  } = {},
): PunchRunResult {
  const stepMs = options.stepMs ?? 33;
  const calibration: CalibrationProfile = { ...DEFAULT_CALIBRATION, ...options.calibration };

  const analyzer = new MotionAnalyzer({ sensitivity: options.sensitivity ?? 1, calibration });
  if (options.assist !== undefined) {
    analyzer.assist.level = options.assist;
    // Пин: иначе собственная логика подстройки тут же сдвинет уровень, и
    // сравнение перестанет быть сравнением.
    analyzer.assist.noteMistake = () => {};
    analyzer.assist.noteHit = () => {};
  }
  if (options.forgive === false) analyzer.forgiveness.consider = () => null;
  const skeleton = new Skeleton();
  const actions: ActionEvent[] = [];

  let maxAdvance = 0;
  let minAdvance = 0;
  let maxStepX = 0;
  for (let i = 0; i < frames.length; i++) {
    const present = buildSkeleton(skeleton, frames[i], i * stepMs, false);
    if (present) analyzer.update(skeleton);
    analyzer.drain(actions);
    maxAdvance = Math.max(maxAdvance, analyzer.state.advance);
    minAdvance = Math.min(minAdvance, analyzer.state.advance);
    maxStepX = Math.max(maxStepX, analyzer.state.stepX);
  }

  const hint = analyzer.mistakes.hint;
  return {
    assistPercent: analyzer.assist.percent,
    forgiven: [...analyzer.forgiveness.forgiven],
    actions: actions.map((a) => ({
      kind: a.kind,
      technique: a.technique,
      side: a.side,
      power: a.power,
    })),
    mistakes: [...analyzer.mistakes.tally].map(([code, count]) => ({ code, count })),
    hint: hint
      ? { code: hint.code, title: hint.title, fix: hint.fix, progress: hint.progress }
      : null,
    quality: analyzer.state.quality,
    maxAdvance,
    minAdvance,
    maxStepX,
    upperBodyOnly: skeleton.upperBodyOnly,
    torsoLength: skeleton.torsoLength,
  };
}

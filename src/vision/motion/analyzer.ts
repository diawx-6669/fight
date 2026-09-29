import { createLogger } from '@/core/logger';
import { clamp } from '@/core/math';
import type { CalibrationProfile } from '../calibration';
import { DEFAULT_CALIBRATION } from '../calibration';
import type { Skeleton } from '../skeleton';
import { DodgeDetector } from './dodge';
import { GuardDetector } from './guard';
import { KickDetector } from './kick';
import { LocomotionDetector } from './locomotion';
import { PunchDetector } from './punch';
import { MistakeLog } from './coach';
import { createMotionState, type ActionEvent, type MotionContext, type MotionState } from './types';

const log = createLogger('motion');

/**
 * Runs every detector in the right order and hands the game a tidy result.
 *
 * Order is not arbitrary. Locomotion runs first because it establishes whether
 * the player is airborne or crouched, and both the kick and guard detectors
 * need that to avoid firing during a jump. Guard runs before the strikes so a
 * punch detector can see that the hands are up and raise its own bar.
 *
 * The analyzer also owns two policies that would be wrong to duplicate inside
 * each detector:
 *
 *   - **Global action cooldown.** However clean the detection, a human cannot
 *     throw two distinct techniques 40ms apart. Anything that close is the same
 *     motion being seen twice.
 *
 *   - **Frame budget.** When tracking quality collapses — the player walked out
 *     of shot, the lights went off — every detector is muted rather than left
 *     to produce confident nonsense.
 */

export interface AnalyzerOptions {
  sensitivity?: number;
  calibration?: CalibrationProfile;
}

export interface AnalyzerDebug {
  /** Last action emitted, retained for the on-screen debug readout. */
  lastAction: ActionEvent | null;
  /** Actions emitted since the last reset. */
  actionCount: number;
  /** Actions suppressed by the global cooldown. */
  suppressedCount: number;
  /** Per-limb activity, for drawing motion trails on the fighter. */
  armActivity: { left: number; right: number };
  legActivity: { left: number; right: number };
}

/** Actions closer together than this are the same motion, seen twice. */
const GLOBAL_COOLDOWN_MS = 90;

/** Below this tracking confidence the analyzer stops trusting itself. */
const MIN_QUALITY = 0.42;

export class MotionAnalyzer {
  readonly state: MotionState = createMotionState();

  /**
   * Режим «ошибка»: почему движение не засчиталось.
   *
   * Живёт на анализаторе, а не внутри каждого детектора, потому что выбирать
   * одну подсказку из нескольких можно только видя их все сразу.
   */
  readonly mistakes = new MistakeLog();

  private readonly locomotion = new LocomotionDetector();
  private readonly guard = new GuardDetector();
  private readonly punch = new PunchDetector();
  private readonly kick = new KickDetector();
  private readonly dodge = new DodgeDetector();

  /** Actions produced this frame, newest last. Cleared by `drain()`. */
  private readonly pending: ActionEvent[] = [];

  private lastActionAt = -Infinity;
  private lastFrameTimestamp = 0;

  sensitivity: number;
  calibration: CalibrationProfile;

  readonly debug: AnalyzerDebug = {
    lastAction: null,
    actionCount: 0,
    suppressedCount: 0,
    armActivity: { left: 0, right: 0 },
    legActivity: { left: 0, right: 0 },
  };

  constructor(options: AnalyzerOptions = {}) {
    this.sensitivity = clamp(options.sensitivity ?? 1, 0.4, 1.8);
    this.calibration = options.calibration ?? { ...DEFAULT_CALIBRATION };
  }

  /**
   * Advances every detector by one vision frame.
   *
   * `dt` is derived from the skeleton's own timestamp rather than the render
   * clock, because the vision loop runs at its own rate and feeding detectors
   * the renderer's `dt` makes every velocity threshold wrong by 2–3x.
   */
  update(skeleton: Skeleton): void {
    const now = skeleton.timestamp;
    const rawDt = this.lastFrameTimestamp === 0 ? 33 : now - this.lastFrameTimestamp;
    this.lastFrameTimestamp = now;

    // A stall — a hidden tab, a GC pause — leaves a huge gap that would read as
    // impossible limb speeds. Clamp it and let the next frame settle things.
    const dt = clamp(rawDt, 8, 120) / 1000;

    const context: MotionContext = {
      skeleton,
      calibration: this.calibration,
      dt,
      now,
      sensitivity: this.sensitivity,
      mistakes: this.mistakes,
    };

    // 1. Body posture: airborne, crouch, lean, footwork.
    this.collect(this.locomotion.update(context, this.state));

    // 2. Guard, which both strike detectors consult.
    this.collect(this.guard.update(context, this.state));

    // Once quality collapses, posture is still worth reading (it degrades
    // gracefully) but discrete strikes are not.
    if (this.state.quality < MIN_QUALITY) {
      // Раньше здесь просто выключались удары, и игрок не узнавал об этом
      // ничего. Разделяем два случая: человека не видно вовсе и человека видно
      // плохо — лечатся они по-разному.
      this.mistakes.note(
        skeleton.present ? 'lowLight' : 'outOfFrame',
        'none',
        this.state.quality / MIN_QUALITY,
        now,
      );
      this.decayActivity();
      this.mistakes.settle(now);
      return;
    }

    // 3. Strikes.
    this.collect(this.punch.update(context, this.state));
    this.collect(this.kick.update(context, this.state));

    // 4. Defensive commitment.
    this.collect(this.dodge.update(context, this.state));

    this.debug.armActivity.left = this.punch.activeArms.left;
    this.debug.armActivity.right = this.punch.activeArms.right;
    this.debug.legActivity.left = this.kick.activeLegs.left;
    this.debug.legActivity.right = this.kick.activeLegs.right;

    this.mistakes.settle(now);
  }

  private collect(event: ActionEvent | null): void {
    if (!event) return;

    // Posture events (crouch, jump) are state changes, not strikes, and are
    // exempt from the strike cooldown — ducking under a punch you are also
    // throwing is legitimate.
    const isStrike = event.kind === 'punch' || event.kind === 'kick';

    if (isStrike && event.timestamp - this.lastActionAt < GLOBAL_COOLDOWN_MS) {
      this.debug.suppressedCount++;
      this.mistakes.note(
        'punchTooSoon',
        event.side === 'left' || event.side === 'right' ? event.side : 'none',
        (event.timestamp - this.lastActionAt) / GLOBAL_COOLDOWN_MS,
        event.timestamp,
      );
      return;
    }

    if (isStrike) {
      this.lastActionAt = event.timestamp;
      // Движение засчитано — держать над ним «ты не дотянулся» больше незачем.
      this.mistakes.clear();
    }
    this.pending.push(event);
    this.debug.lastAction = event;
    this.debug.actionCount++;
    log.debug(`${event.kind}:${event.technique} ${event.side} p=${event.power.toFixed(2)}`);
  }

  private decayActivity(): void {
    this.debug.armActivity.left *= 0.85;
    this.debug.armActivity.right *= 0.85;
    this.debug.legActivity.left *= 0.85;
    this.debug.legActivity.right *= 0.85;
  }

  /** Takes the actions produced since the last call, emptying the queue. */
  drain(out: ActionEvent[] = []): ActionEvent[] {
    for (let i = 0; i < this.pending.length; i++) out.push(this.pending[i]);
    this.pending.length = 0;
    return out;
  }

  /** Discards anything queued without processing it — used when a round ends. */
  flush(): void {
    this.pending.length = 0;
  }

  setSensitivity(value: number): void {
    this.sensitivity = clamp(value, 0.4, 1.8);
  }

  setCalibration(profile: CalibrationProfile): void {
    this.calibration = profile;
    this.reset();
  }

  reset(): void {
    this.locomotion.reset();
    this.guard.reset();
    this.punch.reset();
    this.kick.reset();
    this.dodge.reset();
    this.pending.length = 0;
    this.lastActionAt = -Infinity;
    this.lastFrameTimestamp = 0;
    this.debug.lastAction = null;
    this.debug.actionCount = 0;
    this.debug.suppressedCount = 0;
    this.mistakes.clear();

    const state = this.state;
    state.guarding = false;
    state.guardHeight = 0;
    state.crouch = 0;
    state.lean = 0;
    state.airborne = false;
    state.airHeight = 0;
    state.advance = 0;
    state.stance = 0;
    state.quality = 0;
  }
}

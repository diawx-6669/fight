import { EventBus } from '@/core/events';
import { clamp } from '@/core/math';
import {
  KNOCKOUT_FREEZE_FRAMES,
  ROUNDS_TO_WIN,
  ROUND_INTRO_FRAMES,
  ROUND_OUTRO_FRAMES,
  ROUND_TIME_SECONDS,
  TICK_RATE,
} from './constants';
import type { Fighter } from './fighter';

/**
 * Round and match flow.
 *
 * Split out from the world because the *rules* of a match and the *physics* of
 * a fight change for entirely different reasons. Survival mode wants a
 * different round structure and identical combat; a balance patch wants the
 * opposite. Keeping them apart means neither change has to touch the other.
 */

export type MatchPhase =
  | 'ready'
  | 'fight'
  | 'knockout'
  | 'roundEnd'
  | 'matchEnd';

export type RoundOutcome = 'p1' | 'p2' | 'draw' | 'timeout';

export interface RoundResult {
  round: number;
  winner: RoundOutcome;
  /** Health both fighters had left, `[0, 1]`. */
  p1Health: number;
  p2Health: number;
  /** Whether it was a perfect round for the winner. */
  perfect: boolean;
  /** Frames the round lasted. */
  durationFrames: number;
}

export interface MatchEvents {
  /** A new round is starting. */
  roundStart: { round: number };
  /** The "FIGHT" moment: control is handed to the players. */
  fightStart: { round: number };
  /** Someone went down. */
  knockout: { winner: RoundOutcome; perfect: boolean };
  /** A round finished and the score has been updated. */
  roundEnd: RoundResult;
  /** The whole match is over. */
  matchEnd: { winner: RoundOutcome; results: readonly RoundResult[] };
  /** Ten seconds left. */
  timeWarning: Record<string, never>;
}

export interface MatchRules {
  /** Rounds one side must win to take the match. */
  roundsToWin: number;
  /** Seconds on the clock, or `0` for no limit. */
  roundSeconds: number;
  /** Whether a draw round counts for both sides. */
  drawCountsForBoth: boolean;
}

export const DEFAULT_RULES: MatchRules = {
  roundsToWin: ROUNDS_TO_WIN,
  roundSeconds: ROUND_TIME_SECONDS,
  drawCountsForBoth: true,
};

export class Match {
  readonly events = new EventBus<MatchEvents>();
  readonly rules: MatchRules;

  phase: MatchPhase = 'ready';
  /** Frames spent in the current phase. */
  phaseFrame = 0;

  round = 1;
  p1Wins = 0;
  p2Wins = 0;

  /** Frames left on the round clock. */
  timerFrames: number;

  private roundStartFrame = 0;
  private totalFrames = 0;
  private timeWarningFired = false;
  private pendingResult: RoundResult | null = null;

  readonly results: RoundResult[] = [];

  constructor(rules: Partial<MatchRules> = {}) {
    this.rules = { ...DEFAULT_RULES, ...rules };
    this.timerFrames = this.rules.roundSeconds * TICK_RATE;
  }

  get timeRemaining(): number {
    return this.timerFrames / TICK_RATE;
  }

  get isOver(): boolean {
    return this.phase === 'matchEnd';
  }

  /** Whether the players currently have control. */
  get isLive(): boolean {
    return this.phase === 'fight';
  }

  get matchWinner(): RoundOutcome | null {
    if (this.p1Wins >= this.rules.roundsToWin) return 'p1';
    if (this.p2Wins >= this.rules.roundsToWin) return 'p2';
    return null;
  }

  /** Begins the first round. */
  start(p1: Fighter, p2: Fighter): void {
    this.round = 1;
    this.p1Wins = 0;
    this.p2Wins = 0;
    this.results.length = 0;
    this.totalFrames = 0;
    this.beginRound(p1, p2);
  }

  private beginRound(p1: Fighter, p2: Fighter): void {
    this.phase = 'ready';
    this.phaseFrame = 0;
    this.timerFrames = this.rules.roundSeconds * TICK_RATE;
    this.timeWarningFired = false;
    this.pendingResult = null;
    this.roundStartFrame = this.totalFrames;

    p1.resetForRound(-2.6);
    p2.resetForRound(2.6);

    this.events.emit('roundStart', { round: this.round });
  }

  /** Advances the match by one tick. Returns `true` while fighters may act. */
  tick(p1: Fighter, p2: Fighter): boolean {
    this.phaseFrame++;
    this.totalFrames++;

    switch (this.phase) {
      case 'ready':
        if (this.phaseFrame >= ROUND_INTRO_FRAMES) {
          this.phase = 'fight';
          this.phaseFrame = 0;
          p1.enter('idle');
          p2.enter('idle');
          this.events.emit('fightStart', { round: this.round });
        }
        return false;

      case 'fight':
        return this.tickFight(p1, p2);

      case 'knockout':
        if (this.phaseFrame >= KNOCKOUT_FREEZE_FRAMES) {
          this.phase = 'roundEnd';
          this.phaseFrame = 0;
          if (this.pendingResult) this.commitResult(this.pendingResult, p1, p2);
        }
        return false;

      case 'roundEnd':
        if (this.phaseFrame >= ROUND_OUTRO_FRAMES) {
          const winner = this.matchWinner;
          if (winner) {
            this.phase = 'matchEnd';
            this.phaseFrame = 0;
            this.events.emit('matchEnd', { winner, results: this.results });
          } else {
            this.round++;
            this.beginRound(p1, p2);
          }
        }
        return false;

      case 'matchEnd':
      default:
        return false;
    }
  }

  private tickFight(p1: Fighter, p2: Fighter): boolean {
    if (this.rules.roundSeconds > 0) {
      this.timerFrames--;

      if (!this.timeWarningFired && this.timerFrames <= 10 * TICK_RATE) {
        this.timeWarningFired = true;
        this.events.emit('timeWarning', {});
      }

      if (this.timerFrames <= 0) {
        this.timerFrames = 0;
        // Time out: more health wins. A dead-even timeout is a genuine draw.
        const diff = p1.healthRatio - p2.healthRatio;
        const winner: RoundOutcome = Math.abs(diff) < 0.01 ? 'draw' : diff > 0 ? 'p1' : 'p2';
        this.endRound(winner, p1, p2, true);
        return false;
      }
    }

    // A double knockout is possible and should be honoured rather than
    // arbitrarily resolved — two fighters trading a finishing blow is one of
    // the best things that can happen in a match.
    const p1Down = !p1.isAlive;
    const p2Down = !p2.isAlive;
    if (p1Down || p2Down) {
      const winner: RoundOutcome = p1Down && p2Down ? 'draw' : p1Down ? 'p2' : 'p1';
      this.endRound(winner, p1, p2, false);
      return false;
    }

    return true;
  }

  private endRound(winner: RoundOutcome, p1: Fighter, p2: Fighter, timeout: boolean): void {
    const perfect =
      (winner === 'p1' && p1.healthRatio >= 0.999) || (winner === 'p2' && p2.healthRatio >= 0.999);

    this.pendingResult = {
      round: this.round,
      winner: timeout && winner !== 'draw' ? 'timeout' : winner,
      p1Health: p1.healthRatio,
      p2Health: p2.healthRatio,
      perfect,
      durationFrames: this.totalFrames - this.roundStartFrame,
    };

    this.phase = 'knockout';
    this.phaseFrame = 0;

    // Pose the fighters for the outcome. Losing on the clock is not a knockout,
    // so nobody hits the floor for a timeout.
    if (winner === 'p1') {
      p1.enter('victory');
      if (!timeout) p2.enter('defeat');
    } else if (winner === 'p2') {
      p2.enter('victory');
      if (!timeout) p1.enter('defeat');
    }

    this.events.emit('knockout', { winner, perfect });
  }

  private commitResult(result: RoundResult, p1: Fighter, p2: Fighter): void {
    this.results.push(result);

    const winner = result.winner;
    if (winner === 'p1' || (winner === 'timeout' && result.p1Health > result.p2Health)) {
      this.p1Wins++;
    } else if (winner === 'p2' || (winner === 'timeout' && result.p2Health > result.p1Health)) {
      this.p2Wins++;
    } else if (this.rules.drawCountsForBoth) {
      this.p1Wins++;
      this.p2Wins++;
    }

    this.events.emit('roundEnd', result);
    void p1;
    void p2;
  }

  /** Current score as a fraction for the round pips in the HUD. */
  scoreFor(slot: 0 | 1): number {
    const wins = slot === 0 ? this.p1Wins : this.p2Wins;
    return clamp(wins / this.rules.roundsToWin, 0, 1);
  }

  /** Forfeits the match — used when a remote player disconnects. */
  forfeit(slot: 0 | 1): void {
    if (this.phase === 'matchEnd') return;
    const winner: RoundOutcome = slot === 0 ? 'p2' : 'p1';
    if (winner === 'p1') this.p1Wins = this.rules.roundsToWin;
    else this.p2Wins = this.rules.roundsToWin;
    this.phase = 'matchEnd';
    this.phaseFrame = 0;
    this.events.emit('matchEnd', { winner, results: this.results });
  }
}

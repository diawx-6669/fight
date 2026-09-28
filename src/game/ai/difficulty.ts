/**
 * Difficulty.
 *
 * The temptation with a fighting-game AI is to make it harder by making it
 * faster and more accurate until it becomes literally unbeatable. That is easy
 * and it is not fun: a perfect-reaction opponent does not play a fighting game,
 * it performs a denial-of-service on one.
 *
 * These tiers instead move the AI along a *human* axis. A beginner opponent
 * reacts slowly, telegraphs, and makes unforced errors. A master opponent
 * reacts at roughly the speed of a strong human player (~200ms), punishes
 * whiffs, and mixes up its guard — but it still has a reaction time, it still
 * makes occasional mistakes, and it never reads inputs that have not happened.
 *
 * The one thing that scales without limit is *patience*: higher tiers are
 * willing to wait for an opening instead of walking into your fist.
 */

export type DifficultyId = 'rookie' | 'fighter' | 'veteran' | 'master' | 'nightmare';

export interface DifficultySettings {
  readonly id: DifficultyId;
  readonly label: string;
  readonly description: string;

  /** Frames before the AI can respond to something it just saw. */
  readonly reactionFrames: number;
  /** Random jitter added to reaction time, in frames. */
  readonly reactionJitter: number;

  /** Probability of blocking a strike it has seen coming, `[0, 1]`. */
  readonly blockChance: number;
  /** Probability of guarding at the *correct* height. */
  readonly guardAccuracy: number;
  /** Probability of attempting a parry when one would land. */
  readonly parryChance: number;
  /** Probability of dodging instead of blocking. */
  readonly dodgeChance: number;

  /** How often it attacks when in range, `[0, 1]`. */
  readonly aggression: number;
  /** How reliably it punishes a whiffed move. */
  readonly punishRate: number;
  /** Chance per opening of extending a combo rather than resetting. */
  readonly comboRate: number;

  /** Multiplier on outgoing damage — the last resort, used sparingly. */
  readonly damageScale: number;
  /** Multiplier on how fast its stamina recovers. */
  readonly staminaScale: number;

  /** Chance per second of a deliberate mistake: a wasted move, a dropped guard. */
  readonly mistakeRate: number;
}

export const DIFFICULTIES: Record<DifficultyId, DifficultySettings> = {
  rookie: {
    id: 'rookie',
    label: 'НОВИЧОК',
    description: 'Учится вместе с тобой. Бьёт редко, блокирует ещё реже.',
    reactionFrames: 26,
    reactionJitter: 10,
    blockChance: 0.28,
    guardAccuracy: 0.5,
    parryChance: 0,
    dodgeChance: 0.06,
    aggression: 0.26,
    punishRate: 0.08,
    comboRate: 0.05,
    damageScale: 0.72,
    staminaScale: 0.85,
    mistakeRate: 0.55,
  },

  fighter: {
    id: 'fighter',
    label: 'БОЕЦ',
    description: 'Держит стойку, наказывает за откровенные ошибки.',
    reactionFrames: 19,
    reactionJitter: 7,
    blockChance: 0.48,
    guardAccuracy: 0.66,
    parryChance: 0.04,
    dodgeChance: 0.12,
    aggression: 0.42,
    punishRate: 0.24,
    comboRate: 0.2,
    damageScale: 0.88,
    staminaScale: 1,
    mistakeRate: 0.3,
  },

  veteran: {
    id: 'veteran',
    label: 'ВЕТЕРАН',
    description: 'Читает дистанцию, ловит на промахах, меняет уровень блока.',
    reactionFrames: 14,
    reactionJitter: 5,
    blockChance: 0.66,
    guardAccuracy: 0.8,
    parryChance: 0.1,
    dodgeChance: 0.2,
    aggression: 0.56,
    punishRate: 0.48,
    comboRate: 0.42,
    damageScale: 1,
    staminaScale: 1.1,
    mistakeRate: 0.16,
  },

  master: {
    id: 'master',
    label: 'МАСТЕР',
    description: 'Играет в твою игру лучше тебя. Терпеливый и безжалостный.',
    reactionFrames: 11,
    reactionJitter: 3,
    blockChance: 0.8,
    guardAccuracy: 0.9,
    parryChance: 0.2,
    dodgeChance: 0.3,
    aggression: 0.68,
    punishRate: 0.72,
    comboRate: 0.62,
    damageScale: 1.08,
    staminaScale: 1.2,
    mistakeRate: 0.07,
  },

  nightmare: {
    id: 'nightmare',
    label: 'КОШМАР',
    description: 'Твоя тень, которая тренировалась дольше тебя.',
    // Still 8 frames — about 130ms. Faster than this stops being a fight.
    reactionFrames: 8,
    reactionJitter: 2,
    blockChance: 0.9,
    guardAccuracy: 0.96,
    parryChance: 0.32,
    dodgeChance: 0.38,
    aggression: 0.78,
    punishRate: 0.88,
    comboRate: 0.78,
    damageScale: 1.18,
    staminaScale: 1.3,
    mistakeRate: 0.025,
  },
};

export const DIFFICULTY_ORDER: readonly DifficultyId[] = [
  'rookie',
  'fighter',
  'veteran',
  'master',
  'nightmare',
];

export function getDifficulty(id: string): DifficultySettings {
  return DIFFICULTIES[id as DifficultyId] ?? DIFFICULTIES.fighter;
}

/**
 * Nudges difficulty towards the player's actual level over a match.
 *
 * Kept deliberately gentle and bounded: a player who is winning comfortably
 * gets a slightly sharper opponent, a player being flattened gets a little
 * breathing room, and nobody gets a rubber band so obvious that their wins
 * stop meaning anything.
 */
export class DynamicDifficulty {
  /** `-1` (ease off) to `+1` (press harder). */
  private bias = 0;

  constructor(private readonly enabled: boolean) {}

  /** Called at the end of each round with the health both fighters had left. */
  recordRound(playerHealthRatio: number, aiHealthRatio: number): void {
    if (!this.enabled) return;
    const margin = playerHealthRatio - aiHealthRatio;
    // A dominant round moves the needle about a fifth of the way.
    this.bias = clampBias(this.bias + margin * 0.35);
  }

  /** Applies the current bias to a difficulty's settings. */
  apply(base: DifficultySettings): DifficultySettings {
    if (!this.enabled || Math.abs(this.bias) < 0.05) return base;
    const b = this.bias;
    return {
      ...base,
      reactionFrames: Math.max(7, Math.round(base.reactionFrames - b * 4)),
      blockChance: clamp01(base.blockChance + b * 0.12),
      aggression: clamp01(base.aggression + b * 0.14),
      punishRate: clamp01(base.punishRate + b * 0.15),
      mistakeRate: clamp01(base.mistakeRate - b * 0.08),
    };
  }

  reset(): void {
    this.bias = 0;
  }

  get currentBias(): number {
    return this.bias;
  }
}

function clampBias(value: number): number {
  return Math.max(-0.6, Math.min(0.6, value));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

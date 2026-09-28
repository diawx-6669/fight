import type { Technique } from '@/vision/motion/types';

/**
 * Fighting personalities.
 *
 * Difficulty decides *how well* the AI plays; personality decides *how* it
 * plays. Keeping them orthogonal means a rookie rusher and a master rusher are
 * recognisably the same character at different skill levels, which is what
 * makes an arcade ladder feel like a set of opponents rather than one opponent
 * with a slider.
 *
 * Every number is a bias applied on top of the difficulty's base behaviour, so
 * a personality can never make an opponent harder than its tier allows.
 */

export interface Personality {
  readonly id: string;
  readonly label: string;

  /** Preferred fighting distance in metres. */
  readonly preferredRange: number;
  /** How strictly it holds that range, `[0, 1]`. */
  readonly spacingDiscipline: number;

  /** Multiplier on the difficulty's aggression. */
  readonly aggressionBias: number;
  /** Multiplier on how often it blocks rather than moves. */
  readonly defenseBias: number;
  /** How much it likes to jump. */
  readonly mobility: number;

  /** Relative weights for picking a technique when an opening appears. */
  readonly moveWeights: Partial<Record<Technique, number>>;

  /** Chance of throwing a feint — a move started at the edge of range. */
  readonly feintRate: number;
  /** How long it waits after a whiff before pressing again, in frames. */
  readonly patience: number;
}

const BALANCED_WEIGHTS: Partial<Record<Technique, number>> = {
  jab: 3,
  cross: 2.5,
  hook: 1.6,
  uppercut: 1,
  overhead: 0.8,
  lowKick: 1.6,
  midKick: 1.4,
  highKick: 0.7,
  pushKick: 0.9,
  kneeStrike: 1,
};

export const PERSONALITIES: Record<string, Personality> = {
  balanced: {
    id: 'balanced',
    label: 'Универсал',
    preferredRange: 1.5,
    spacingDiscipline: 0.55,
    aggressionBias: 1,
    defenseBias: 1,
    mobility: 0.5,
    moveWeights: BALANCED_WEIGHTS,
    feintRate: 0.1,
    patience: 24,
  },

  rusher: {
    id: 'rusher',
    label: 'Напор',
    // Lives in your face and never lets go. Beatable by anyone who can block.
    preferredRange: 1.05,
    spacingDiscipline: 0.25,
    aggressionBias: 1.55,
    defenseBias: 0.65,
    mobility: 0.7,
    moveWeights: {
      jab: 4,
      cross: 3,
      hook: 2.6,
      uppercut: 1.6,
      kneeStrike: 2.2,
      lowKick: 1.2,
      midKick: 0.8,
      overhead: 0.6,
      highKick: 0.3,
      pushKick: 0.2,
    },
    feintRate: 0.05,
    patience: 8,
  },

  counter: {
    id: 'counter',
    label: 'Контратака',
    // Waits at the edge of your reach and punishes everything you miss.
    preferredRange: 1.95,
    spacingDiscipline: 0.85,
    aggressionBias: 0.6,
    defenseBias: 1.5,
    mobility: 0.45,
    moveWeights: {
      jab: 2.4,
      cross: 3.2,
      uppercut: 2.2,
      midKick: 2,
      pushKick: 1.6,
      hook: 1.2,
      lowKick: 1,
      highKick: 1.2,
      overhead: 0.7,
      kneeStrike: 0.4,
    },
    feintRate: 0.22,
    patience: 46,
  },

  zoner: {
    id: 'zoner',
    label: 'Дистанция',
    // Kicks. Just kicks. Getting inside is the entire puzzle.
    preferredRange: 2.3,
    spacingDiscipline: 0.95,
    aggressionBias: 0.85,
    defenseBias: 1.1,
    mobility: 0.6,
    moveWeights: {
      midKick: 3.4,
      pushKick: 3,
      lowKick: 2.4,
      highKick: 1.8,
      jab: 1.2,
      cross: 1,
      hook: 0.3,
      uppercut: 0.2,
      overhead: 0.4,
      kneeStrike: 0.1,
    },
    feintRate: 0.16,
    patience: 34,
  },

  trickster: {
    id: 'trickster',
    label: 'Хитрец',
    // Mixes high and low relentlessly. Punishes players who block on autopilot.
    preferredRange: 1.4,
    spacingDiscipline: 0.4,
    aggressionBias: 1.15,
    defenseBias: 0.95,
    mobility: 0.9,
    moveWeights: {
      overhead: 3,
      lowKick: 3,
      jab: 2,
      hook: 2,
      uppercut: 1.4,
      kneeStrike: 1.2,
      highKick: 1.2,
      cross: 1,
      midKick: 0.8,
      pushKick: 0.6,
    },
    feintRate: 0.34,
    patience: 18,
  },
};

export function getPersonality(id: string): Personality {
  return PERSONALITIES[id] ?? PERSONALITIES.balanced;
}

/** Which personality each roster character fights with. */
export const CHARACTER_PERSONALITY: Record<string, string> = {
  kai: 'balanced',
  rei: 'rusher',
  grom: 'counter',
  vega: 'zoner',
  nox: 'counter',
  umbra: 'trickster',
};

export function personalityFor(characterId: string): Personality {
  return getPersonality(CHARACTER_PERSONALITY[characterId] ?? 'balanced');
}

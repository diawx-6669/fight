import type { RigProportions } from './rig';
import { DEFAULT_PROPORTIONS } from './rig';

/**
 * The roster.
 *
 * Characters differ along four axes that the player can actually feel within
 * one round: how hard they hit, how much they can take, how fast they move,
 * and how forgiving their stamina is. Everything else — silhouette, palette,
 * trail colour, the shape of their scarf — is identity rather than balance.
 *
 * Deliberately *not* included: per-character move lists. The player's body is
 * the move list, and locking a technique behind a character would mean telling
 * someone their punch does not count because they picked the wrong fighter.
 */

export interface CharacterStats {
  /** Multiplies all outgoing damage. */
  readonly power: number;
  /** Multiplies max health. */
  readonly toughness: number;
  /** Multiplies walk and dash speed. */
  readonly speed: number;
  /** Multiplies stamina pool and regeneration. */
  readonly endurance: number;
  /** Multiplies meter gain — how often their super comes up. */
  readonly focus: number;
  /** Scales every bone length; changes reach and hurtbox size together. */
  readonly build: number;
}

export interface CharacterVisuals {
  /** Body fill, from core to edge. */
  readonly bodyInner: string;
  readonly bodyOuter: string;
  /** Rim light that separates the silhouette from the background. */
  readonly rim: string;
  /** Weapon and limb trails. */
  readonly trail: string;
  /** Impact sparks and hit flashes. */
  readonly spark: string;
  /** Aura when the super meter is full. */
  readonly aura: string;
  /** Scarf / sash colour. */
  readonly cloth: string;
  /** Number of cloth ribbons trailing from the body. */
  readonly ribbons: number;
  /** Length of the hair ribbon, in metres. */
  readonly hairLength: number;
}

export interface Character {
  readonly id: string;
  readonly name: string;
  /** One line of flavour shown on the select screen. */
  readonly tagline: string;
  /** Two or three sentences on how they play. */
  readonly description: string;
  readonly stats: CharacterStats;
  readonly visuals: CharacterVisuals;
  readonly proportions: RigProportions;
  /** Unlocked from the start, or earned. */
  readonly unlockedByDefault: boolean;
  /** Arcade wins needed to unlock. */
  readonly unlockWins: number;
}

function proportions(overrides: Partial<RigProportions> = {}): RigProportions {
  return { ...DEFAULT_PROPORTIONS, ...overrides };
}

export const CHARACTERS: readonly Character[] = [
  {
    id: 'kai',
    name: 'КАЙ',
    tagline: 'Тень, что бьёт первой',
    description:
      'Сбалансированный боец без слабых мест. Быстрые руки, надёжная стойка, ' +
      'ровная выносливость. С него стоит начинать — он прощает ошибки.',
    stats: { power: 1, toughness: 1, speed: 1, endurance: 1, focus: 1, build: 1 },
    visuals: {
      bodyInner: '#14161f',
      bodyOuter: '#05060b',
      rim: '#ff7a45',
      trail: '#ff5a2b',
      spark: '#ffc247',
      aura: '#ff8a5c',
      cloth: '#c9372c',
      ribbons: 2,
      hairLength: 0.22,
    },
    proportions: proportions(),
    unlockedByDefault: true,
    unlockWins: 0,
  },

  {
    id: 'rei',
    name: 'РЭЙ',
    tagline: 'Быстрее, чем видно',
    description:
      'Хрупкая, но невероятно быстрая. Живёт на дистанции джеба и уклонений. ' +
      'Пропускает два тяжёлых удара — и раунд окончен.',
    stats: { power: 0.84, toughness: 0.82, speed: 1.28, endurance: 1.15, focus: 1.2, build: 0.93 },
    visuals: {
      bodyInner: '#101822',
      bodyOuter: '#04070d',
      rim: '#35d6ff',
      trail: '#8ceaff',
      spark: '#d8f6ff',
      aura: '#35d6ff',
      cloth: '#1e8fb5',
      ribbons: 3,
      hairLength: 0.4,
    },
    proportions: proportions({ upperArm: 0.31, forearm: 0.31, thigh: 0.46, shin: 0.45 }),
    unlockedByDefault: true,
    unlockWins: 0,
  },

  {
    id: 'grom',
    name: 'ГРОМ',
    tagline: 'Один удар — одна история',
    description:
      'Танк. Бьёт так, что экран трясётся, и держит удар дольше всех. ' +
      'Медленный: каждый промах стоит дорого.',
    stats: { power: 1.34, toughness: 1.3, speed: 0.78, endurance: 0.88, focus: 0.85, build: 1.12 },
    visuals: {
      bodyInner: '#1a1512',
      bodyOuter: '#08060a',
      rim: '#ffab3d',
      trail: '#ff8a1f',
      spark: '#ffd88a',
      aura: '#ff6a1f',
      cloth: '#7a4a1e',
      ribbons: 1,
      hairLength: 0.12,
    },
    proportions: proportions({
      spine: 0.45,
      shoulderWidth: 0.24,
      upperArm: 0.34,
      forearm: 0.32,
      thigh: 0.44,
      shin: 0.42,
    }),
    unlockedByDefault: true,
    unlockWins: 0,
  },

  {
    id: 'vega',
    name: 'ВЕГА',
    tagline: 'Длинные ноги, короткий разговор',
    description:
      'Держит дистанцию ногами. Самый большой радиус поражения в игре. ' +
      'В ближнем бою почти беспомощна — не дай себя зажать.',
    stats: { power: 1.08, toughness: 0.9, speed: 1.05, endurance: 0.95, focus: 1.1, build: 1.08 },
    visuals: {
      bodyInner: '#18121f',
      bodyOuter: '#070510',
      rim: '#c39bff',
      trail: '#a874ff',
      spark: '#e8d4ff',
      aura: '#9d5cff',
      cloth: '#5a2a8f',
      ribbons: 4,
      hairLength: 0.34,
    },
    proportions: proportions({ thigh: 0.51, shin: 0.5, upperArm: 0.3, forearm: 0.3 }),
    unlockedByDefault: false,
    unlockWins: 3,
  },

  {
    id: 'nox',
    name: 'НОКС',
    tagline: 'Питается твоими ошибками',
    description:
      'Контратакующий стиль. Быстро копит ярость и наказывает за каждый ' +
      'промах. Награждает тех, кто умеет блокировать и парировать.',
    stats: { power: 1.02, toughness: 0.95, speed: 1.06, endurance: 1.25, focus: 1.45, build: 0.98 },
    visuals: {
      bodyInner: '#0d1a14',
      bodyOuter: '#03080a',
      rim: '#9dff4f',
      trail: '#5cffb0',
      spark: '#d4ffb8',
      aura: '#5cff9d',
      cloth: '#1f6b3a',
      ribbons: 3,
      hairLength: 0.26,
    },
    proportions: proportions(),
    unlockedByDefault: false,
    unlockWins: 6,
  },

  {
    id: 'umbra',
    name: 'УМБРА',
    tagline: 'Твоя собственная тень',
    description:
      'Финальный противник. Без слабостей, без пощады, с идеальной ' +
      'статистикой. Побеждает тех, кто дерётся, а не размахивает руками.',
    stats: { power: 1.18, toughness: 1.12, speed: 1.16, endurance: 1.2, focus: 1.3, build: 1.03 },
    visuals: {
      bodyInner: '#0a0a12',
      bodyOuter: '#000004',
      rim: '#ff2b55',
      trail: '#ff2b55',
      spark: '#ff8aa8',
      aura: '#ff0040',
      cloth: '#30000f',
      ribbons: 5,
      hairLength: 0.44,
    },
    proportions: proportions({ shoulderWidth: 0.22 }),
    unlockedByDefault: false,
    unlockWins: 10,
  },
];

const BY_ID = new Map(CHARACTERS.map((character) => [character.id, character]));

export function getCharacter(id: string): Character {
  // Falling back to the starter rather than throwing keeps a stale saved
  // selection or a malformed network payload from taking the game down.
  return BY_ID.get(id) ?? CHARACTERS[0];
}

export function unlockedCharacters(wins: number): readonly Character[] {
  return CHARACTERS.filter(
    (character) => character.unlockedByDefault || wins >= character.unlockWins,
  );
}

/**
 * Есть ли у игрока этот боец.
 *
 * Раньше это решало число побед. Теперь решает владение: бойцы выпадают из
 * кейсов, и победы к ним отношения не имеют — они приносят монеты, а кейс
 * приносит бойца. `unlockedByDefault` остаётся как стартовый набор.
 */
export function isUnlocked(character: Character, owned: readonly string[]): boolean {
  return character.unlockedByDefault || owned.includes(character.id);
}

/** Stat bars for the select screen, each normalised to `[0, 1]`. */
export function statBars(character: Character): ReadonlyArray<{ label: string; value: number }> {
  const s = character.stats;
  const normalise = (value: number) => Math.max(0, Math.min(1, (value - 0.7) / 0.75));
  return [
    { label: 'СИЛА', value: normalise(s.power) },
    { label: 'ЗАЩИТА', value: normalise(s.toughness) },
    { label: 'СКОРОСТЬ', value: normalise(s.speed) },
    { label: 'ВЫНОСЛИВОСТЬ', value: normalise(s.endurance) },
    { label: 'ЯРОСТЬ', value: normalise(s.focus) },
  ];
}

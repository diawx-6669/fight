import { Rng } from '@/core/rng';
import { CHARACTERS } from './characters';

/**
 * Кейсы: бойцы покупаются за монеты, а не выпрашиваются у таблицы побед.
 *
 * Раньше бойцы открывались по числу побед — честно, но мёртво: игрок либо уже
 * открыл всех, либо знал, сколько именно боёв осталось, и никакого события из
 * этого не выходило. Кейс превращает то же самое в момент: ты копил, ты
 * открыл, и кто выпадет — неизвестно.
 *
 * Два правила, без которых это было бы неприятной механикой, а не приятной.
 *
 * **Шансы показаны.** Каждая строка таблицы выпадения видна до покупки, в
 * процентах. Скрытые вероятности — то, чем игровые кейсы заслужили дурную
 * славу, и прятать их здесь не от кого: продажи нет, валюта зарабатывается
 * игрой.
 *
 * **Дубликат не пустышка.** Уже открытый боец возвращается монетами, и
 * заметной долей цены. Кейс, отдающий пустоту за накопленное, учит не
 * открывать кейсы.
 */

export type Rarity = 'common' | 'rare' | 'legendary';

export const RARITY_LABEL: Record<Rarity, string> = {
  common: 'ОБЫЧНЫЙ',
  rare: 'РЕДКИЙ',
  legendary: 'ЛЕГЕНДАРНЫЙ',
};

export const RARITY_COLOR: Record<Rarity, string> = {
  common: '#8ea2c6',
  rare: '#4fc3ff',
  legendary: '#ffb03a',
};

/** Сколько монет возвращает дубликат. */
export const DUPLICATE_REFUND: Record<Rarity, number> = {
  common: 90,
  rare: 260,
  legendary: 700,
};

/** Редкость бойца. Выведена из того, насколько поздно он открывался раньше. */
export const CHARACTER_RARITY: Record<string, Rarity> = {
  kai: 'common',
  rei: 'common',
  grom: 'common',
  vega: 'rare',
  nox: 'rare',
  umbra: 'legendary',
};

export function rarityOf(characterId: string): Rarity {
  return CHARACTER_RARITY[characterId] ?? 'common';
}

export interface CaseDefinition {
  readonly id: string;
  readonly name: string;
  readonly subtitle: string;
  readonly price: number;
  /** Шансы по редкостям. Сумма всегда единица. */
  readonly odds: Readonly<Record<Rarity, number>>;
}

export const CASES: readonly CaseDefinition[] = [
  {
    id: 'street',
    name: 'УЛИЧНЫЙ',
    subtitle: 'Дёшево и часто',
    price: 300,
    odds: { common: 0.78, rare: 0.2, legendary: 0.02 },
  },
  {
    id: 'temple',
    name: 'ХРАМОВЫЙ',
    subtitle: 'Ровно посередине',
    price: 900,
    odds: { common: 0.45, rare: 0.45, legendary: 0.1 },
  },
  {
    id: 'shadow',
    name: 'ТЕНЕВОЙ',
    subtitle: 'Дорого, но без обычных',
    price: 2400,
    odds: { common: 0, rare: 0.68, legendary: 0.32 },
  },
];

export function caseById(id: string): CaseDefinition | undefined {
  return CASES.find((c) => c.id === id);
}

export interface CaseDrop {
  characterId: string;
  rarity: Rarity;
  /** Боец уже был — вместо него монеты. */
  duplicate: boolean;
  refund: number;
}

/**
 * Открывает кейс.
 *
 * `seed` передаётся снаружи, чтобы результат можно было воспроизвести в тесте
 * и чтобы анимация открытия показывала именно тот исход, который уже выпал, —
 * а не крутила барабан и решала в конце.
 */
export function openCase(
  definition: CaseDefinition,
  owned: readonly string[],
  seed: number,
): CaseDrop {
  const rng = new Rng(seed);
  const rarity = rollRarity(definition, rng);

  // Внутри редкости все равны. Уже открытые из пула не исключаются: иначе
  // последний невыпавший боец становился бы гарантией, и последний кейс
  // терял бы всякий смысл.
  const pool = CHARACTERS.filter((c) => rarityOf(c.id) === rarity);
  const fallback = pool.length > 0 ? pool : CHARACTERS;
  const character = fallback[rng.int(0, fallback.length - 1)];

  const duplicate = owned.includes(character.id);
  return {
    characterId: character.id,
    rarity,
    duplicate,
    refund: duplicate ? DUPLICATE_REFUND[rarity] : 0,
  };
}

function rollRarity(definition: CaseDefinition, rng: Rng): Rarity {
  const roll = rng.range(0, 1);
  let sum = 0;
  for (const rarity of ['legendary', 'rare', 'common'] as const) {
    sum += definition.odds[rarity];
    if (roll < sum) return rarity;
  }
  // Сюда попасть нельзя, пока шансы складываются в единицу; но если таблицу
  // однажды поправят и забудут, пусть выпадет обычный, а не `undefined`.
  return 'common';
}

/** Бойцы, доступные с самого начала — их не надо выбивать. */
export function startingRoster(): string[] {
  return CHARACTERS.filter((c) => c.unlockedByDefault).map((c) => c.id);
}

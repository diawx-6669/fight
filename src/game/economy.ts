import { clamp } from '@/core/math';
import type { RoundResult } from './match';

/**
 * Монеты, опыт и уровни.
 *
 * Награда здесь считается не за победу, а за то, *как* она добыта, и это
 * принципиально. Игра управляется телом: если платить только за факт победы,
 * выгоднее всего стоять столбом против пассивного манекена в тренировке.
 * Поэтому деньги приносят попадания, комбо, чистые раунды и уровень
 * сложности — то есть ровно то, ради чего человек двигается.
 *
 * Вторая мысль, спрятанная в числах: поражение тоже оплачивается. Не наравне
 * с победой, но и не нулём. Игра, где проигранный бой не дал ничего, учит не
 * рисковать и выбирать противника полегче, а эта игра хочет ровно обратного —
 * чтобы человек лез выше и двигался больше.
 */

export interface FightOutcome {
  /** Победил ли игрок. */
  won: boolean;
  /** Раунды матча, в порядке. */
  rounds: readonly RoundResult[];
  /** Сколько урона нанёс игрок за бой. */
  damageDealt: number;
  /** Самое длинное комбо за бой. */
  bestCombo: number;
  /** Раунды, выигранные без единого пропущенного удара. */
  perfects: number;
  /** Множитель сложности соперника, `1` — обычная. */
  difficulty: number;
  /** Режим: тренировка не платит, остальное платит. */
  mode: string;
  /** Ступень аркады или серия выживания — чем дальше, тем дороже. */
  stage: number;
}

export interface Reward {
  coins: number;
  xp: number;
  /** Из чего сложилась награда — показывается построчно на экране итогов. */
  lines: { label: string; coins: number; xp: number }[];
}

/** Тренировка ничего не приносит: там нет соперника, есть манекен. */
const PAID_MODES = new Set(['arcade', 'versus', 'survival', 'online']);

const WIN_COINS = 60;
const LOSS_COINS = 18;
const COINS_PER_1000_DAMAGE = 22;
const COMBO_COINS = 8;
const PERFECT_COINS = 35;

const WIN_XP = 100;
const LOSS_XP = 35;
const XP_PER_1000_DAMAGE = 40;
const COMBO_XP = 12;
const PERFECT_XP = 60;

export function rewardFor(outcome: FightOutcome): Reward {
  const lines: Reward['lines'] = [];
  if (!PAID_MODES.has(outcome.mode)) return { coins: 0, xp: 0, lines };

  const add = (label: string, coins: number, xp: number) => {
    const c = Math.round(coins);
    const x = Math.round(xp);
    if (c === 0 && x === 0) return;
    lines.push({ label, coins: c, xp: x });
  };

  add(outcome.won ? 'Победа' : 'Бой проведён', outcome.won ? WIN_COINS : LOSS_COINS,
      outcome.won ? WIN_XP : LOSS_XP);

  const damage = Math.max(0, outcome.damageDealt) / 1000;
  add('Нанесённый урон', damage * COINS_PER_1000_DAMAGE, damage * XP_PER_1000_DAMAGE);

  // Комбо оплачивается сверх второго удара: два подряд получаются случайно,
  // пять подряд — нет.
  const combo = Math.max(0, outcome.bestCombo - 1);
  add(combo > 0 ? `Комбо ×${outcome.bestCombo}` : '', combo * COMBO_COINS, combo * COMBO_XP);

  if (outcome.perfects > 0) {
    add(`Чистых раундов: ${outcome.perfects}`,
        outcome.perfects * PERFECT_COINS, outcome.perfects * PERFECT_XP);
  }

  let coins = lines.reduce((sum, l) => sum + l.coins, 0);
  let xp = lines.reduce((sum, l) => sum + l.xp, 0);

  // Сложность и глубина — множители, а не слагаемые: они должны делать
  // ценным каждый предыдущий пункт, а не добавлять свой собственный.
  const difficulty = clamp(outcome.difficulty, 0.6, 1.6);
  const depth = 1 + clamp(outcome.stage, 0, 20) * 0.06;
  const multiplier = difficulty * depth;

  if (Math.abs(multiplier - 1) > 0.02) {
    const beforeCoins = coins;
    const beforeXp = xp;
    coins = Math.round(coins * multiplier);
    xp = Math.round(xp * multiplier);
    add(`Множитель ×${multiplier.toFixed(2)}`, coins - beforeCoins, xp - beforeXp);
  }

  return { coins, xp, lines };
}

/**
 * Опыт, нужный для перехода с уровня `level` на следующий.
 *
 * Растёт, но не круто: смысл уровней здесь не в том, чтобы растягивать игру,
 * а в том, чтобы у человека был повод сыграть ещё один бой после того, как
 * все бойцы уже открыты. Полтора часа до десятого уровня — примерно верно.
 */
export function xpForLevel(level: number): number {
  return Math.round(240 * Math.pow(1.22, Math.max(0, level - 1)));
}

export interface LevelState {
  level: number;
  /** Опыт внутри текущего уровня. */
  into: number;
  /** Сколько нужно до следующего. */
  needed: number;
  /** Доля до следующего уровня, `[0, 1]`. */
  ratio: number;
}

export function levelFromXp(totalXp: number): LevelState {
  let level = 1;
  let remaining = Math.max(0, Math.round(totalXp));

  // Потолок нужен: без него испорченное сохранение с гигантским опытом
  // повесило бы игру в этом цикле.
  while (level < MAX_LEVEL && remaining >= xpForLevel(level)) {
    remaining -= xpForLevel(level);
    level++;
  }

  const needed = level >= MAX_LEVEL ? 0 : xpForLevel(level);
  return {
    level,
    into: remaining,
    needed,
    ratio: needed > 0 ? clamp(remaining / needed, 0, 1) : 1,
  };
}

export const MAX_LEVEL = 50;

/** Монеты за новый уровень — чтобы уровень что-то значил, а не был числом. */
export function levelUpBonus(level: number): number {
  return 50 + level * 10;
}

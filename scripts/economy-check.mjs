#!/usr/bin/env node
/**
 * Проверяет экономику: награды, уровни, кейсы, таблицу рекордов.
 *
 * Арифметика прогресса — то место, где ошибка не падает, а тихо портит игру:
 * уровень, который нельзя взять; кейс, который никогда не отдаёт легендарного;
 * рекорд, вытесненный нулём. Ничего из этого не видно на экране, пока не
 * станет поздно.
 *
 * Сборка:
 *   npx esbuild scripts/economy-entry.ts --bundle --format=esm \
 *     --outfile=.tmp/economy.mjs --alias:@=./src
 */

import {
  rewardFor, levelFromXp, xpForLevel, levelUpBonus, MAX_LEVEL,
  openCase, CASES, rarityOf, startingRoster, DUPLICATE_REFUND,
  withRecord, forMode, CHARACTERS,
} from '../.tmp/economy.mjs';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const base = {
  won: true, rounds: [], damageDealt: 2000, bestCombo: 4,
  perfects: 1, difficulty: 1, mode: 'arcade', stage: 0,
};

console.log('Награда за бой:');
{
  const win = rewardFor(base);
  const loss = rewardFor({ ...base, won: false });
  check('победа приносит монеты и опыт', win.coins > 0 && win.xp > 0,
    `${win.coins} монет, ${win.xp} опыта`);
  check('поражение тоже платит', loss.coins > 0 && loss.xp > 0,
    'игра, где проигрыш не даёт ничего, учит не рисковать');
  check('но заметно меньше', loss.coins < win.coins * 0.8,
    `${loss.coins} против ${win.coins}`);
  check('награда расписана построчно', win.lines.length >= 3,
    `${win.lines.length} строк`);
  check('строки сходятся с итогом',
    Math.abs(win.lines.reduce((s, l) => s + l.coins, 0) - win.coins) <= 1,
    `${win.lines.reduce((s, l) => s + l.coins, 0)} против ${win.coins}`);

  const lazy = rewardFor({ ...base, damageDealt: 0, bestCombo: 0, perfects: 0 });
  check('пассивная победа дешевле активной', lazy.coins < win.coins,
    `${lazy.coins} против ${win.coins}`);

  const training = rewardFor({ ...base, mode: 'training' });
  check('тренировка не платит', training.coins === 0 && training.xp === 0,
    'иначе выгоднее всего бить манекен');

  const hard = rewardFor({ ...base, difficulty: 1.6 });
  check('сложность повышает награду', hard.coins > win.coins,
    `${hard.coins} против ${win.coins}`);

  const deep = rewardFor({ ...base, stage: 8 });
  check('глубина аркады повышает награду', deep.coins > win.coins,
    `${deep.coins} против ${win.coins}`);
}

console.log('\nУровни:');
{
  check('нулевой опыт — первый уровень', levelFromXp(0).level === 1);
  check('опыт ровно на уровень его и даёт', levelFromXp(xpForLevel(1)).level === 2,
    String(levelFromXp(xpForLevel(1)).level));

  // Уровень обязан расти монотонно: иначе где-то в таблице потерян уровень.
  let previous = 0;
  let monotonic = true;
  for (let xp = 0; xp < 400_000; xp += 517) {
    const level = levelFromXp(xp).level;
    if (level < previous) monotonic = false;
    previous = level;
  }
  check('уровень нигде не падает при росте опыта', monotonic);
  check('таблица упирается в потолок, а не зацикливается',
    levelFromXp(50_000_000).level === MAX_LEVEL, String(levelFromXp(50_000_000).level));
  check('доля до следующего уровня в пределах [0,1]',
    [0, 100, 5000, 250_000].every((xp) => {
      const s = levelFromXp(xp);
      return s.ratio >= 0 && s.ratio <= 1;
    }));
  check('бонус за уровень растёт', levelUpBonus(10) > levelUpBonus(2));

  // Сколько боёв до десятого уровня — проверка на здравый смысл, а не на код.
  const perFight = rewardFor(base).xp;
  let xp = 0;
  let fights = 0;
  while (levelFromXp(xp).level < 10 && fights < 1000) { xp += perFight; fights++; }
  check('десятый уровень достижим за разумное число боёв',
    fights > 10 && fights < 120, `${fights} боёв по ${perFight} опыта`);
}

console.log('\nКейсы:');
{
  for (const definition of CASES) {
    const sum = Object.values(definition.odds).reduce((a, b) => a + b, 0);
    check(`шансы «${definition.name}» складываются в единицу`, Math.abs(sum - 1) < 1e-9,
      String(sum));
  }

  // Частоты по большой выборке должны сойтись с объявленными шансами: именно
  // это отличает честную таблицу от нарисованной.
  for (const definition of CASES) {
    const counts = { common: 0, rare: 0, legendary: 0 };
    const runs = 20000;
    for (let i = 0; i < runs; i++) counts[openCase(definition, [], i).rarity]++;
    const worst = Object.entries(definition.odds).reduce((max, [rarity, odds]) => {
      const actual = counts[rarity] / runs;
      return Math.max(max, Math.abs(actual - odds));
    }, 0);
    check(`«${definition.name}» выдаёт объявленные шансы`, worst < 0.02,
      `наибольшее расхождение ${(worst * 100).toFixed(2)} п.п.`);
  }

  const shadow = CASES.find((c) => c.id === 'shadow');
  const commons = Array.from({ length: 4000 }, (_, i) => openCase(shadow, [], i))
    .filter((d) => d.rarity === 'common').length;
  check('теневой кейс не отдаёт обычных вовсе', commons === 0, String(commons));

  const owned = startingRoster();
  const drops = Array.from({ length: 500 }, (_, i) => openCase(CASES[0], owned, i));
  const dupes = drops.filter((d) => d.duplicate);
  check('дубликаты случаются', dupes.length > 0);
  check('дубликат возвращает монеты, а не пустоту',
    dupes.every((d) => d.refund === DUPLICATE_REFUND[d.rarity] && d.refund > 0));
  check('новый боец монет не возвращает',
    drops.filter((d) => !d.duplicate).every((d) => d.refund === 0));
  check('выпадают только существующие бойцы',
    drops.every((d) => CHARACTERS.some((c) => c.id === d.characterId)));
  check('редкость дропа совпадает с редкостью бойца',
    drops.every((d) => rarityOf(d.characterId) === d.rarity));

  check('один и тот же seed даёт один и тот же исход',
    JSON.stringify(openCase(CASES[1], [], 42)) === JSON.stringify(openCase(CASES[1], [], 42)),
    'иначе анимация открытия показывала бы не то, что выпало');

  // Собрать всех можно: если пул легендарных недостижим, игра бесконечна зря.
  const collected = new Set(startingRoster());
  for (let i = 0; i < 20000 && collected.size < CHARACTERS.length; i++) {
    collected.add(openCase(CASES[1], [...collected], i).characterId);
  }
  check('всех бойцов реально собрать', collected.size === CHARACTERS.length,
    `${collected.size} из ${CHARACTERS.length}`);
}

console.log('\nТаблица рекордов:');
{
  let records = [];
  for (let i = 1; i <= 8; i++) {
    records = withRecord(records, { mode: 'arcade', score: i, character: 'kai', at: i });
  }
  const arcade = forMode(records, 'arcade');
  check('хранится пять лучших строк', arcade.length === 5, String(arcade.length));
  check('лучшая — первая', arcade[0].score === 8, String(arcade[0].score));
  check('слабые вытеснены', !arcade.some((r) => r.score < 4));

  records = withRecord(records, { mode: 'survival', score: 3, character: 'rei', at: 9 });
  check('режимы не мешают друг другу',
    forMode(records, 'arcade').length === 5 && forMode(records, 'survival').length === 1);

  const before = records.length;
  records = withRecord(records, { mode: 'arcade', score: 0, character: 'kai', at: 10 });
  check('нулевой результат не занимает строку', records.length === before);
}

if (failures > 0) {
  console.error(`\n${failures} проверок не прошло.`);
  process.exit(1);
}
console.log('\nВсе проверки пройдены.');

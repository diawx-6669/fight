/**
 * Headless-вход для `economy-check.mjs`: награды, уровни, кейсы, рекорды.
 *
 * Ничего из этого не касается DOM, и проверять это в браузере значило бы
 * гонять пятнадцать боёв ради арифметики.
 */

export { rewardFor, levelFromXp, xpForLevel, levelUpBonus, MAX_LEVEL } from '@/game/economy';
export { openCase, CASES, caseById, rarityOf, startingRoster, DUPLICATE_REFUND } from '@/game/cases';
export { withRecord, forMode, bestByMode } from '@/game/records';
export { CHARACTERS } from '@/game/characters';

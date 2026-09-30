#!/usr/bin/env node
/**
 * Проверяет то, на что игрок жалуется словами «оно меня не видит».
 *
 * Два прогона одного и того же удара: от игрока, стоящего в полный рост, и от
 * игрока, сидящего за ноутбуком, когда в кадр попадают только плечи и руки.
 * Физически это один удар. До починки засчитывался только первый: «телесная
 * единица» — это торс, а торс при съёмке по пояс оценивается по ширине плеч и
 * выходит почти вдвое больше, так что все скорости делятся на большее число и
 * не дотягивают до фиксированного порога.
 *
 * Отдельно проверяется режим «ошибка»: недоведённый удар обязан породить
 * конкретную подсказку, а не тишину.
 *
 * Сборка:
 *   npx esbuild scripts/punch-entry.ts --bundle --format=esm \
 *     --outfile=.tmp/punch.mjs --alias:@=./src
 */

import { runPunch } from '../.tmp/punch.mjs';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const NOSE = 0, L_SH = 11, R_SH = 12, L_EL = 13, R_EL = 14, L_WR = 15, R_WR = 16;
const L_HIP = 23, R_HIP = 24, L_KN = 25, R_KN = 26, L_AN = 27, R_AN = 28;

function frame(points) {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.02 }));
  for (const [index, value] of Object.entries(points)) {
    landmarks[Number(index)] = { z: 0, visibility: 0.95, ...value };
  }
  return landmarks;
}

/**
 * Строит удар правой: кисть уходит от плеча вперёд за `punchFrames` кадров,
 * потом возвращается. `s` — масштаб фигуры в кадре, он же вся разница между
 * «стою далеко» и «сижу близко».
 */
function punchSequence({ scale, fullBody, punchFrames = 5, idleFrames = 8, travel = 1 }) {
  const cx = 0.5;
  const shoulderY = 0.5 - 0.1 * scale;
  const span = 0.12 * scale;

  const frames = [];
  const at = (t) => {
    // t: 0 — рука у лица, 1 — рука полностью выпрямлена вперёд.
    const wristX = cx + span * 0.5 + t * travel * span * 2.6;
    const wristY = shoulderY + span * 0.15;
    const elbowX = cx + span * 0.35 + t * travel * span * 1.3;

    const points = {
      [NOSE]: { x: cx, y: shoulderY - span * 0.85 },
      [L_SH]: { x: cx - span, y: shoulderY },
      [R_SH]: { x: cx + span, y: shoulderY },
      [L_EL]: { x: cx - span * 1.1, y: shoulderY + span * 0.9 },
      [R_EL]: { x: elbowX, y: shoulderY + span * 0.5 },
      [L_WR]: { x: cx - span * 0.75, y: shoulderY + span * 0.35 },
      [R_WR]: { x: wristX, y: wristY },
    };

    if (fullBody) {
      const hipY = shoulderY + span * 2.1;
      Object.assign(points, {
        [L_HIP]: { x: cx - span * 0.45, y: hipY },
        [R_HIP]: { x: cx + span * 0.45, y: hipY },
        [L_KN]: { x: cx - span * 0.42, y: hipY + span * 1.7 },
        [R_KN]: { x: cx + span * 0.42, y: hipY + span * 1.7 },
        [L_AN]: { x: cx - span * 0.4, y: hipY + span * 3.4 },
        [R_AN]: { x: cx + span * 0.4, y: hipY + span * 3.4 },
      });
    }
    return frame(points);
  };

  for (let i = 0; i < idleFrames; i++) frames.push(at(0));

  // Выброс с замедлением к концу, а не равномерный.
  // Это не косметика: детектор ищет пик скорости и её спад — так он ставит
  // удар в тот момент, когда человек его чувствует, а не на полсекунды позже.
  // Равномерное движение пика не имеет, детектор досиживает до таймаута, и к
  // этому времени рука уже возвращается — измеренный путь выходит нулевым.
  // Иначе говоря, синтетика без замедления проверяет то, чего не бывает.
  for (let i = 1; i <= punchFrames; i++) {
    const k = i / punchFrames;
    frames.push(at(1 - (1 - k) * (1 - k)));
  }
  for (let i = 0; i < 3; i++) frames.push(at(1));
  for (let i = punchFrames; i >= 0; i--) frames.push(at((i / punchFrames) * 0.35));
  for (let i = 0; i < idleFrames; i++) frames.push(at(0));
  return frames;
}

/**
 * Калибровка снимается с той же последовательности, что потом играется.
 *
 * Так делает и настоящая калибровка: она запоминает, насколько далеко кисть
 * ушла от плеча на разминке. Зашивать сюда числа «от настоящего человека»
 * было бы ошибкой — они не имеют отношения к пропорциям этой синтетической
 * фигуры, и тест проверял бы не игру, а согласованность двух моих выдумок.
 */
function calibrationFor(frames) {
  const peak = peakReach(frames);
  return { reachForward: peak, standingHipY: 2.1 };
}

/**
 * Максимальное расстояние от плеча до кисти за всю последовательность,
 * в телесных единицах — ровно та величина, которую пишет калибровка.
 */
function peakReach(frames) {
  let best = 0;
  for (const f of frames) {
    const sh = f[R_SH];
    const wr = f[R_WR];
    const torso = f[L_HIP].visibility > 0.5
      ? Math.hypot((f[L_HIP].x + f[R_HIP].x) / 2 - (f[L_SH].x + f[R_SH].x) / 2,
                   (f[L_HIP].y + f[R_HIP].y) / 2 - (f[L_SH].y + f[R_SH].y) / 2)
      : Math.min(Math.hypot(f[R_SH].x - f[L_SH].x, f[R_SH].y - f[L_SH].y) * 1.25, 0.6);
    best = Math.max(best, Math.hypot(wr.x - sh.x, wr.y - sh.y) / torso);
  }
  return best;
}

console.log('Удар в полный рост:');
{
  const frames = punchSequence({ scale: 1, fullBody: true });
  const r = runPunch(frames, { calibration: calibrationFor(frames) });
  check('кадр разобран как полное тело', !r.upperBodyOnly);
  const punches = r.actions.filter((a) => a.kind === 'punch');
  check('удар засчитан', punches.length > 0, `действий: ${r.actions.length}`);
  if (punches.length) {
    check('удар пришёл правой', punches[0].side === 'right', punches[0].side);
    check('сила в разумных пределах', punches[0].power > 0.3 && punches[0].power <= 1,
      String(punches[0].power));
  }
}

console.log('\nТот же удар, в кадре только верх тела:');
{
  const frames = punchSequence({ scale: 2.2, fullBody: false });
  const r = runPunch(frames, { calibration: calibrationFor(frames) });
  check('кадр разобран как верх тела', r.upperBodyOnly);
  const punches = r.actions.filter((a) => a.kind === 'punch');
  check(
    'удар засчитан — раньше здесь была тишина',
    punches.length > 0,
    `действий: ${r.actions.length}, ошибки: ${r.mistakes.map((m) => `${m.code}×${m.count}`).join(', ') || 'нет'}`,
  );
}

console.log('\nРежим «ошибка» — слабый, недоведённый удар:');
{
  // Кисть проходит четверть нужного пути: человек обозначил удар, а не ударил.
  // Калибровка от полноценного удара, а сам удар — вполсилы. Именно так и
  // выглядит настоящий промах: человек размялся как следует, а в бою
  // обозначает движение вместо того, чтобы его делать.
  const reference = punchSequence({ scale: 1, fullBody: true });
  const frames = punchSequence({ scale: 1, fullBody: true, travel: 0.45, punchFrames: 7 });
  const r = runPunch(frames, { calibration: calibrationFor(reference) });
  check('удар не засчитан', r.actions.filter((a) => a.kind === 'punch').length === 0);
  check('игра не промолчала', r.hint !== null,
    'ни одной подсказки — именно это и выглядит как «игра сломана»');
  if (r.hint) {
    console.log(`    → «${r.hint.title}: ${r.hint.fix}» (${Math.round(r.hint.progress * 100)}%)`);
    check('подсказка про сам удар, а не про кадр',
      ['punchTooShort', 'punchTooSlow', 'punchNotExtended'].includes(r.hint.code), r.hint.code);
    check('подсказка говорит, насколько было близко',
      r.hint.progress > 0 && r.hint.progress < 1, String(r.hint.progress));
    check('подсказка предлагает действие, а не диагноз', r.hint.fix.length > 12);
  }
}

console.log('\nРежим «ошибка» — рука вне кадра:');
{
  const frames = punchSequence({ scale: 1, fullBody: true });
  // Модель теряет правое запястье ровно посреди выброса — рука есть, удара нет.
  for (let i = 10; i < frames.length; i++) frames[i][R_WR].visibility = 0.1;
  const r = runPunch(frames, { calibration: calibrationFor(frames) });
  const codes = r.mistakes.map((m) => m.code);
  check('потерянная рука замечена', codes.includes('armHidden'),
    `ошибки: ${codes.join(', ') || 'нет'}`);
}

console.log('\nАвтоподстройка — игра, которая не видит ударов:');
{
  // Человек бьёт раз за разом почти как надо, и ни один удар не проходит.
  // Именно так выглядит жалоба «сайт не видит моих ударов»: дело не в том,
  // что он делает не то, а в том, что порог стоит не там.
  const reference = punchSequence({ scale: 1, fullBody: true });
  const calibration = calibrationFor(reference);

  let frames = [];
  for (let i = 0; i < 12; i++) {
    frames = frames.concat(punchSequence({ scale: 1, fullBody: true, travel: 0.5, punchFrames: 6, idleFrames: 8 }));
  }
  const r = runPunch(frames, { calibration });

  check('игра заметила, что пороги не по человеку', r.assistPercent > 0,
    `подстройка ${r.assistPercent}%`);
  check('но не опустила их безгранично', r.assistPercent <= 50,
    `подстройка ${r.assistPercent}%`);
  console.log(`    → облегчила пороги на ${r.assistPercent}%`);
}

console.log('\nПодстройка действительно опускает порог:');
{
  const reference = punchSequence({ scale: 1, fullBody: true });
  const calibration = calibrationFor(reference);
  let frames = [];
  for (let i = 0; i < 10; i++) {
    frames = frames.concat(punchSequence({ scale: 1, fullBody: true, travel: 0.55, punchFrames: 6, idleFrames: 8 }));
  }

  const strict = runPunch(frames, { calibration, assist: 1 });
  const helped = runPunch(frames, { calibration, assist: 1.5 });
  const a = strict.actions.filter((x) => x.kind === 'punch').length;
  const b = helped.actions.filter((x) => x.kind === 'punch').length;

  check('с подстройкой засчитывается больше ударов', b > a, `${a} → ${b}`);
  console.log(`    → без помощи ${a}, с помощью ${b}`);
}

console.log('\nАвтоподстройка не включается, когда всё и так работает:');
{
  let frames = [];
  for (let i = 0; i < 10; i++) {
    frames = frames.concat(punchSequence({ scale: 1, fullBody: true, idleFrames: 3 }));
  }
  const reference = punchSequence({ scale: 1, fullBody: true });
  const r = runPunch(frames, { calibration: calibrationFor(reference) });

  check('удары засчитываются', r.actions.filter((a) => a.kind === 'punch').length >= 5,
    `${r.actions.filter((a) => a.kind === 'punch').length} ударов`);
  check('помощь не понадобилась', r.assistPercent === 0, `подстройка ${r.assistPercent}%`);
}

if (failures > 0) {
  console.error(`\n${failures} проверок не прошло.`);
  process.exit(1);
}
console.log('\nВсе проверки пройдены.');

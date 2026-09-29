#!/usr/bin/env node
/**
 * Checks the body-space builder against synthetic poses.
 *
 * This is the one piece of the vision pipeline worth testing without a camera:
 * everything downstream trusts `buildSkeleton` to hand it a sane frame of
 * reference, and the upper-body path has to produce one from a hip the model
 * never actually saw.
 *
 * Build the module first:
 *   npx esbuild src/vision/skeleton.ts --bundle --format=esm --outfile=.tmp/skeleton.mjs
 */

import { Skeleton, buildSkeleton, Joint } from '../.tmp/skeleton.mjs';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(actual, expected, tolerance, label) {
  check(
    label,
    Math.abs(actual - expected) <= tolerance,
    `получили ${actual.toFixed(3)}, ждали ${expected.toFixed(3)} ±${tolerance}`,
  );
}

/** Builds 33 landmarks, all hidden, then applies the given overrides. */
function pose(overrides) {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.02 }));
  for (const [index, value] of Object.entries(overrides)) {
    landmarks[Number(index)] = { z: 0, visibility: 0.95, ...value };
  }
  return landmarks;
}

// A laptop-webcam framing: head, shoulders and arms, nothing below the ribs.
// Proportions follow an adult seen close up — shoulder width 0.24 of the frame,
// nose about 0.43 shoulder widths above the shoulder line.
const UPPER_BODY = pose({
  [Joint.Nose]: { x: 0.5, y: 0.417 },
  [Joint.LeftShoulder]: { x: 0.38, y: 0.52 },
  [Joint.RightShoulder]: { x: 0.62, y: 0.52 },
  [Joint.LeftElbow]: { x: 0.34, y: 0.7 },
  [Joint.RightElbow]: { x: 0.66, y: 0.7 },
  [Joint.LeftWrist]: { x: 0.37, y: 0.86 },
  [Joint.RightWrist]: { x: 0.63, y: 0.86 },
});

// The same player standing back far enough for the whole body to fit.
const FULL_BODY = pose({
  [Joint.Nose]: { x: 0.5, y: 0.14 },
  [Joint.LeftShoulder]: { x: 0.44, y: 0.26 },
  [Joint.RightShoulder]: { x: 0.56, y: 0.26 },
  [Joint.LeftElbow]: { x: 0.42, y: 0.38 },
  [Joint.RightElbow]: { x: 0.58, y: 0.38 },
  [Joint.LeftWrist]: { x: 0.43, y: 0.49 },
  [Joint.RightWrist]: { x: 0.57, y: 0.49 },
  [Joint.LeftHip]: { x: 0.46, y: 0.52 },
  [Joint.RightHip]: { x: 0.54, y: 0.52 },
  [Joint.LeftKnee]: { x: 0.455, y: 0.72 },
  [Joint.RightKnee]: { x: 0.545, y: 0.72 },
  [Joint.LeftAnkle]: { x: 0.45, y: 0.92 },
  [Joint.RightAnkle]: { x: 0.55, y: 0.92 },
});

// Turned away: the model reports a person, but not both shoulders.
const NO_SHOULDERS = pose({
  [Joint.Nose]: { x: 0.5, y: 0.4 },
  [Joint.LeftShoulder]: { x: 0.45, y: 0.52, visibility: 0.1 },
  [Joint.RightShoulder]: { x: 0.55, y: 0.52, visibility: 0.12 },
});

console.log('Полное тело:');
{
  const skeleton = new Skeleton();
  const ok = buildSkeleton(skeleton, FULL_BODY, 1000, false);
  check('кадр принят', ok);
  check('режим — всё тело', !skeleton.upperBodyOnly);
  check('ноги видны', skeleton.legsVisible);
  near(skeleton.torsoLength, 0.26, 0.02, 'длина торса измерена по тазу');
  near(skeleton.hipY, 0.52, 0.001, 'таз взят из ландмарок');
}

console.log('\nТолько верх тела:');
{
  const skeleton = new Skeleton();
  const ok = buildSkeleton(skeleton, UPPER_BODY, 1000, false);
  check('кадр принят', ok, 'раньше здесь игра вставала намертво');
  check('режим — верх тела', skeleton.upperBodyOnly);
  check('ноги не видны', !skeleton.legsVisible);

  // Shoulder width 0.24 → torso ≈ 0.30; the head-span floor must not win here.
  near(skeleton.torsoLength, 0.3, 0.03, 'масштаб выведен из ширины плеч');
  check(
    'выведенный таз ниже плеч',
    skeleton.hipY > skeleton.shoulderY,
    `таз ${skeleton.hipY.toFixed(3)}, плечи ${skeleton.shoulderY.toFixed(3)}`,
  );
  near(skeleton.hipX, 0.5, 0.02, 'таз по центру плеч');

  // Body space must be usable: the wrist sits below the shoulder and roughly
  // one torso length out from it.
  const wrist = skeleton.at(Joint.RightWrist);
  const shoulder = skeleton.at(Joint.RightShoulder);
  check('запястье ниже плеча в телесных координатах', wrist.y < shoulder.y);
  check(
    'запястье на вменяемом расстоянии от осевой',
    Math.abs(wrist.x) > 0.2 && Math.abs(wrist.x) < 2,
    `x=${wrist.x.toFixed(2)}`,
  );
  check('уверенность считается по верхним суставам', skeleton.confidence > 0.5);
}

console.log('\nПлечи не видны:');
{
  const skeleton = new Skeleton();
  const ok = buildSkeleton(skeleton, NO_SHOULDERS, 1000, false);
  check('кадр отклонён', !ok);
  check('скелет не считается найденным', !skeleton.present);
  check('но поза от модели зафиксирована', skeleton.hasLandmarks);
}

console.log('\nБоком к камере (плечи сжаты проекцией):');
{
  const sideways = pose({
    [Joint.Nose]: { x: 0.5, y: 0.417 },
    [Joint.LeftShoulder]: { x: 0.49, y: 0.52 },
    [Joint.RightShoulder]: { x: 0.53, y: 0.52 },
    [Joint.LeftElbow]: { x: 0.47, y: 0.7 },
    [Joint.RightElbow]: { x: 0.55, y: 0.7 },
    [Joint.LeftWrist]: { x: 0.48, y: 0.86 },
    [Joint.RightWrist]: { x: 0.56, y: 0.86 },
  });
  const skeleton = new Skeleton();
  buildSkeleton(skeleton, sideways, 1000, false);
  // Shoulder width collapses to 0.04 here. Without the head-span floor the
  // torso estimate would be 0.05 and every threshold derived from it would be
  // an order of magnitude too small.
  check(
    'масштаб не схлопнулся при развороте боком',
    skeleton.torsoLength > 0.15,
    `торс ${skeleton.torsoLength.toFixed(3)}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} проверок не прошло.`);
  process.exit(1);
}
console.log('\nВсе проверки пройдены.');

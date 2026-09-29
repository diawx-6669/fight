#!/usr/bin/env node
/**
 * Drives the camera→rig path that the browser smoke test can never reach.
 *
 * Without a webcam the game falls back to the procedural animator, so the
 * retargeting code — the code that actually runs for every real player — is
 * exercised by nothing. A single non-finite number anywhere in this chain
 * makes every joint NaN, the fighter disappears, and the screen goes black
 * with no error at all.
 *
 * Build first:
 *   npx esbuild scripts/retarget-entry.ts --bundle --format=esm --outfile=.tmp/retarget.mjs
 */

import { runRetarget } from '../.tmp/retarget.mjs';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function pose(overrides) {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.02 }));
  for (const [index, value] of Object.entries(overrides)) {
    landmarks[Number(index)] = { z: 0, visibility: 0.95, ...value };
  }
  return landmarks;
}

const NOSE = 0, L_SH = 11, R_SH = 12, L_EL = 13, R_EL = 14, L_WR = 15, R_WR = 16;
const L_HIP = 23, R_HIP = 24, L_KN = 25, R_KN = 26, L_AN = 27, R_AN = 28;

const CASES = {
  'полное тело, руки опущены': pose({
    [NOSE]: { x: 0.5, y: 0.14 },
    [L_SH]: { x: 0.44, y: 0.26 }, [R_SH]: { x: 0.56, y: 0.26 },
    [L_EL]: { x: 0.42, y: 0.38 }, [R_EL]: { x: 0.58, y: 0.38 },
    [L_WR]: { x: 0.43, y: 0.49 }, [R_WR]: { x: 0.57, y: 0.49 },
    [L_HIP]: { x: 0.46, y: 0.52 }, [R_HIP]: { x: 0.54, y: 0.52 },
    [L_KN]: { x: 0.455, y: 0.72 }, [R_KN]: { x: 0.545, y: 0.72 },
    [L_AN]: { x: 0.45, y: 0.92 }, [R_AN]: { x: 0.55, y: 0.92 },
  }),
  'только верх тела': pose({
    [NOSE]: { x: 0.5, y: 0.417 },
    [L_SH]: { x: 0.38, y: 0.52 }, [R_SH]: { x: 0.62, y: 0.52 },
    [L_EL]: { x: 0.34, y: 0.7 }, [R_EL]: { x: 0.66, y: 0.7 },
    [L_WR]: { x: 0.37, y: 0.86 }, [R_WR]: { x: 0.63, y: 0.86 },
  }),
  'рука вытянута в удар': pose({
    [NOSE]: { x: 0.5, y: 0.417 },
    [L_SH]: { x: 0.38, y: 0.52 }, [R_SH]: { x: 0.62, y: 0.52 },
    [L_EL]: { x: 0.3, y: 0.55 }, [R_EL]: { x: 0.66, y: 0.7 },
    [L_WR]: { x: 0.14, y: 0.56 }, [R_WR]: { x: 0.63, y: 0.86 },
  }),
  'все суставы в одной точке': pose({
    [NOSE]: { x: 0.5, y: 0.5 },
    [L_SH]: { x: 0.5, y: 0.5 }, [R_SH]: { x: 0.5, y: 0.5 },
    [L_EL]: { x: 0.5, y: 0.5 }, [R_EL]: { x: 0.5, y: 0.5 },
    [L_WR]: { x: 0.5, y: 0.5 }, [R_WR]: { x: 0.5, y: 0.5 },
  }),
  'плечи слиплись, руки разведены': pose({
    [NOSE]: { x: 0.5, y: 0.45 },
    [L_SH]: { x: 0.5, y: 0.52 }, [R_SH]: { x: 0.5, y: 0.52 },
    [L_EL]: { x: 0.2, y: 0.6 }, [R_EL]: { x: 0.8, y: 0.6 },
    [L_WR]: { x: 0.02, y: 0.7 }, [R_WR]: { x: 0.98, y: 0.7 },
  }),
};

for (const [label, landmarks] of Object.entries(CASES)) {
  console.log(`\n${label}:`);
  let result;
  try {
    result = runRetarget(landmarks);
  } catch (error) {
    check('ретаргет не бросает исключение', false, String(error));
    continue;
  }

  check('ретаргет не бросает исключение', true);

  if (!result.present) {
    check('кадр отклонён осознанно, без мусора в риге', true);
    continue;
  }

  const bad = result.joints.filter((j) => !Number.isFinite(j.x) || !Number.isFinite(j.y));
  check(
    'все суставы рига — конечные числа',
    bad.length === 0,
    bad.length ? `${bad.length} сломанных: ${bad.map((j) => j.name).join(', ')}` : '',
  );

  const far = result.joints.filter((j) => Math.abs(j.x) > 60 || Math.abs(j.y) > 60);
  check(
    'суставы не улетели за пределы арены',
    far.length === 0,
    far.length ? `${far[0].name} на (${far[0].x.toFixed(1)}, ${far[0].y.toFixed(1)})` : '',
  );
}

if (failures > 0) {
  console.error(`\n${failures} проверок не прошло.`);
  process.exit(1);
}
console.log('\nВсе проверки пройдены.');

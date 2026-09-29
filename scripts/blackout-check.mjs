#!/usr/bin/env node
/**
 * Proves the game cannot be blacked out by a single bad number.
 *
 * This is the bug that was reported as "the game just doesn't work": the whole
 * scene gone, the HUD still drawn over it, and nothing in the console. Canvas
 * 2D answers a non-finite transform by silently drawing nothing, so one `NaN`
 * in a fighter position — or in the camera focus derived from it — removes
 * every camera-space draw call in the game while leaving design-space ones
 * untouched. The HUD never uses the camera, which is exactly why it survived
 * and made the failure so confusing to look at.
 *
 * So the defences get a test that reproduces the failure on purpose: poison
 * the simulation from the console, then check the screen is still painting.
 *
 * Needs the dev server (`npm run dev`) — `window.shadowstrike` only exists in
 * development builds.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.smoke');
const URL = process.env.POSE_URL ?? 'http://127.0.0.1:5175/';

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader'],
});
// Deliberately not 16:9. The stage is letterboxed inside whatever shape the
// window is, and for a long time the canvas was only cleared when there were
// bars to paint — so a scene that stopped drawing looked frozen in a 16:9
// window and black in every other one. Testing in 16:9 tested the one shape
// that could not show the reported bug.
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera'] });
const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

/** Mean brightness of the stage canvas, 0–255. */
const BRIGHTNESS = () => {
  const canvas = document.getElementById('stage');
  const probe = document.createElement('canvas');
  probe.width = 160;
  probe.height = 90;
  const ctx = probe.getContext('2d');
  ctx.drawImage(canvas, 0, 0, 160, 90);
  const data = ctx.getImageData(0, 0, 160, 90).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  return sum / (data.length / 4);
};

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Waits for the app to finish booting, so a navigation is not dropped. */
async function settled() {
  await page.waitForFunction(
    () => window.shadowstrike && !window.shadowstrike.router.isTransitioning,
    null,
    { timeout: 30_000 },
  );
}

try {
  await page.goto(URL, { waitUntil: 'load', timeout: 45_000 });
  await settled();

  await page.evaluate(() => window.shadowstrike.navigate('fight', { mode: 'training' }));
  await settled();
  await page.waitForTimeout(2000);

  const healthy = await page.evaluate(BRIGHTNESS);
  check('бой рисуется до вмешательства', healthy > 6, `яркость ${healthy.toFixed(1)}`);

  const POISON = [
    ['позиция бойца', () => {
      const world = window.shadowstrike.router.current.world;
      world.p1.x = NaN;
      world.p2.vx = Infinity;
    }],
    ['фокус камеры', () => {
      const world = window.shadowstrike.router.current.world;
      world.focus.x = NaN;
      world.focus.zoom = NaN;
    }],
    ['тряска экрана', () => {
      const world = window.shadowstrike.router.current.world;
      world.shake.x = NaN;
      world.shake.y = -Infinity;
    }],
  ];

  for (const [label, poison] of POISON) {
    console.log(`\nОтравляем: ${label}`);
    await page.evaluate(poison);
    await page.waitForTimeout(1200);

    const brightness = await page.evaluate(BRIGHTNESS);
    // Compared against the healthy frame rather than against a fixed floor:
    // the backdrop alone is bright enough to pass any absolute threshold, so
    // an absolute check would sail straight past a scene with no fighters in
    // it — which is most of what going wrong here looks like.
    check(
      'кадр остался таким же живым, как до вмешательства',
      brightness > healthy * 0.6,
      `яркость ${brightness.toFixed(1)} против ${healthy.toFixed(1)}`,
    );

    // The original failure was an exception, not a dim frame: a non-finite
    // coordinate makes `createRadialGradient` throw, the frame unwinds before
    // the HUD is drawn, and five of those stop the game outright.
    check('игра не остановилась с ошибкой', !(await page.locator('#runtime-error').count()));

    const finite = await page.evaluate(() => {
      const world = window.shadowstrike.router.current.world;
      return [world.p1.x, world.p2.vx, world.focus.x, world.focus.zoom, world.shake.x]
        .every(Number.isFinite);
    });
    check('симуляция вернулась к конечным числам', finite);
    await page.screenshot({ path: join(OUT, `blackout-${label.split(' ')[0]}.png`) });
  }

  const repairs = await page.evaluate(() => window.shadowstrike.router.current.world.badNumberTicks);
  check('починки были замечены и посчитаны', repairs > 0, `счётчик ${repairs}`);

  // --- the screen that comes up black ---------------------------------------
  //
  // Reproduces the shape of the original report exactly: the scene draws
  // nothing while the HUD carries on over the top of it, because the HUD never
  // touches the camera. Dropping the per-fighter visuals is the cheapest way
  // to force that from outside, and it is one of the states `draw` already
  // refuses to run in.
  //
  // What is being tested is not the renderer but the *response*: the game has
  // to notice, fall back to the plain path by itself, and — when even that is
  // blank, as it is here — say so instead of sitting there black.
  console.log('\nСцена, которая рисует пустоту:');
  await page.evaluate(() => {
    const scene = window.shadowstrike.router.current.scene;
    scene.visuals = null;
    // Keep it null: entering safe mode re-attaches the scene, which would
    // otherwise quietly repair it and hide the failure being tested.
    Object.defineProperty(scene, 'visuals', { get: () => null, set: () => {} });
  });

  // Generous, and deliberately a wait-for rather than a sleep: the watch
  // samples on the wall clock, and this runs in a software renderer managing a
  // few frames a second. Two verdicts have to land — one to drop to the plain
  // renderer, a second to give up on it — and each needs its own window.
  let reported = true;
  await page
    .waitForSelector('#blank-screen', { timeout: 45_000 })
    .catch(() => { reported = false; });

  check(
    'игра сама ушла на простую графику',
    await page.evaluate(() => window.shadowstrike.settings.quality === 'low'),
    await page.evaluate(() => window.shadowstrike.settings.quality),
  );
  check('пустой экран не остался молча пустым', reported);
  await page.screenshot({ path: join(OUT, 'blackout-reported.png') });
} catch (error) {
  check('прогон завершился', false, String(error));
} finally {
  if (errors.length) {
    console.error('\nОшибки страницы:');
    for (const e of errors.slice(0, 5)) console.error(`  ✗ ${e}`);
    failures += errors.length;
  }
  await browser.close();
}

if (failures > 0) {
  console.error(`\n${failures} проблем.`);
  process.exit(1);
}
console.log('\nЧёрный экран воспроизвести не удалось — как и задумано.');

#!/usr/bin/env node
/**
 * Reproduces the black screen.
 *
 * The browser smoke test passes because without a webcam the game falls back
 * to the procedural animator. A real player has pose data, so the renderer
 * takes a completely different path — the one that retargets the camera onto
 * the fighter's rig every frame. Nothing exercised that in a browser.
 *
 * This drives a real fight with a synthetic skeleton injected into the running
 * app, then checks that the canvas is actually painting something.
 *
 * Needs the dev server (`npm run dev`), because the app only exposes itself on
 * `window.shadowstrike` in development builds.
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
  args: ['--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

await context.addInitScript(() => {
  localStorage.setItem(
    'shadowstrike:calibration',
    JSON.stringify({
      version: 2, torsoLength: 0.22, restWristY: -0.75, restWristX: 0.62,
      reachUp: 1.85, reachForward: 1.55, standingHipY: 2.1, noiseFloor: 0.012,
      centerX: 0.5, floorY: 0.98, quality: 0.8, capturedAt: Date.now(),
    }),
  );
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (t.includes('Failed to load resource') || t.includes('Камера не найдена') || t.includes('model load failed')) return;
  errors.push(`console: ${t}`);
});

async function clickDesign(x, y, settle = 1600) {
  const box = await page.locator('#stage').boundingBox();
  const aspect = 16 / 9;
  let sw = box.width, sh = sw / aspect;
  if (sh > box.height) { sh = box.height; sw = sh * aspect; }
  const ox = box.x + (box.width - sw) / 2;
  const oy = box.y + (box.height - sh) / 2;
  await page.mouse.click(ox + (x / 1920) * sw, oy + (y / 1080) * sh);
  await page.waitForTimeout(settle);
}

/** Writes a plausible body-space pose straight into the live skeleton. */
const INJECT_SOURCE = (upperBodyOnly) => {
  const app = window.shadowstrike;
  if (!app) return 'нет window.shadowstrike — нужен dev-сервер';
  const vision = app.vision;
  if (!vision) return 'нет vision';
  const sk = vision.skeleton;

  // Body space: hips at the origin, one unit = torso length, +y up.
  const J = {
    0: [0, 2.0], 11: [-0.45, 1.0], 12: [0.45, 1.0],
    13: [-0.7, 0.45], 14: [0.7, 0.45], 15: [-0.55, 0.05], 16: [0.55, 0.05],
    23: [-0.18, 0], 24: [0.18, 0], 25: [-0.2, -1.05], 26: [0.2, -1.05],
    27: [-0.22, -2.1], 28: [0.22, -2.1],
  };
  for (let i = 0; i < 33; i++) {
    const p = J[i] ?? [0, 0.5];
    sk.joints[i].x = p[0];
    sk.joints[i].y = p[1];
    sk.joints[i].z = 0;
    sk.joints[i].visibility = upperBodyOnly && i >= 23 ? 0.05 : 0.95;
    sk.raw[i].x = 0.5 + p[0] * 0.1;
    sk.raw[i].y = 0.6 - p[1] * 0.1;
    sk.raw[i].visibility = sk.joints[i].visibility;
  }
  sk.present = true;
  sk.hasLandmarks = true;
  sk.upperBodyOnly = upperBodyOnly;
  sk.legsVisible = !upperBodyOnly;
  sk.confidence = 0.9;
  sk.anchorVisibility = 0.9;
  sk.torsoLength = 0.22;
  sk.hipX = 0.5; sk.hipY = 0.62;
  sk.shoulderX = 0.5; sk.shoulderY = 0.5;
  sk.shoulderWidth = 0.2;
  sk.timestamp = performance.now();

  const motion = vision.analyzer?.state;
  if (motion) { motion.quality = 0.9; motion.guarding = false; }
  return 'ok';
};

// Install it in the page so a timer can keep re-applying it: the vision loop
// never refreshes the skeleton here (no model), but the game is free to reset
// `present` on its own, and a pose applied once would not survive a round
// transition.
await context.addInitScript((source) => {
  window.__inject = new Function('upperBodyOnly', `return (${source})(upperBodyOnly)`);
}, INJECT_SOURCE.toString());

/** Mean brightness of the stage canvas, 0–255. */
const BRIGHTNESS = () => {
  const canvas = document.getElementById('stage');
  const probe = document.createElement('canvas');
  probe.width = 160; probe.height = 90;
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
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

try {
  await page.goto(URL, { waitUntil: 'load', timeout: 45_000 });
  await page.waitForTimeout(4000);

  await clickDesign(400, 418);           // В БОЙ
  await clickDesign(1622, 991);          // ВЫБРАТЬ БОЙЦА
  await clickDesign(1612, 1001, 3000);   // В БОЙ

  const menuBrightness = await page.evaluate(BRIGHTNESS);
  check('бой отрисовался до подачи позы', menuBrightness > 6, `яркость ${menuBrightness.toFixed(1)}`);
  await page.screenshot({ path: join(OUT, 'pose-00-before.png') });

  for (const [label, upper] of [['всё тело', false], ['верх тела', true]]) {
    console.log(`\nПоза: ${label}`);
    const injected = await page.evaluate((u) => window.__inject(u), upper);
    check('поза внедрена', injected === 'ok', injected);
    if (injected !== 'ok') break;

    // Keep re-injecting: the vision loop would otherwise never refresh it.
    await page.evaluate((u) => {
      window.__poseTimer && clearInterval(window.__poseTimer);
      window.__poseTimer = setInterval(() => window.__inject(u), 30);
    }, upper);
    await page.waitForTimeout(3500);

    const brightness = await page.evaluate(BRIGHTNESS);
    check('экран не чёрный', brightness > 6, `яркость ${brightness.toFixed(1)}`);
    check('игра не остановилась с ошибкой', !(await page.locator('#runtime-error').count()));

    await page.screenshot({ path: join(OUT, `pose-${upper ? 'upper' : 'full'}.png`) });
  }
  // --- a navigation that throws must not swallow the screen ---------------
  //
  // This is the black screen reproduced on purpose. Breaking the quality tier
  // makes FightScreen.enter() throw while the transition curtain is fully
  // down; before the fix the curtain never lifted and nothing was reported.
  console.log('\nСломанный переход:');
  await page.evaluate(() => {
    window.__poseTimer && clearInterval(window.__poseTimer);
    window.shadowstrike.settings.quality = 'не-существует';
    window.shadowstrike.context.settings.quality = 'не-существует';
  });

  await clickDesign(960, 1080 - 180, 1200);   // В МЕНЮ / любой выход
  await page.evaluate(() => window.shadowstrike.navigate('menu'));
  await page.waitForTimeout(1600);
  await clickDesign(400, 418);
  await clickDesign(1622, 991);
  await clickDesign(1612, 1001, 2500);

  const reported = await page.locator('#runtime-error').count();
  const brightness = await page.evaluate(BRIGHTNESS);
  check('сбой перехода показан игроку, а не съеден', reported > 0 || brightness > 6,
    `панель=${reported}, яркость ${brightness.toFixed(1)}`);
  await page.screenshot({ path: join(OUT, 'pose-broken-nav.png') });
  // The deliberate breakage produces expected console noise; drop it.
  errors.length = 0;
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

if (failures > 0) { console.error(`\n${failures} проблем.`); process.exit(1); }
console.log('\nВсё чисто.');

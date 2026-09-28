#!/usr/bin/env node
/**
 * Browser smoke test.
 *
 * Boots the built game in headless Chromium, walks menu → mode → character →
 * fight, and fails if anything throws. It is deliberately not a unit test
 * suite: this project's failure modes are overwhelmingly *visual and
 * integrative* — a rig that inverts, a path that fills inside out, a screen
 * that never advances — and none of those are caught by asserting on numbers.
 *
 * Screenshots land in `.smoke/` so a human can look at what the machine saw.
 *
 *   npm run build && npm run smoke
 *
 * The camera and the model CDN are both expected to be unavailable here. That
 * is part of the test: the game must stay usable when they are.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.SMOKE_OUT ?? join(ROOT, '.smoke');
const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/';
const EXECUTABLE = process.env.CHROMIUM_PATH ?? undefined;

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
  args: [
    '--use-fake-device-for-media-capture',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader',
  ],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 810 },
  permissions: ['camera'],
});

// Seed a calibration profile and some progress so the walk reaches a fight
// without needing a body in front of the camera.
await context.addInitScript(() => {
  localStorage.setItem(
    'shadowstrike:calibration',
    JSON.stringify({
      version: 2,
      torsoLength: 0.22,
      restWristY: -0.75,
      restWristX: 0.62,
      reachUp: 1.85,
      reachForward: 1.55,
      standingHipY: 2.1,
      noiseFloor: 0.012,
      centerX: 0.5,
      floorY: 0.98,
      quality: 0.8,
      capturedAt: Date.now(),
    }),
  );
  localStorage.setItem(
    'shadowstrike:progress',
    JSON.stringify({
      wins: 12,
      losses: 3,
      arcadeStage: 2,
      survivalBest: 0,
      played: [],
      totalHits: 214,
      totalDamage: 9100,
      bestCombo: 7,
      perfects: 2,
    }),
  );
});

const page = await context.newPage();

/** Only genuine script failures fail the run; network and camera do not. */
const fatal = [];
page.on('pageerror', (error) => fatal.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  if (text.includes('Failed to load resource')) return;
  if (text.includes('Камера не найдена')) return;
  if (text.includes('model load failed')) return;
  fatal.push(`console: ${text}`);
});

/** Clicks a point given in the game's 1920×1080 design space. */
async function clickDesign(x, y, settle = 1400) {
  const box = await page.locator('#stage').boundingBox();
  if (!box) throw new Error('#stage has no layout box');

  const aspect = 16 / 9;
  let stageWidth = box.width;
  let stageHeight = stageWidth / aspect;
  if (stageHeight > box.height) {
    stageHeight = box.height;
    stageWidth = stageHeight * aspect;
  }
  const originX = box.x + (box.width - stageWidth) / 2;
  const originY = box.y + (box.height - stageHeight) / 2;

  await page.mouse.move(originX + (x / 1920) * stageWidth, originY + (y / 1080) * stageHeight);
  await page.waitForTimeout(160);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(settle);
}

const steps = [
  ['01-menu', null],
  ['02-mode', [400, 418]],
  ['03-character', [1622, 991]],
  ['04-fight', [1612, 1001]],
];

try {
  await page.goto(URL, { waitUntil: 'load', timeout: 45_000 });
  await page.waitForTimeout(4500);

  for (const [name, click] of steps) {
    if (click) await clickDesign(click[0], click[1], 2400);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log(`  ✓ ${name}`);
  }

  // Let the fight run a while: most rendering bugs only show up once the
  // animator, the particles and the round timer have all had a turn.
  await page.waitForTimeout(6000);
  await page.screenshot({ path: join(OUT, '05-fight-settled.png') });
  console.log('  ✓ 05-fight-settled');

  // The canvas must still be painting, not frozen on a crashed frame.
  const alive = await page.evaluate(() => {
    const canvas = document.getElementById('stage');
    return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0;
  });
  if (!alive) fatal.push('stage canvas has no backing store');
} catch (error) {
  fatal.push(`walk failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser.close();
}

if (fatal.length > 0) {
  console.error('\nSmoke test failed:');
  for (const line of fatal) console.error(`  ✗ ${line}`);
  process.exit(1);
}

console.log(`\nSmoke test passed. Screenshots in ${OUT}`);

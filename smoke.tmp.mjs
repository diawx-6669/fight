/**
 * Deeper smoke test: seed a calibration profile so the game skips straight to
 * mode select, then walk menu → mode → character → fight and screenshot each.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT ?? '/tmp/claude-0/-home-user-fight/b9dbaba3-7c7f-5238-acd9-5be10e25544c/scratchpad/shots';
mkdirSync(OUT, { recursive: true });
const URL = process.env.URL ?? 'http://127.0.0.1:4173/';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
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
      wins: 12, losses: 3, arcadeStage: 2, survivalBest: 0,
      played: [], totalHits: 214, totalDamage: 9100, bestCombo: 7, perfects: 2,
    }),
  );
});

const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
await page.waitForTimeout(4500);

async function clickDesign(dx, dy, wait = 1200) {
  const box = await page.locator('#stage').boundingBox();
  const aspect = 16 / 9;
  let sw = box.width;
  let sh = sw / aspect;
  if (sh > box.height) { sh = box.height; sw = sh * aspect; }
  const ox = box.x + (box.width - sw) / 2;
  const oy = box.y + (box.height - sh) / 2;
  await page.mouse.move(ox + (dx / 1920) * sw, oy + (dy / 1080) * sh);
  await page.waitForTimeout(180);
  await page.mouse.down();
  await page.waitForTimeout(70);
  await page.mouse.up();
  await page.waitForTimeout(wait);
}

await page.screenshot({ path: `${OUT}/10-menu.png` });

// "В БОЙ"
await clickDesign(400, 418, 1600);
await page.screenshot({ path: `${OUT}/11-mode.png` });

// "ВЫБРАТЬ БОЙЦА"
await clickDesign(1920 - 128 - 170, 1080 - 128 + 39, 1800);
await page.screenshot({ path: `${OUT}/12-character.png` });

// "В БОЙ"
await clickDesign(1920 - 128 - 180, 1080 - 116 + 37, 3000);
await page.screenshot({ path: `${OUT}/13-fight-intro.png` });

await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}/14-fight.png` });

await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/15-fight-later.png` });

console.log(JSON.stringify({ errorCount: errors.length, errors: errors.slice(0, 15) }, null, 2));
await browser.close();

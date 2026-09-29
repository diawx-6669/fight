#!/usr/bin/env node
/**
 * Copies the MediaPipe WASM runtime out of `node_modules` and into `public/`,
 * so the game can be served entirely from its own origin.
 *
 * By default the Tasks Vision library loads its runtime from jsDelivr and its
 * models from Google's storage CDN. Both are blocked or unreliable on a great
 * many networks — corporate proxies, university Wi-Fi, and whole countries —
 * and when they fail the game is not degraded, it is dead: the camera opens,
 * the preview shows the player, and nothing is ever recognised. That is the
 * worst possible failure for a game whose entire premise is the camera, and it
 * looks to the player like the game is simply broken.
 *
 * The runtime is a build dependency we already have on disk, so there is no
 * reason to ask a CDN for it. Models are fetched separately by
 * `fetch:models`, which needs the network once, at build time, on a machine
 * that has it.
 *
 * Both directories are gitignored: several megabytes of binary do not belong
 * in a repository, and this script reproduces them exactly.
 */

import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FROM = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const TO = join(ROOT, 'public', 'wasm');

async function main() {
  try {
    await stat(FROM);
  } catch {
    console.warn(
      'MediaPipe runtime not found in node_modules — run `npm ci` first.\n' +
        'The game will fall back to the public CDN, which many networks block.',
    );
    return;
  }

  await mkdir(TO, { recursive: true });
  await cp(FROM, TO, { recursive: true });

  const files = await readdir(TO);
  let bytes = 0;
  for (const file of files) bytes += (await stat(join(TO, file))).size;
  console.log(`WASM runtime: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB → public/wasm/`);
}

main().catch((error) => {
  // Never fail the build over this: the CDN fallback still exists.
  console.warn('sync-runtime failed:', error.message);
});

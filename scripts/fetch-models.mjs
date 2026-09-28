#!/usr/bin/env node
/**
 * Downloads the MediaPipe models into `public/models/`.
 *
 * The game works without this — it falls back to Google's CDN at runtime — but
 * a local copy is worth having for three reasons:
 *
 *   1. Plenty of networks (schools, offices, some countries) block that CDN,
 *      and a fighting game that cannot load its pose model is not a game.
 *   2. Offline play, which is most of the point of a self-contained bundle.
 *   3. The first fight starts noticeably faster from disk.
 *
 * Run it with `npm run fetch:models`. The files are gitignored: they are a
 * few megabytes of binary that do not belong in a repository.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'models');
const BASE = process.env.MODEL_BASE ?? 'https://storage.googleapis.com/mediapipe-models';

const MODELS = [
  {
    name: 'pose_landmarker_lite.task',
    path: 'pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    note: 'body tracking (fast, default)',
  },
  {
    name: 'pose_landmarker_full.task',
    path: 'pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
    note: 'body tracking (accurate)',
    optional: true,
  },
  {
    name: 'hand_landmarker.task',
    path: 'hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    note: 'hand tracking for menus',
  },
];

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function download(model) {
  const target = join(OUT_DIR, model.name);

  if (await exists(target)) {
    console.log(`  ✓ ${model.name} (already present)`);
    return true;
  }

  const url = `${BASE}/${model.path}`;
  process.stdout.write(`  … ${model.name} — ${model.note}\n`);

  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (error) {
    console.warn(`  ✗ ${model.name}: ${error.message}`);
    return false;
  }

  if (!response.ok || !response.body) {
    console.warn(`  ✗ ${model.name}: HTTP ${response.status}`);
    return false;
  }

  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  } catch (error) {
    // A truncated model file is worse than none: it would fail at load time
    // with an opaque error instead of falling through to the CDN.
    await unlink(target).catch(() => {});
    console.warn(`  ✗ ${model.name}: ${error.message}`);
    return false;
  }

  const info = await stat(target);
  console.log(`  ✓ ${model.name} (${human(info.size)})`);
  return true;
}

async function main() {
  console.log(`Fetching MediaPipe models into ${OUT_DIR}`);
  await mkdir(OUT_DIR, { recursive: true });

  let required = 0;
  let got = 0;

  for (const model of MODELS) {
    const ok = await download(model);
    if (!model.optional) {
      required++;
      if (ok) got++;
    }
  }

  if (got === required) {
    console.log('\nAll set. The game will now load its models from disk.');
    return;
  }

  console.warn(
    `\n${required - got} of ${required} required models could not be fetched.\n` +
      'The game will fall back to the public CDN at runtime, which needs\n' +
      'network access to storage.googleapis.com. Set MODEL_BASE to use a mirror.',
  );
  // Not a build failure: the game still runs.
  process.exitCode = 0;
}

main().catch((error) => {
  console.error('fetch-models failed:', error);
  process.exitCode = 1;
});

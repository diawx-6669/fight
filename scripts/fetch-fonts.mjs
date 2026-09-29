#!/usr/bin/env node
/**
 * Downloads the two display faces into `public/fonts/` and writes the
 * stylesheet that points at them.
 *
 * Same reasoning as the models: `fonts.googleapis.com` is blocked on plenty of
 * networks, and when it is, the game does not fail — it just quietly stops
 * looking like itself. Condensed display type carries most of the visual
 * identity here, and the fallback is whatever sans the system happens to have.
 *
 * Fetching at build time also removes a render-blocking request to a third
 * party from the critical path, which is worth having on its own.
 *
 * Both faces are under the SIL Open Font License; `public/fonts/OFL.txt`
 * records that.
 */

import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'fonts');

/**
 * Oswald for display, Exo 2 for the interface.
 *
 * Both were chosen over the obvious condensed/techno pairing (Bebas Neue and
 * Rajdhani) for one reason: neither of those covers Cyrillic. Every Russian
 * word in this game — which is all of them — was silently falling back to
 * whatever sans the system had, so the typography the design assumed was
 * never once on screen. Oswald keeps the tall condensed display voice and
 * Exo 2 the squared-off technical one, and both cover the alphabet the game
 * is actually written in.
 */
const CSS_URL =
  'https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700' +
  '&family=Exo+2:wght@400;500;600;700&display=swap';

// Google serves a different stylesheet per user agent. Asking as a modern
// browser gets woff2, which every browser this game supports can read.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const OFL = `Oswald and Exo 2 are licensed under the SIL Open Font License 1.1.
Oswald — Copyright (c) The Oswald Project Authors.
Exo 2 — Copyright (c) The Exo 2 Project Authors.
Full licence text: https://openfontlicense.org/
`;

async function main() {
  await mkdir(OUT, { recursive: true });

  const response = await fetch(CSS_URL, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`stylesheet: HTTP ${response.status}`);
  let css = await response.text();

  const urls = [...new Set([...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map((m) => m[1]))];
  console.log(`Fetching ${urls.length} font files into ${OUT}`);

  let index = 0;
  for (const url of urls) {
    // The filename Google uses is opaque; a stable local name is nicer to read
    // in a network panel and survives their URLs changing.
    const extension = url.split('.').pop()?.split('?')[0] ?? 'woff2';
    const name = `face-${String(++index).padStart(2, '0')}.${extension}`;
    const file = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!file.ok) throw new Error(`${url}: HTTP ${file.status}`);
    await writeFile(join(OUT, name), Buffer.from(await file.arrayBuffer()));
    css = css.split(url).join(`./${name}`);
  }

  await writeFile(join(OUT, 'fonts.css'), css);
  await writeFile(join(OUT, 'OFL.txt'), OFL);

  const files = await readdir(OUT);
  let bytes = 0;
  for (const f of files) bytes += (await stat(join(OUT, f))).size;
  console.log(`  ✓ ${files.length} files, ${(bytes / 1024).toFixed(0)} KB`);
}

main().catch((error) => {
  // The page still links the Google stylesheet as a fallback, so a failure
  // here costs nothing but the self-hosted copy.
  console.warn('fetch-fonts failed:', error.message);
});

#!/usr/bin/env node
// Stages the web root the iOS app ships with.
//
// website/ stays the single source of truth: this only copies, never rewrites.
// The one change is the filename -- Capacitor boots whatever index.html sits at
// the root of webDir, and website/index.html is the personal homepage, not this
// app. Everything else in website/ (chess, brew, map) is deliberately left out.

import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'website');
const out = join(root, 'build', 'app-www');

// [source relative to website/, destination relative to build/app-www/]
const COPY = [
  ['diet-stack.html', 'index.html'],
  ['derive.js', 'derive.js'],
  ['foods.json', 'foods.json'],
  ['manifest.webmanifest', 'manifest.webmanifest'],
  ['vendor', 'vendor'],
  ['fonts', 'fonts'],
  ['icons', 'icons'],
];

const missing = COPY.filter(([from]) => !existsSync(join(src, from))).map(([from]) => from);
if (missing.length) {
  console.error(`build-app-www: missing from website/: ${missing.join(', ')}`);
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const [from, to] of COPY) {
  await cp(join(src, from), join(out, to), { recursive: true });
}

console.log(`build-app-www: staged ${COPY.length} entries in build/app-www`);

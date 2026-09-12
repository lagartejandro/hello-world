#!/usr/bin/env node
// Validates website/foods.json and the compound ingredient graph.
//
// Runs the same derivation the page runs (website/derive.js) so there is one
// implementation, not two that drift. Plain Node, no dependencies.
//
//   node scripts/validate-foods.mjs          errors only
//   node scripts/validate-foods.mjs --table  also print the derived flag table

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(root, 'website/foods.json'), 'utf8'));
const page = readFileSync(join(root, 'website/diet-stack.html'), 'utf8');

// derive.js is a browser script assigning to a global; run it and take the API.
const deriveSrc = readFileSync(join(root, 'website/derive.js'), 'utf8');
const { DIET_KEYS, derive } = new Function(
  'globalThis',
  deriveSrc + '\n;return globalThis.DietStackDerive;'
)({});

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const foods = data.foods ?? [];
const compounds = data.compounds ?? [];

// ── Ids ──────────────────────────────────────────────────────────────────────
const foodIds = new Set();
for (const f of foods) {
  if (foodIds.has(f.id)) err(`duplicate food id "${f.id}"`);
  foodIds.add(f.id);
}
const compoundIds = new Set();
for (const c of compounds) {
  if (compoundIds.has(c.id)) err(`duplicate compound id "${c.id}"`);
  if (foodIds.has(c.id)) err(`compound id "${c.id}" collides with a single food`);
  compoundIds.add(c.id);
}
const known = new Set([...foodIds, ...compoundIds]);

// ── Every single food carries every diet flag ─────────────────────────────────
for (const f of foods) {
  for (const key of DIET_KEYS) {
    if (typeof f[key] !== 'boolean') err(`food "${f.id}" has no boolean "${key}"`);
  }
}

// ── Compound shape, refs, overrides ──────────────────────────────────────────
for (const c of compounds) {
  if (c.type !== 'dish' && c.type !== 'base') {
    err(`compound "${c.id}" has type "${c.type}" (expected "dish" or "base")`);
  }
  if (!c.ingredients?.length) err(`compound "${c.id}" has no ingredients`);

  const required = new Set();
  for (const group of ['ingredients', 'optional']) {
    for (const ing of c[group] ?? []) {
      if (!known.has(ing.ref)) {
        err(`compound "${c.id}" ${group} references "${ing.ref}", which matches no food or compound`);
      }
      if (ing.ref === c.id) err(`compound "${c.id}" lists itself as an ingredient`);
      if (group === 'ingredients') required.add(ing.ref);
      else if (required.has(ing.ref)) {
        err(`compound "${c.id}" lists "${ing.ref}" as both required and optional`);
      }
    }
  }

  for (const [key, o] of Object.entries(c.overrides ?? {})) {
    if (!DIET_KEYS.includes(key)) err(`compound "${c.id}" overrides unknown diet "${key}"`);
    if (typeof o?.value !== 'boolean') err(`compound "${c.id}" override "${key}" has no boolean value`);
    if (!o?.reason?.trim()) err(`compound "${c.id}" override "${key}" has no reason`);
  }
}

// ── Derivation: cycles and dangling refs surface here ─────────────────────────
const { resolved, errors: deriveErrors } = derive(foods, compounds);
deriveErrors.forEach(err);
if (resolved.length !== compounds.length) {
  err(`only ${resolved.length} of ${compounds.length} compounds resolved (likely a cycle)`);
}
const byId = new Map(resolved.map((r) => [r.id, r]));

// A stale override no longer changes anything, so it is dead weight that reads
// as if it were doing work.
for (const c of compounds) {
  const r = byId.get(c.id);
  for (const [key, o] of Object.entries(c.overrides ?? {})) {
    if (r && o.value === r.overrideNotes.find((n) => n.key === key)?.was) {
      err(`compound "${c.id}" override "${key}" matches the derived value — it does nothing`);
    }
  }
}

// ── Unreferenced bases usually mean a typo'd ref somewhere else ───────────────
const referenced = new Set();
for (const c of compounds) {
  for (const group of ['ingredients', 'optional']) {
    for (const ing of c[group] ?? []) referenced.add(ing.ref);
  }
}
for (const c of compounds) {
  if (c.type === 'base' && !referenced.has(c.id)) {
    warn(`base "${c.id}" is referenced by nothing — typo in another compound's refs?`);
  }
}

// ── The page must have UI for every diet the derivation knows about ───────────
const uiKeys = new Set([...page.matchAll(/\bkey:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));
for (const key of DIET_KEYS) {
  if (!uiKeys.has(key)) err(`diet "${key}" is in DIET_KEYS but has no entry in the page's DIETS`);
}
for (const key of uiKeys) {
  if (!DIET_KEYS.includes(key)) err(`the page's DIETS has "${key}", which is not in DIET_KEYS`);
}

// ── Report ───────────────────────────────────────────────────────────────────
if (process.argv.includes('--table')) {
  const short = DIET_KEYS.map((k) => k.slice(0, 4));
  console.log('\n' + ' '.repeat(26) + short.map((s) => s.padEnd(5)).join(''));
  for (const r of resolved) {
    const cells = DIET_KEYS.map((k) => (r[k] ? '  ✓  ' : '  ·  ')).join('');
    console.log(`${r.type === 'base' ? '·' : ' '} ${r.name.slice(0, 23).padEnd(24)}${cells}`);
  }
  console.log();
}

const nBase = compounds.filter((c) => c.type === 'base').length;
console.log(
  `${foods.length} single foods, ${compounds.length} compounds ` +
  `(${nBase} bases, ${compounds.length - nBase} dishes), ${DIET_KEYS.length} diets`
);
warnings.forEach((w) => console.log(`  warning: ${w}`));
if (errors.length) {
  console.error(`\n${errors.length} error${errors.length === 1 ? '' : 's'}:`);
  errors.forEach((e) => console.error(`  ${e}`));
  process.exit(1);
}
console.log(warnings.length ? `OK with ${warnings.length} warning(s)` : 'OK');

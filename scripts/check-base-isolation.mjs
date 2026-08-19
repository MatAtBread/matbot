#!/usr/bin/env node
// Guards the author-facing subpaths of @matatbread/matbot-core (./providers-base, ./storage-base).
//
// Why this exists: these subtrees are published as subpath exports so a plugin author can import
// `parseSSE` / `executeQuery` WITHOUT pulling the host runtime. Subpath load-isolation only holds
// if the subtree never imports the runner — and now that they share a package, the old package
// boundary no longer enforces it (any file could `import '../session.js'`). This replaces that
// boundary: a subtree file may import only within its own subtree or the external contract
// (@matatbread/matbot-plugin-api). A relative import escaping the subtree, or any import of the
// core barrel, re-couples the leaf to the runtime and is a hard error.
//
// It also guards the OTHER author-facing boundary: `@matatbread/matbot-plugin-api/host` is boot assembly
// for an embedder, and CLAUDE.md asserted that no plugin imports it. That assertion was false — one plugin
// reached into /host for `onContextQuiesce`, the single edge function a plugin has any use for, which is
// how the one thing a plugin author needs came to live behind a door marked embedders-only. The claim is
// true again, and now checked, because a file boundary only cannot erode if something says so out loud.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guarded = ['core/src/providers-base', 'core/src/storage-base'];

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const importRe = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
const violations = [];

for (const rel of guarded) {
  const base = path.join(root, rel);
  for (const file of walk(base)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(importRe)) {
      const spec = m[1];
      if (spec === '@matatbread/matbot-core' || spec.startsWith('@matatbread/matbot-core/')) {
        violations.push(`${path.relative(root, file)}: imports the core barrel ('${spec}')`);
      } else if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec);
        if (!resolved.startsWith(base + path.sep)) {
          violations.push(`${path.relative(root, file)}: relative import escapes the subtree ('${spec}')`);
        }
      }
    }
  }
}

// A plugin is any package under plugins/ — including the -node ones, which are platform-specific but still
// plugins. apps/ are the embedders and may import /host freely.
const hostReachers = [];
for (const file of walk(path.join(root, 'plugins'))) {
  if (file.includes(`${path.sep}node_modules${path.sep}`) || file.endsWith('.test.ts')) continue;
  for (const m of readFileSync(file, 'utf8').matchAll(importRe)) {
    if (m[1] === '@matatbread/matbot-plugin-api/host') {
      hostReachers.push(`${path.relative(root, file)}: imports '@matatbread/matbot-plugin-api/host'`);
    }
  }
}

if (violations.length > 0) {
  console.error('base-isolation: author-facing subpaths must not depend on the runtime:\n  ' + violations.join('\n  '));
  process.exit(1);
}
if (hostReachers.length > 0) {
  console.error(
    'base-isolation: /host is boot assembly for an embedder, not a plugin. A plugin needing something from\n' +
    'it means either the plugin is doing a host\'s job, or that export belongs at the plugin-api root — see\n' +
    'the split table in CLAUDE.md before adding an exception:\n  ' + hostReachers.join('\n  '),
  );
  process.exit(1);
}
console.log(`base-isolation: ${guarded.length} subtrees clean; no plugin reaches into /host.`);

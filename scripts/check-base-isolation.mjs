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

if (violations.length > 0) {
  console.error('base-isolation: author-facing subpaths must not depend on the runtime:\n  ' + violations.join('\n  '));
  process.exit(1);
}
console.log(`base-isolation: ${guarded.length} subtrees clean.`);

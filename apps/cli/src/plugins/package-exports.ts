// What Node's ESM resolver matches when it imports a package: the CLI imports the entry this returns
// with Node, so a different answer here is an entry Node would never have chosen. `module` is a
// bundler convention Node ignores; `module-sync` is Node's own (default since 22.12).
const CONDITIONS = new Set(['node', 'import', 'module-sync', 'default']);

// A package's main entry from its `exports`, as Node resolves `import 'pkg'`. Conditions are matched in
// the order the PACKAGE lists them, not by a priority of ours, and a `null` target excludes the entry
// rather than falling through to the next condition.
export function exportsEntry(exports: unknown): string | undefined {
  const isSubpathMap = typeof exports === 'object' && exports !== null && !Array.isArray(exports)
    && Object.keys(exports).some(k => k.startsWith('.'));
  return target(isSubpathMap ? (exports as Record<string, unknown>)['.'] : exports) ?? undefined;
}

function target(value: unknown): string | null | undefined {
  if (typeof value === 'string') return value;
  if (value === null) return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = target(v);
      if (typeof t === 'string') return t;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  for (const [key, v] of Object.entries(value)) {
    if (!CONDITIONS.has(key)) continue;
    const t = target(v);
    if (t !== undefined) return t;
  }
  return undefined;
}

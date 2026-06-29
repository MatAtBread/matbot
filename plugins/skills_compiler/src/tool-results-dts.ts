import type TS from 'typescript';

// Derive a self-contained `declare module … { interface ToolResults {…} }` from the live type graph,
// so a compiled plugin sees correct result types for the tools it can call (typed `toolResult`, fewer
// LLM-generated dross calls). The runtime registry can't supply this — result types are erased; only a
// TS compilation can read the `declare module` augmentations each tool package ships.
//
// Approach (a): emit only entries whose result type is *portable* — every named type it references is
// declared in plugin-api or a TS lib, so the emitted `.d.ts` is self-contained. A result referencing a
// package-private type (e.g. `Trigger`, `DreamRun`, `StoreDef`) is skipped: that tool falls back to
// `unknown` at the call site, exactly as before. `Session`/`ToolResult`/etc. are plugin-api exports, so
// the common tools survive. A later pass could bundle the referenced private types instead of skipping.
//
// Caveat: `ts.createProgram` over the workspace is CPU-heavy and runs in-process, so it briefly blocks
// the event loop (the typecheck step spawns the `tsc` binary for the same reason). Acceptable for a
// once-per-compile step; move to a worker_thread if it becomes a problem.

export interface ToolResultsDts {
  dts:     string;
  emitted: string[];
  skipped: string[];
}

// Returns null when the workspace layout isn't present (e.g. a non-monorepo install where the tool
// sources aren't on disk) — the caller then falls back to its static DTS.
export async function buildToolResultsDts(projectRoot: string): Promise<ToolResultsDts | null> {
  const ts = (await import('typescript')).default as typeof TS;
  const { readFileSync, readdirSync, statSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');

  const pluginApiIndex = join(projectRoot, 'plugin-api', 'src', 'index.ts');
  if (!existsSync(pluginApiIndex)) return null;

  // Files that augment ToolResults (the built-in tool packages). A match must carry both the interface
  // and the plugin-api module specifier, so a stray `interface ToolResults` (e.g. inside a string
  // literal) isn't picked up. Generated `matbot-tools.d.ts` files are excluded to avoid feeding our own
  // prior output back in.
  const augmenting: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === 'node_modules' || name === 'dist' || name === '.git' || name === 'compiled-plugins') continue;
      const p = join(dir, name);
      let isDir: boolean;
      try { isDir = statSync(p).isDirectory(); } catch { continue; }
      if (isDir) { walk(p); continue; }
      if (!name.endsWith('.ts') || name.endsWith('matbot-tools.d.ts')) continue;
      const src = readFileSync(p, 'utf8');
      if (/\binterface\s+ToolResults\b/.test(src) && /declare\s+module\s+['"]@matatbread\/matbot-plugin-api['"]/.test(src)) {
        augmenting.push(p);
      }
    }
  };
  walk(join(projectRoot, 'plugins'));
  if (augmenting.length === 0) return null;

  const program = ts.createProgram([pluginApiIndex, ...augmenting], {
    target:                   ts.ScriptTarget.ES2022,
    module:                   ts.ModuleKind.NodeNext,
    moduleResolution:         ts.ModuleResolutionKind.NodeNext,
    strict:                   true,
    exactOptionalPropertyTypes: true,
    noEmit:                   true,
    skipLibCheck:             true,
    baseUrl:                  projectRoot,
  });
  const checker = program.getTypeChecker();

  const apiSf = program.getSourceFile(pluginApiIndex);
  if (!apiSf) return null;
  const apiModule = checker.getSymbolAtLocation(apiSf);
  if (!apiModule) return null;
  const apiExports = checker.getExportsOfModule(apiModule);
  const toolResults = apiExports.find(s => s.name === 'ToolResults');
  if (!toolResults) return null;
  const TYPE_FLAGS = ts.SymbolFlags.Type | ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias;
  const apiTypeNames = new Set(apiExports.filter(s => (s.flags & TYPE_FLAGS) !== 0).map(s => s.name));

  const inPortableFile = (sym: TS.Symbol): boolean => {
    const decls = sym.declarations ?? [];
    if (decls.length === 0) return true;                       // intrinsic / synthesised
    return decls.every(d => {
      const f = d.getSourceFile();
      return program.isSourceFileDefaultLibrary(f) || f.fileName.includes('/plugin-api/');
    });
  };
  const isAnonymous = (sym: TS.Symbol): boolean => sym.name === '__type' || sym.name === '';

  const INTRINSIC =
    ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral |
    ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.Null | ts.TypeFlags.Undefined |
    ts.TypeFlags.Void | ts.TypeFlags.Never | ts.TypeFlags.Unknown | ts.TypeFlags.Any | ts.TypeFlags.BigInt |
    ts.TypeFlags.ESSymbol | ts.TypeFlags.Enum | ts.TypeFlags.EnumLiteral | ts.TypeFlags.UniqueESSymbol;

  const portable = (type: TS.Type, seen: Set<TS.Type>): boolean => {
    if (seen.has(type)) return true;
    seen.add(type);
    if ((type.flags & INTRINSIC) !== 0) return true;
    if (type.isUnionOrIntersection()) return type.types.every(t => portable(t, seen));
    const alias = type.aliasSymbol;
    if (alias && !inPortableFile(alias)) return false;
    if (alias && type.aliasTypeArguments && !type.aliasTypeArguments.every(t => portable(t, seen))) return false;
    if ((type.flags & ts.TypeFlags.Object) !== 0) {
      const sym = type.symbol;
      const named = sym !== undefined && (sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.TypeAlias)) !== 0 && !isAnonymous(sym);
      if (named && sym && !inPortableFile(sym)) return false;
      for (const arg of checker.getTypeArguments(type as TS.TypeReference)) {
        if (!portable(arg, seen)) return false;
      }
      if (!named) {
        for (const prop of checker.getPropertiesOfType(type)) {
          const d = prop.valueDeclaration ?? prop.declarations?.[0] ?? apiSf;
          if (!portable(checker.getTypeOfSymbolAtLocation(prop, d), seen)) return false;
        }
      }
    }
    return true;
  };

  const FORMAT = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType;
  const importNames = new Set<string>();
  const emitted: string[] = [];
  const skipped: string[] = [];
  const lines: string[] = [];
  const props = checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(toolResults));
  for (const prop of [...props].sort((a, b) => a.name.localeCompare(b.name))) {
    const d = prop.valueDeclaration ?? prop.declarations?.[0] ?? apiSf;
    const t = checker.getTypeOfSymbolAtLocation(prop, d);
    if (!portable(t, new Set<TS.Type>())) { skipped.push(prop.name); continue; }
    // typeToString prints a non-global ref as `import("…/plugin-api/…"[, { with: … }]).Name`; strip to
    // the bare `Name` and import it from plugin-api (only plugin-api/lib names reach here, by portability).
    const str = checker.typeToString(t, undefined, FORMAT).replace(/import\([^)]*\)\.(\w+)/g, (_m, n: string) => {
      importNames.add(n);
      return n;
    });
    lines.push(`    ${prop.name}: ${str};`);
    emitted.push(prop.name);
  }

  const imports = [...importNames].filter(n => apiTypeNames.has(n)).sort();
  const importLine = imports.length ? `import type { ${imports.join(', ')} } from '@matatbread/matbot-plugin-api';\n` : '';
  const dts = `import '@matatbread/matbot-plugin-api';
${importLine}declare module '@matatbread/matbot-plugin-api' {
  interface ToolResults {
${lines.join('\n')}
  }
}
`;
  return { dts, emitted, skipped };
}

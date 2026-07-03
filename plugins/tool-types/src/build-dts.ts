import type TS from 'typescript';

// Derive a self-contained `declare module … { interface ToolContracts {…} interface MatbotServices {…} }`
// from the live type graph, so a compiled (or hand-rolled) plugin's compilation sees correct types for
// the tools it can call (`toolResult`) AND the registry services on its `MatbotMachine` (`services.X`) —
// the practical goal being that the codegen/typecheck loop gets the earliest possible warning that
// generated code is unsound. The runtime registry can't supply this (result/service types are erased);
// only a TS compilation reading each plugin's `declare module` augmentation can.
//
// Each member's type closure is walked. A referenced named type is classified and:
//   - plugin-api export  → referenced by name + imported from plugin-api (the generated plugin has it).
//   - TS-lib global      → referenced by name (global, nothing to do).
//   - workspace interface/type-alias → its declaration is EMITTED into the DTS (recursing its own refs),
//                          so the DTS stays self-contained.
//   - workspace class/enum/function, or any `node_modules`/unresolved type → can't be made
//                          self-contained, so that *leaf* is replaced in place with `unknown` and a
//                          comment naming it (LEAF substitution — `(req: unknown /* IncomingMessage */) =>
//                          …` keeps the rest of the type useful). `unknown` is sound here: permissive in
//                          a parameter, narrow-forcing in a result. The whole member only collapses to
//                          `unknown` when the offender sits where `unknown` can't go (e.g. an `extends`
//                          base). The naming comment is emitted once per distinct offender.
//
// For `MatbotServices` only the plugin-contributed members are emitted; the base members (`Vault`,
// `StorageBackend?`, `KnowledgeIndex`) are already visible through plugin-api.
//
// Caveat: `ts.createProgram` over the workspace runs in-process and briefly blocks the event loop.
// Acceptable once-per-compile; the planned coverage work (drive off the live loaded-plugin set, build
// lazily + dirty on plugin load) also removes that cost. Coverage today is the monorepo `plugins/` tree.

export interface MatbotToolsDts {
  dts:      string;
  tools:    { emitted: string[]; unknown: string[] };
  services: { emitted: string[]; unknown: string[] };
  // Per source-scanned tool: its wire contract — the flattened `params`/`result` union text, extracted
  // from the `ToolContracts` arms. The single authored contract (the arms) is thus also the source of the
  // wire description, so a source tool's `ToolContracts` augmentation is its single contract.
  contracts: Record<string, { params: string; result: string }>;
}

type Classification =
  | { tag: 'ignore' }
  | { tag: 'lib' }
  | { tag: 'api' }
  | { tag: 'bundle'; sym: TS.Symbol }
  | { tag: 'bail';   label: string };

// `pluginEntryUrls` are the resolved import URLs of the LIVE loaded plugins (each plugin's `resolvedUrl`,
// via the `plugin` tool's `list`). Each entry is used as a Program root: it pulls in that plugin's own
// augmenting files transitively, so coverage follows the actual loaded set (npm / `.plugins/` / local),
// not just the monorepo tree. When none resolve to on-disk source, falls back to globbing the monorepo
// `plugins/` tree. Returns null when neither yields anything (the caller then uses its static DTS).
export async function buildMatbotToolsDts(projectRoot: string, pluginEntryUrls?: readonly string[]): Promise<MatbotToolsDts | null> {
  const ts = (await import('typescript')).default as typeof TS;
  const { readFileSync, readdirSync, statSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createRequire } = await import('node:module');

  // Anchor plugin-api at the monorepo source if present, else the installed package.
  const monorepoApi = join(projectRoot, 'plugin-api', 'src', 'index.ts');
  let pluginApiIndex: string | undefined = existsSync(monorepoApi) ? monorepoApi : undefined;
  if (!pluginApiIndex) {
    try { pluginApiIndex = createRequire(join(projectRoot, '_')).resolve('@matatbread/matbot-plugin-api'); } catch { /* unresolved */ }
  }
  if (!pluginApiIndex) return null;

  const roots = new Set<string>([pluginApiIndex]);

  // A loaded plugin's `resolvedUrl` → an on-disk type-bearing source file. `.ts`/`.d.ts` used directly;
  // an npm `.js` entry maps to its sibling `.d.ts`; anything else (blob:, bare specifier, missing) skipped.
  const toSource = (u: string): string | undefined => {
    let p: string;
    try { p = u.startsWith('file:') ? fileURLToPath(u) : u; } catch { return undefined; }
    if (/\.d\.ts$|(?<!\.d)\.ts$/.test(p)) return existsSync(p) ? p : undefined;
    if (p.endsWith('.js')) { const d = p.replace(/\.js$/, '.d.ts'); return existsSync(d) ? d : undefined; }
    return undefined;
  };
  for (const u of pluginEntryUrls ?? []) { const p = toSource(u); if (p) roots.add(p); }

  // UNION with a glob of the monorepo `plugins/` tree (not a fallback): the resolvedUrl roots above cover
  // every *loaded* plugin (builtin, compiled, installed), but miss monorepo source that isn't loaded as a
  // plugin with a resolvedUrl — notably the app-embedded `plugin`/`provider` builtins in `plugins/tool-plugin/`,
  // which the host constructs directly. The glob catches those. In a real deployment there is no `plugins/`
  // tree, so this no-ops and the scan is purely resolvedUrl-driven. Dedup is by path (a Set of roots).
  // Generated `matbot-tools.d.ts` files are skipped (don't feed prior output back in). `skills_compiler` IS
  // scanned — it declares its own `skill_compiler` ToolContracts arm, which must be seen; its loose
  // `MatbotServices.SkillManager` slice is a harmless duplicate of the real one (the skills package is
  // walked first, so its full declaration wins the emit; and `services.SkillManager` isn't referenced by
  // generated/compiled plugin code anyway).
  if (existsSync(join(projectRoot, 'plugins'))) {
    const SKIP = new Set(['node_modules', 'dist', '.git', 'compiled-plugins']);
    const walk = (dir: string): void => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (SKIP.has(name)) continue;
        const p = join(dir, name);
        let isDir: boolean;
        try { isDir = statSync(p).isDirectory(); } catch { continue; }
        if (isDir) { walk(p); continue; }
        if (!name.endsWith('.ts') || name.endsWith('matbot-tools.d.ts')) continue;
        const src = readFileSync(p, 'utf8');
        if (/declare\s+module\s+['"]@matatbread\/matbot-plugin-api['"]/.test(src) && /\binterface\s+(?:ToolContracts|MatbotServices)\b/.test(src)) roots.add(p);
      }
    };
    walk(join(projectRoot, 'plugins'));
  }
  if (roots.size === 1) return null;                          // nothing to scan beyond plugin-api itself

  const program = ts.createProgram([...roots], {
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

  const apiSf = program.getSourceFile(pluginApiIndex)
    ?? program.getSourceFiles().find(f => f.fileName.includes('/plugin-api/') && /\/index\.d?\.ts$/.test(f.fileName));
  if (!apiSf) return null;
  const apiModule = checker.getSymbolAtLocation(apiSf);
  if (!apiModule) return null;
  const apiExports = checker.getExportsOfModule(apiModule);
  const TYPE_FLAGS = ts.SymbolFlags.Type | ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias;
  const apiTypeNames = new Set(apiExports.filter(s => (s.flags & TYPE_FLAGS) !== 0).map(s => s.name));

  // Resolve an augmentable interface from its CANONICAL top-level declaration in plugin-api, not the
  // index.ts re-export: `export * from './plugin.js'` (MatbotServices) exposes a stunted re-export view
  // that drops cross-file augmentations; the canonical declaration's symbol carries the merged set.
  const findCanonicalSymbol = (name: string): TS.Symbol | undefined => {
    for (const sf of program.getSourceFiles()) {
      if (!sf.fileName.includes('/plugin-api/')) continue;
      let found: TS.Symbol | undefined;
      const visit = (n: TS.Node): void => {
        if (found) return;
        if (ts.isInterfaceDeclaration(n) && n.name.text === name && !ts.isModuleBlock(n.parent)) {
          found = checker.getSymbolAtLocation(n.name);
          return;
        }
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(sf, visit);
      if (found) return found;
    }
    return undefined;
  };

  const inPluginApi = (sym: TS.Symbol): boolean =>
    (sym.declarations ?? []).every(d => d.getSourceFile().fileName.includes('/plugin-api/'));

  // Classify a referenced type symbol (resolving import aliases to the real declaration first).
  const classify = (raw: TS.Symbol): Classification => {
    const wasAlias = (raw.flags & ts.SymbolFlags.Alias) !== 0;
    const sym = wasAlias ? checker.getAliasedSymbol(raw) : raw;
    if ((sym.flags & ts.SymbolFlags.TypeParameter) !== 0) return { tag: 'ignore' };
    const decls = sym.declarations ?? [];
    // An alias resolving to nothing is an unresolved external import (e.g. `IncomingMessage` from
    // `node:http` when @types/node isn't in this program). A non-alias with no declarations is an
    // intrinsic/synthesised type.
    if (decls.length === 0) return wasAlias ? { tag: 'bail', label: `${raw.name} (external)` } : { tag: 'ignore' };
    const files = decls.map(d => d.getSourceFile());
    if (files.every(f => program.isSourceFileDefaultLibrary(f))) return { tag: 'lib' };
    if (files.some(f => f.fileName.includes('/plugin-api/')))     return { tag: 'api' };
    if (files.some(f => f.fileName.includes('/node_modules/')))   return { tag: 'bail', label: `${sym.name} (external)` };
    const d0 = decls[0]!;
    if (ts.isInterfaceDeclaration(d0) || ts.isTypeAliasDeclaration(d0)) return { tag: 'bundle', sym };
    const kind = ts.isClassDeclaration(d0) ? 'class' : ts.isEnumDeclaration(d0) ? 'enum' : ts.isFunctionDeclaration(d0) ? 'function' : 'value';
    return { tag: 'bail', label: `${kind} ${sym.name}` };
  };
  const classifyEntity = (entity: TS.EntityName): Classification => {
    const sym = checker.getSymbolAtLocation(entity);
    if (!sym) return { tag: 'bail', label: `${entity.getText()} (unresolved)` };
    return classify(sym);
  };

  const stripModifiers = (text: string): string => text.replace(/^export\s+/, '').replace(/^declare\s+/, '');
  const declKey = (d: TS.Node): string => `${d.getSourceFile().fileName}:${d.getStart()}`;

  // Emit comment-per-offender once, so a recurring external type doesn't litter every site.
  const commented = new Set<string>();
  const unknownOf = (label: string): string => {
    if (commented.has(label)) return 'unknown';
    commented.add(label);
    return `unknown /* ${label} */`;
  };

  const importNames  = new Set<string>();
  const bundledDecls = new Map<string, string>();

  interface Ctx { imports: Set<string>; seen: Set<string>; heritageBail: string | null; }

  // Emit `node`'s source text with every bailing type-reference replaced in place by `unknown` (leaf
  // substitution). Accumulates imports (plugin-api refs) and bundled declarations (workspace refs,
  // recursively emitted through here too). Sets `ctx.heritageBail` if a bail sits in an `extends` base,
  // where `unknown` can't go — the caller then collapses that whole member.
  const emitNode = (node: TS.Node, ctx: Ctx): string => {
    const base = node.getStart();
    const repls: Array<{ s: number; e: number; t: string }> = [];
    const bundle = (sym: TS.Symbol): void => {
      for (const d of sym.declarations ?? []) {
        if (!ts.isInterfaceDeclaration(d) && !ts.isTypeAliasDeclaration(d)) continue;
        const key = declKey(d);
        if (ctx.seen.has(key)) continue;
        ctx.seen.add(key);
        bundledDecls.set(key, stripModifiers(emitNode(d, ctx)));
      }
    };
    const visit = (n: TS.Node): void => {
      if (ctx.heritageBail) return;
      if (ts.isTypeReferenceNode(n)) {
        const c = classifyEntity(n.typeName);
        if (c.tag === 'bail') { repls.push({ s: n.getStart() - base, e: n.getEnd() - base, t: unknownOf(c.label) }); return; }
        if (c.tag === 'api') importNames.add(n.typeName.getText());
        else if (c.tag === 'bundle') bundle(c.sym);
        n.typeArguments?.forEach(visit);
        return;
      }
      if (ts.isExpressionWithTypeArguments(n) && ts.isIdentifier(n.expression)) {  // heritage base
        const c = classifyEntity(n.expression);
        if (c.tag === 'bail') { ctx.heritageBail = c.label; return; }
        if (c.tag === 'api') importNames.add(n.expression.getText());
        else if (c.tag === 'bundle') bundle(c.sym);
        n.typeArguments?.forEach(visit);
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    let text = node.getText();
    for (const r of repls.sort((a, b) => b.s - a.s)) text = text.slice(0, r.s) + r.t + text.slice(r.e);
    return text;
  };

  // Emit one augmentable interface's plugin-contributed members. `onlyAugmented` skips base members
  // already visible via plugin-api (no-op for ToolContracts).
  const emitInterface = (interfaceName: string, onlyAugmented: boolean): { lines: string[]; emitted: string[]; unknown: string[] } => {
    const sym = findCanonicalSymbol(interfaceName);
    const lines: string[] = [], emitted: string[] = [], unknownNames: string[] = [];
    if (!sym) return { lines, emitted, unknown: unknownNames };
    const props = [...checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(sym))].sort((a, b) => a.name.localeCompare(b.name));
    for (const prop of props) {
      if (onlyAugmented && inPluginApi(prop)) continue;
      const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0 ? '?' : '';
      const decl = (prop.declarations ?? []).find(d => ts.isPropertySignature(d));
      const ann  = decl && ts.isPropertySignature(decl) ? decl.type : undefined;
      if (!ann) {
        lines.push(`    ${prop.name}${optional}: ${unknownOf('no type annotation')};`);
        unknownNames.push(prop.name);
        continue;
      }
      const ctx: Ctx = { imports: new Set(), seen: new Set(), heritageBail: null };
      const text = emitNode(ann, ctx);
      if (ctx.heritageBail) {                                        // can't substitute in `extends` — whole member unknown
        lines.push(`    ${prop.name}${optional}: ${unknownOf(ctx.heritageBail)};`);
        unknownNames.push(prop.name);
        continue;
      }
      ctx.imports.forEach(n => importNames.add(n));
      lines.push(`    ${prop.name}${optional}: ${text};`);
      // A member whose own annotation was entirely replaced is effectively unknown; one with only nested
      // substitutions is still a usable typed surface.
      if (/^unknown\b/.test(text.trim())) unknownNames.push(prop.name);
      else emitted.push(prop.name);
    }
    return { lines, emitted, unknown: unknownNames };
  };

  const tools    = emitInterface('ToolContracts',    false);
  const services = emitInterface('MatbotServices', true);

  // Per-tool wire contract: flatten each `ToolContracts` arm to its `params`/`result` union source text.
  // Only pure `ToolContract<R, P>`-arm entries yield one (a bare/plain entry is skipped — it keeps whatever
  // the tool authored). This is the flat params/result union the wire description needs, from the arms.
  const extractArms = (ann: TS.TypeNode): { params: string; result: string } | undefined => {
    const arms = ts.isUnionTypeNode(ann) ? [...ann.types] : [ann];
    const params: string[] = [], results: string[] = [];
    for (const a of arms) {
      if (!ts.isTypeReferenceNode(a) || a.typeName.getText() !== 'ToolContract' || a.typeArguments?.length !== 2) return undefined;
      results.push(a.typeArguments[0]!.getText());
      params.push(a.typeArguments[1]!.getText());
    }
    return { result: results.join(' | '), params: params.join(' | ') };
  };
  const contracts: Record<string, { params: string; result: string }> = {};
  const toolContractsSym = findCanonicalSymbol('ToolContracts');
  if (toolContractsSym) {
    for (const prop of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(toolContractsSym))) {
      const decl = (prop.declarations ?? []).find(d => ts.isPropertySignature(d));
      const ann  = decl && ts.isPropertySignature(decl) ? decl.type : undefined;
      if (!ann) continue;
      const c = extractArms(ann);
      if (c) contracts[prop.name] = c;
    }
  }

  const block = (name: string, lines: string[]): string =>
    lines.length ? `  interface ${name} {\n${lines.join('\n')}\n  }\n` : '';
  const imports = [...importNames].filter(n => apiTypeNames.has(n)).sort();
  const importLine  = imports.length ? `import type { ${imports.join(', ')} } from '@matatbread/matbot-plugin-api';\n` : '';
  const bundleBlock = bundledDecls.size ? `${[...bundledDecls.values()].join('\n\n')}\n\n` : '';
  const dts = `import '@matatbread/matbot-plugin-api';
${importLine}${bundleBlock}declare module '@matatbread/matbot-plugin-api' {
${block('ToolContracts', tools.lines)}${block('MatbotServices', services.lines)}}
`;
  return {
    dts,
    tools:    { emitted: tools.emitted,    unknown: tools.unknown },
    services: { emitted: services.emitted, unknown: services.unknown },
    contracts,
  };
}

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

/**
 * A registry key declared more than once, with DIFFERENT types, across the scanned files. Declaration
 * merging requires the declarations to be identical (TS2717 otherwise) — but this scan reads the
 * checker and never the Program's diagnostics, so the error is invisible here: one declaration wins on
 * Program file order and the emitted contract asserts its shape for the tool.
 *
 * That is worse than the untyped fallback. An unregistered tool resolves to `unknown` and forces a
 * generator to narrow; a wrong-but-concrete shape typechecks, so the check loop rejects the correct
 * field and accepts one that reads `undefined` at runtime. Reported, never resolved — picking a winner
 * here would just relocate the arbitrariness.
 */
export interface ContractConflict {
  registry: 'ToolContracts' | 'MatbotServices';
  key:      string;
  /** `file:line` of the declaration that won the merge — the shape actually emitted. */
  winner:   string;
  /** `file:line` of each declaration that lost, in declaration order. */
  losers:   string[];
}

export interface MatbotToolsDts {
  dts:      string;
  tools:    { emitted: string[]; unknown: string[] };
  services: { emitted: string[]; unknown: string[] };
  conflicts: ContractConflict[];
  // Per source-scanned tool (live ones only, as with the dts): its wire contract — the flattened
  // `params`/`result` union text, extracted from the `ToolContracts` arms. The single authored contract
  // (the arms) is thus also the source of the wire description, so a source tool's `ToolContracts`
  // augmentation is its single contract.
  contracts: Record<string, { params: string; result: string }>;
  // The names of every plugin-api type export. A source-less tool's `toolContract` string may name one
  // (e.g. `StoreQuery`); the consumer (ToolTypeIndex) uses this to import the ones it references so those
  // references resolve rather than dangle.
  apiExports: string[];
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
//
// `liveToolNames` is the live tool registry (`machine.tools.list()`), and it is what makes the emitted
// `ToolContracts` a description of what a generator can actually CALL rather than of what happens to be on
// disk: the roots are a superset of the loaded set by construction (see the glob below), so a name absent
// from the registry is declared, typed, and uncallable — `tool.telegram_send(…)` typechecks clean and
// throws "not registered" at runtime, which is the one failure the check gate exists to prevent. Omit it
// only when the caller genuinely wants the whole scanned tree (the clash census test); the registry is not
// optional information for anything that shows the dts to a model.
export async function buildMatbotToolsDts(
  projectRoot: string, pluginEntryUrls?: readonly string[], liveToolNames?: readonly string[],
): Promise<MatbotToolsDts | null> {
  const ts = (await import('typescript')).default as typeof TS;
  const { readFileSync, readdirSync, statSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createRequire } = await import('node:module');

  // Anchor plugin-api: the monorepo source if present, then the project's own install, and finally THIS
  // module's own resolution — which always works, because tool-types peer-depends on plugin-api, so
  // whatever copy the host loaded is reachable from here.
  //
  // The last step is not belt-and-braces. Without it, a deployment where matbot is not resolvable from the
  // config dir (installed globally, or a config dir outside the project) returned null, and the *silence*
  // was the damage: ToolTypeIndex has no dts, skills_compiler falls back to a three-arm hardcoded stub, and
  // the model then generates against a view of the registry that omits most live tools. Measured: asked to
  // call `whoami`, it declared a `ToolContracts` arm for it *itself* — inventing `{ id: string; type: string }`
  // — which compiled clean and only happened to resemble the real `Principal`. A wrong guess compiles too,
  // and the cast gate cannot see it: nothing was cast, a contract was asserted. Same failure the scaffold's
  // dangling plugin-api link used to cause, and the same fix.
  const monorepoApi = join(projectRoot, 'plugin-api', 'src', 'index.ts');
  let pluginApiIndex: string | undefined = existsSync(monorepoApi) ? monorepoApi : undefined;
  for (const from of pluginApiIndex === undefined ? [join(projectRoot, '_'), fileURLToPath(import.meta.url)] : []) {
    try { pluginApiIndex = createRequire(from).resolve('@matatbread/matbot-plugin-api'); break; } catch { /* try the next anchor */ }
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
  //
  // So the roots deliberately over-reach: wherever that tree exists — this repo, or an embedder that vendors
  // it — plugins for OTHER runtimes and plugins nobody loaded are scanned too. Two consequences, and they
  // need different answers. A key declared by an unloaded plugin is filtered out by `liveToolNames` at emit
  // (a scanned root may contribute a contract, never the FACT of a tool). A key declared by both — `bash` by
  // `plugins/bash` and `plugins/docker-bash` — still merges by Program file order, so the unloaded one can
  // win and describe the loaded one; that is what `conflicts` makes audible, and it cannot be filtered away
  // because the name IS live.
  // Generated `matbot-tools.d.ts` files are skipped (don't feed prior output back in).
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
        // Any augmentation of plugin-api, not just one naming `ToolContracts`/`MatbotServices`. Those two
        // are the interfaces EMITTED, but they are not the only ones that change what they mean: a tool
        // result is now a named interface (`LoadedPluginSummary`), so a file adding a field to one — the
        // google-drive `plugin` override does exactly that — alters `ToolContracts['plugin']` without
        // ever mentioning `ToolContracts`. Filtering on the emitted names left such a file unrooted and
        // its field invisible to the very generators the augmentation exists to inform.
        if (/declare\s+module\s+['"]@matatbread\/matbot-plugin-api['"]/.test(src)) roots.add(p);
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
  // already visible via plugin-api (no-op for ToolContracts). `only`, when given, keeps just those keys —
  // for `ToolContracts` that is the live registry, so a scanned-but-unloaded plugin's arm is dropped before
  // `emitNode` runs and its referenced types are never bundled or imported either.
  const emitInterface = (
    interfaceName: string, onlyAugmented: boolean, only?: ReadonlySet<string>,
  ): { lines: string[]; emitted: string[]; unknown: string[] } => {
    const sym = findCanonicalSymbol(interfaceName);
    const lines: string[] = [], emitted: string[] = [], unknownNames: string[] = [];
    if (!sym) return { lines, emitted, unknown: unknownNames };
    const props = [...checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(sym))].sort((a, b) => a.name.localeCompare(b.name));
    for (const prop of props) {
      if (onlyAugmented && inPluginApi(prop)) continue;
      if (only !== undefined && !only.has(prop.name)) continue;
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

  // A tool the registry doesn't hold isn't a tool. `MatbotServices` takes no such filter: a member there is
  // consumed as `services.X?.` and its absence is already a type (the `?:` IS the "may not be loaded"
  // signal), whereas a `ToolContracts` key carries no such qualifier — declared means callable.
  const live     = liveToolNames !== undefined ? new Set(liveToolNames) : undefined;
  const tools    = emitInterface('ToolContracts', false, live);
  const services = emitInterface('MatbotServices', true);

  // Re-emit plugin-side augmentations of plugin-api interfaces. A contract that references a plugin-api
  // type is emitted as that NAME plus an import, so the generated compilation resolves it against the
  // real package — which carries none of the `declare module` additions a plugin made. That is precisely
  // where a named result shape earns its keep (google-drive's `plugin` override adds `managedBy` to
  // `LoadedPluginSummary`), so the field has to travel with the dts or it is invisible exactly where it
  // is meant to be used. Members go through `emitNode`, so a reference to a plugin-local type is bundled
  // or `unknown`-substituted like any other — an augmentation cannot leave a dangling name behind and
  // collapse the whole check. `ToolContracts`/`MatbotServices` are excluded: they are computed above from
  // the merged symbol, and re-emitting them here would declare their members twice.
  const COMPUTED_INTERFACES = new Set(['ToolContracts', 'MatbotServices']);
  const augmentations: string[] = [];
  const seenAugments = new Set<string>();
  for (const sf of program.getSourceFiles()) {
    if (sf.fileName.includes('/plugin-api/') || sf.fileName.includes('/node_modules/')) continue;
    ts.forEachChild(sf, n => {
      if (!ts.isModuleDeclaration(n) || !ts.isStringLiteral(n.name)
          || n.name.text !== '@matatbread/matbot-plugin-api'
          || n.body === undefined || !ts.isModuleBlock(n.body)) return;
      for (const m of n.body.statements) {
        if (!ts.isInterfaceDeclaration(m) || COMPUTED_INTERFACES.has(m.name.text)) continue;
        const key = declKey(m);
        if (seenAugments.has(key)) continue;
        seenAugments.add(key);
        const ctx: Ctx = { imports: new Set(), seen: new Set(), heritageBail: null };
        const text = emitNode(m, ctx);
        if (ctx.heritageBail) continue;
        ctx.imports.forEach(i => importNames.add(i));
        augmentations.push(`  ${stripModifiers(text)}`);
      }
    });
  }

  // Clash census. Derived from the symbol table already walked above rather than from
  // `getPreEmitDiagnostics`, which costs ~4x this whole build (measured: +750ms on a 40-root scan) and
  // says less: a raw TS2717 filter reports only the losing site, whereas the merged symbol's
  // declaration list names the winner too — and it can't distinguish a real clash from the legal
  // identical re-declaration TypeScript never complains about (`bash`, `mcp_action` and
  // `url_for_resource` are each declared twice here, identically, and are not conflicts).
  const relPath = (f: string): string => f.startsWith(projectRoot) ? f.slice(projectRoot.length + 1) : f;
  const siteOf  = (d: TS.Node): string =>
    `${relPath(d.getSourceFile().fileName)}:${d.getSourceFile().getLineAndCharacterOfPosition(d.getStart()).line + 1}`;

  const collectConflicts = (interfaceName: 'ToolContracts' | 'MatbotServices'): ContractConflict[] => {
    const sym = findCanonicalSymbol(interfaceName);
    if (!sym) return [];
    const out: ContractConflict[] = [];
    for (const prop of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(sym))) {
      // Don't warn about a clash between two tools that aren't there: nothing is emitted for them, so
      // there is no wrong shape to act on, and the warning would point at a fix nobody needs to make.
      if (interfaceName === 'ToolContracts' && live !== undefined && !live.has(prop.name)) continue;
      // Declaration order is merge order: `emitInterface` reads the first property signature, so that
      // one is the winner by the same rule that produced the emitted text.
      const sites = (prop.declarations ?? []).flatMap(d =>
        ts.isPropertySignature(d) && d.type !== undefined ? [{ node: d, type: d.type }] : []);
      if (sites.length < 2) continue;
      const distinct = new Set(sites.map(s =>
        checker.typeToString(checker.getTypeFromTypeNode(s.type), undefined, ts.TypeFormatFlags.NoTruncation)));
      if (distinct.size < 2) continue;
      out.push({
        registry: interfaceName,
        key:      prop.name,
        winner:   siteOf(sites[0]!.node),
        losers:   sites.slice(1).map(s => siteOf(s.node)),
      });
    }
    return out;
  };
  const conflicts = [...collectConflicts('ToolContracts'), ...collectConflicts('MatbotServices')];
  // Warned here rather than by the caller because both callers (ToolTypeIndex and skills_compiler) need
  // it and neither can act on it — the fix is always in the clashing source, not at the call site.
  for (const c of conflicts) {
    console.warn(`[matbot] ${c.registry}.${c.key} is declared ${c.losers.length + 1}× with different types — `
      + `"${c.winner}" wins, ignoring ${c.losers.join(', ')}. The emitted contract may not match what the tool returns.`);
  }

  // Per-tool wire contract: flatten each `ToolContracts` arm to its `params`/`result` union source text.
  // Only pure `ToolContract<R, P>`-arm entries yield one (a bare/plain entry is skipped — it keeps whatever
  // the tool authored). This is the flat params/result union the wire description needs, from the arms.
  // Follow a bare reference to a type alias through to the alias's own type node, so a tool that NAMES
  // its arm union (`plugin: PluginToolContract`) flattens exactly like one spelled out inline. Naming
  // the union is what lets two implementations of one tool name share ONE declaration rather than two
  // that merge only while they stay textually identical.
  const resolveAlias = (node: TS.TypeNode): TS.TypeNode => {
    if (!ts.isTypeReferenceNode(node) || node.typeArguments !== undefined) return node;
    const sym = checker.getSymbolAtLocation(node.typeName);
    if (!sym) return node;
    const target = (sym.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(sym) : sym;
    const decl = (target.declarations ?? []).find(ts.isTypeAliasDeclaration);
    return decl?.type ?? node;
  };

  // Expand named shapes to their structure for the WIRE text only. The dts bundles a referenced
  // declaration alongside the reference, so a name resolves there; a tool description carries nothing
  // but this string, so `result: PluginListResult` would tell the model nothing about the fields. Naming
  // a result type is an API-side decision — it is what makes the shape augmentable — and it must not
  // cost the model the shape. Only workspace/plugin-api interfaces and aliases expand: a lib or
  // node_modules name stays as written (`Date`, `AbortSignal` mean more as names than as members), and
  // so does anything past the depth cap or already on the path, which is what terminates a recursive
  // shape rather than diverging.
  //
  // The cap is 2 because that is PARITY, not a tuning choice: it reproduces what an inline object
  // literal used to render — the arm's own shape, and the shape of what its members hold, with anything
  // deeper left as a name (`tools: ToolSummary[]` read exactly so before these types were named, and
  // reads so now). Every level costs tokens in every tool description of every turn: unbounded
  // expansion doubled the total wire text across the 38 source tools, mostly by inlining `Session` and
  // `StoreQuery` into `session_action`.
  const WIRE_DEPTH = 2;
  const expandNamed = (node: TS.TypeNode, path: ReadonlySet<string>, depth: number): string => {
    const base = node.getStart();
    const repls: Array<{ s: number; e: number; t: string }> = [];

    const expansionOf = (ref: TS.TypeReferenceNode): string | undefined => {
      if (ref.typeArguments !== undefined || depth >= WIRE_DEPTH) return undefined;
      const raw = checker.getSymbolAtLocation(ref.typeName);
      if (!raw) return undefined;
      const sym   = (raw.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(raw) : raw;
      const decls = sym.declarations ?? [];
      if (decls.length === 0) return undefined;
      const files = decls.map(d => d.getSourceFile());
      if (files.some(f => program.isSourceFileDefaultLibrary(f) || f.fileName.includes('/node_modules/'))) return undefined;

      const key = declKey(decls[0]!);
      if (path.has(key)) return undefined;
      const nextPath = new Set([...path, key]);

      // A union or intersection substituted into a reference position needs its own parentheses:
      // `readonly Runtime[]` with `Runtime = 'node' | 'browser'` would otherwise render as
      // `readonly 'node' | 'browser'[]`, which parses as a union whose second arm is an array.
      const parenthesised = (t: string): string => {
        let d = 0;
        for (let i = 0; i < t.length; i++) {
          const c = t[i];
          if (c === '<' || c === '{' || c === '(' || c === '[') d++;
          else if (c === '>' || c === '}' || c === ')' || c === ']') d--;
          else if (d === 0 && (c === '|' || c === '&')) return `(${t})`;
        }
        return t;
      };

      const alias = decls.find(ts.isTypeAliasDeclaration);
      if (alias) return parenthesised(expandNamed(alias.type, nextPath, depth + 1));
      if (!decls.some(ts.isInterfaceDeclaration)) return undefined;

      // Read members off the MERGED symbol, not one declaration: an interface that a plugin augmented
      // (the whole point of naming these) carries its added members on the merged type only, and
      // inherited members come through the same call.
      const declared = checker.getDeclaredTypeOfSymbol(sym);
      const members: string[] = [];
      // Index signatures are not properties, and dropping one inverts its meaning: `ModelParameters`
      // would read as a closed set of four generation knobs when the whole point of its
      // `[key: string]: unknown` is that a provider takes arbitrary ones.
      for (const info of checker.getIndexInfosOfType(declared)) {
        members.push(`[key: ${checker.typeToString(info.keyType)}]: ${checker.typeToString(info.type)}`);
      }
      for (const prop of checker.getPropertiesOfType(declared)) {
        const sig = (prop.declarations ?? []).find(ts.isPropertySignature);
        if (!sig?.type) return undefined;                       // a member we can't render ⇒ keep the name
        const opt = (prop.flags & ts.SymbolFlags.Optional) !== 0 ? '?' : '';
        members.push(`${prop.name}${opt}: ${expandNamed(sig.type, nextPath, depth + 1)}`);
      }
      return members.length ? `{ ${members.join('; ')} }` : undefined;
    };

    const visit = (n: TS.Node): void => {
      if (ts.isTypeReferenceNode(n)) {
        const text = expansionOf(n);
        if (text !== undefined) { repls.push({ s: n.getStart() - base, e: n.getEnd() - base, t: text }); return; }
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

  const extractArms = (ann: TS.TypeNode): { params: string; result: string } | undefined => {
    const resolved = resolveAlias(ann);
    const arms = ts.isUnionTypeNode(resolved) ? [...resolved.types] : [resolved];
    const params: string[] = [], results: string[] = [];
    for (const raw of arms) {
      const a = resolveAlias(raw);
      if (!ts.isTypeReferenceNode(a) || a.typeName.getText() !== 'ToolContract' || a.typeArguments?.length !== 2) return undefined;
      results.push(expandNamed(a.typeArguments[0]!, new Set(), 0));
      params.push(expandNamed(a.typeArguments[1]!, new Set(), 0));
    }
    return { result: results.join(' | '), params: params.join(' | ') };
  };
  const contracts: Record<string, { params: string; result: string }> = {};
  const toolContractsSym = findCanonicalSymbol('ToolContracts');
  if (toolContractsSym) {
    for (const prop of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(toolContractsSym))) {
      if (live !== undefined && !live.has(prop.name)) continue;      // same live-registry filter as the dts
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
${block('ToolContracts', tools.lines)}${block('MatbotServices', services.lines)}${augmentations.length ? `${augmentations.join('\n')}\n` : ''}}
`;
  return {
    dts,
    tools:    { emitted: tools.emitted,    unknown: tools.unknown },
    services: { emitted: services.emitted, unknown: services.unknown },
    conflicts,
    contracts,
    apiExports: [...apiTypeNames],
  };
}

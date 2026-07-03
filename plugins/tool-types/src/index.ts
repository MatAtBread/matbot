import type TS from 'typescript';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotMachine, MatbotPluginSpec, ToolTypeIndex } from '@matatbread/matbot-plugin-api';
import { getRegisteredPlugins } from '@matatbread/matbot-core';
import { buildMatbotToolsDts } from './build-dts.js';

export { buildMatbotToolsDts, type MatbotToolsDts } from './build-dts.js';

// Split a string on `sep` at bracket-depth 0 only (respecting `<> {} () []`), so a top-level `|` or `,`
// inside a nested type isn't mistaken for a separator.
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<' || c === '{' || c === '(' || c === '[') depth++;
    else if (c === '>' || c === '}' || c === ')' || c === ']') depth--;
    else if (depth === 0 && c === sep) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

// Flatten a `toolContract` (`ToolContract<Result, Args>`, or a `|`-union of such arms) to the wire's
// `params`/`result` union text — the same projection build-dts derives from source arms.
function splitContract(contract: string): { params: string; result: string } {
  const results: string[] = [], params: string[] = [];
  for (const armText of splitTopLevel(contract, '|')) {
    const m = armText.trim().match(/^ToolContract\s*<([\s\S]*)>$/);
    if (!m) continue;
    const inner = splitTopLevel(m[1]!, ',');
    if (inner[0] !== undefined) results.push(inner[0].trim());
    if (inner[1] !== undefined) params.push(inner[1].trim());
  }
  return { result: results.join(' | ') || 'unknown', params: params.join(' | ') || 'unknown' };
}

/**
 * Derives (via {@link buildMatbotToolsDts}) and caches the `.d.ts` of what the loaded tools' calls resolve
 * to, invalidating on any tool-registry change. The scan is driven off the loaded plugins' `resolvedUrl`s —
 * the real source each tool was loaded from — so builtin, compiled, and installed plugins are all covered
 * (the types are erased at runtime, but the `.ts` the runtime loaded from is still on disk). A source-less
 * tool (a `function-tools` function; the `tool-store` per-namespace tool) carries its contract on the
 * registered `Tool` as a `toolContract` string, appended in a second augmentation block; a name the scan
 * already declares is skipped, so nothing is declared twice. `declare const tool: ToolProxy` (mapped over
 * the merged `ToolContracts`) is what generators call.
 */
class ToolTypeIndexImpl implements ToolTypeIndex {
  private readonly machine: MatbotMachine;
  private readonly ac = new AbortController();
  private covered = new Set<string>();   // tool names the source scan already declares (registry-block dedup)
  private cache: string | null = null;   // null ⇒ (re)build needed
  private contracts: Record<string, { params: string; result: string }> = {};   // per-tool wire contract
  private dirty = true;

  constructor(machine: MatbotMachine) {
    this.machine = machine;
    void this.watchTools();
  }

  private async watchTools(): Promise<void> {
    try { for await (const _ev of this.machine.tools.watch(this.ac.signal)) this.dirty = true; }
    catch { /* signal aborted on teardown */ }
  }

  close(): void { this.ac.abort(); }

  private async ensureBuilt(): Promise<void> {
    if (this.dirty || this.cache === null) {
      const root   = this.machine.configPath !== undefined ? dirname(this.machine.configPath) : '.';
      // Scan the source each loaded plugin was actually loaded from (its resolvedUrl) — builtin, compiled
      // (compiled-plugins/), or installed (.plugins/) alike — so every registered tool's real augmentation
      // is read. build-dts globs the monorepo `plugins/` tree ONLY as a fallback, when no resolvedUrl
      // resolves to on-disk source (a host that constructed its plugins by hand).
      const urls   = getRegisteredPlugins().map(p => p.resolvedUrl).filter((u): u is string => u !== undefined);
      const built  = await buildMatbotToolsDts(root, urls);
      this.cache     = built?.dts ?? '';
      this.covered   = new Set([...(built?.tools.emitted ?? []), ...(built?.tools.unknown ?? [])]);
      this.contracts = built?.contracts ?? {};
      this.dirty     = false;
    }
  }

  async dts(): Promise<string> {
    await this.ensureBuilt();
    // `tool` — the injected proxy `function-tools`/compiled skills call — is `ToolProxy`, a mapped type over
    // the (augmented) `ToolContracts`: each multi-arm entry becomes an overload set, so `await tool.x(params)`
    // narrows its result by the params. Derived, never hand-authored; `check()` uses this same string, so what
    // a generator is shown is exactly what it is graded against.
    return `${this.registryBlock(this.cache!)}\ndeclare const tool: import('@matatbread/matbot-plugin-api').ToolProxy;\n`;
  }

  async wireContracts(): Promise<Record<string, { params: string; result: string }>> {
    await this.ensureBuilt();
    const out: Record<string, { params: string; result: string }> = {};
    for (const [name, c] of Object.entries(this.contracts)) out[name] = c;   // source tools: arms flattened by build-dts
    for (const t of this.machine.tools.list()) {                             // source-less tools: split their toolContract
      if (out[t.name] !== undefined || t.toolContract === undefined) continue;
      out[t.name] = splitContract(t.toolContract);
    }
    return out;
  }

  async check(snippet: string): Promise<string[]> {
    const ts   = (await import('typescript')).default;
    const root = this.machine.configPath !== undefined ? dirname(this.machine.configPath) : '.';
    const prefix = `${await this.dts()}\n`;
    const source = `${prefix}${snippet}\nexport {};\n`;           // trailing export ⇒ this file is a module
    const virtual = `${root}/__mb_toolcheck_${crypto.randomUUID()}.ts`;

    // Anchor `@matatbread/matbot-plugin-api` — it isn't a bare-resolvable dep of the project root, so map it
    // to the monorepo source (or the installed package). Without this the imports fail and every type
    // collapses to `any`, silently passing bad snippets.
    const monorepoApi = join(root, 'plugin-api', 'src', 'index.ts');
    let apiIndex: string | undefined = existsSync(monorepoApi) ? monorepoApi : undefined;
    if (apiIndex === undefined) {
      try { apiIndex = createRequire(join(root, '_')).resolve('@matatbread/matbot-plugin-api'); } catch { /* unresolved */ }
    }

    const options: TS.CompilerOptions = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true, baseUrl: root,
      ...(apiIndex !== undefined ? { paths: { '@matatbread/matbot-plugin-api': [apiIndex] } } : {}),
    };
    const host = ts.createCompilerHost(options);
    const getSF = host.getSourceFile.bind(host);
    host.getSourceFile = (f, lang, onErr, create) =>
      f === virtual ? ts.createSourceFile(f, source, lang, true) : getSF(f, lang, onErr, create);
    const fileExists = host.fileExists.bind(host); host.fileExists = f => f === virtual || fileExists(f);
    const readFile   = host.readFile.bind(host);   host.readFile   = f => (f === virtual ? source : readFile(f));

    const program = ts.createProgram([virtual], options, host);
    const sf = program.getSourceFile(virtual);
    if (sf === undefined) return [];

    const prefixLen   = prefix.length;
    const prefixLines = prefix.split('\n').length - 1;
    const out: string[] = [];
    for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
      if (typeof d.start !== 'number' || d.start < prefixLen) continue;   // only the caller's snippet
      const { line } = sf.getLineAndCharacterOfPosition(d.start);
      out.push(`line ${line - prefixLines + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    }
    return out;
  }

  // Every live tool the source scan didn't already declare: a source-less tool that carries its contract as
  // a `toolContract` string (a `function-tools` function; the `tool-store` per-namespace tool), spliced
  // verbatim; plus any tool with neither augmentation nor `toolContract` (a foreign/MCP proxy, or a plugin
  // with no resolvable source) — emitted `ToolContract<unknown, unknown>` so it still appears in
  // `keyof ToolContracts`, hence in `ToolProxy`, and stays loosely callable. Names the source scan already
  // declared are skipped, so nothing is declared twice. `ToolContract` is referenced bare — it resolves to
  // the top-of-file import the derived block emits (every arm references it); when the scan produced nothing
  // to import it (no source resolved, or an all-`MatbotServices` block), this block supplies that one import.
  private registryBlock(derived: string): string {
    const arms: string[] = [];
    for (const t of this.machine.tools.list()) {
      if (this.covered.has(t.name)) continue;
      arms.push(`    ${JSON.stringify(t.name)}: ${t.toolContract ?? 'ToolContract<unknown, unknown>'};`);
    }
    if (arms.length === 0) return derived;
    const imported = /^import type \{[^}]*\bToolContract\b[^}]*\} from '@matatbread\/matbot-plugin-api'/m.test(derived);
    const head = imported ? '' : `${derived === '' ? "import '@matatbread/matbot-plugin-api';\n" : ''}import type { ToolContract } from '@matatbread/matbot-plugin-api';\n`;
    return `${head}${derived}\ndeclare module '@matatbread/matbot-plugin-api' {\n  interface ToolContracts {\n${arms.join('\n')}\n  }\n}\n`;
  }
}

export function createToolTypesPlugin(): MatbotPluginSpec {
  let impl: ToolTypeIndexImpl | undefined;
  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: { description: 'Node-only ToolTypeIndex service: derives a .d.ts of the loaded tools\' result/service types so tool-call code generators and composers (skills_compiler, function-tools) can type what `tool` calls resolve to.' },

    async setup(services) {
      impl = new ToolTypeIndexImpl(services);
      await services.register('ToolTypeIndex', impl);
    },

    async teardown() { impl?.close(); },
  };
}

export const plugin: MatbotPluginSpec = createToolTypesPlugin();

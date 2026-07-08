import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotMachine, MatbotPluginSpec, ToolTypeIndex } from '@matatbread/matbot-plugin-api';
import { getRegisteredPlugins } from '@matatbread/matbot-core';
import { buildMatbotToolsDts } from './build-dts.js';
import { checkSnippetAgainst } from './checker.js';

export { buildMatbotToolsDts, type MatbotToolsDts } from './build-dts.js';
export { checkProjectDir, checkSnippetAgainst, type CheckResult } from './checker.js';

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

// Best-effort JSON-Schema → TypeScript type text. Used only for the params half of a tool that has neither
// a source augmentation nor a `toolContract` (a foreign/MCP proxy): its `inputSchema` is always present, so
// we synthesise *something* structural rather than leaving `unknown` — so a composer sees real fields. There
// is no 1:1 JSON-Schema↔TS mapping; this is deliberately shallow and total — anything unrecognised degrades
// to `unknown` (never throws), and the output is purely structural (no named refs) so the dts stays
// self-contained. `unknown` here flows back through `ArmCallSig`'s `unknown extends P` branch to an
// optional param, so an opaque schema still leaves the tool callable arg-less.
//   Enhancement (parked, not needed now): a fuller conversion — $ref/allOf/format/pattern/const/tuples —
//   could be delegated to a package like `json-schema-to-typescript`. This dependency-free shallow pass is
//   enough to give a composer real fields for the common MCP shapes.
function schemaToTs(schema: unknown, depth = 0): string {
  if (depth > 6 || schema === null || typeof schema !== 'object') return 'unknown';
  const s = schema as Record<string, unknown>;
  const lit = (v: unknown): string =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null ? JSON.stringify(v) : 'unknown';

  const union = s['anyOf'] ?? s['oneOf'];
  if (Array.isArray(union)) {
    const parts = [...new Set(union.map(u => schemaToTs(u, depth + 1)))];
    return parts.length ? parts.join(' | ') : 'unknown';
  }
  if (Array.isArray(s['enum'])) {
    const parts = [...new Set(s['enum'].map(lit))];
    return parts.length ? parts.join(' | ') : 'unknown';
  }
  const type = s['type'];
  if (Array.isArray(type)) return [...new Set(type.map(t => schemaToTs({ ...s, type: t }, depth)))].join(' | ') || 'unknown';
  switch (type) {
    case 'string':  return 'string';
    case 'integer':
    case 'number':  return 'number';
    case 'boolean': return 'boolean';
    case 'null':    return 'null';
    case 'array': {
      const items = Array.isArray(s['items']) ? 'unknown' : schemaToTs(s['items'], depth + 1);
      return /[ |&]/.test(items) ? `Array<${items}>` : `${items}[]`;
    }
  }
  const props = s['properties'] && typeof s['properties'] === 'object' ? s['properties'] as Record<string, unknown> : undefined;
  if (props && Object.keys(props).length > 0) {
    const required = new Set(Array.isArray(s['required']) ? s['required'] as unknown[] : []);
    const members = Object.entries(props).map(([k, v]) => {
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
      return `${key}${required.has(k) ? '' : '?'}: ${schemaToTs(v, depth + 1)}`;
    });
    return `{ ${members.join('; ')} }`;
  }
  if (type === 'object') {
    const ap = s['additionalProperties'];
    return ap !== null && typeof ap === 'object' ? `Record<string, ${schemaToTs(ap, depth + 1)}>` : 'Record<string, unknown>';
  }
  return 'unknown';
}

/**
 * Derives (via {@link buildMatbotToolsDts}) and caches the `.d.ts` of what the loaded tools' calls resolve
 * to, invalidating on any tool-registry change. The scan is driven off the loaded plugins' `resolvedUrl`s —
 * the real source each tool was loaded from — so builtin, compiled, and installed plugins are all covered
 * (the types are erased at runtime, but the `.ts` the runtime loaded from is still on disk). A source-less
 * tool (a `function-tools` function; the `tool-store` per-namespace tool) carries its contract on the
 * registered `Tool` as a `toolContract` string, appended in a second augmentation block; a name the scan
 * already declares is skipped, so nothing is declared twice. `declare const tool: ToolProxy` (mapped over
 * the merged `ToolContracts`) plus its override factory `toolInContext` is what generators call.
 */
class ToolTypeIndexImpl implements ToolTypeIndex {
  private readonly machine: MatbotMachine;
  private readonly ac = new AbortController();
  private covered = new Set<string>();   // tool names the source scan already declares (registry-block dedup)
  private cache: string | null = null;   // null ⇒ (re)build needed
  private contracts: Record<string, { params: string; result: string }> = {};   // per-tool wire contract
  private apiExports: string[] = [];     // plugin-api type export names (for importing those a toolContract names)
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
      this.cache      = built?.dts ?? '';
      this.covered    = new Set([...(built?.tools.emitted ?? []), ...(built?.tools.unknown ?? [])]);
      this.contracts  = built?.contracts ?? {};
      this.apiExports = built?.apiExports ?? [];
      this.dirty      = false;
    }
  }

  async dts(): Promise<string> {
    await this.ensureBuilt();
    // `tool` — the injected proxy `function-tools`/compiled skills call — is a `ToolProxy`, a mapped type
    // over the (augmented) `ToolContracts`: each multi-arm entry becomes an overload set, so `await
    // tool.x(params)` narrows its result by the params, and a non-existent tool name is a compile error.
    // `toolInContext(override)` is the sibling factory for a context override. Both derived, never
    // hand-authored; `check()` uses this same string, so what a generator is shown is exactly what it is
    // graded against.
    return `${this.registryBlock(this.cache!)}\ndeclare const tool: import('@matatbread/matbot-plugin-api').ToolProxy;\ndeclare const toolInContext: import('@matatbread/matbot-plugin-api').ToolBox;\n`;
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
    const root = this.machine.configPath !== undefined ? dirname(this.machine.configPath) : '.';
    const prefix = `${await this.dts()}\n`;
    const source = `${prefix}${snippet}\nexport {};\n`;           // trailing export ⇒ this file is a module

    // Anchor `@matatbread/matbot-plugin-api` — it isn't a bare-resolvable dep of the project root, so map it
    // to the monorepo source (or the installed package). Without this the imports fail and every type
    // collapses to `any`, silently passing bad snippets.
    const monorepoApi = join(root, 'plugin-api', 'src', 'index.ts');
    let apiIndex: string | undefined = existsSync(monorepoApi) ? monorepoApi : undefined;
    if (apiIndex === undefined) {
      try { apiIndex = createRequire(join(root, '_')).resolve('@matatbread/matbot-plugin-api'); } catch { /* unresolved */ }
    }

    // Worker-hosted check (see checker.ts) — off the main loop, and each diagnostic comes back as an
    // annotated block (caret-anchored frame, related locations, HINT) with snippet-relative positions.
    return checkSnippetAgainst({
      root, source,
      prefixLen: prefix.length,
      prefixLines: prefix.split('\n').length - 1,
      ...(apiIndex !== undefined ? { apiIndexPath: apiIndex } : {}),
    });
  }

  // Every live tool the source scan didn't already declare: a source-less tool that carries its contract as
  // a `toolContract` string (a `function-tools` function; the `tool-store` per-namespace tool), spliced
  // verbatim; plus any tool with neither augmentation nor `toolContract` (a foreign/MCP proxy, or a plugin
  // with no resolvable source) — for which the result stays `unknown` but the params are synthesised from
  // the tool's (always-present) `inputSchema` (see {@link schemaToTs}), so it isn't a bare
  // `ToolContract<unknown, unknown>` and a composer sees real fields. Either way it appears in
  // `keyof ToolContracts`, hence in `ToolProxy`, and stays callable. Names the source scan already declared
  // are skipped, so nothing is declared twice. `ToolContract` is referenced bare — it resolves to the
  // top-of-file import the derived block emits (every arm references it); when the scan produced nothing to
  // import it (no source resolved, or an all-`MatbotServices` block), this block supplies that one import.
  private registryBlock(derived: string): string {
    const arms: string[] = [];
    for (const t of this.machine.tools.list()) {
      if (this.covered.has(t.name)) continue;
      arms.push(`    ${JSON.stringify(t.name)}: ${t.toolContract ?? `ToolContract<unknown, ${schemaToTs(t.inputSchema)}>`};`);
    }
    if (arms.length === 0) return derived;
    const body = arms.join('\n');
    // Import the plugin-api types these arms reference — `ToolContract` always, plus any plugin-api export a
    // source-less `toolContract` names (e.g. `StoreQuery`) — minus whatever the derived block already imports
    // (importing a name twice is a redeclaration error). A synthetic tool inlines its own shape types, so the
    // only names left here are genuine plugin-api exports.
    const alreadyImported = new Set(
      (derived.match(/^import type \{([^}]*)\} from '@matatbread\/matbot-plugin-api'/m)?.[1] ?? '')
        .split(',').map(s => s.trim()).filter(Boolean),
    );
    const referenced = ['ToolContract', ...this.apiExports.filter(n => new RegExp(`\\b${n}\\b`).test(body))];
    const needed = [...new Set(referenced)].filter(n => !alreadyImported.has(n));
    const head = needed.length
      ? `${derived === '' ? "import '@matatbread/matbot-plugin-api';\n" : ''}import type { ${needed.join(', ')} } from '@matatbread/matbot-plugin-api';\n`
      : '';
    return `${head}${derived}\ndeclare module '@matatbread/matbot-plugin-api' {\n  interface ToolContracts {\n${body}\n  }\n}\n`;
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

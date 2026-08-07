import type { MatbotMachine, ToolTypeIndex } from '@matatbread/matbot-plugin-api';

// A browser ToolTypeIndex. The node one (@matatbread/matbot-tool-types) runs the real TypeScript compiler
// over each tool's on-disk source to recover its `ToolContracts` augmentation; the browser has neither the
// compiler nor a filesystem, so it derives contracts from two sources, in precedence order:
//   • EMBEDDED — the assembler runs the node compiler at BUILD time and bakes the per-tool { params, result }
//     for every built-in tool into the artifact; passed in here. This is what gives the browser the SAME
//     real result types (not just `unknown`) as node for the built-in library.
//   • a source-less tool (a function-tools function, the tool-store per-namespace tool) registered at
//     runtime — absent from the embedded map — carries its contract as a `toolContract` string → spliced.
//   • any remaining tool (e.g. an MCP proxy) has no reachable contract; `dts()` still synthesises its params
//     from the (always-present) `inputSchema` (see schemaToTs) so a composer sees real fields, but
//     `wireContracts()` omits it (no misleading `unknown` result in the wire description) — mirroring node.
// `check()` is a no-op ([] = clean): there is no compiler to grade a snippet against, so function-tools
// degrades to guess-and-run (define/lambda still compile and run via the sucrase TypeScriptStripper).

// Split on `sep` at bracket-depth 0 only (respecting `<> {} () []`), so a top-level `|`/`,` inside a nested
// type isn't mistaken for a separator.
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

// Parse a `ToolContract<Result, Args>` type (or a `|`-union of such arms) to its `params`/`result` union
// text. Returns null unless EVERY arm is a `ToolContract<R, P>` — mirroring the node compiler's extractArms
// (a bare/plain entry yields no wire contract). This is the shape check; splitContract wraps it with a
// permissive fallback for the always-a-contract `toolContract` string case.
function parseContractArms(type: string): { params: string; result: string } | null {
  const results: string[] = [], params: string[] = [];
  for (const armText of splitTopLevel(type, '|')) {
    const t = armText.trim();
    if (t === '') continue;                          // leading/trailing `|` in a multi-arm union
    const m = t.match(/^ToolContract\s*<([\s\S]*)>$/);
    if (!m) return null;
    const inner = splitTopLevel(m[1]!, ',');
    results.push((inner[0] ?? 'unknown').trim());
    params.push((inner[1] ?? 'unknown').trim());
  }
  return results.length ? { result: results.join(' | '), params: params.join(' | ') } : null;
}

// Flatten a `toolContract` (`ToolContract<Result, Args>`, or a `|`-union of arms) to the wire's
// `params`/`result` union text. Permissive: a non-contract falls back to `unknown`/`unknown`.
function splitContract(contract: string): { params: string; result: string } {
  return parseContractArms(contract) ?? { result: 'unknown', params: 'unknown' };
}

// Scan from `start` to the `;` that closes a statement at bracket depth 0, so an object-literal member
// separator (`{ a: string; b: number }`) doesn't truncate the type it sits inside.
function readToStatementEnd(s: string, start: number): { text: string; end: number } {
  let depth = 0, i = start;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '<' || c === '{' || c === '(' || c === '[') depth++;
    else if (c === '>' || c === '}' || c === ')' || c === ']') depth--;
    else if (c === ';' && depth === 0) break;
  }
  return { text: s.slice(start, i), end: i };
}

/**
 * Named arm-unions (`type PluginToolContract = ToolContract<…> | …`) declared in RAW source, keyed by
 * name. The two builtin tools with both a node and a browser implementation share ONE contract declared
 * in plugin-api, because a `ToolContracts` key is registered by declaration merging and cannot be
 * declared twice with different types; the arms therefore live behind a name, and a compiler-free
 * scanner has to be able to follow it or those two tools silently lose their wire contract.
 *
 * Collected separately from {@link extractToolContracts} because the alias and its use are in different
 * files: the caller collects across every source it has, then extracts.
 */
export function collectContractAliases(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const RE = /\btype\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  for (let m = RE.exec(clean); m !== null; m = RE.exec(clean)) {
    const { text, end } = readToStatementEnd(clean, RE.lastIndex);
    if (text.includes('ToolContract<')) out[m[1]!] = text.trim();
    RE.lastIndex = end;
  }
  return out;
}

// Extract per-tool wire contracts from RAW .ts source, compiler-free: find each `interface ToolContracts
// { … }` augmentation block and read each arm's `ToolContract<Result, Params>` type-argument TEXT. This is
// exactly what the node compiler path does (it merges the augmentation declarations via the checker, then
// reads `.getText()` on the two type args) — the checker is only needed to MERGE declarations across files,
// not to extract, so a source scan is equivalent per-file. Runs at assemble time over built-in source AND at
// runtime over http-fetched plugin source, so a remotely-loaded plugin's tools carry real TS too. Best-effort
// (shares splitTopLevel's `>`-as-close-bracket limitation, so an arrow type inside a contract arg can confuse
// depth); an unparseable arm simply yields no contract for that tool, which degrades to its base description.
export function extractToolContracts(
  src: string,
  aliases: Readonly<Record<string, string>> = {},
): Record<string, { params: string; result: string }> {
  const out: Record<string, { params: string; result: string }> = {};
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');   // drop comments
  // A member may name its arm union instead of spelling it out; resolve through the caller's map, plus
  // any alias this same file declares.
  const known = { ...collectContractAliases(src), ...aliases };
  const RE = /interface\s+ToolContracts\s*\{/g;
  for (let m = RE.exec(clean); m !== null; m = RE.exec(clean)) {
    let depth = 1, i = RE.lastIndex;
    for (; i < clean.length && depth > 0; i++) {
      const c = clean[i];
      if (c === '{') depth++; else if (c === '}') depth--;
    }
    const body = clean.slice(RE.lastIndex, i - 1);
    for (const member of splitTopLevel(body, ';')) {
      const text = member.trim();
      const q = text.match(/^(['"])(.*?)\1\s*:\s*([\s\S]*)$/);          // quoted key
      const b = q ? null : text.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/);   // bare key
      const key  = q?.[2] ?? b?.[1];
      const type = q?.[3] ?? b?.[2];
      if (key === undefined || type === undefined) continue;
      const trimmed = type.trim();
      const arms = known[trimmed] ?? trimmed;
      if (!arms.includes('ToolContract')) continue;                     // not a contract member
      const c = parseContractArms(arms);
      if (c) out[key] = c;
    }
    RE.lastIndex = i;
  }
  return out;
}

// Best-effort JSON-Schema → TypeScript type text. Deliberately shallow and total (never throws; anything
// unrecognised degrades to `unknown`) and purely structural (no named refs) so the dts stays self-contained.
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

class BrowserToolTypeIndex implements ToolTypeIndex {
  private readonly machine: MatbotMachine;
  // Assembler-baked per-tool { params, result } (node compiler run at build time), keyed by tool name.
  // Empty when a bundle didn't bake them, in which case behaviour falls back to the pre-embed path.
  private readonly embedded: Record<string, { params: string; result: string }>;
  constructor(machine: MatbotMachine, embedded?: Record<string, { params: string; result: string }>) {
    this.machine  = machine;
    this.embedded = embedded ?? {};
  }

  async dts(): Promise<string> {
    const arms = this.machine.tools.list().map(t => {
      const emb = this.embedded[t.name];
      const contract = t.toolContract
        ?? (emb ? `ToolContract<${emb.result}, ${emb.params}>` : `ToolContract<unknown, ${schemaToTs(t.inputSchema)}>`);
      return `    ${JSON.stringify(t.name)}: ${contract};`;
    });
    // `ToolContract` and the overloaded `tool` proxy resolve against plugin-api (textually — this dts is
    // shown to the model, not compiled here). A `toolContract` may name a plugin-api type (e.g. StoreQuery)
    // left bare; harmless in the shown text, which is enough for a composer to write `await tool.x(params)`.
    return `import type { ToolContract } from '@matatbread/matbot-plugin-api';\n`
      + `declare module '@matatbread/matbot-plugin-api' {\n  interface ToolContracts {\n${arms.join('\n')}\n  }\n}\n`
      + `declare const tool: import('@matatbread/matbot-plugin-api').ToolProxy;\n`
      + `declare const toolInContext: import('@matatbread/matbot-plugin-api').ToolBox;\n`
      + `declare const context: import('@matatbread/matbot-plugin-api').ComposedCallContext;\n`;
  }

  async check(): Promise<string[]> { return []; }

  async wireContracts(): Promise<Record<string, { params: string; result: string }>> {
    const out: Record<string, { params: string; result: string }> = {};
    for (const t of this.machine.tools.list()) {
      if (t.toolContract !== undefined) out[t.name] = splitContract(t.toolContract);   // runtime source-less tool
      else if (this.embedded[t.name] !== undefined) out[t.name] = this.embedded[t.name]!;   // built-in / remote: baked
    }
    return out;
  }

  // Merge more contracts (e.g. extractToolContracts() over a remotely-loaded plugin's source). Idempotent.
  addContracts(contracts: Record<string, { params: string; result: string }>): void {
    Object.assign(this.embedded, contracts);
  }
}

/** The browser ToolTypeIndex plus its runtime-merge hook (used by the host to add http-loaded plugins). */
export type BrowserToolTypeIndexHandle = ToolTypeIndex & {
  addContracts(contracts: Record<string, { params: string; result: string }>): void;
};

export function createBrowserToolTypeIndex(
  machine: MatbotMachine,
  embedded?: Record<string, { params: string; result: string }>,
): BrowserToolTypeIndexHandle {
  return new BrowserToolTypeIndex(machine, embedded);
}

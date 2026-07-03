import type { MatbotMachine, ToolTypeIndex } from '@matatbread/matbot-plugin-api';

// A browser ToolTypeIndex. The node one (@matatbread/matbot-tool-types) runs the real TypeScript compiler
// over each tool's on-disk source to recover its `ToolContracts` augmentation; the browser has neither the
// compiler nor a filesystem, so this derives the dts from the LIVE REGISTRY alone — the graceful fallback:
//   • a source-less tool (a function-tools function, the tool-store per-namespace tool) carries its contract
//     as a `toolContract` string on the registered Tool → spliced verbatim;
//   • any other tool has no reachable contract here, so its result stays `unknown` but its params are
//     synthesised from the (always-present) `inputSchema` (see schemaToTs), so a composer still sees real
//     fields rather than a bare `ToolContract<unknown, unknown>`.
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

// Flatten a `toolContract` (`ToolContract<Result, Args>`, or a `|`-union of arms) to the wire's
// `params`/`result` union text.
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
  constructor(machine: MatbotMachine) { this.machine = machine; }

  async dts(): Promise<string> {
    const arms = this.machine.tools.list().map(
      t => `    ${JSON.stringify(t.name)}: ${t.toolContract ?? `ToolContract<unknown, ${schemaToTs(t.inputSchema)}>`};`,
    );
    // `ToolContract` and the overloaded `tool` proxy resolve against plugin-api (textually — this dts is
    // shown to the model, not compiled here). A `toolContract` may name a plugin-api type (e.g. StoreQuery)
    // left bare; harmless in the shown text, which is enough for a composer to write `await tool.x(params)`.
    return `import type { ToolContract } from '@matatbread/matbot-plugin-api';\n`
      + `declare module '@matatbread/matbot-plugin-api' {\n  interface ToolContracts {\n${arms.join('\n')}\n  }\n}\n`
      + `declare const tool: import('@matatbread/matbot-plugin-api').ToolProxy;\n`;
  }

  async check(): Promise<string[]> { return []; }

  async wireContracts(): Promise<Record<string, { params: string; result: string }>> {
    const out: Record<string, { params: string; result: string }> = {};
    for (const t of this.machine.tools.list()) {
      if (t.toolContract !== undefined) out[t.name] = splitContract(t.toolContract);
    }
    return out;
  }
}

export function createBrowserToolTypeIndex(machine: MatbotMachine): ToolTypeIndex {
  return new BrowserToolTypeIndex(machine);
}

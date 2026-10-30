// The `ToolContracts` arms for tools that carry their contract as a `toolContract` STRING, written out for a
// file that declares them: the generated dts a body is checked against, the program that types them for
// validation, a turn's own tools appended to a snippet. One implementation, because each of those must agree
// on what a string means, and a fourth copy of the namespace rule would drift from the other three.
//
// A string may name types that exist nowhere else — a function package's own `interface HubReport`, carried
// on `toolContractTypes`. Those are declared in a namespace of their own with an alias per tool beside them,
// so the contract is written exactly as its author wrote it and still resolves, and two packages' `Report`s
// never meet. Tools carrying identical declarations (one package's exports) share one namespace.

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export interface ContractSource {
  readonly name:      string;
  readonly contract:  string;
  readonly types?:    string | undefined;
}

export interface ContractArms {
  /** Top-level declarations to place ahead of the `ToolContracts` augmentation; empty when nothing has types. */
  readonly preamble:   string;
  /** Per tool, the type to write as its `ToolContracts` arm: its own string, or the alias that wraps it. */
  readonly arms:       ReadonlyMap<string, string>;
  /** Per namespace in the preamble, the tools it serves — what a diagnostic inside it is attributed to. */
  readonly namespaces: ReadonlyMap<string, readonly string[]>;
}

export function contractArms(tools: Iterable<ContractSource>): ContractArms {
  const arms = new Map<string, string>();
  const groups = new Map<string, { ns: string; members: [alias: string, tool: string, contract: string][] }>();
  for (const t of tools) {
    if (t.types === undefined || t.types.trim() === '') { arms.set(t.name, t.contract); continue; }
    let group = groups.get(t.types);
    if (group === undefined) { group = { ns: `ToolContractTypes${groups.size + 1}`, members: [] }; groups.set(t.types, group); }
    const alias = IDENTIFIER.test(t.name) ? t.name : `Tool${group.members.length + 1}`;
    group.members.push([alias, t.name, t.contract]);
    arms.set(t.name, `${group.ns}.${alias}`);
  }
  const preamble = [...groups].map(([types, g]) =>
    `declare namespace ${g.ns} {\n${types.split('\n').map(l => `  ${l}`).join('\n')}\n`
    + g.members.map(([alias, , contract]) => `  export type ${alias} = ${contract};`).join('\n') + '\n}\n').join('');
  const namespaces = new Map([...groups.values()].map(g => [g.ns, g.members.map(([, tool]) => tool)] as const));
  return { preamble, arms, namespaces };
}

/**
 * Split TypeScript type text on any of `seps` at bracket depth 0. A separator inside a string-literal type
 * (`'a|b'`) or a comment cannot split, and the `>` of an arrow (`(x: A) => B`) closes nothing — the two ways
 * a depth count without them goes wrong on a contract a function author wrote.
 */
export function splitTypeText(s: string, seps: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (c === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
      const end = s[i + 1] === '/' ? s.indexOf('\n', i) : s.indexOf('*/', i) + 1;
      i = end <= 0 ? s.length : end;
      continue;
    }
    if (c === '=' && s[i + 1] === '>') { i++; continue; }
    if (c === '<' || c === '{' || c === '(' || c === '[') depth++;
    else if (c === '>' || c === '}' || c === ')' || c === ']') { if (depth > 0) depth--; }
    else if (depth === 0 && c !== undefined && seps.includes(c)) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

/**
 * The `params`/`result` union text of a `ToolContract<Result, Params>` type, or a `|`-union of such arms —
 * the flat form the wire carries. `null` unless EVERY arm is a `ToolContract`, which is what a contract is:
 * a bare type there names no call.
 */
export function parseContractArms(type: string): { params: string; result: string } | null {
  const results: string[] = [], params: string[] = [];
  for (const armText of splitTypeText(type, '|')) {
    const t = armText.trim();
    if (t === '') continue;                          // the leading `|` of a multi-line union
    const m = t.match(/^ToolContract\s*<([\s\S]*)>$/);
    if (!m) return null;
    const inner = splitTypeText(m[1]!, ',');
    results.push((inner[0] ?? 'unknown').trim());
    params.push((inner[1] ?? 'unknown').trim());
  }
  return results.length ? { result: results.join(' | '), params: params.join(' | ') } : null;
}

/** {@link parseContractArms} for a tool's `toolContract` string, which is always meant as one: anything
 *  else reads as `unknown` both ways rather than as no contract. */
export function splitContract(contract: string): { params: string; result: string } {
  return parseContractArms(contract) ?? { result: 'unknown', params: 'unknown' };
}

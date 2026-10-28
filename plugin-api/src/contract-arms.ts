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

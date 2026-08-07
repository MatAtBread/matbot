#!/usr/bin/env node
// Compares a tool's two authored descriptions of its own inputs, and reports where they contradict.
//
// Why this exists: a tool with scannable source declares its call contract as `ToolContracts` arms, and
// separately hand-authors an `inputSchema`. Both describe the same parameters, and NOTHING relates them.
// They have different jobs — the arms are what a composer typechecks against, the schema is the loose
// gate the provider is given and `json-validation` enforces — so they are deliberately not identical,
// and deriving either from the other would delete what the other carries (the schema's per-field
// `description`/`default`, the arms' precise per-action structure). What can be checked is that they do
// not CONTRADICT: a property in one and not the other, or two different constraints on the same value.
//
// The comparison is asymmetric on purpose. A schema LOOSER than the contract is the documented design
// for a multi-action tool ("inputSchema loose (`required: ['action']`), executor enforces"), so a
// weaker `required` is never reported. A property that exists in only one of the two is not looseness;
// it is one side knowing about an input the other does not.
//
// Both artefacts only sit on one object at RUNTIME, on the registered `Tool` — which is why this runs
// the CLI's `--dump-tools` rather than scanning source. An `inputSchema` reaches the registry from an
// inline literal, a module const, or a `tools:` array, and pairing those back to a tool name statically
// is far more fragile than booting the machine that already did it.
//
//   node scripts/check-tool-contracts.mjs [dump.json] [--config matbot.yaml]
//
// With no dump path, one is produced into a temp file. Exits 1 if anything is reported.

import { readFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Divergences accepted deliberately: `'<tool>.<property>': 'why'`. A check with no way to record an
// intentional difference gets switched off wholesale the first time one is intentional.
const ACCEPTED = {
  'http.method':
    'The two surfaces have different reach, so the type is deliberately the wider one. json-validation ' +
    'runs on the `toolcall` hook, which only the model-driven turn loop dispatches — invokeTool (and so ' +
    'the `tool` proxy a composition calls) goes straight to the executor. The schema enum is therefore a ' +
    'guardrail on what the MODEL sends; the executor passes any verb to fetch, and a composition may use one.',
};

// ── Type-text scanning ────────────────────────────────────────────────────────
// The contract arrives as TypeScript source text, so reading it means scanning it. Only the TOP level
// is needed — property names, optionality, and any literal value set — never a full conversion, which
// is the job `function-tools` does for its own generated schemas and not something to repeat here.

/** Split on any of `seps` at bracket depth 0. A separator inside a string-literal type (`'a|b'`) is
 *  inert, and `=>` is skipped so an arrow type's `>` doesn't close a bracket it never opened. */
function splitTopLevel(s, seps) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      for (let j = i + 1; j < s.length; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === c) { i = j; break; } }
      continue;
    }
    if (c === '=' && s[i + 1] === '>') { i++; continue; }
    if (c === '<' || c === '{' || c === '(' || c === '[') depth++;
    else if (c === '>' || c === '}' || c === ')' || c === ']') { if (depth > 0) depth--; }
    else if (depth === 0 && seps.includes(c)) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

/** Peel parens that wrap the whole type. A parenthesised arm — `({ action: 'set' } & Partial<…>)` —
 *  otherwise holds every separator inside it at depth 1, so nothing splits and the arm reads as opaque.
 *  An arrow type's leading `(` is not a wrapper (its `)` isn't the last character) and is left alone. */
function peel(s) {
  let t = s.trim();
  while (t.startsWith('(')) {
    let depth = 0, close = -1;
    for (let i = 0; i < t.length && close < 0; i++) {
      const c = t[i];
      if (c === "'" || c === '"' || c === '`') {
        for (let j = i + 1; j < t.length; j++) { if (t[j] === '\\') { j++; continue; } if (t[j] === c) { i = j; break; } }
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) close = i;
    }
    if (close !== t.length - 1) return t;
    t = t.slice(1, -1).trim();
  }
  return t;
}

function objectMembers(t) {
  const out = [];
  for (const member of splitTopLevel(t.slice(1, -1), ';,')) {
    const bits = splitTopLevel(member.trim(), ':');
    if (bits.length < 2) continue;
    let key = bits[0].trim();
    const type = bits.slice(1).join(':').trim();
    if (key.startsWith('[')) continue;                              // index signature — no fixed name
    const optional = key.endsWith('?');
    if (optional) key = key.slice(0, -1).trim();
    key = key.replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;                  // a method/call signature
    out.push({ key, optional, type });
  }
  return out;
}

/** One union arm's members. `open` when an intersection operand is something this can't enumerate (a
 *  named type, a mapped `Partial<…>`) — the arm then accepts properties beyond those returned, so an
 *  unmatched schema property can't be called extraneous. `structural` distinguishes an arm that takes
 *  NO properties from one this can't read: `{}` and `Record<string, never>` are both a complete,
 *  empty property list, so a schema property is checkable against them. */
function armMembers(arm) {
  const members = [];
  let open = false, structural = false;
  for (const operand of splitTopLevel(peel(arm), '&')) {
    const t = peel(operand);
    if (t.startsWith('{') && t.endsWith('}')) { members.push(...objectMembers(t)); structural = true; }
    else if (/^Record\s*<\s*string\s*,\s*never\s*>$/.test(t)) structural = true;
    else open = true;
  }
  return { members, open, structural };
}

/** The value set a type text admits, or null if any arm of it isn't a literal (so the type is open). */
function literalValues(type) {
  const values = [];
  for (const a of splitTopLevel(type, '|')) {
    const t = peel(a);
    if (t === 'undefined') continue;
    const q = t.match(/^'([^']*)'$/) ?? t.match(/^"([^"]*)"$/);
    if (q) { values.push(q[1]); continue; }
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(t)) { values.push(Number(t)); continue; }
    if (t === 'true' || t === 'false') { values.push(t === 'true'); continue; }
    return null;
  }
  return values.length > 0 ? values : null;
}

// ── Comparison ────────────────────────────────────────────────────────────────

const KINDS = {
  'schema-only-property':    'the schema advertises a property no contract arm accepts — the model can send it, a composer cannot',
  'contract-only-property':  'a contract arm accepts a property the schema does not advertise — a composer can pass it, the model is never told it exists',
  'required-not-in-contract':'the schema requires a property no contract arm accepts',
  'enum-mismatch':           'both constrain the value set, and the two sets differ',
  'enum-vs-open-type':       'the schema constrains the value set; the TypeScript type leaves it open',
  'literals-vs-open-schema': 'the TypeScript type constrains the value set; the schema leaves it open',
};

function compare(tool) {
  const params = tool.wireContract?.params;
  if (params === undefined || params === 'unknown') return [];

  const arms = splitTopLevel(params, '|').map(armMembers);
  if (!arms.some(a => a.structural)) return [];   // nothing enumerable to compare against
  const openSet = arms.some(a => a.open);

  const contract = new Map();
  for (const arm of arms) {
    for (const m of arm.members) {
      const e = contract.get(m.key) ?? { arms: 0, types: new Set() };
      e.arms++;
      e.types.add(m.type);
      contract.set(m.key, e);
    }
  }

  const schema  = tool.inputSchema ?? {};
  const sProps  = schema.properties ?? {};
  const found   = [];
  const at      = (kind, prop, detail) => {
    if (`${tool.name}.${prop}` in ACCEPTED) return;
    found.push({ kind, prop, detail });
  };

  // Suppressed when any arm is open: with an unenumerable operand in play, a schema property can't be
  // shown to be absent from the contract.
  if (!openSet) {
    for (const name of Object.keys(sProps)) {
      if (!contract.has(name)) at('schema-only-property', name, '');
    }
  }
  for (const name of Array.isArray(schema.required) ? schema.required : []) {
    if (!openSet && !contract.has(name)) at('required-not-in-contract', name, '');
  }
  for (const [name, e] of contract) {
    if (!(name in sProps)) { at('contract-only-property', name, `in ${e.arms}/${arms.length} arm(s)`); continue; }

    const sEnum = Array.isArray(sProps[name].enum) ? sProps[name].enum : null;
    const perArm = [...e.types].map(literalValues);
    const tValues = perArm.every(v => v !== null) ? [...new Set(perArm.flat())] : null;

    if (sEnum !== null && tValues === null) {
      at('enum-vs-open-type', name, `schema ${JSON.stringify(sEnum)} vs type \`${[...e.types].join(' | ')}\``);
    } else if (sEnum === null && tValues !== null) {
      at('literals-vs-open-schema', name, `type ${JSON.stringify(tValues)} vs schema ${JSON.stringify(sProps[name].type ?? 'unconstrained')}`);
    } else if (sEnum !== null && tValues !== null) {
      const s = new Set(sEnum.map(String)), t = new Set(tValues.map(String));
      const schemaOnly   = sEnum.filter(v => !t.has(String(v)));
      const contractOnly = tValues.filter(v => !s.has(String(v)));
      if (schemaOnly.length > 0 || contractOnly.length > 0) {
        at('enum-mismatch', name, `schema-only ${JSON.stringify(schemaOnly)}, contract-only ${JSON.stringify(contractOnly)}`);
      }
    }
  }
  return found;
}

// ── Run ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let config = path.join(root, 'matbot.yaml');
let dumpPath;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config') config = args[++i];
  else dumpPath = args[i];
}

if (dumpPath === undefined) {
  dumpPath = path.join(mkdtempSync(path.join(tmpdir(), 'matbot-contracts-')), 'tools.json');
  const run = spawnSync('node', ['bin.js', '--dump-tools', dumpPath, '--config', path.resolve(config)], {
    cwd: path.join(root, 'apps', 'cli'), stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (run.status !== 0) {
    console.error(`\nCould not dump the tool registry (matbot exited ${run.status}). Pass an existing dump instead:\n  node scripts/check-tool-contracts.mjs tools-dump.json\n`);
    process.exit(1);
  }
}

const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const withContract = dump.filter(t => t.wireContract !== undefined);
const report = dump.map(t => ({ name: t.name, found: compare(t) })).filter(t => t.found.length > 0);

if (report.length === 0) {
  console.log(`Tool contracts agree with their inputSchemas (${withContract.length} of ${dump.length} tools carry a contract).`);
  process.exit(0);
}

const total = report.reduce((n, t) => n + t.found.length, 0);
console.error(`\n${total} contract/schema divergence(s) across ${report.length} tool(s):\n`);
for (const { name, found } of report) {
  console.error(`  ${name}`);
  for (const f of found) console.error(`    ${f.kind}: ${f.prop}${f.detail ? ` — ${f.detail}` : ''}`);
}
console.error('\nWhat each means:');
for (const kind of new Set(report.flatMap(t => t.found.map(f => f.kind)))) {
  console.error(`  ${kind}\n    ${KINDS[kind]}`);
}
console.error('\nFix whichever artefact is wrong — or, if the difference is deliberate, record it in ACCEPTED\nin scripts/check-tool-contracts.mjs with the reason.\n');
process.exit(1);

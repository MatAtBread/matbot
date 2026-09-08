import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createToolTypesPlugin } from '@matatbread/matbot-tool-types';
import type { ToolValidatorSupplier } from '@matatbread/matbot-tool-types';
import type { MatbotMachine, Tool } from '@matatbread/matbot-plugin-api';

// A tool built at RUNTIME cannot carry a static `ToolContracts` augmentation, so it declares the same
// contract as a `toolContract` STRING on its registered `Tool` — `function-tools`' generated functions
// and `tool-store`'s per-namespace CRUD tools (`tool_router_nouns_action` and friends).
//
// Those strings are real and reach the model: `wireContracts()` unions them with the scanned
// augmentations, and the result is folded into the outgoing tool descriptions, which is why asking the
// model for a synthetic tool's type signature gets a full discriminated union back with no tool call.
//
// The generated VALIDATORS do not cover them, because the emitter needs a `ts.Type` and a string is not
// one: `build-dts` walks the `ToolContracts` type in a `ts.Program` built from scanned sources, and a
// synthetic arm exists only in the live registry. So a synthetic tool is advertised as typed and
// enforced only by its loose `inputSchema`.
//
// They ARE now validated: the strings are rendered into a virtual augmentation file and typed by a small
// second Program, and the same emitter runs over the result — so a runtime-built tool is enforced exactly
// like a compiled one. What is still taken verbatim from the string is the wire text and the dts arm,
// since that is what the model already reads and re-deriving it would expand aliases the author chose.
const root = join(import.meta.dirname, '..', '..', '..');

// Multi-arm and PARAMETERISED, which is the case that matters: a no-argument synthetic tool would be
// validated by accident, since `{}` admits nothing either way.
const SYNTHETIC: Tool = {
  name: 'synthetic_thing',
  description: 'a runtime-registered tool, contract declared as a string',
  inputSchema: { type: 'object', properties: {}, required: ['action'] },
  toolContract:
    'ToolContract<{ ok: boolean }, { action: "get"; id: string }>'
    + ' | ToolContract<{ n: number }, { action: "count"; of: string[]; deep?: { flag: boolean } }>',
  executor: { execute: () => (async function* () {})() },
};

// Names a plugin-api export (`StoreQuery`), which is the reason the import list has to be exact rather
// than guessed — the arms are typed in their own Program, which knows nothing but plugin-api.
const SYNTHETIC_API: Tool = {
  name: 'synthetic_query',
  description: 'a runtime tool whose contract references a plugin-api type',
  inputSchema: { type: 'object' },
  toolContract: 'ToolContract<{ items: unknown[] }, { action: "query"; query?: StoreQuery }>',
  executor: { execute: () => (async function* () {})() },
};

// Deliberately broken, to prove one bad string cannot take the batch with it.
const SYNTHETIC_BAD: Tool = {
  name: 'synthetic_broken',
  description: 'a runtime tool whose contract does not parse',
  inputSchema: { type: 'object' },
  toolContract: 'ToolContract<{ oops: , }, {',
  executor: { execute: () => (async function* () {})() },
};

// Stands in for the real `session_action`: its CONTRACT comes from the scanned source either way, so
// only the name has to be live here.
const SESSION_STUB: Tool = {
  name: 'session_action', description: 'scanned comparator', inputSchema: { type: 'object' },
  executor: { execute: () => (async function* () {})() },
};

const ALL = [SYNTHETIC, SYNTHETIC_API, SYNTHETIC_BAD, SESSION_STUB];

async function index(): Promise<ToolValidatorSupplier & {
  wireContracts(): Promise<Record<string, { params: string; result: string }>>;
}> {
  let registered: unknown;
  const machine = {
    // `configPath`'s directory is where the scan roots, so the real monorepo contracts are read — the
    // point is the CONTRAST between a scanned tool and a synthetic one, not a synthetic one alone.
    configPath: join(root, 'matbot.yaml'),
    Notifier: { consume: () => {}, notify: () => {}, subscribe: () => (async function* () {})() },
    tools: {
      // Both must be LIVE: a scanned contract is filtered by the tool registry (build-dts applies the
      // same live filter to contracts and validators as to the dts), because a validator for a tool
      // nobody loaded is unreachable. `session_action` is here purely as the scanned comparator.
      list: () => ALL,
      resolve: (n: string) => ALL.find(t => t.name === n) ?? null,
      register() {}, remove() {}, removeByPlugin() {},
    },
    register: async (_k: string, v: unknown) => { registered = v; },
  } as unknown as MatbotMachine;

  await createToolTypesPlugin().setup?.(machine);
  return registered as ToolValidatorSupplier & {
    wireContracts(): Promise<Record<string, { params: string; result: string }>>;
  };
}

test('a synthetic tool DOES reach the model with its declared type', async () => {
  const wire = await (await index()).wireContracts();
  const entry = wire['synthetic_thing'];
  assert.ok(entry, 'a `toolContract` string must produce a wire contract');
  assert.match(entry.params, /action/, 'the params text must carry the declared arm');
  assert.match(entry.result, /ok/, 'and the result text its result type');
});

test('and it is validated per arm, exactly like a compiled tool', async () => {
  const validators = await (await index()).toolValidators();

  const scanned = validators['session_action'];
  assert.ok(scanned && !('refused' in scanned), 'a source-declared contract must still be validatable');

  const v = validators['synthetic_thing'];
  assert.ok(v && !('refused' in v), `a runtime-declared contract must yield a validator, got ${JSON.stringify(v)}`);

  assert.deepEqual(v.validate({ action: 'get', id: 'x' }), [], 'a valid first arm');
  assert.deepEqual(v.validate({ action: 'count', of: ['a'] }), [], 'a valid second arm, optional field omitted');
  assert.deepEqual(v.validate({ action: 'count', of: [], deep: { flag: true } }), [], 'nested optional object');

  // Dispatched on the discriminant, so the error names the field set of the arm the caller chose —
  // the whole reason a type beats the tool's loose `inputSchema` here.
  const wrongArm = v.validate({ action: 'count', id: 'x' });
  assert.ok(wrongArm.some(e => e.path === '.of' && /required/.test(e.message)), JSON.stringify(wrongArm));
  assert.ok(wrongArm.some(e => e.path === '.id' && /unexpected/.test(e.message)),
    `a field belonging to the OTHER arm must be rejected: ${JSON.stringify(wrongArm)}`);

  const badElement = v.validate({ action: 'count', of: [1] });
  assert.equal(badElement[0]?.path, '.of[0]', JSON.stringify(badElement));

  const badNested = v.validate({ action: 'count', of: [], deep: { flag: 'yes' } });
  assert.equal(badNested[0]?.path, '.deep.flag', JSON.stringify(badNested));
});

test('a plugin-api type named by the string resolves', async () => {
  // The arms are typed in a Program that knows only plugin-api, so `StoreQuery` has to be imported into
  // the virtual file — which is why the import list is taken from the resolved export set rather than
  // guessed from the text. Guessing needs a denylist of TS's own utility types, and `Record<string,
  // never>` (= `NoParams`) is the first thing such a list gets wrong.
  const v = (await (await index()).toolValidators())['synthetic_query'];
  assert.ok(v && !('refused' in v), `expected StoreQuery to resolve, got ${JSON.stringify(v)}`);
  assert.deepEqual(v.validate({ action: 'query' }), [], 'the optional query may be omitted');
  assert.deepEqual(v.validate({ action: 'query', query: { limit: 5 } }), [], 'a real StoreQuery field');
  assert.ok(v.validate({ action: 'query', query: { limit: 'lots' } }).length, 'and its type is enforced');
});

test('one malformed contract is refused alone, taking nothing else with it', async () => {
  // They become properties of ONE interface, so an unscreened stray brace would swallow every arm after
  // it. A refusal is also the honest report: nothing else in the system parses these strings, so a broken
  // one was previously just bad documentation that nothing could notice.
  const validators = await (await index()).toolValidators();

  const bad = validators['synthetic_broken'];
  assert.ok(bad && 'refused' in bad, `a broken string must be refused, got ${JSON.stringify(bad)}`);
  assert.match(bad.refused, /does not parse/);

  for (const name of ['synthetic_thing', 'synthetic_query']) {
    const v = validators[name];
    assert.ok(v && !('refused' in v), `${name} must survive its neighbour being broken`);
  }
});

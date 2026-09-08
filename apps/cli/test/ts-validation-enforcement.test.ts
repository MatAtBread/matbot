import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MatbotMachine } from '@matatbread/matbot-plugin-api';
import type { ToolInputValidator } from '@matatbread/matbot-core';
import { ItemChangeKind, runAs, installPrincipalCarrier } from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '../src/principal-als.ts';

installPrincipalCarrier(createAlsPrincipalCarrier());
import type { ToolValidator } from '@matatbread/matbot-tool-types';
import { plugin as tsValidation } from '@matatbread/matbot-tool-ts-validation';

// The packages divide as supplier / consumer:
//   tool-types      does the type formation and analysis, and SUPPLIES a generated validator per tool
//                   (`toolValidators()`); it registers no validator service, so a code generator loading
//                   it for `dts()` alone never silently starts having its tool calls rejected.
//   ts-validation   CONSUMES that, applies an enforcement policy, and registers core's
//                   `ToolCallValidator` — the key core consults at the executor, so the model's path,
//                   HTTP tool routes and `invokeTool` are all covered by one validator.
//
// What is worth pinning here is the policy, since every one of its states is a way to get enforcement
// wrong; the generation itself is pinned in tool-contract-validators.test.ts.

type Errs = { path: string; message: string }[];

function harness(opts: {
  enforce?:   string;
  entry?:     ToolValidator;          // absent ⇒ no contract for this tool
  supplier?:  false;                  // tool-types not loaded
  previous?:  ToolInputValidator;     // a validator this one displaces
}): {
  setup(): Promise<void>;
  validate(input: unknown): Promise<Errs | undefined>;
  services: MatbotMachine;
  warnings: string[];
  reg: Record<string, unknown>;
  reads(): number;
  write(enforce: string, principal?: string, key?: string): void;
} {
  const warnings: string[] = [];
  const store = new Map<string, unknown>();
  let reads = 0;
  // The invalidation half of the bus: the plugin caches `enforce` and re-reads only when a settings
  // write announces itself, so a test needs to publish one.
  const sinks: ((n: unknown) => void)[] = [];
  if (opts.enforce !== undefined) store.set('enforce', opts.enforce);
  let registered: ToolInputValidator | undefined;

  // A real registry, so a service the plugin registers itself is observable here — which is how the
  // self-install path is tested rather than assumed.
  const reg: Record<string, unknown> = {
    ...(opts.previous !== undefined ? { ToolCallValidator: opts.previous } : {}),
    ...(opts.supplier === false ? {} : {
      // Only `toolValidators` matters: ts-validation duck-types the supply off ToolTypeIndex, so the
      // rest of that service (dts/check/wireContracts) is beside the point here.
      ToolTypeIndex: {
        toolValidators: async () => (opts.entry === undefined ? {} : { session_action: opts.entry }),
      },
    }),
  };

  const services = {
    // The plugin compares an announcement's `key` against its own name, so the harness must have one.
    self: { name: PLUGIN_NAME, specifier: PLUGIN_NAME },
    settings: () => ({
      get: async <T,>(k: string): Promise<T | undefined> => { reads++; return store.get(k) as T | undefined; },
      set: async () => {}, delete: async () => {},
    }),
    register: async (key: string, value: unknown) => {
      reg[key] = value;
      if (key === 'ToolCallValidator') registered = value as ToolInputValidator;
    },
    unregister: (key: string) => { delete reg[key]; },
    get ToolTypeIndex() { return reg['ToolTypeIndex']; },
    get ToolCallValidator() { return opts.previous; },
    // Enough machine for a REAL ToolTypeIndex to be constructed: it subscribes to tool-registry changes
    // to know when its dts is stale, and roots its scan at the config's directory. `configPath` is left
    // undefined so the scan roots at '.', which keeps these tests off the monorepo walk — the generated
    // output is pinned in tool-contract-validators.test.ts, not here.
    Notifier: {
      consume: (h: (n: unknown) => void) => { sinks.push(h); },
      notify: () => {}, subscribe: () => (async function* () {})(),
    },
    tools: { list: () => [], resolve: () => null, register() {}, remove() {}, removeByPlugin() {} },
  } as unknown as MatbotMachine;

  const original = console.warn;
  return {
    warnings, services, reg,
    reads: () => reads,
    write(enforce: string, principal?: string, key = PLUGIN_NAME) {
      store.set('enforce', enforce);
      for (const sink of sinks) {
        // `key` is the settings namespace as core was addressed by it; `id` is that name slugged to a
        // legal document id. The plugin must match on the former — see the filter it installs.
        sink({ kind: ItemChangeKind, plugin: 'core', source: 'settings', namespace: 'settings',
               id: key.replace(/[^\w-]+/g, '_'), key, operation: 'saved',
               ...(principal !== undefined ? { principal: { id: principal, type: 'user' } } : {}) });
      }
    },
    setup: async () => { await tsValidation.setup?.(services); },
    async validate(input: unknown) {
      if (!registered) await tsValidation.setup?.(services);
      console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
      try { return await registered!.validateToolCall('session_action', input); }
      finally { console.warn = original; }
    },
  };
}

/** The loader-derived name of the plugin under test — the string its settings are namespaced by. */
const PLUGIN_NAME = '@matatbread/matbot-tool-ts-validation';

const FAILS: ToolValidator = {
  warnings: [],
  validate: () => [{ path: '.title', message: 'required property missing' }],
};
const PASSES: ToolValidator = { warnings: [], validate: () => [] };

test("'reject' returns the offending paths verbatim, for core to hand the model", async () => {
  const h = harness({ enforce: 'reject', entry: FAILS });
  assert.deepEqual(await h.validate({ action: 'rename' }),
    [{ path: '.title', message: 'required property missing' }], 'the paths must survive intact');
});

test("'reject' is the default — registering the plugin is the opt-in", async () => {
  const h = harness({ entry: FAILS });                        // no `enforce` set at all
  const out = await h.validate({ action: 'rename' });
  assert.ok(out && out.length > 0, 'the unset default must enforce, not warn');
});

test("'warn' reports clean so the call proceeds, but says what it would have done", async () => {
  const h = harness({ enforce: 'warn', entry: FAILS });
  assert.deepEqual(await h.validate({ action: 'rename' }), [], 'warn must not refuse the call');
  assert.ok(h.warnings.some(w => w.includes('Would reject')), 'the near-miss must be audible');
});

test("'off' hands straight over, and does not claim to have checked", async () => {
  const h = harness({ enforce: 'off', entry: FAILS });
  assert.equal(await h.validate({ action: 'rename' }), undefined, 'off must be NO OPINION, not "valid"');
  assert.deepEqual(h.warnings, []);
});

test('valid input reports clean', async () => {
  for (const enforce of ['warn', 'reject']) {
    const h = harness({ enforce, entry: PASSES });
    assert.deepEqual(await h.validate({ action: 'list' }), [], `enforce=${enforce}`);
  }
});

test('an unconstrained field is announced once, and does not stop validation', async () => {
  const h = harness({
    enforce: 'reject',
    entry: { warnings: ['("query").params: bare `object` — accepts any non-primitive'], validate: () => [] },
  });
  assert.deepEqual(await h.validate({ action: 'query' }), []);
  assert.ok(h.warnings.some(w => w.includes('unconstrained field')), 'a caveat must be visible');
});

test('no typed contract defers to the validator this one displaced', async () => {
  // The typed path has nothing for this tool, so the schema validator it loaded over must still get its
  // say — otherwise adopting typed validation silently switches off schema validation.
  const schemaSaid = [{ path: '.x', message: 'expected string' }];
  const h = harness({ enforce: 'reject', previous: { validateToolCall: async () => schemaSaid } });
  assert.deepEqual(await h.validate({ x: 1 }), schemaSaid, 'the displaced validator must be consulted');
  assert.ok(h.warnings.some(w => w.includes('no typed contract')), 'and the gap must be announced');
});

test('a REFUSED contract also defers, naming why', async () => {
  const schemaSaid = [{ path: '.n', message: 'expected number' }];
  const h = harness({
    enforce: 'reject',
    entry: { refused: 'params.n: bigint (JSON.stringify throws on it)' },
    previous: { validateToolCall: async () => schemaSaid },
  });
  assert.deepEqual(await h.validate({ n: 'x' }), schemaSaid);
  assert.ok(h.warnings.some(w => w.includes('cannot be validated as JSON') && w.includes('bigint')),
    'an unvalidatable contract must say so, not pass silently');
});

test('an already-registered supply is used as-is, and no second one is installed', async () => {
  // The load-ORDER case that works: tool-types listed first owns the service, so this plugin must
  // resolve to THAT index — not stand up a rival holding its own worker and its own build.
  const h = harness({ enforce: 'reject', entry: FAILS });
  const supply = h.reg['ToolTypeIndex'];
  await h.setup();
  assert.equal(h.reg['ToolTypeIndex'], supply, 'the registered index must be left exactly as it was');
  assert.deepEqual(await h.validate({ action: 'rename' }), [{ path: '.title', message: 'required property missing' }]);
});

test('with no tool-types loaded the plugin installs one, rather than failing to load', async () => {
  // It used to throw here, which made `plugins:` order a silent config trap — tool-types had to be
  // listed FIRST or this plugin was simply absent. The dependency is hard and direct (a `dependencies`
  // entry, the module already imported), so there is nothing to negotiate: it installs the service.
  const h = harness({ enforce: 'reject', supplier: false });
  await h.setup();
  assert.ok(h.reg['ToolTypeIndex'], 'setup must leave a ToolTypeIndex registered');
  assert.equal(typeof (h.reg['ToolTypeIndex'] as { toolValidators?: unknown }).toolValidators, 'function');
  await tsValidation.teardown?.();
});

test('a supply that disappears mid-flight is re-created, not fatal', async () => {
  // This one bricked a live machine. Failing CLOSED here — an error for every call whose contract could
  // not be verified — sounds right until tool-types is unloaded: EVERY tool then fails, including the
  // `plugin` tool needed to put it back and the calls the web UI makes to draw itself, so the only way
  // out is a restart. A dependency this plugin can re-create is not an unverifiable call at all.
  const h = harness({ enforce: 'reject', entry: PASSES });
  await h.setup();
  delete h.reg['ToolTypeIndex'];

  const out = await h.validate({ action: 'list' });
  // Not rejected — which is the whole point. The freshly installed index scans nothing in this harness,
  // so it holds no contract for the tool and the honest answer is NO OPINION (`undefined`, deferring to
  // whoever came before). What must never come back is a rejection the caller cannot act on.
  assert.ok(out === undefined || out.length === 0, `the call must not be refused, got ${JSON.stringify(out)}`);
  assert.ok(h.reg['ToolTypeIndex'], 'and the supply must have been re-installed');
  await tsValidation.teardown?.();
});

// ── The `enforce` cache ────────────────────────────────────────────────────────
// Validation now sits at the executor, so `enforce` is read on every tool call through every door.
// Re-reading a store (a disk read on the filesystem backend) to re-learn a value that changes
// approximately never is the cost; a settings ItemChange is what makes caching it correct rather than
// a TTL guess.

test('enforce is read once and then cached', async () => {
  const h = harness({ enforce: 'reject', entry: PASSES });
  await h.validate({ action: 'list' });
  const after = h.reads();
  await h.validate({ action: 'list' });
  await h.validate({ action: 'list' });
  assert.equal(h.reads(), after, 'later calls must not re-read the settings store');
  await tsValidation.teardown?.();
});

test('a settings write invalidates it, so a change takes effect on the next call', async () => {
  const h = harness({ enforce: 'warn', entry: FAILS });
  assert.deepEqual(await h.validate({ action: 'rename' }), [], 'warn lets the call through');
  h.write('reject');
  const out = await h.validate({ action: 'rename' });
  assert.ok(out && out.length > 0, 'the new value must be in force without a restart');
  await tsValidation.teardown?.();
});

test('the cache is keyed by principal, and a write clears only that one', async () => {
  // An override is per-principal and CAS'd, so one user switching to `off` must not switch it off for
  // everyone — the disambiguation ItemChange.principal already carries.
  const h = harness({ enforce: 'reject', entry: FAILS });
  const asUser = (id: string) => runAs({ id, type: 'user' }, () => h.validate({ action: 'rename' }));

  assert.ok((await asUser('a'))?.length, 'a is enforcing');
  assert.ok((await asUser('b'))?.length, 'b is enforcing');
  const before = h.reads();

  h.write('off', 'a');
  assert.equal(await asUser('a'), undefined, "a's write must take effect for a");
  assert.ok((await asUser('b'))?.length, "and must not disturb b's cached value");
  assert.equal(h.reads(), before + 1, 'exactly one entry was invalidated');
  await tsValidation.teardown?.();
});

test("another plugin's settings write does not invalidate this one's cache", async () => {
  // The reason `key` exists on ItemChange. Matching on `id` instead would mean copying core's namespace
  // slug into this plugin, where it would keep compiling after core's rule changed and silently stop
  // matching — a cache that never invalidates, which is worse than the read it replaced.
  const h = harness({ enforce: 'reject', entry: FAILS });
  await h.validate({ action: 'rename' });
  const before = h.reads();

  h.write('off', undefined, '@matatbread/matbot-telegram');
  assert.ok((await h.validate({ action: 'rename' }))?.length, 'an unrelated write must not change policy');
  assert.equal(h.reads(), before, 'and must not even cost a read');

  h.write('off');
  assert.equal(await h.validate({ action: 'rename' }), undefined, 'this plugin\'s own write still lands');
  await tsValidation.teardown?.();
});

test('an announcement with no `key` invalidates everything, failing loose', async () => {
  // A producer older than the field, or a bridged remote. Failing loose costs one read; failing tight
  // costs a setting that appears not to work.
  const h = harness({ enforce: 'warn', entry: FAILS });
  assert.deepEqual(await h.validate({ action: 'rename' }), []);
  h.write('reject', undefined, undefined as unknown as string);
  assert.ok((await h.validate({ action: 'rename' }))?.length, 'an unkeyed write must still invalidate');
  await tsValidation.teardown?.();
});

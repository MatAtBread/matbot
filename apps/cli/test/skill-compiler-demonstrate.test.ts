import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRunner, installPrincipalCarrier, installUsageCarrier, runAs } from '@matatbread/matbot-core';
import type {
  Session, Store, Tool, ToolRegistry, ProviderAdapter, ProviderConfig, CompletionEvent, EphemeralRun,
} from '@matatbread/matbot-core';
import { MemoryStore } from '@matatbread/matbot-core/storage-base';
import { demonstrate } from '@matatbread/matbot-tool-skill-compiler';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// The compiler performs a skill once to capture a working trace, and that run is a throwaway: it used to
// be a real session in the user's store, announced, listed, and orphaned if the process died mid-run.
// Whether it lands there is invisible in the compile result — the trace is the same either way — so it
// is asserted here, and logged while the ephemeral run is new.

const principal = { id: 'tester', type: 'user' as const };

const fetchBalance: Tool = {
  name: 'fetch_balance',
  description: 'reads the balance',
  inputSchema: { type: 'object', properties: {} },
  executor: { async *execute() { yield { type: 'result', value: { balance: 51_000_000 } }; } },
};

const tools = {
  register: () => {}, unregister: () => {},
  resolve:  (name: string) => (name === fetchBalance.name ? fetchBalance : null),
  list:     () => [fetchBalance],
  has:      (name: string) => name === fetchBalance.name,
} as unknown as ToolRegistry;

function performer(): ProviderAdapter {
  let call = 0;
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      const n = call++;
      return (async function* () {
        if (n === 0) yield { type: 'tool-call', id: 'c0', name: 'fetch_balance', input: {} };
        else         yield { type: 'text-delta', delta: 'The balance is 51M.' };
        yield { type: 'done' };
      })();
    },
  };
}

// Records every write, so "nothing reached the machine's store" is a statement about writes rather than
// about what happens to be there afterwards (a write then a delete would leave it empty).
function watched(): { store: Store<Session>; writes: string[] } {
  const inner = new MemoryStore<Session>();
  const writes: string[] = [];
  return {
    writes,
    store: {
      get:    id => inner.get(id),
      set:    async (id, v) => { writes.push(`set ${id}`); await inner.set(id, v); },
      cas:    async (id, e, v) => { writes.push(`cas ${id}`); return inner.cas(id, e, v); },
      delete: async (id, e) => { writes.push(`delete ${id}`); return inner.delete(id, e); },
      query:  q => inner.query(q),
    },
  };
}

function runOver(store: Store<Session>): EphemeralRun {
  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  return {
    sessions: store,
    run: createSessionRunner({
      store,
      resolveProvider: async () => ({ adapter: performer(), config }),
      tools,
      loadPlugin:   async () => { throw new Error('loadPlugin unused'); },
      unloadPlugin: async () => false,
    }),
  };
}

async function demonstrateLogged(demo: EphemeralRun, machine: Store<Session>): Promise<{ session: Session | undefined; log: string[] }> {
  const log: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { log.push(args.map(String).join(' ')); };
  try {
    const session = await runAs(principal, async () => {
      const gen = demonstrate(demo, machine, { skill: 'check-balance', skillContent: 'Read the balance.', provider: 'fake', signal: new AbortController().signal });
      for (;;) { const step = await gen.next(); if (step.done === true) return step.value; }
    });
    return { session, log: log.filter(l => l.startsWith('[skills_compiler]')) };
  } finally {
    console.error = original;
  }
}

test('the demonstration runs on the ephemeral run and never touches the persisted session store', { timeout: 15000 }, async () => {
  const machine = watched();
  const { session, log } = await demonstrateLogged(runOver(new MemoryStore<Session>()), machine.store);

  assert.ok(session, 'a transcript came back');
  assert.ok(session.messages.some(m => m.content.some(c => c.type === 'tool-call')), 'with the working trace in it');
  assert.deepEqual(machine.writes, [], 'nothing was written to the machine\'s session store');
  assert.equal(log.length, 2, log.join('\n'));
  assert.match(log[0]!, /demonstrating "check-balance" in ephemeral session/);
  assert.match(log[1]!, /not in the persisted session store/);
});

test('the leak check fires when the demonstration does land in the persisted store', { timeout: 15000 }, async () => {
  // The negative control: a run whose store IS the machine's — what the compiler used to do.
  const machine = watched();
  const { log } = await demonstrateLogged(runOver(machine.store), machine.store);
  assert.ok(machine.writes.length > 0);
  assert.match(log.at(-1) ?? '', /LEAKED into the persisted session store/);
});

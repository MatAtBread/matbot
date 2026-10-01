import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier } from '@matatbread/matbot-core';
import type {
  Session, Store, ToolRegistry, ProviderAdapter, ProviderConfig, CompletionEvent,
  Principal, MessageContent,
} from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// The usage flush is a read-modify-write of the session, done once the pump's queue drains. The pump
// used to drop `running` BEFORE awaiting it, so a submission arriving during the flush started a second
// pump, whose persist-at-turn-start write interleaved with the flush's — and whichever landed second
// erased the other: the flushed accounting, or the new turn's user message. A slow store read makes the
// window wide enough to land in deterministically.

const principal: Principal = { id: 'tester', type: 'user' };

const emptyTools = {
  register: () => { throw new Error('register unused'); },
  unregister: () => { throw new Error('unregister unused'); },
  resolve: () => null,
  list: () => [],
  has: () => false,
} as unknown as ToolRegistry;

const text = (t: string): MessageContent[] => [{ type: 'text', text: t }];

test('a submission arriving during the usage flush neither erases it nor is erased', { timeout: 15000 }, async () => {
  const session = createSession();
  const docs = new Map<string, Session>([[session.id, session]]);

  // With no hooks registered, the first read after the first turn's two writes (persist-at-turn-start,
  // then the end-of-turn commit) is the flush's. Delay that one: read now, deliver late, as a slow
  // medium would — a snapshot that predates anything written in the meantime.
  let sets = 0;
  let gated = false;
  let flushReadStarted!: () => void;
  const flushRead = new Promise<void>(resolve => { flushReadStarted = resolve; });
  const store: Store<Session> = {
    get: async id => {
      const doc = docs.get(id) ?? null;
      if (sets === 2 && !gated) {
        gated = true;
        flushReadStarted();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return doc;
    },
    set: async (id, v) => { sets++; docs.set(id, v); },
    cas: async () => { throw new Error('cas unused'); },
    delete: async () => { throw new Error('delete unused'); },
    query: async () => { throw new Error('query unused'); },
  };

  const adapter: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      return (async function* () {
        yield { type: 'text-delta', delta: 'answer' };
        yield { type: 'usage', inputTokens: 10, outputTokens: 2 };
        yield { type: 'done' };
      })();
    },
  };

  const runner = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter, config: { name: 'fake', module: 'fake', model: 'fake' } as ProviderConfig }),
    tools:           emptyTools,
    loadPlugin:      async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin:    async () => false,
  });
  const submit = (t: string) => runner.open({
    sessionId: session.id, signal: new AbortController().signal,
    content: text(t), provider: 'fake', principal,
  });

  await submit('one');
  await flushRead;
  const second = await submit('two');
  for await (const ev of second.events) if (ev.type === 'idle' && !runner.status(session.id).busy) break;

  const users = docs.get(session.id)!.messages.filter(m => m.role === 'user');
  assert.equal(users.length, 2, 'the second turn\'s user message survived the flush');
  assert.ok((users[0]!.activity?.length ?? 0) > 0, 'the first turn\'s usage survived the second turn');
  assert.ok((users[1]!.activity?.length ?? 0) > 0, 'the second turn\'s usage was flushed too');
});

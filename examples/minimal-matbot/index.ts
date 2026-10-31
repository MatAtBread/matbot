// The smallest useful matbot: one machine, built from @matatbread/matbot-core and nothing else, that
// reads a prompt from stdin, runs one turn against the chatjimmy provider and streams the reply to stdout.
//
//   echo "Why is the sky blue?" | pnpm start
import {
  assembleMachine, ProviderRegistryImpl, VaultImpl, loadPlugins, createSession,
  installPrincipalCarrier, createConstantPrincipalCarrier, installUsageCarrier, createSerialUsageCarrier,
} from '@matatbread/matbot-core';
import type { Principal } from '@matatbread/matbot-core';
import { MemoryStorageBackend } from '@matatbread/matbot-core/storage-base';

// Whoever is running this process. Every store, vault and tool call is made on someone's behalf; a
// server would establish one per request with `runAs` instead of one for the whole process.
const me: Principal = { id: 'me', type: 'user' };
installPrincipalCarrier(createConstantPrincipalCarrier(me));
installUsageCarrier(createSerialUsageCarrier());

const { services, loaded } = assembleMachine({
  bootBackend: new MemoryStorageBackend(),   // nothing persists past this process
  vault:       new VaultImpl({}),            // chatjimmy needs no credentials
  providers:   new ProviderRegistryImpl([['jimmy', {
    name:   'jimmy',
    module: '@matatbread/matbot-provider-chatjimmy',
    model:  'llama3.1-8B',
    // A plain question and answer. The machine's built-in tools (about_matbot, single_turn, gate_action)
    // would otherwise be described to the model on every request, in an endpoint window of about 6k tokens.
    parameters: { tools: false },
  }]]),
  version: '0.0.0',
  host: machine => ({
    // A provider's `module` is a plugin like any other, and comes through here. Resolve it from THIS
    // module, where its package is installed: core resolving it would look beside core instead.
    async loadPlugin(specifier, prompt) {
      const [plugin] = await loadPlugins([{ spec: specifier, importSpec: import.meta.resolve(specifier) }], machine(), false, prompt, 'throw');
      if (plugin === undefined) throw new Error(`No plugin loaded for "${specifier}"`);
      return plugin;
    },
    unloadPlugin: async () => false,
    isSubAgent:   () => false,
    // Only a `tool_function` body is ever stripped, and nothing here defines one.
    TypeScriptStripper: { strip: source => source },
  }),
});
loaded();

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (prompt.trim() === '') {
  console.error('Nothing on stdin. Try: echo "Why is the sky blue?" | pnpm start');
  process.exit(1);
}

const session = createSession();
await services.sessions!.set(session.id, session);
const turn = await services.run!.open({
  sessionId: session.id,
  provider:  'jimmy',
  principal: me,
  content:   [{ type: 'text', text: prompt }],
  signal:    AbortSignal.timeout(60_000),
});

for await (const event of turn.events) {
  switch (event.type) {
    case 'text-delta': process.stdout.write(event.delta); break;
    case 'error':      throw new Error(event.error);
    case 'done':
    case 'aborted':    process.stdout.write('\n'); break;
    case 'idle':       process.exit(0);
    default:           break;
  }
}

import type { Tool, ToolEvent, ToolContext } from '@matatbread/matbot-plugin-api';
import type { AvailableProvider, ProviderDraft } from './setup.js';

export interface ProviderRow {
  name:      string;
  module:    string;
  model:     string;
  endpoint?: string;
  hasKey:    boolean;
}

/**
 * The provider-admin surface the bootstrap owns. Mirrors what the node `provider` tool gets from
 * matbot.yaml + the loaded-plugin registry — but backed by the portable store/vault path instead of
 * filesystem YAML editing, which is the only reason the node tool wasn't reusable here.
 */
export interface ProviderAdmin {
  available: AvailableProvider[];
  list(): ProviderRow[];
  add(draft: ProviderDraft): Promise<string>;   // persist + load adapter + canonicalise + register
  remove(name: string): Promise<boolean>;
}

type ProviderInput =
  | { action: 'list' }
  | { action: 'add'; name: string; adapter: string; endpoint: string; model: string }
  | { action: 'remove'; name: string };

/**
 * Browser `provider` tool. The portable analogue of the node provider tool: it manages the same
 * named-LLM-profile concept, but reads/writes the live providers map + localStorage + vault rather
 * than a YAML file. The API key is collected out-of-band via `ctx.prompt` (never in the transcript),
 * exactly like `plugin store-key`.
 */
export function createBrowserProviderTool(admin: ProviderAdmin): Tool {
  const adapterList = () => admin.available.map((a, i) => `  ${i}. ${a.label}  (${a.module})`).join('\n');

  const executor = {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const act = input as ProviderInput;

      if (act.action === 'list') {
        yield { type: 'result', value: { providers: admin.list(), adapters: admin.available.map(a => a.label) } };
        return;
      }

      if (act.action === 'add') {
        const { name, adapter, endpoint, model } = act;
        if (!name || !adapter || !endpoint || !model) {
          yield { type: 'error', message: 'add requires: name, adapter, endpoint, model.' };
          return;
        }
        // Resolve adapter by module spec, exact/substring label, or numeric index.
        const idx = /^\d+$/.test(adapter) ? Number(adapter) : -1;
        const found =
          admin.available[idx] ??
          admin.available.find(a => a.module === adapter || a.label === adapter) ??
          admin.available.find(a => a.label.toLowerCase().includes(adapter.toLowerCase()));
        if (found === undefined) {
          yield { type: 'error', message: `Unknown adapter "${adapter}". Available:\n${adapterList()}` };
          return;
        }
        // Key out-of-band — never through the conversation.
        const apiKey = await ctx.prompt({ name: 'apiKey', label: `API key for provider "${name}" (not added to the conversation):`, type: 'password' });
        if (!apiKey.trim()) {
          yield { type: 'result', value: { message: `No key entered; "${name}" was not added.` } };
          return;
        }
        const draft: ProviderDraft = { name, module: found.module, endpoint, model, apiKey: apiKey.trim() };
        try {
          const added = await admin.add(draft);
          yield { type: 'result', value: { message: `Provider "${added}" added and ready (adapter: ${found.label}).` } };
        } catch (e) {
          yield { type: 'error', message: `Failed to add provider: ${String(e)}` };
        }
        return;
      }

      if (act.action === 'remove') {
        if (!act.name) { yield { type: 'error', message: 'remove requires a "name".' }; return; }
        const ok = await admin.remove(act.name);
        yield { type: 'result', value: { message: ok ? `Provider "${act.name}" removed.` : `No provider named "${act.name}".` } };
        return;
      }

      yield { type: 'error', message: `Unknown action "${String((act as { action: string }).action)}".` };
    },
  };

  return {
    name: 'provider',
    description:
      'Manage LLM provider profiles — the named model configurations matbot can talk to (each is an ' +
      'adapter + endpoint + model + key). List them, add one, or remove one. This is the browser ' +
      'build: profiles persist in browser storage and the key in the vault (no config file).\n\n' +
      'The API key is never passed here — `add` requests it out-of-band so it stays out of the ' +
      'conversation. `adapter` is one of the available adapter types (by label, module, or index; ' +
      'call `list` to see them).\n\n' +
      'Parameters depend on `action` (TypeScript):\n' +
      '```ts\n' +
      'type ProviderAction =\n' +
      "  | { action: 'list' }                                                          // profiles + available adapters\n" +
      "  | { action: 'add'; name: string; adapter: string; endpoint: string; model: string }  // key requested separately\n" +
      "  | { action: 'remove'; name: string };\n" +
      '```',
    inputSchema: {
      type:     'object',
      required: ['action'],
      properties: {
        action:   { type: 'string', enum: ['list', 'add', 'remove'] },
        name:     { type: 'string', description: 'Profile name (add/remove).' },
        adapter:  { type: 'string', description: 'Adapter type — label, module, or index from `list` (add).' },
        endpoint: { type: 'string', description: 'Endpoint URL (add).' },
        model:    { type: 'string', description: 'Model name (add).' },
      },
    },
    executor,
  };
}

import type { Tool, ToolExecutor, ToolResult, ToolResultOf, ToolContext } from '@matatbread/matbot-plugin-api';

/** An adapter type the provider tool / startup wizard can offer (baked from the build's providerModules). */
export interface AvailableProvider {
  label:         string;
  module:        string;   // importable specifier of the adapter plugin
  endpointHint?: string;
  modelHint?:    string;
  /** A provider that needs no endpoint/model/API key (e.g. a self-contained local adapter). The
   *  wizard hides those fields and submits with just a name; `modelHint` (if any) is used as model. */
  selfContained?: boolean;
}

/** Everything the user supplies for one provider — the browser equivalent of the CLI setup wizard. */
export interface ProviderDraft {
  name:     string;
  module:   string;
  endpoint: string;
  model:    string;
  apiKey:   string;
  /** Generation parameters (maxTokens, temperature, thinking, …) — the wizard never sets this; the
   *  `provider` tool's `add` action does, mirroring the node tool's `parameters` input. */
  parameters?: Record<string, unknown>;
}

declare module '@matatbread/matbot-plugin-api' {
  interface ToolResults {
    provider:
      | ToolResult<{ providers: ProviderRow[]; adapters: AvailableProvider[] }, { action: 'list'   }>
      | ToolResult<{ message: string }, { action: 'add'    }>
      | ToolResult<{ message: string }, { action: 'remove' }>;
  }
}

export interface ProviderRow {
  name:        string;
  module:      string;
  model:       string;
  endpoint?:   string;
  parameters?: Record<string, unknown>;
  hasKey:      boolean;
}

/**
 * The provider-admin surface a host (the web bootstrap) or a storage-backend plugin (google-drive)
 * owns. Mirrors what the node `provider` tool gets from matbot.yaml + the loaded-plugin registry — but
 * backed by a portable store/vault path instead of filesystem YAML editing, which is the only reason
 * the node tool wasn't reusable here. Swap the backing (localStorage vs a Drive manifest) and the same
 * `provider` tool syncs across machines.
 */
export interface ProviderAdmin {
  available: AvailableProvider[];
  list(): ProviderRow[];
  add(draft: ProviderDraft): Promise<string>;   // persist + load adapter + register
  remove(name: string): Promise<boolean>;
}

type ProviderInput =
  | { action: 'list' }
  | { action: 'add'; name: string; adapter: string; endpoint?: string; model?: string; parameters?: Record<string, unknown> }
  | { action: 'remove'; name: string };

/**
 * Browser `provider` tool. The portable analogue of the node provider tool: it manages the same
 * named-LLM-profile concept, but reads/writes a live providers map + a backing store + the vault rather
 * than a YAML file. The API key is collected out-of-band via `ctx.prompt` (never in the transcript),
 * exactly like `plugin store-key`. Persistence is entirely the injected {@link ProviderAdmin}'s concern.
 */
export function createBrowserProviderTool(admin: ProviderAdmin): Tool<ToolResultOf<'provider'>> {
  const adapterList = () => admin.available.map((a, i) => `  ${i}. ${a.label}  (${a.module})`).join('\n');

  const executor: ToolExecutor<ToolResultOf<'provider'>> = {
    async *execute(input: unknown, ctx: ToolContext) {
      const act = input as ProviderInput;

      if (act.action === 'list') {
        yield { type: 'result', value: { providers: admin.list(), adapters: admin.available } };
        return;
      }

      if (act.action === 'add') {
        const { name, adapter, endpoint, model, parameters } = act;
        if (!name || !adapter) {
          yield { type: 'error', message: 'add requires: name, adapter.' };
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

        // A self-contained adapter (e.g. a local demo LLM) needs no endpoint, model, or key — mirrors
        // the setup wizard, which hides those fields entirely for one. Asking for any of them, or
        // refusing to add without a key, would be wrong for this class of adapter.
        const resolvedModel = found.selfContained ? (model || found.modelHint || found.label) : model;
        if (!found.selfContained) {
          if (!endpoint)      { yield { type: 'error', message: 'add requires "endpoint" for this adapter.' }; return; }
          if (!resolvedModel) { yield { type: 'error', message: 'add requires "model" for this adapter.' };    return; }
        }

        // Key out-of-band — never through the conversation. A blank answer just means no credentials
        // (e.g. an unauthenticated local server); it does not abort the add — mirrors the node provider
        // tool, which treats an empty credential prompt the same way.
        let apiKey = '';
        if (!found.selfContained) {
          apiKey = await ctx.prompt({
            name: 'apiKey', type: 'password',
            label: `API key for provider "${name}" (leave blank if none required; not added to the conversation):`,
          });
        }

        const draft: ProviderDraft = {
          name, module: found.module, model: resolvedModel ?? '',
          endpoint: endpoint ?? '', apiKey: apiKey.trim(),
          ...(parameters !== undefined ? { parameters } : {}),
        };
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

        // Same guards as the node provider tool: never remove the profile powering this very turn,
        // and never remove the last remaining profile (there would be nothing left to run with).
        if (ctx.provider === act.name) {
          yield { type: 'result', value: { message: `Cannot remove "${act.name}" — it is the provider currently running this turn. Switch providers first.` } };
          return;
        }

        const rows = admin.list();
        if (!rows.some(r => r.name === act.name)) {
          yield { type: 'result', value: { message: `No provider named "${act.name}".` } };
          return;
        }
        if (rows.length <= 1) {
          yield { type: 'result', value: { message: `Cannot remove "${act.name}" — it is the only configured provider. Add a replacement profile first.` } };
          return;
        }

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
      'adapter + endpoint + model + key + optional generation parameters). List them, add one, or ' +
      'remove one. This is the browser build: profiles persist in browser storage and the key in the ' +
      'vault (no matbot.yaml; there is no separate `credentialEnvVar` concept since there are no ' +
      'process env vars to reference).\n\n' +
      'The API key is never passed here — `add` requests it out-of-band so it stays out of the ' +
      'conversation, and a blank answer just means "no credentials needed" (it does not abort the ' +
      'add). `adapter` is one of the available adapter types (by label, module, or index; call `list` ' +
      'to see them — each carries `endpointHint`/`modelHint` and whether it is `selfContained`). A ' +
      '`selfContained` adapter (e.g. a local demo LLM) needs no endpoint, model, or key at all — omit ' +
      'them and the tool will not prompt for a key either. `remove` refuses to delete the only ' +
      'configured profile or the one powering the current turn — add a replacement first or switch ' +
      'providers.\n\n' +
      'Parameters depend on `action` (TypeScript):\n' +
      '```ts\n' +
      'type ProviderAction =\n' +
      "  | { action: 'list' }                                                          // profiles + available adapters\n" +
      "  | { action: 'add'; name: string; adapter: string; endpoint?: string; model?: string;\n" +
      '      parameters?: object }   // endpoint/model required unless the adapter is selfContained; key requested separately\n' +
      "  | { action: 'remove'; name: string };\n" +
      '```\n\n' +
      'PARAMETERS  (pass as the `parameters` object on add)\n' +
      '  maxTokens   — integer, maximum output tokens\n' +
      '  temperature — float 0.0–1.0\n' +
      '  topP        — float, nucleus sampling probability\n' +
      '  thinking    — { type: "enabled", budgetTokens: <int> }  (Anthropic extended thinking;\n' +
      '                claude-3-7-sonnet and newer; set maxTokens > budgetTokens)',
    inputSchema: {
      type:     'object',
      required: ['action'],
      properties: {
        action:   { type: 'string', enum: ['list', 'add', 'remove'] },
        name:     { type: 'string', description: 'Profile name (add/remove).' },
        adapter:  { type: 'string', description: 'Adapter type — label, module, or index from `list` (add).' },
        endpoint: { type: 'string', description: 'Endpoint URL (add; omit for a selfContained adapter).' },
        model:    { type: 'string', description: 'Model name (add; omit for a selfContained adapter — its modelHint/label is used).' },
        parameters: {
          type:                 'object',
          additionalProperties: true,
          description:          'Generation parameters: maxTokens, temperature, topP, thinking, etc. (add only).',
        },
      },
    },
    executor,
  };
}

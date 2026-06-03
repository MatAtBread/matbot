import type { Tool, ToolEvent, ToolContext, ProviderConfig } from '@matatbread/matbot-plugin-api';
import { getRegisteredPlugins }                             from '@matatbread/matbot-core';
import { readFile, writeFile }                              from 'node:fs/promises';
import path                                                 from 'node:path';

// Credential env-var naming convention for secrets created by this tool.
function credEnvVarName(profileName: string): string {
  return `MATBOT_API_KEY_${profileName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

// ── Input types ───────────────────────────────────────────────────────────────

type ProviderInput =
  | { action: 'list' }
  | {
      action:            'add';
      name:              string;
      module:            string;
      model:             string;
      endpoint?:         string;
      credentialKey?:    string;
      credentialEnvVar?: string;
      parameters?:       Record<string, unknown>;
    }
  | { action: 'remove'; name: string };

// ── YAML helpers (read/write only — runtime state comes from liveProviders) ───

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendYamlFields(obj: Record<string, unknown>, indent: string, lines: string[]): void {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      lines.push(`${indent}${k}:`);
      appendYamlFields(v as Record<string, unknown>, `${indent}  `, lines);
    } else if (Array.isArray(v)) {
      lines.push(`${indent}${k}:`);
      for (const item of v) lines.push(`${indent}  - ${String(item)}`);
    } else {
      lines.push(`${indent}${k}: ${String(v)}`);
    }
  }
}

function buildProviderBlock(opts: {
  name:           string;
  module:         string;
  model:          string;
  endpoint?:      string;
  envVarName?:    string;
  credentialKey?: string;
  parameters?:    Record<string, unknown>;
}): string {
  const lines = [
    `  ${opts.name}:`,
    `    module: ${opts.module}`,
    ...(opts.endpoint !== undefined ? [`    endpoint: ${opts.endpoint}`] : []),
    `    model: ${opts.model}`,
  ];
  if (opts.envVarName) {
    lines.push(`    credentials:`);
    lines.push(`      ${opts.credentialKey ?? 'apiKey'}: \${env:${opts.envVarName}}`);
  }
  if (opts.parameters && Object.keys(opts.parameters).length > 0) {
    lines.push(`    parameters:`);
    appendYamlFields(opts.parameters, '      ', lines);
  }
  return lines.join('\n') + '\n';
}

async function addProviderToConfig(configPath: string, block: string): Promise<void> {
  const text = await readFile(configPath, 'utf8');
  const m    = /^providers:[ \t]*\n/m.exec(text);
  let updated: string;

  if (m) {
    // Walk to the end of the providers block (first non-indented, non-blank line after header).
    let endPos = m.index + m[0].length;
    while (endPos < text.length) {
      const nl   = text.indexOf('\n', endPos);
      const line = text.slice(endPos, nl === -1 ? text.length : nl);
      if (line.length > 0 && line[0] !== ' ' && line[0] !== '\t') break;
      endPos = nl === -1 ? text.length : nl + 1;
    }
    updated = text.slice(0, endPos) + block + text.slice(endPos);
  } else {
    const pi = text.search(/^plugins:[ \t]*$/m);
    updated  = pi !== -1
      ? `${text.slice(0, pi)}providers:\n${block}\n${text.slice(pi)}`
      : `providers:\n${block}\n${text}`;
  }

  await writeFile(configPath, updated, 'utf8');
}

async function removeProviderFromConfig(configPath: string, name: string): Promise<boolean> {
  const text = await readFile(configPath, 'utf8');

  // Match '  name:\n' plus every following line that does NOT start with '  <non-space>'
  // (deeply-indented children and blank lines are included; sibling keys are not).
  const pattern = new RegExp(
    `^  ${escapeRegex(name)}:\\n(?:(?!  \\S)[^\\n]*\\n)*`,
    'm',
  );

  const updated = text.replace(pattern, '');
  if (updated === text) return false;
  await writeFile(configPath, updated, 'utf8');
  return true;
}

// ── Endpoint reachability check ───────────────────────────────────────────────

async function checkEndpoint(url: string): Promise<string | null> {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5_000) });
    return null;
  } catch (ex: unknown) {
    return ex instanceof Error ? ex.message : String(ex);
  }
}

// ── Current provider detection ────────────────────────────────────────────────

function currentProviderName(ctx: ToolContext): string | undefined {
  // The runner stamps providerName on every assistant message it produces.
  for (let i = ctx.session.messages.length - 1; i >= 0; i--) {
    const msg = ctx.session.messages[i];
    if (msg?.role === 'assistant' && msg.providerName) return msg.providerName;
  }
  return undefined;
}

// ── Executor ──────────────────────────────────────────────────────────────────

function makeExecutor(liveProviders: Map<string, ProviderConfig>, pluginNameToOrigPath?: ReadonlyMap<string, string>) {
  return {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { action } = input as ProviderInput;

      const configPath = ctx.configPath;
      if (!configPath) {
        yield { type: 'error', message: 'No config path in tool context — cannot manage providers.' };
        return;
      }

      // ── list ───────────────────────────────────────────────────────────────
      if (action === 'list') {
        yield {
          type:  'result',
          value: {
            providers: [...liveProviders.values()].map(cfg => ({
              name:           cfg.name,
              module:         pluginNameToOrigPath?.get(cfg.module) ?? cfg.module,
              model:          cfg.model,
              hasCredentials: (cfg.credentials !== undefined && Object.keys(cfg.credentials).length > 0),
              ...(cfg.endpoint   !== undefined ? { endpoint:   cfg.endpoint   } : {}),
              ...(cfg.parameters !== undefined ? { parameters: cfg.parameters } : {}),
            })),
          },
        };
        return;
      }

      // ── add ────────────────────────────────────────────────────────────────
      if (action === 'add') {
        const { name, module: mod, model, endpoint, credentialKey, credentialEnvVar, parameters } =
          input as Extract<ProviderInput, { action: 'add' }>;

        if (liveProviders.has(name)) {
          yield { type: 'result', value: { message: `Profile "${name}" already exists. Use a different name or remove it first.` } };
          return;
        }

        // Obtain the credential value out-of-band (keeps it out of session history).
        let envVarName: string | undefined;

        if (credentialEnvVar) {
          envVarName = credentialEnvVar;
        } else {
          const credKey = credentialKey ?? 'apiKey';
          const answer  = await ctx.prompt(`${credKey} for provider "${name}" (leave blank if none required):`, '');
          if (answer.trim()) {
            const varName = credEnvVarName(name);
            await ctx.vault.createSecret(varName, answer.trim());
            yield { type: 'stdout', chunk: `API key stored in vault as ${varName}.\n` };
            envVarName = varName;
          }
        }

        if (endpoint) {
          yield { type: 'stdout', chunk: `Testing ${endpoint} …\n` };
          const err = await checkEndpoint(endpoint);
          if (err) {
            const cont = await ctx.prompt(`Endpoint check failed: ${err}. Add anyway? [y/N]`, 'N');
            if (!/^y(es)?$/i.test(cont.trim())) {
              yield { type: 'result', value: { message: 'Cancelled.' } };
              return;
            }
          } else {
            yield { type: 'stdout', chunk: `Endpoint reachable.\n` };
          }
        }

        const confirm = await ctx.prompt(
          `Add provider profile "${name}" (${model} via ${mod})? [y/N]`,
          'N',
        );
        if (!/^y(es)?$/i.test(confirm.trim())) {
          yield { type: 'result', value: { message: 'Cancelled.' } };
          return;
        }

        const block = buildProviderBlock({
          name,
          module: mod,
          model,
          ...(endpoint      !== undefined ? { endpoint      } : {}),
          ...(envVarName    !== undefined ? { envVarName    } : {}),
          ...(credentialKey !== undefined ? { credentialKey } : {}),
          ...(parameters    !== undefined ? { parameters    } : {}),
        });

        await addProviderToConfig(configPath, block);

        // Hot-update the live map — new profile is usable immediately without restart.
        liveProviders.set(name, {
          name,
          module: mod,
          model,
          ...(endpoint   !== undefined ? { endpoint } : {}),
          ...(envVarName !== undefined
            ? { credentials: { [credentialKey ?? 'apiKey']: `\${env:${envVarName}}` } }
            : {}),
          ...(parameters !== undefined ? { parameters } : {}),
        });

        yield {
          type:  'result',
          value: { message: `Profile "${name}" added and active.` },
        };
        return;
      }

      // ── remove ─────────────────────────────────────────────────────────────
      if (action === 'remove') {
        const { name } = input as Extract<ProviderInput, { action: 'remove' }>;

        const currentProvider = currentProviderName(ctx);
        if (currentProvider === name) {
          yield {
            type:  'result',
            value: { message: `Cannot remove "${name}" — it is the provider currently running this turn. Switch providers first.` },
          };
          return;
        }

        if (!liveProviders.has(name)) {
          yield { type: 'result', value: { message: `No profile named "${name}" found.` } };
          return;
        }
        if (liveProviders.size <= 1) {
          yield {
            type:  'result',
            value: { message: `Cannot remove "${name}" — it is the only configured provider. Add a replacement profile first.` },
          };
          return;
        }

        const confirm = await ctx.prompt(`Remove provider profile "${name}"? [y/N]`, 'N');
        if (!/^y(es)?$/i.test(confirm.trim())) {
          yield { type: 'result', value: { message: 'Cancelled.' } };
          return;
        }

        const removed = await removeProviderFromConfig(configPath, name);
        if (!removed) {
          yield { type: 'error', message: `Failed to locate "${name}" in ${path.basename(configPath)}.` };
          return;
        }

        liveProviders.delete(name);
        yield { type: 'result', value: { message: `Profile "${name}" removed.` } };
      }
    },
  };
}

// ── Tool factory ──────────────────────────────────────────────────────────────

export function createProviderTool(
  providers:          ReadonlyMap<string, ProviderConfig>,
  pluginNameToOrigPath?: ReadonlyMap<string, string>,
): Tool {
  // Cast to mutable so add/remove can update the live map without a restart.
  const liveProviders = providers as Map<string, ProviderConfig>;

  // Derive adapter list from provider plugins registered at call time.
  // Show the original YAML-valid module path (e.g. ./packages/plugins/providers/anthropic)
  // rather than the internal plugin name that canonicalisation produces.
  const adapterPlugins = getRegisteredPlugins().filter(p => p.provider !== undefined);
  const adapterSection = adapterPlugins.length > 0
    ? adapterPlugins.map(p => {
        const modulePath = pluginNameToOrigPath?.get(p.name) ?? p.name;
        const desc = p.manifest?.description ? ` — ${p.manifest.description}` : '';
        return `  ${modulePath}${desc}`;
      }).join('\n')
    : '  (no provider adapter plugins loaded — check matbot.yaml plugins list)';

  const profileList = providers.size > 0
    ? [...providers.keys()].map(n => `"${n}"`).join(', ')
    : '(none — use add to create the first one)';

  return {
    name:     'provider',
    requires: ['filesystem'],
    description: `Manage LLM provider profiles in matbot.yaml. Each profile is a named
configuration combining an adapter module, model identifier, endpoint URL,
API credentials, and optional generation parameters. Profiles are what users
select when starting a conversation.

ACTIONS
  list   — Show all configured profiles.
  add    — Create a new named profile. The API key (if required) is prompted
           out-of-band for security and never stored in session history.
           Required fields: name, module, model.
           Optional: endpoint, credentialKey (default "apiKey"),
           credentialEnvVar (reuse an existing env var instead of prompting),
           parameters (maxTokens, temperature, topP, thinking, etc.).
  remove — Delete a profile by name. Refuses if it is the only profile or
           the one powering the current turn.

AVAILABLE ADAPTER MODULES  (use one of these as the module value when adding)
${adapterSection}

CURRENTLY CONFIGURED PROFILES
  ${profileList}

PARAMETERS  (pass as the parameters object)
  maxTokens   — integer, maximum output tokens
  temperature — float 0.0–1.0
  topP        — float, nucleus sampling probability
  thinking    — { type: "enabled", budgetTokens: <int> }  (Anthropic extended thinking;
                claude-3-7-sonnet and newer; set maxTokens > budgetTokens)

GUIDANCE
When a user asks to add a new LLM or provider, ask for:
  1. Which adapter module to use (from the list above)
  2. Model name — e.g. claude-sonnet-4-6, gpt-4o, deepseek-chat, llama3.2
  3. Endpoint URL — required for OpenAI-compat adapters; may be optional for others
  4. API key source — existing env var (credentialEnvVar) or enter now (blank = prompted)
  5. Profile name — descriptive, e.g. "claude-sonnet-4-6" or "ollama-llama3"`,

    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action: {
          type:        'string',
          enum:        ['list', 'add', 'remove'],
          description: 'list: show all profiles. add: create a new profile. remove: delete a profile.',
        },
        name: {
          type:        'string',
          description: 'Unique profile name used as the provider key (add/remove).',
        },
        module: {
          type:        'string',
          description: 'Adapter module specifier (add only).',
        },
        model: {
          type:        'string',
          description: 'Model identifier passed to the adapter, e.g. "claude-sonnet-4-6" (add only).',
        },
        endpoint: {
          type:        'string',
          description: 'Base URL of the provider API. Required for openai-compat; omit to use the adapter default (add only).',
        },
        credentialKey: {
          type:        'string',
          description: 'Credential field name, default "apiKey" (add only).',
        },
        credentialEnvVar: {
          type:        'string',
          description: 'Existing env var name to use as the credential value. If omitted the tool prompts the user (add only).',
        },
        parameters: {
          type:                 'object',
          additionalProperties: true,
          description:          'Generation parameters: maxTokens, temperature, topP, thinking, etc. (add only).',
        },
      },
    },

    executor: makeExecutor(liveProviders, pluginNameToOrigPath),
  };
}

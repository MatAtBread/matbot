import type { Tool, ToolExecutor, ToolResultOf, ToolContext, ProviderRegistry, MatbotPlugin,
              ProviderToolContract, ProviderPatch, ProviderConfig } from '@matatbread/matbot-plugin-api';

// Shared with the browser implementation of this same tool name — see plugin-api/src/types/builtin-tools.ts.
declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    provider: ProviderToolContract;
  }
}
import { applyProviderPatch, patchedFields }                 from '@matatbread/matbot-plugin-api';
import { getRegisteredPlugins, getSpecifierForPlugin }       from '@matatbread/matbot-core';
import { readFile, writeFile }                               from 'node:fs/promises';
import { fileURLToPath }                                     from 'node:url';
import path                                                  from 'node:path';

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
      maxRounds?:        number;
    }
  | ({ action: 'update'; name: string } & ProviderPatch)
  | { action: 'remove'; name: string };

// ── YAML helpers (read/write only — runtime state comes from liveProviders) ───

// ── Module resolution (write-time) ──────────────────────────────────────────────
//
// The LLM interchanges the canonical package name, the YAML path, and the resolved
// file URL for the same adapter "according to the weather". All resolution and
// validation therefore happens here, before anything is written: we resolve whatever
// form arrives to (a) the canonical plugin name for the live map, and (b) a
// specifier the loader (via instantiateProvider) can resolve at use time.
// We write the canonical package name when it resolves (location-independent), and fall
// back to a path only for a local, unpublished adapter whose name resolves nowhere — a
// bare package name for such a plugin is not loadable and would crash startup.

const pathLike = (s: string): boolean => s.startsWith('.') || s.startsWith('/') || path.isAbsolute(s);

// The path part of a resolved specifier, or undefined if it isn't a file: URL.
function resolvedEntryPath(name: string): string | undefined {
  const resolved = getSpecifierForPlugin(name);
  if (resolved?.startsWith('file:')) return fileURLToPath((resolved.split('?')[0]) ?? resolved);
  return undefined;
}

// Find the already-loaded provider adapter that `mod` refers to, in any of the forms
// the LLM might use: canonical name, recorded YAML specifier, resolved file URL, or a
// differently-spelled path (absolute vs relative, trailing slash).
function findLoadedAdapter(
  mod:                 string,
  projectDir:          string,
  pluginNameToOrigPath?: ReadonlyMap<string, string>,
): MatbotPlugin | undefined {
  const adapters = getRegisteredPlugins().filter(p => p.provider !== undefined);

  for (const p of adapters) {
    if (mod === p.name) return p;
    if (pluginNameToOrigPath?.get(p.name) === mod) return p;
    if (getSpecifierForPlugin(p.name) === mod) return p;
  }

  if (pathLike(mod)) {
    const target = path.resolve(projectDir, mod);
    for (const p of adapters) {
      const entry = resolvedEntryPath(p.name);
      if (entry !== undefined && (entry === target || entry.startsWith(target + path.sep))) return p;
    }
  }
  return undefined;
}

// The YAML-valid specifier to write for an already-loaded adapter. Prefer the canonical package
// name — the location-independent form, resolvable whether matbot is installed or run from a
// checkout (the host's `nameResolves` predicate confirms this, since only the host knows the CLI's
// own install can resolve a bundled adapter's name). Otherwise fall back to the human-authored yaml
// string, then a relative path derived from the resolved entry — the only forms that work for a
// local, unpublished adapter whose name resolves nowhere.
function yamlSpecifierFor(
  name:                 string,
  projectDir:           string,
  pluginNameToOrigPath?: ReadonlyMap<string, string>,
  nameResolves?:         (pluginName: string) => boolean,
): string | undefined {
  if (nameResolves?.(name)) return name;
  const orig = pluginNameToOrigPath?.get(name);
  if (orig !== undefined) return orig;
  const entry = resolvedEntryPath(name);
  if (entry !== undefined) return './' + path.relative(projectDir, entry).replace(/\\/g, '/');
  // No file: URL — the adapter resolved as a real npm package, so its name is valid.
  return getSpecifierForPlugin(name);
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

// `credentials` is written verbatim as the map it already is, rather than reconstructed from an env-var
// name and a key. `update` regenerates a whole block from the stored profile, and the credential is the
// one field it is not allowed to touch — a map in, the same map out, with nothing in between that could
// mangle a `${NAME}` reference or (a config may hold one) a literal key.
function buildProviderBlock(opts: {
  name:         string;
  module:       string;
  model:        string;
  endpoint?:    string;
  credentials?: Record<string, string>;
  parameters?:  Record<string, unknown>;
  maxRounds?:   number;
}): string {
  const lines = [
    `  ${opts.name}:`,
    `    module: ${opts.module}`,
    ...(opts.endpoint !== undefined ? [`    endpoint: ${opts.endpoint}`] : []),
    `    model: ${opts.model}`,
  ];
  if (opts.credentials !== undefined && Object.keys(opts.credentials).length > 0) {
    lines.push(`    credentials:`);
    for (const [k, v] of Object.entries(opts.credentials)) lines.push(`      ${k}: ${v}`);
  }
  if (opts.maxRounds !== undefined) {
    lines.push(`    maxRounds: ${opts.maxRounds}`);
  }
  if (opts.parameters && Object.keys(opts.parameters).length > 0) {
    lines.push(`    parameters:`);
    appendYamlFields(opts.parameters, '      ', lines);
  }
  return lines.join('\n') + '\n';
}

/**
 * Why this config cannot be written to matbot.yaml and read back as itself — `undefined` when it can.
 * The `unstorableKey` idiom: return the rule, for whoever must now pick another value.
 *
 * The config parser strips `#` to end-of-line before it tokenises, quotes included, so a value carrying
 * one is not representable at all and no amount of escaping here would make it so. That matters because
 * `update` regenerates a block from values that already round-tripped once: writing the truncation would
 * change a value the caller never asked to change, and the next read would report the mangled version as
 * the truth. A refusal naming the field is the only honest answer.
 */
function unrepresentableYamlValue(cfg: ProviderConfig): string | undefined {
  const walk = (v: unknown, path: string): string | undefined => {
    if (typeof v === 'string' && v.includes('#')) {
      return `${path} contains "#", which matbot.yaml cannot represent — the config parser treats it as the start of a comment, in quotes or out`;
    }
    if (Array.isArray(v)) {
      for (const [i, item] of v.entries()) { const r = walk(item, `${path}[${i}]`); if (r !== undefined) return r; }
      return undefined;
    }
    if (typeof v === 'object' && v !== null) {
      for (const [k, item] of Object.entries(v)) { const r = walk(item, `${path}.${k}`); if (r !== undefined) return r; }
      return undefined;
    }
    return undefined;
  };
  const { name: _name, ...rest } = cfg;
  return walk(rest, 'provider');
}

/**
 * Replace a profile's block in matbot.yaml with one generated from `cfg`. `false` ⇒ the profile is not in
 * the file (a runtime-contributed profile — one a storage backend replayed from its own medium), and
 * nothing was written: there is no block to replace, and appending one would persist into matbot.yaml a
 * profile whose source of truth is somewhere else.
 *
 * Regenerating rather than editing in place means any comment or formatting inside that one block is
 * lost, and the block moves to the end of `providers:`. That is the accepted cost of not carrying a
 * round-tripping YAML editor; every other block in the file is untouched.
 */
export async function writeProviderBlock(configPath: string, cfg: ProviderConfig): Promise<boolean> {
  if (!await removeProviderFromConfig(configPath, cfg.name)) return false;
  await addProviderToConfig(configPath, buildProviderBlock({
    name:   cfg.name,
    module: cfg.module,
    model:  cfg.model,
    ...(cfg.endpoint    !== undefined ? { endpoint:    cfg.endpoint    } : {}),
    ...(cfg.credentials !== undefined ? { credentials: cfg.credentials } : {}),
    ...(cfg.parameters  !== undefined ? { parameters:  cfg.parameters  } : {}),
    ...(cfg.maxRounds   !== undefined ? { maxRounds:   cfg.maxRounds   } : {}),
  }));
  return true;
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

/**
 * Delete `  name:` and the block indented beneath it. `false` ⇒ no such key, and nothing written.
 *
 * A line walk rather than the regex it replaces. That regex consumed every following line which did not
 * begin `  <non-space>` — a sibling key stopped it, but a TOP-LEVEL one did not, so removing the last
 * profile in `providers:` also deleted the header of whatever section came next and promoted that
 * section's children into `providers:`. Silent: the file still parsed, `default_settings:` had simply
 * ceased to exist and a settings namespace had become a provider profile. Indentation is what actually
 * delimits the block, so that is what this reads.
 *
 * Trailing blank lines are left in place: they separate the block from what follows, and the following
 * section is not this function's to reformat.
 */
async function removeProviderFromConfig(configPath: string, name: string): Promise<boolean> {
  const text  = await readFile(configPath, 'utf8');
  const lines = text.split('\n');

  const start = lines.findIndex(l => l.trimEnd() === `  ${name}:`);
  if (start === -1) return false;

  let last = start;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    if (line.length - line.trimStart().length <= 2) break;   // a sibling (2) or a top-level key (0)
    last = i;
  }

  lines.splice(start, last - start + 1);
  await writeFile(configPath, lines.join('\n'), 'utf8');
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

function makeExecutor(
  providers:            ProviderRegistry,
  pluginNameToOrigPath?: ReadonlyMap<string, string>,
  nameResolves?:         (pluginName: string) => boolean,
): ToolExecutor<ToolResultOf<'provider'>> {
  return {
    async *execute(input: unknown, ctx: ToolContext) {
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
            providers: [...providers.values()].map(cfg => ({
              name:           cfg.name,
              module:         cfg.module,
              model:          cfg.model,
              hasCredentials: (cfg.credentials !== undefined && Object.keys(cfg.credentials).length > 0),
              ...(cfg.endpoint   !== undefined ? { endpoint:   cfg.endpoint   } : {}),
              ...(cfg.parameters !== undefined ? { parameters: cfg.parameters } : {}),
              ...(cfg.maxRounds  !== undefined ? { maxRounds:  cfg.maxRounds  } : {}),
            })),
          },
        };
        return;
      }

      // ── add ────────────────────────────────────────────────────────────────
      if (action === 'add') {
        const { name, module: mod, model, endpoint, credentialKey, credentialEnvVar, parameters, maxRounds } =
          input as Extract<ProviderInput, { action: 'add' }>;

        if (providers.has(name)) {
          yield { type: 'result', value: { message: `Profile "${name}" already exists. Use a different name or remove it first.` } };
          return;
        }

        const projectDir = path.dirname(configPath);

        // Resolve and validate the module up front, before prompting for anything. yamlModule is the
        // loader-resolvable specifier written to matbot.yaml AND registered live — the stored `module` is
        // always the source string, and instantiateProvider resolves it to the adapter factory at use time.
        // We never write the raw `mod` the LLM supplied unless it resolves as-is.
        let yamlModule: string;

        const loaded = findLoadedAdapter(mod, projectDir, pluginNameToOrigPath);
        if (loaded !== undefined) {
          const spec = yamlSpecifierFor(loaded.name, projectDir, pluginNameToOrigPath, nameResolves);
          if (spec === undefined) {
            yield { type: 'error', message: `Adapter "${loaded.name}" is loaded but its module path could not be determined.` };
            return;
          }
          yamlModule = spec;
        } else {
          // Not yet loaded — try to load it (a new npm package or an unused path).
          try {
            const justLoaded = await ctx.loadPlugin(mod);
            if (justLoaded.provider === undefined) {
              yield { type: 'error', message: `Module "${mod}" loaded but is not a provider adapter.` };
              return;
            }
            // Prefer the canonical package name (location-independent) when it resolves; otherwise the
            // just-supplied `mod` resolved and loaded, so it is YAML-valid as written.
            yamlModule = nameResolves?.(justLoaded.name) ? justLoaded.name : mod;
            if (pluginNameToOrigPath !== undefined) {
              (pluginNameToOrigPath as Map<string, string>).set(justLoaded.name, mod);
            }
          } catch {
            const available = getRegisteredPlugins()
              .filter(p => p.provider !== undefined)
              .map(p => yamlSpecifierFor(p.name, projectDir, pluginNameToOrigPath, nameResolves) ?? p.name);
            yield {
              type:    'error',
              message: `Could not resolve provider module "${mod}". Use one of the available adapter modules: ${available.join(', ')}.`,
            };
            return;
          }
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
            // createSecret may return a different name (an existing key the value already lives
            // under, or a key name the user typed by mistake); reference what it returns.
            envVarName = await ctx.vault.createSecret(varName, answer.trim());
            yield { type: 'stdout', chunk: `API key stored in vault as ${envVarName}.\n` };
          }
        }

        if (endpoint) {
          yield { type: 'stdout', chunk: `Testing ${endpoint} …\n` };
          const err = await checkEndpoint(endpoint);
          if (err) {
            if (!await ctx.gate({ gate: 'add-unverified', subject: name, fallback: false,
                                  label: `Endpoint check failed: ${err}\n\nAdd **"${name}"** anyway?` })) {
              yield { type: 'result', value: { message: 'Cancelled.' } };
              return;
            }
          } else {
            yield { type: 'stdout', chunk: `Endpoint reachable.\n` };
          }
        }

        if (!await ctx.gate({ gate: 'add', subject: name, fallback: false,
                              label: `Add provider profile **"${name}"** (${model} via ${yamlModule})?` })) {
          yield { type: 'result', value: { message: 'Cancelled.' } };
          return;
        }

        const credentials = envVarName !== undefined
          ? { [credentialKey ?? 'apiKey']: `\${${envVarName}}` }
          : undefined;

        const block = buildProviderBlock({
          name,
          module: yamlModule,
          model,
          ...(endpoint    !== undefined ? { endpoint    } : {}),
          ...(credentials !== undefined ? { credentials } : {}),
          ...(parameters  !== undefined ? { parameters  } : {}),
          ...(maxRounds   !== undefined ? { maxRounds   } : {}),
        });

        await addProviderToConfig(configPath, block);

        // Hot-update the live registry — new profile is usable immediately without restart. The stored
        // module matches what was written to matbot.yaml; instantiateProvider resolves it at use time.
        providers.register({
          name,
          module: yamlModule,
          model,
          ...(endpoint    !== undefined ? { endpoint    } : {}),
          ...(credentials !== undefined ? { credentials } : {}),
          ...(parameters  !== undefined ? { parameters  } : {}),
          ...(maxRounds   !== undefined ? { maxRounds   } : {}),
        });

        yield {
          type:  'result',
          value: { message: `Profile "${name}" added and active.` },
        };
        return;
      }

      // ── update ─────────────────────────────────────────────────────────────
      if (action === 'update') {
        const { name, ...patch } = input as Extract<ProviderInput, { action: 'update' }>;

        const cur = providers.get(name);
        if (cur === undefined) {
          // An error, not a result: naming a profile that does not exist is a failed update, and a
          // programmatic caller (a trigger, `invokeTool`, `POST /tools/provider`) has no way to tell a
          // prose "no profile named…" apart from a successful one.
          yield {
            type:    'error',
            message: `No profile named "${name}" found. Configured profiles: ${[...providers.keys()].map(n => `"${n}"`).join(', ')}.`,
          };
          return;
        }

        const supplied = patchedFields(patch);
        if (supplied.length === 0) {
          yield {
            type:  'result',
            value: { message: `Nothing to update. Supply at least one of model, endpoint, parameters, maxRounds — null to clear a field. To change the API key use "plugin store-key"; to change the adapter module, remove the profile and add it again.` },
          };
          return;
        }

        const next = applyProviderPatch(cur, patch);

        const unwritable = unrepresentableYamlValue(next);
        if (unwritable !== undefined) {
          yield { type: 'error', message: `Cannot update "${name}": ${unwritable}.` };
          return;
        }

        // The same reachability courtesy `add` extends, for the same reason: a typo'd endpoint is
        // otherwise found by the next turn failing.
        if (patch.endpoint !== undefined && patch.endpoint !== null) {
          yield { type: 'stdout', chunk: `Testing ${patch.endpoint} …\n` };
          const err = await checkEndpoint(patch.endpoint);
          if (err) {
            if (!await ctx.gate({ gate: 'update-unverified', subject: name, fallback: false,
                                  label: `Endpoint check failed: ${err}\n\nUpdate **"${name}"** anyway?` })) {
              yield { type: 'result', value: { message: 'Cancelled.' } };
              return;
            }
          } else {
            yield { type: 'stdout', chunk: `Endpoint reachable.\n` };
          }
        }

        const show = (v: unknown): string => v === undefined ? '(unset)' : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
        const diff = supplied.map(f => `  ${f}: ${show(cur[f])} → ${show(next[f])}`).join('\n');

        // Confirmed like add/remove, and for a reason particular to update: the block is regenerated,
        // so any comment inside it does not survive. The caller sees that before it happens.
        if (!await ctx.gate({ gate: 'update', subject: name, fallback: false,
          label: `Update provider profile **"${name}"**?\n${diff}\n\n_(the profile's block in matbot.yaml is rewritten; comments inside it are lost)_` })) {
          yield { type: 'result', value: { message: 'Cancelled.' } };
          return;
        }

        if (!await writeProviderBlock(configPath, next)) {
          yield {
            type:    'error',
            message: `Profile "${name}" is not defined in ${path.basename(configPath)} — it was contributed at runtime (e.g. replayed by a storage backend), so its definition lives elsewhere and cannot be edited here.`,
          };
          return;
        }

        providers.register(next);

        // Deliberately not refused when it is the profile powering this turn: the resolution that
        // produced the running adapter already happened, so nothing about the current turn changes and
        // there is nothing to be inconsistent with. Say when it takes effect rather than saying no.
        const isCurrent = currentProviderName(ctx) === name;
        yield {
          type:  'result',
          value: {
            message: `Profile "${name}" updated: ${supplied.join(', ')}.`
              + (isCurrent ? ' It is the profile running this turn, so the change takes effect on the next one.' : ''),
          },
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

        if (!providers.has(name)) {
          yield { type: 'result', value: { message: `No profile named "${name}" found.` } };
          return;
        }
        if (providers.size <= 1) {
          yield {
            type:  'result',
            value: { message: `Cannot remove "${name}" — it is the only configured provider. Add a replacement profile first.` },
          };
          return;
        }

        if (!await ctx.gate({ gate: 'remove', subject: name, fallback: false,
                              label: `Remove provider profile **"${name}"**?` })) {
          yield { type: 'result', value: { message: 'Cancelled.' } };
          return;
        }

        const removed = await removeProviderFromConfig(configPath, name);
        if (!removed) {
          yield { type: 'error', message: `Failed to locate "${name}" in ${path.basename(configPath)}.` };
          return;
        }

        providers.remove(name);
        yield { type: 'result', value: { message: `Profile "${name}" removed.` } };
      }
    },
  };
}

// ── Tool factory ──────────────────────────────────────────────────────────────

export function createProviderTool(
  providers:          ProviderRegistry,
  pluginNameToOrigPath?: ReadonlyMap<string, string>,
  nameResolves?:         (pluginName: string) => boolean,
): Tool<ToolResultOf<'provider'>> {
  // Derive the adapter list from provider plugins registered at call time. Advertise each by the
  // exact specifier the tool would write for it (yamlSpecifierFor) — the canonical package name when
  // it resolves, else the yaml path — so the module the LLM copies from this list is the one the
  // loader can resolve.
  const adapterPlugins = getRegisteredPlugins().filter(p => p.provider !== undefined);
  const adapterSection = adapterPlugins.length > 0
    ? adapterPlugins.map(p => {
        const modulePath = (nameResolves?.(p.name) ? p.name : pluginNameToOrigPath?.get(p.name)) ?? p.name;
        const desc = p.manifest?.description ? ` — ${p.manifest.description}` : '';
        return `  ${modulePath}${desc}`;
      }).join('\n')
    : '  (no provider adapter plugins loaded — check matbot.yaml plugins list)';

  const profileList = providers.size > 0
    ? [...providers.keys()].map(n => `"${n}"`).join(', ')
    : '(none — use add to create the first one)';

  return {
    name:     'provider',
    description: `Manage LLM provider profiles in matbot.yaml. Each profile is a named
configuration combining an adapter module, model identifier, endpoint URL,
API credentials, optional generation parameters, and an optional per-turn
agentic round ceiling. Profiles are what users select when starting a
conversation.

ACTIONS
  list   — Show all configured profiles.
  add    — Create a new named profile. The API key (if required) is prompted
           out-of-band for security and never stored in session history.
  update — Change model, endpoint, parameters or maxRounds on an existing
           profile, leaving its credentials untouched. See UPDATE below.
  remove — Delete a profile by name. Refuses if it is the only profile or
           the one powering the current turn.

UPDATE  (for a renamed model, a moved endpoint, a parameter change)
  Supply the profile name plus only the fields to change. An omitted field is
  left alone; an explicit null CLEARS it (endpoint, parameters and maxRounds
  only — a profile must keep a model).

  parameters is replaced WHOLESALE, not merged key by key: to change one
  parameter, "list" first, then send the whole object back with your edit
  applied. Anything you omit from it is gone.

  Two things update CANNOT change:
    credentials — use "plugin store-key" with the key name from matbot.yaml,
                  which writes the new value to the vault under the name the
                  profile already references. Nothing about the profile needs
                  to change to rotate a key.
    module      — changing the adapter is remove + add.

  Takes effect on the next turn. The profile's block in matbot.yaml is
  regenerated, so comments inside that one block are not preserved.

AVAILABLE ADAPTER MODULES  (use one of these as the module value when adding)
${adapterSection}

CURRENTLY CONFIGURED PROFILES
  ${profileList}

MAX ROUNDS  (maxRounds, a sibling of model/endpoint — NOT a parameter)
  Ceiling on the agentic rounds one turn may take on this profile, a round
  being one model call plus the tool batch it asked for. Reaching it ends the
  turn instead of starting another round. Omit for no ceiling. It is denominated
  per profile because that is how spend varies: a cheap local model can afford to
  grind where a frontier model cannot.

PARAMETERS  (pass as the parameters object). NB: This is an example - the parameters are passed to the LLM endpoint with no modification and are model/provider specific
  maxTokens   — integer, maximum output tokens
  temperature — float 0.0–1.0
  topP        — float, nucleus sampling probability
  thinking    — { type: "enabled", budgetTokens: <int> }  (Anthropic extended thinking;
                claude-3-7-sonnet and newer; set maxTokens > budgetTokens)
  promptCache — boolean, opt-in Anthropic-style cache_control breakpoints (openai-compat
                adapter only; OpenRouter Anthropic/Gemini/Qwen); default off

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
          enum:        ['list', 'add', 'update', 'remove'],
          description: 'list: show all profiles. add: create a new profile. update: change fields on an existing profile. remove: delete a profile.',
        },
        name: {
          type:        'string',
          description: 'Unique profile name used as the provider key (add/update/remove).',
        },
        module: {
          type:        'string',
          description: 'Adapter module specifier (add only — update cannot change it; remove and re-add instead).',
        },
        model: {
          type:        'string',
          description: 'Model identifier passed to the adapter, e.g. "claude-sonnet-4-6" (add/update).',
        },
        endpoint: {
          // `['string','null']`, and likewise for parameters/maxRounds below: null is update's clear
          // signal, and inputSchema is an enforcement point (json-validation) as well as documentation.
          type:        ['string', 'null'],
          description: 'Base URL of the provider API. Required for openai-compat; omit to use the adapter default (add/update; null on update clears it).',
        },
        credentialKey: {
          type:        'string',
          description: 'Credential field name, default "apiKey" (add only — update never touches credentials; use "plugin store-key").',
        },
        credentialEnvVar: {
          type:        'string',
          description: 'Existing env var name to use as the credential value. If omitted the tool prompts the user (add only).',
        },
        parameters: {
          type:                 ['object', 'null'],
          additionalProperties: true,
          description:          'Generation parameters: maxTokens, temperature, topP, thinking, etc. (add/update). On update this REPLACES the whole object — list first and send back everything you want to keep; null clears it.',
        },
        maxRounds: {
          type:        ['integer', 'null'],
          minimum:     1,
          description: 'Optional per-turn ceiling on agentic rounds (one model call plus its tool batch) for this profile. Omit for no ceiling. Not a generation parameter — never sent to the endpoint (add/update; null on update clears it).',
        },
      },
    },

    executor: makeExecutor(providers, pluginNameToOrigPath, nameResolves),
  };
}

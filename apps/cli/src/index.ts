#!/usr/bin/env node
import { loadConfig, loadConfigFromText, loadDotEnv } from './config.js';
import { installPlugin }                    from './install.js';
import { executeQuery }                     from '@matatbread/matbot-core/storage-base';
import { loadPluginsWithDescriptions, readPluginMeta, type PluginLoadRequest } from './plugin-description.js';
import { nodePluginResolver }               from './plugin-resolver.js';
import type { Principal, ProviderAdapter,
              ProviderConfig, Session,
              Store, StoreQuery, QueryResult, CASResult,
              MessageContent, FileStore } from '@matatbread/matbot-core';
import { appendMessage, createMessage,
         createSession,
         createSessionRunner,
         HookRegistry, SystemContextRegistryImpl, ToolRegistryImpl,
         resolveProviderFactory,
         teardownPlugins,
         unloadPlugin as unloadPluginFn,
         getPluginNameForSpecifier, getRegisteredPlugins, recordServiceKey,
         installPrincipalCarrier, enterPrincipal, currentPrincipal,
         unifyServices, forwardingProxy, makeSwappable, singleTurnRequest,
         createMountTable, onContextQuiesce, flushIfQuiescent,
         createSingleTurnTool,
         MissingSecretError }              from '@matatbread/matbot-core';
import type { MatbotMachine, MatbotServices, PluginSettings, Vault, SessionRunner,
              MatbotPlugin, StorageBackend, KnowledgeIndex, PromptFn, FormField, SwapFn } from '@matatbread/matbot-core';
import { systemPrincipal }                 from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier }       from './principal-als.js';
import { EnvFileVault }                     from './env-vault.js';
import { FilesystemStore }                 from '@matatbread/matbot-storage-filesystem';
import { FilesystemFileStore }             from '@matatbread/matbot-files-node';
import { createBuiltinTools, createProviderTool, classifySpecifier, materializeRemote } from '@matatbread/matbot-tool-plugin';
import { LookupKnowledgeIndex }               from '@matatbread/matbot-core';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface }                 from 'node:readline/promises';
import { createRequire }                   from 'node:module';
import { fileURLToPath, pathToFileURL }     from 'node:url';
import process                             from 'node:process';
import path                                from 'node:path';

// Prefix all console output with ISO timestamp + PID so parent and spawned
// background processes are distinguishable in shared terminal output.
const _pid = process.pid;
const isBackground = process.env.IS_SUB_AGENT === '1';
for (const level of ['log', 'warn', 'error'] as const) {
  const orig = console[level].bind(console) as (...a: unknown[]) => void;
  console[level] = (label, ...args: unknown[]) => {
    if (!isBackground || level === 'error')
      orig(`[${new Date().toISOString()} ${_pid}] ${label}`, ...args);
  };
}
const write = isBackground ? (text: string) => {} : (text: string) => process.stderr.write(text);

// Colour only when writing to an interactive terminal — piped/background output stays clean.
const useColor = !isBackground && process.stderr.isTTY === true;
const yellow = (s: string): string => (useColor ? `\x1b[33m${s}\x1b[0m` : s);
const dim    = (s: string): string => (useColor ? `\x1b[2m${s}\x1b[0m`  : s);

// One marker block → a human-facing line. The dispatcher's hook-failure marker is a warning
// (amber); any other marker is shown dimmed and generic.
function formatMarker(part: Extract<MessageContent, { type: 'marker' }>): string {
  if (part.creator === 'matbot-hooks') {
    const data = (part.data ?? {}) as { channel?: string; pluginName?: string; message?: string };
    const who  = data.pluginName !== undefined ? ` (${data.pluginName})` : '';
    return yellow(`⚠  ${data.channel ?? 'hook'} hook${who} failed and was skipped: ${data.message ?? 'unknown error'}`);
  }
  return dim(`🔖 ${part.creator}: ${JSON.stringify(part.data)}`);
}

/**
 * Given a package exports field (or any nested value), return the first
 * string entry point, preferring "import" > "default" > first value.
 */
function resolveExportsEntry(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  // Subpath map: { ".": ... } → unwrap the "." entry
  if ('.' in obj) return resolveExportsEntry(obj['.']);
  // Condition map: prefer import > default > first
  for (const key of ['import', 'default', ...Object.keys(obj)]) {
    if (key in obj) return resolveExportsEntry(obj[key]);
  }
  return undefined;
}

/**
 * Resolve config/human plugin specifiers into fully-formed load requests for the platform-neutral
 * loader. Each request keeps the original `spec` (recorded as `plugin.specifier`, so it matches the
 * matbot.yaml entry the user added) alongside the `importSpec` (a file: URL the loader actually
 * imports) and the `name`/`runtimes` read from the resolved package.json. Per the classifier:
 *  - local  → resolve package.json exports["."] so matbot.yaml can reference the package folder
 *             rather than a deep src/ path;
 *  - remote → fetch the module graph into `.plugins/` (idempotent; a restart loads from cache) and
 *             point at the cached entry — bare imports then resolve up to the host's node_modules;
 *  - npm / tarball / git → resolved through the project's module graph (pnpm installs them); a bare
 *             name passes through if not yet on disk so loadPlugins can emit the warning.
 *
 * This is the single funnel for both startup and runtime (`plugin add` / hot-load) resolution.
 */
async function resolvePluginSpecifiers(specifiers: readonly string[], configDir: string): Promise<PluginLoadRequest[]> {
  const req = createRequire(path.join(configDir, '_'));
  const dotPlugins = path.join(configDir, '.plugins');
  const results: PluginLoadRequest[] = [];

  for (const spec of specifiers) {
    const classified = await classifySpecifier(spec, configDir);
    let importSpec: string;

    if (classified.kind === 'remote') {
      try {
        importSpec = pathToFileURL(await materializeRemote(spec, dotPlugins, configDir)).href;
      } catch (e) {
        console.warn(`[matbot] Could not fetch remote plugin "${spec}": ${e instanceof Error ? e.message : String(e)}`);
        results.push({ spec, importSpec: spec });  // unresolved — let loadPlugins surface the failure
        continue;
      }
    } else if (classified.kind === 'local' || classified.kind === 'missing-path') {
      const absDir = classified.kind === 'local' ? classified.dir : classified.resolved;
      importSpec = pathToFileURL(absDir).href;
      try {
        const pkg  = JSON.parse(await readFile(path.join(absDir, 'package.json'), 'utf8')) as Record<string, unknown>;
        const main = resolveExportsEntry(pkg['exports']);
        if (typeof main === 'string') importSpec = pathToFileURL(path.resolve(absDir, main)).href;
      } catch { /* no package.json or unparseable — import the directory */ }
    } else {
      // npm / pnpm-url: installed in node_modules under the package name (the stored specifier).
      try {
        importSpec = pathToFileURL(req.resolve(spec)).href;
      } catch {
        results.push({ spec, importSpec: spec });  // not on disk — let loadPlugins emit the warning
        continue;
      }
    }

    const meta = await readPluginMeta(importSpec, configDir);
    results.push({
      spec,
      importSpec,
      ...(meta.name     !== undefined ? { name:     meta.name }     : {}),
      ...(meta.runtimes !== undefined ? { runtimes: meta.runtimes } : {}),
    });
  }

  return results;
}

/** Walk up from `start` until we find a file named `filename`, or return null. */
async function findUp(filename: string, start = process.cwd()): Promise<string | null> {
  let dir = path.resolve(start);
  while (true) {
    const candidate = path.join(dir, filename);
    try { await access(candidate); return candidate; } catch { /* not here */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;  // filesystem root
    dir = parent;
  }
}

async function resolveCredentials(
  credentials: Record<string, string>,
  vault: Vault,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(credentials)) {
    resolved[k] = await vault.resolve(v);
  }
  return resolved;
}

// Bootstrap path: the provider credential is needed before any LLM exists, so it cannot
// be gathered lazily via the `plugin store-key` tool. On a MissingSecretError, prompt
// out-of-band for the unresolved keys, store them in the vault (which persists to .env),
// and retry until every placeholder resolves.
async function resolveCredentialsInteractive(
  credentials: Record<string, string>,
  vault: Vault,
): Promise<Record<string, string>> {
  for (;;) {
    try {
      return await resolveCredentials(credentials, vault);
    } catch (e) {
      if (!(e instanceof MissingSecretError)) throw e;
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        for (const name of e.missingKeys) {
          const value = await rl.question(`Secret required — ${name}: `);
          if (!value.trim()) throw new Error(`No value provided for required secret "${name}".`);
          // writeSecret, not createSecret: the placeholder named this exact key, so store verbatim.
          await vault.writeSecret(name, value.trim());
        }
      } finally {
        rl.close();
      }
    }
  }
}

// Reused as the no-op signal fallback; never aborted.
const NEVER_ABORT_SIGNAL = new AbortController().signal;

// ── Ephemeral in-memory store ──────────────────────────────────────────────────

class MemoryStore<T extends { id: string; version: string }> implements Store<T> {
  private readonly items = new Map<string, T>();

  async get(id: string): Promise<T | null> {
    return this.items.get(id) ?? null;
  }

  async set(id: string, value: T): Promise<void> {
    this.items.set(id, value);
  }

  async cas(id: string, expected: string, next: T): Promise<CASResult<T>> {
    const current = this.items.get(id) ?? null;
    if (current === null || current.version !== expected) return { ok: false, current };
    this.items.set(id, next);
    return { ok: true, doc: next };
  }

  async delete(id: string, expectedVersion?: string): Promise<boolean> {
    if (expectedVersion !== undefined) {
      const current = this.items.get(id);
      if (current === undefined || current.version !== expectedVersion) return false;
    }
    return this.items.delete(id);
  }

  async query(q: StoreQuery): Promise<QueryResult<T>> {
    return executeQuery([...this.items.values()], q);
  }
}

// ── Arg parsing ────────────────────────────────────────────────────────────────

interface CliOpts {
  provider?:   string;
  session?:    string;
  system?:     string;
  config:      string;
  promptFile?: string;
  ephemeral:   boolean;
  principal?:  string;
}

function parseArgs(argv: string[]): { opts: CliOpts; prompt: string | undefined } {
  const args = argv.slice(2);
  const opts: CliOpts = { config: './matbot.yaml', ephemeral: false };
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case '--provider':    { const v = args[++i]; if (v !== undefined) opts.provider   = v; } break;
      case '--session':     { const v = args[++i]; if (v !== undefined) opts.session    = v; } break;
      case '--system':      { const v = args[++i]; if (v !== undefined) opts.system     = v; } break;
      case '--config':      { const v = args[++i]; if (v !== undefined) opts.config     = v; } break;
      case '--prompt-file': { const v = args[++i]; if (v !== undefined) opts.promptFile = v; } break;
      case '--principal':   { const v = args[++i]; if (v !== undefined) opts.principal  = v; } break;
      case '--ephemeral':   opts.ephemeral = true; break;
      case '--help': printHelp(); process.exit(0);
      default:
        if (!arg.startsWith('-')) positional.push(arg);
    }
  }

  return { opts, prompt: positional.length ? positional.join(' ') : undefined };
}

// A principal supplied as a CLI flag or env var: either a bare id (type "user") or the JSON
// `{"id","type"}` that spawners (e.g. the background plugin) write to MATBOT_PRINCIPAL.
function parsePrincipalArg(raw: string): Principal | undefined {
  const s = raw.trim();
  if (s === '') return undefined;
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s) as { id?: unknown; type?: unknown };
      if (typeof o.id === 'string' && o.id !== '' &&
          (o.type === 'user' || o.type === 'agent' || o.type === 'system')) {
        return { id: o.id, type: o.type };
      }
    } catch { /* fall through to invalid */ }
    return undefined;
  }
  return { id: s, type: 'user' };
}

// The process boot identity, resolved once at the entry. Precedence, most specific first:
//   --principal flag  →  MATBOT_PRINCIPAL env  →  config principal:  →  system.
// The env slot is the cross-process transport: a parent (pod/sandbox, or the background plugin
// delegating its creator) sets it; the child re-establishes that identity here.
function resolveBootPrincipal(opts: CliOpts, config: import('./config.js').MatbotConfig): Principal {
  if (opts.principal !== undefined) {
    const p = parsePrincipalArg(opts.principal);
    if (p === undefined) throw new Error(`Invalid --principal "${opts.principal}". Use an id (e.g. "alice") or JSON {"id","type"}.`);
    return p;
  }
  const env = process.env['MATBOT_PRINCIPAL'];
  if (env !== undefined && env.trim() !== '') {
    const p = parsePrincipalArg(env);
    if (p === undefined) throw new Error(`Invalid MATBOT_PRINCIPAL "${env}". Use an id or JSON {"id","type"}.`);
    return p;
  }
  if (config.principal !== undefined) return config.principal;
  return systemPrincipal();
}

function printHelp(): void {
  process.stderr.write(`
matbot — AI CLI

Usage:
  matbot [options] [prompt]

Options:
  --provider    <name>      Provider key from matbot.yaml (default: first in file)
  --session     <id>|create Resume an existing session, or "create" to start a new persistent one
  --system      <text>      System prompt injected at session start
  --config      <path>      Config file path (default: ./matbot.yaml)
  --prompt-file <path>      Read prompt from file; run single turn and exit
  --ephemeral               Force ephemeral even when --session is given
  --principal   <id|json>   Boot identity: an id (type "user") or JSON {"id","type"}.
                            Overrides MATBOT_PRINCIPAL and config principal:.
  --help                    Show this help

Sessions are ephemeral by default (discarded on exit). Use --session create to persist,
or --session <id> to resume a previously persisted session.

If [prompt] and --prompt-file are both omitted, starts an interactive REPL.
`.trimStart());
}

// ── Single turn ────────────────────────────────────────────────────────────────

async function runTurn(
  session:      Session,
  content:      string | MessageContent[],
  run:          SessionRunner,
  providerName: string,
  principal:    Principal,
  promptFn:     PromptFn,
): Promise<Session> {
  const ac       = new AbortController();
  // Ctrl-C aborts the running turn (and drops anything queued) through the runner.
  const onSigint = (): void => { run.abort(session.id); };
  process.once('SIGINT', onSigint);

  const contentArr: MessageContent[] = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content;

  let updated       = session;
  let totalIn       = 0;
  let totalOut      = 0;
  let totalCostUsd  = 0;
  let thinkingTicks = 0;

  const clearThinking = (): void => {
    if (thinkingTicks > 0) { process.stderr.write('\n'); thinkingTicks = 0; }
  };

  try {
    // The runner appends + persists the user message and auto-titles at turn start.
    const view = await run.open({
      sessionId: session.id,
      signal:    ac.signal,
      content:   contentArr,
      provider:  providerName,
      principal,
      prompt:    promptFn,
    });
    for await (const ev of view.events) {
      if (ev.type === 'idle') continue; // session-level lifecycle signal, not this turn's
      if (ev.traceId !== view.traceId) continue;
      switch (ev.type) {
        case 'text-delta':
          clearThinking();
          process.stdout.write(ev.delta);
          break;
        case 'thinking':
          thinkingTicks++;
          write(`\r[thinking… ×${thinkingTicks}]`);
          break;
        case 'tool:start':
          clearThinking();
          write(`\n⚙  ${ev.name} ${JSON.stringify(ev.input)}\n`);
          break;
        case 'tool:stdout': write(ev.chunk); break;
        case 'tool:stderr': write(ev.chunk); break;
        case 'tool:end':    write(`\n`); break;
        case 'usage':
          totalIn      += ev.inputTokens;
          totalOut     += ev.outputTokens;
          if (ev.costUsd !== undefined) totalCostUsd += ev.costUsd;
          break;
        case 'done':        clearThinking(); updated = ev.session; break;
        case 'robo-user': {
          // Machine-authored context folded onto the user turn by a screen hook (e.g. a fired
          // `contextual` trigger) — system-supplied, not the user's words, so label it as such.
          const text = ev.content
            .filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
            .map(c => c.text).join('');
          if (text) write(`[context] ${text}\nassistant: `);
          break;
        }
        case 'aborted': {
          clearThinking();
          updated = ev.session;
          const formMsg = [...ev.session.messages].reverse().find(
            m => m.content.some(c => c.type === 'form'),
          );
          if (formMsg) {
            const formPart = formMsg.content.find(
              (c): c is Extract<MessageContent, { type: 'form' }> => c.type === 'form',
            );
            if (formPart) {
              write('\n');
              const values: Record<string, string> = {};
              for (const field of formPart.fields) {
                const hint = field.options ? ` [${field.options.join('/')}]` : '';
                values[field.name] = await promptFn(`${field.label}${hint}`, field.default);
              }
              process.removeListener('SIGINT', onSigint);
              ac.abort();
              return await runTurn(ev.session, [{ type: 'form-response', values }], run, providerName, principal, promptFn);
            }
          } else {
            process.stderr.write(`\n[aborted: ${ev.reason}]\n`);
          }
          break;
        }
        case 'marker': {
          clearThinking();
          for (const part of ev.content) {
            if (part.type === 'marker') write(`\n${formatMarker(part)}\n`);
          }
          break;
        }
        case 'error': clearThinking(); process.stderr.write(`\n[error: ${ev.error}]\n`); break;
        default: break;
      }
      // One submission == one turn here; the per-session stream would otherwise keep yielding.
      if (ev.type === 'done' || ev.type === 'aborted' || ev.type === 'error' || ev.type === 'cancelled') break;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    ac.abort();
  }

  write('\n');
  if (totalIn > 0 || totalOut > 0) {
    const cost = totalCostUsd > 0 ? ` ≈$${totalCostUsd.toFixed(4)}` : '';
    write(`[↑${totalIn} ↓${totalOut} tokens${cost}]\n`);
  }

  return updated;
}

// ── Main ───────────────────────────────────────────────────────────────────────

// ── Setup wizard ───────────────────────────────────────────────────────────────

interface ProviderPackage { type: string; name: string; dir: string; }

// The provider adapters the CLI ships with (its dependencies). Resolved through the module graph
// rather than a directory scan, so discovery works identically when installed (node_modules) and in
// the monorepo (workspace symlinks). A user can `plugin add` other providers after setup.
const BUNDLED_PROVIDERS = [
  '@matatbread/matbot-provider-anthropic',
  '@matatbread/matbot-provider-openai-compat',
  '@matatbread/matbot-provider-customer-services',
];

async function discoverProviders(): Promise<ProviderPackage[]> {
  const require = createRequire(import.meta.url);
  const results: ProviderPackage[] = [];
  for (const name of BUNDLED_PROVIDERS) {
    let dir: string;
    try {
      // package root is two levels up from the entry (…/<pkg>/src/index.ts)
      dir = path.dirname(path.dirname(require.resolve(name)));
    } catch { continue; }  // not installed
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
      const type = name.slice('@matatbread/matbot-provider-'.length);
      results.push({ type, name: (pkg['name'] as string) ?? name, dir });
    } catch { /* unreadable package.json */ }
  }
  return results;
}

async function testEndpointReachable(url: string): Promise<string | false> {
  try {
    const { status, statusText } = (await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) }));
    return (status == 401 || status == 403) ? `Endpoint reachable but returned ${statusText} (check credentials)` : false;
  } catch (ex: any) {
    return `Endpoint failed (${ex?.message ?? String(ex)})`;
  }
}

async function runSetupWizard(configPath: string): Promise<import('./config.js').MatbotConfig> {
  const rl  = createInterface({ input: process.stdin, output: process.stderr });
  const ask = async (question: string): Promise<string> => {
    const answer = await rl.question(`${question}: `);
    return answer.trim();
  };

  try {
    process.stderr.write('\nNo providers configured. Let\'s set one up.\n\n');

    const discovered = await discoverProviders();
    if (discovered.length === 0) {
      throw new Error('No provider packages found. Cannot continue setup.');
    }

    process.stderr.write('Available provider types:\n');
    for (let i = 0; i < discovered.length; i++) {
      process.stderr.write(`  ${i + 1}. ${discovered[i]!.type}  (${discovered[i]!.name})\n`);
    }
    process.stderr.write('\n');

    let chosen!: ProviderPackage;
    for (;;) {
      const choice = await ask(`Choose a type [1-${discovered.length}]`);
      const n = parseInt(choice, 10);
      if (n >= 1 && n <= discovered.length) { chosen = discovered[n - 1]!; break; }
      process.stderr.write(`Please enter a number between 1 and ${discovered.length}.\n`);
    }

    let providerName = '';
    for (;;) {
      providerName = await ask(`Provider name (how this LLM key is named in ${configPath} and presented to you)`);
      if (providerName) break;
      process.stderr.write('Provider name is required.\n');
    }

    let model = '';
    for (;;) {
      model = await ask('Model name');
      if (model) break;
      process.stderr.write('Model name is required.\n');
    }

    let endpoint = await ask('Endpoint URL');
    let apiKey = await ask('API key');

    if (endpoint && !endpoint.startsWith('http')) {
      process.stderr.write(`\nTesting ${endpoint}… `);
      const reachable = await testEndpointReachable(endpoint);
      if (!reachable) {
        process.stderr.write('reachable\n');
      } else {
        process.stderr.write(reachable + '\n');
        const cont = await ask('Continue with this endpoint anyway? [y/N]');
        if (cont.toLowerCase() !== 'y') {
          process.stderr.write('Setup cancelled.\n');
          process.exit(1);
        }
      }
    }
    const configDir  = path.dirname(configPath);
    const envPath    = path.join(configDir, '.env');
    const envVarName = `MATBOT_API_KEY_${providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

    let envContent = '';
    try { envContent = await readFile(envPath, 'utf8'); } catch { /* no existing .env */ }
    const envLines = envContent
      ? envContent.split('\n').filter(l => !l.startsWith(`${envVarName}=`) && l !== '')
      : [];
    envLines.push(`${envVarName}=${apiKey}`);
    await writeFile(envPath, envLines.join('\n') + '\n', 'utf8');
    process.env[envVarName] = apiKey;

    // Reference the provider by package name: resolves via node_modules when installed and via the
    // workspace symlink in the monorepo, so the config is portable either way.
    const moduleSpec = chosen.name;

    const yaml = [
      'providers:',
      `  ${providerName}:`,
      `    module: ${moduleSpec}`,
      `    endpoint: ${endpoint}`,
      `    model: ${model}`,
      `    credentials:`,
      `      apiKey: \${${envVarName}}`,
    ].join('\n') + '\n';

    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, yaml, 'utf8');
    process.stderr.write(`\nConfiguration written to ${configPath}\n\n`);

    return {
      plugins:   [],
      providers: new Map([[providerName, {
        name:        providerName,
        module:      moduleSpec,
        model,
        credentials: { apiKey },
        endpoint,
      }]]),
    };
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const serverMode = process.argv[2] === 'start';

  // ── install subcommand ────────────────────────────────────────────────────
  if (process.argv[2] === 'install') {
    const specifier = process.argv.slice(3).find(a => !a.startsWith('-'));
    if (!specifier) {
      process.stderr.write('Usage: matbot install <package>\n');
      process.exit(1);
    }
    const configFlag = process.argv.indexOf('--config');
    const configArg  = configFlag !== -1 ? process.argv[configFlag + 1] : undefined;
    const configPath = configArg !== undefined
      ? path.resolve(configArg)
      : (await findUp('matbot.yaml')) ?? path.resolve('matbot.yaml');
    await installPlugin(specifier, configPath);
    return;
  }

  const { opts, prompt: parsedPrompt } = parseArgs(process.argv);

  // ── Config loading ────────────────────────────────────────────────────────────

  let matbotConfig!: import('./config.js').MatbotConfig;
  let configPath: string;

  if (opts.config === '-') {
    // Read YAML from stdin; project root anchors to the base config via extends:
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on('data', (c: Buffer) => chunks.push(c));
      process.stdin.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', reject);
    });
    const { config, projectDir } = await loadConfigFromText(text, process.cwd());
    matbotConfig = config;
    configPath   = path.join(projectDir, 'matbot.yaml'); // virtual — used for plugin resolution
    process.chdir(projectDir);
    await loadDotEnv(projectDir);
  } else {
    // Resolve relative paths against INIT_CWD (set by pnpm/npm to the directory
    // from which the user ran the package manager) so --config foo.yaml lands
    // next to the user's project, not inside the CLI package directory.
    const userCwd = process.env['INIT_CWD'] ?? process.cwd();
    configPath = opts.config === './matbot.yaml'
      ? (await findUp('matbot.yaml')) ?? path.resolve(userCwd, 'matbot.yaml')
      : path.isAbsolute(opts.config) ? opts.config : path.resolve(userCwd, opts.config);
    process.chdir(path.dirname(configPath));
    await loadDotEnv(path.dirname(configPath));
    let loadResult: { config: import('./config.js').MatbotConfig; projectDir: string } | null = null;
    try {
      loadResult = await loadConfig(configPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
    if (loadResult !== null) {
      matbotConfig = loadResult.config;
      if (loadResult.projectDir !== path.dirname(configPath)) {
        process.chdir(loadResult.projectDir);
        configPath = path.join(loadResult.projectDir, 'matbot.yaml');
      }
    }
    if (loadResult === null || matbotConfig!.providers.size === 0) {
      matbotConfig = await runSetupWizard(configPath);
    }
  }

  // Merge prompt sources: CLI flag/arg > config file
  const argPrompt = opts.promptFile !== undefined
    ? await readFile(path.resolve(opts.promptFile), 'utf8')
    : (parsedPrompt ?? matbotConfig.prompt);

  // Ephemeral by default; opt into persistence with --session <id|create>.
  // config ephemeral:true (e.g. background sub-agents) is a hard override.
  const isEphemeral = opts.ephemeral || matbotConfig.ephemeral === true || opts.session === undefined;

  // Guard: stdin config without a prompt would consume stdin then hang on REPL
  if (opts.config === '-' && argPrompt === undefined) {
    throw new Error('--config - requires a prompt: field in the config or a positional prompt argument.');
  }

  // ── Plugin setup ─────────────────────────────────────────────────────────────

  // Install the ambient security carrier before anything that could read it. The node app uses an
  // AsyncLocalStorage carrier so concurrent turns / frontend requests stay isolated; entering the
  // boot principal here gives the CLI process its identity for any out-of-turn backend access
  // (frontend handlers and per-turn pumps shadow it with their own principal via runAs). The boot
  // identity is resolved at this entry — flag → MATBOT_PRINCIPAL → config → system — so a pod or a
  // delegating parent (the background plugin) can supply it without any shared-package env reads.
  installPrincipalCarrier(createAlsPrincipalCarrier());
  enterPrincipal(resolveBootPrincipal(opts, matbotConfig));

  // The vault is a capture-safe forwarding proxy over a swappable backend (mirrors StorageBackend):
  // EnvFileVault by default, replaced when a plugin calls register('Vault', impl). References to
  // `services.Vault` / `ctx.vault` captured before the swap keep resolving to the live impl.
  let activeVault: Vault = new EnvFileVault(
    path.join(path.dirname(configPath), '.env'),
    process.env as Record<string, string | undefined>,
  );
  const vault: Vault = forwardingProxy<Vault>(() => activeVault);

  // ── Stores (created early so plugins like frontend-web can use them) ──────────

  const dotData  = path.join(path.dirname(configPath), '.data');
  const dataDir  = path.join(dotData, 'sessions');
  const workDir  = path.join(dotData, 'bash-cwd');
  const filesDir = path.join(dotData, 'files');

  // Resolve plugin specifiers here so we can pre-scan for a storage backend before
  // creating stores. Node caches the imported modules, so loadPlugins below is free.
  const providerModules: string[] = [];
  const seenProviderModules = new Set<string>();
  for (const cfg of matbotConfig.providers.values()) {
    const mod = cfg.module;
    if (!seenProviderModules.has(mod)) {
      seenProviderModules.add(mod);
      providerModules.push(mod);
    }
  }
  const resolvedProviderMods = await resolvePluginSpecifiers(providerModules, path.dirname(configPath));
  const resolvedPluginMods   = await resolvePluginSpecifiers(matbotConfig.plugins, path.dirname(configPath));
  const allSpecifiers        = [...resolvedProviderMods, ...resolvedPluginMods];

  // A plugin with storageBackend replaces the default filesystem stores.
  // It must be listed before any plugin whose setup() calls createStore.
  let activeStorageBackend: StorageBackend | undefined;
  let knowledgeImpl: KnowledgeIndex = new LookupKnowledgeIndex();
  // Capture-safe service handles (see forwardingProxy): a captured reference — including a destructure
  // like `const { KnowledgeIndex, StorageBackend } = services` — keeps resolving to the live impl across
  // a register()-driven swap, instead of pinning whatever was current at capture time.
  const knowledgeProxy      = forwardingProxy<KnowledgeIndex>(() => knowledgeImpl);
  const storageBackendProxy = forwardingProxy<StorageBackend>(() => activeStorageBackend);

  // The host's own boot base — captured *before* the pre-scan, so it is always the app default
  // (filesystem/memory), never a config-supplied backend. A StorageBackend swap reverts here when its
  // providing plugin is unloaded. A pre-scanned backend is treated as plugin-owned (see storageBootSpec
  // below), so unloading it lands on this same base.
  const bootBackend: StorageBackend | undefined = activeStorageBackend;
  const bootFileStore: FileStore = new FilesystemFileStore(filesDir);

  // The config entry of the plugin whose storageBackend the pre-scan opened, if any. Recorded against
  // its plugin name once the loader has resolved names, so its unload reverts storage like a register().
  let storageBootSpec: string | undefined;
  for (const { spec, importSpec } of allSpecifiers) {
    try {
      const mod  = await import(/* @vite-ignore */ importSpec) as Record<string, unknown>;
      const plug = (mod['plugin'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['plugin']) as MatbotPlugin | undefined;
      if (plug?.storageBackend !== undefined) {
        activeStorageBackend = await plug.storageBackend.open(dotData);
        storageBootSpec = spec;
        break;
      }
    } catch { /* loadPlugins will surface errors */ }
  }

  if (activeStorageBackend === undefined) {
    const mkdirs: Promise<unknown>[] = [mkdir(filesDir, { recursive: true })];
    // Only create the sessions directory when we'll actually write to it.
    if (!isEphemeral) mkdirs.push(mkdir(dataDir, { recursive: true }));
    await Promise.all(mkdirs);
  }

  // Each Store and FileStore is a forwarding proxy (forwardingProxy/makeSwappable, shared with the
  // web bundle) backed by a mutable `current` target. Callers may freely capture references — all
  // method calls route through the proxy to whichever backend is current. register('StorageBackend',
  // …) calls each proxy's swap fn.
  type AnyStore = Store<{ id: string; version: string }>;

  // One proxy per namespace, including 'sessions'. Keyed by namespace string.
  const storeProxies = new Map<string, [AnyStore, SwapFn<AnyStore>]>();

  const makeStoreForNamespace = (namespace: string): AnyStore =>
    activeStorageBackend?.createStore(namespace) ??
    new FilesystemStore(namespace === 'sessions' ? dataDir : path.join(dotData, namespace));

  const createStore = <T extends { id: string; version: string }>(namespace: string): Store<T> => {
    let entry = storeProxies.get(namespace);
    if (entry === undefined) {
      entry = makeSwappable<AnyStore>(makeStoreForNamespace(namespace));
      storeProxies.set(namespace, entry);
    }
    return entry[0] as Store<T>;
  };

  // sessions and fileStore are stable proxy references — safe to capture anywhere.
  const store     = createStore<Session>('sessions');

  // Boot defaults, captured for revert-on-unregister: a plugin that swaps a core service in via
  // register() reverts to these when it is unloaded, instead of leaving a dangling reference to the
  // now-gone impl. (bootBackend/bootFileStore are captured above, before the pre-scan, so a
  // config-supplied backend never poses as the host base.)
  const bootVault                  = activeVault;
  const bootKnowledge              = knowledgeImpl;

  // The live file proxy starts on the pre-scanned backend (if any), falling back to the host base.
  const [fileStore, swapFiles] = makeSwappable<FileStore>(activeStorageBackend?.fileStore ?? bootFileStore);

  // Re-point every store proxy + the file proxy at `next` (or the host base when undefined). Returns
  // whether anything actually changed, so the caller can skip a redundant `mounted` emit. Synchronous:
  // the repoint completes before this returns, so readers see `next` at once and the `mounted` emit can
  // fire immediately. The displaced backend is closed in the *background* — a slow or throwing close()
  // (e.g. node:sqlite's db.close() rejecting on a still-open statement) must never gate the swap or
  // suppress the mounted notification, which was the cause of a swap that "only took on the 2nd try".
  // Driven only from the quiescent-edge flush below — never mid-turn.
  const swapStorage = (next: StorageBackend | undefined): boolean => {
    const removed = activeStorageBackend;
    if (removed === next) return false;
    activeStorageBackend = next;
    for (const [ns, [, swap]] of storeProxies) swap(makeStoreForNamespace(ns));
    swapFiles(next?.fileStore ?? bootFileStore);
    void Promise.resolve(removed?.close?.()).catch(e => console.error('[matbot] closing displaced StorageBackend:', e));
    return true;
  };

  // Deferred StorageBackend swap. register/unregister('StorageBackend') stage the desired backend here
  // (last write wins — only the final intended backend matters, so a slot, not a queue) and ask the
  // context-switch machinery to land it at the next quiescent edge. Swapping the system of record under
  // a running turn would split a compare-and-swap across two backends, so the apply waits for depth 0.
  // The mount table batches mount notifications to the quiescent edge: register/unregister mark a key
  // dirty; the edge computes each key's net presence transition (mount / remount / committed unload) and
  // multicasts to that key's subscribers. A reload (unregister+register within one turn) collapses to a
  // single remount. Notification timing is deliberately unspecified — see the `Mounted` contract.
  const mountTable = createMountTable(() => services);
  let pendingSwap: { next: StorageBackend | undefined } | undefined;
  const stageSwap = (next: StorageBackend | undefined): void => {
    pendingSwap = { next };
    flushIfQuiescent();
  };
  onContextQuiesce(() => {
    if (pendingSwap !== undefined) {
      const { next } = pendingSwap;
      pendingSwap = undefined;
      if (swapStorage(next)) mountTable.markDirty('StorageBackend');
    }
    mountTable.flush();
  });

  // Swap the KnowledgeIndex, draining the displaced impl's entries into the incoming one.
  const swapKnowledge = (next: KnowledgeIndex): void => {
    const prev = knowledgeImpl;
    if (prev === next) return;
    knowledgeImpl = next;
    if (prev.entries !== undefined) for (const e of prev.entries()) void next.index(e);
  };

  // toolReg is shared: plugins register into it via services, runSession reads it
  const toolReg = new ToolRegistryImpl(createBuiltinTools());

  // hookReg is shared: plugins register hooks via services, runSession fires them
  const hookReg = new HookRegistry();
  const systemContextReg = new SystemContextRegistryImpl();

  const serviceRegistry     = new Map<string, unknown>();

  // Constructed just after the services object (it closes over services.loadPlugin); exposed via
  // the `run` getter below so frontends submit/observe through one serialiser instead of each
  // calling runSession directly.
  let sessionRunner: SessionRunner | undefined;

  const baseServices: MatbotMachine = {
    // Plugins always receive the plugin-scoped override built in setupPlugin; the base is never the
    // one a plugin calls. Core reads its reserved settings doc via makePluginSettings directly.
    settings(): PluginSettings {
      throw new Error('settings() is only available within a plugin scope (use the services passed to setup()).');
    },

    createStore,

    get(key) { return serviceRegistry.get(key as string) as never; },
    async register(key, value) {
      // StorageBackend is the system of record: stage it and let the quiescent edge apply it (idle →
      // now; mid-turn → at turn end) — its mount notification is marked dirty there, after the swap
      // lands. The other swap-keys repoint immediately, then mark dirty so the edge multicasts the mount.
      if (key === 'StorageBackend')      stageSwap(value as StorageBackend);
      else if (key === 'KnowledgeIndex') swapKnowledge(value as KnowledgeIndex);
      else if (key === 'Vault')          activeVault = value as Vault;
      else serviceRegistry.set(key as string, value);
      if (key !== 'StorageBackend') { mountTable.markDirty(key); flushIfQuiescent(); }
    },
    // Symmetric with register: a swap-key reverts to the app's captured boot default instead of
    // dangling on the unloaded plugin's impl; everything else is a plain registry delete. Marking dirty
    // lets the edge deliver a committed unload (or, if re-registered before the edge, a single remount).
    unregister(key: string) {
      if (key === 'StorageBackend')      stageSwap(bootBackend);
      else if (key === 'KnowledgeIndex') knowledgeImpl = bootKnowledge;
      else if (key === 'Vault')          activeVault = bootVault;
      else serviceRegistry.delete(key);
      if (key !== 'StorageBackend') { mountTable.markDirty(key as keyof MatbotServices); flushIfQuiescent(); }
    },
    registerFrontend() { /* bound per-plugin in setupPlugin's scopedServices; base is a no-op */ },

    async complete(req) {
      const rawCfg = matbotConfig.providers.get(req.provider);
      if (rawCfg === undefined) {
        throw new Error(
          `complete(): unknown provider "${req.provider}". ` +
          `Available: ${[...matbotConfig.providers.keys()].join(', ')}`,
        );
      }
      const resolved: ProviderConfig = {
        ...rawCfg,
        ...(rawCfg.credentials !== undefined ? { credentials: await resolveCredentials(rawCfg.credentials, vault) } : {}),
        ...(rawCfg.endpoint    !== undefined ? { endpoint: await vault.resolve(rawCfg.endpoint) } : {}),
      };
      const adpt = resolveProviderFactory(resolved.module)(resolved);
      const msgs = req.system !== undefined
        ? [
            createMessage({
              role:    'system',
              content: [{ type: 'text', text: req.system }],
              traceId: crypto.randomUUID(),
            }),
            ...req.messages,
          ]
        : req.messages;
      const signal = req.signal ?? NEVER_ABORT_SIGNAL;
      let text = '';
      let inputTokens = 0;
      let outputTokens = 0;
      for await (const ev of adpt.complete(msgs, resolved, [], signal)) {
        if (ev.type === 'text-delta') text += ev.delta;
        if (ev.type === 'usage') { inputTokens = ev.inputTokens; outputTokens = ev.outputTokens; }
      }
      return { text, usage: { inputTokens, outputTokens } };
    },
    async singleTurn(req) {
      return this.complete(singleTurnRequest(req));
    },
    async loadPlugin(specifier: string, prompt?: PromptFn) {
      const resolved = await resolvePluginSpecifiers([specifier], path.dirname(configPath));
      const plugins  = await loadPluginsWithDescriptions(resolved, services, path.dirname(configPath), /* bustCache */ true, prompt, /* onLoadError */ 'throw');
      const plugin   = plugins[0];
      if (plugin === undefined) throw new Error(`No plugin loaded for specifier "${specifier}"`);
      return plugin;
    },
    async unloadPlugin(specifier: string): Promise<boolean> {
      // A loaded plugin records its config-level specifier (= the matbot.yaml entry) and its canonical
      // name; accept either. (No re-resolution needed — `plugin.specifier` is the original specifier.)
      const name = getPluginNameForSpecifier(specifier)
        ?? (getRegisteredPlugins().some(p => p.name === specifier) ? specifier : undefined);
      if (name === undefined) {
        console.warn(`[matbot] No loaded plugin found for "${specifier}"`);
        return false;
      }
      return unloadPluginFn(name, services);
    },
    resolver:  nodePluginResolver(path.dirname(configPath)),
    providers: matbotConfig.providers,
    mounted:   mountTable.mounted,
    get StorageBackend() { return activeStorageBackend === undefined ? undefined : storageBackendProxy; },
    sessions:  store,
    get run() { return sessionRunner; },
    files:     fileStore,
    Vault:     vault,
    hooks:          hookReg,
    tools:          toolReg,
    systemContext:  systemContextReg,
    workdir:    workDir,
    configPath,
    isSubAgent: () => isBackground,
    get KnowledgeIndex() { return knowledgeProxy; },
  };
  const services: MatbotMachine = unifyServices(baseServices);

  // resolveProvider reads matbotConfig.providers lazily (per turn), so it sees both the
  // canonicalised module names set below and any live `provider add/remove` edits.
  const resolveProvider = async (name: string): Promise<{ adapter: ProviderAdapter; config: ProviderConfig } | null> => {
    const cfg = matbotConfig.providers.get(name);
    if (cfg === undefined) return null;
    const resolved: ProviderConfig = {
      ...cfg,
      ...(cfg.credentials !== undefined ? { credentials: await resolveCredentials(cfg.credentials, vault) } : {}),
      ...(cfg.endpoint    !== undefined ? { endpoint: await vault.resolve(cfg.endpoint) } : {}),
    };
    return { adapter: resolveProviderFactory(resolved.module)(resolved), config: resolved };
  };

  // One runner per store: frontends share this one over the persistent sessions store, but the CLI
  // can instantiate its own over an ephemeral MemoryStore (see main). That a SessionRunner composes
  // over *any* Store is the point — nothing about the agentic loop is bound to a single backend.
  const makeRunner = (sessionStore: Store<Session>): SessionRunner => createSessionRunner({
    store:         sessionStore,
    resolveProvider,
    tools:         toolReg,
    hooks:         hookReg,
    systemContext: systemContextReg,
    vault,
    files:         fileStore,
    workdir:       workDir,
    configPath,
    loadPlugin:    services.loadPlugin.bind(services),
    unloadPlugin:  services.unloadPlugin.bind(services),
  });

  sessionRunner = makeRunner(store);

  // Load provider plugins first so module names can be canonicalised before any
  // frontend plugin's setup() calls resolveProviderFactory(cfg.module).
  await loadPluginsWithDescriptions(resolvedProviderMods, services, path.dirname(configPath));

  // Canonicalise each provider config's module to the loaded plugin's name so that
  // resolveProviderFactory() (keyed by plugin.name) finds the factory regardless of
  // whether the config used an npm name, a relative path, or a file URL.
  for (const [key, cfg] of matbotConfig.providers) {
    // A loaded plugin records its config specifier (= cfg.module) as plugin.specifier.
    const pluginName = getPluginNameForSpecifier(cfg.module);
    if (pluginName !== undefined && pluginName !== cfg.module) {
      matbotConfig.providers.set(key, { ...cfg, module: pluginName });
    }
  }

  // Map plugin name → the original module specifier written in matbot.yaml.
  // Used by the provider tool so its description and list output show YAML-valid
  // specifiers, and so `provider add` writes a path the loader can resolve — never
  // the bare package name of a local plugin, which crashes startup.
  const pluginNameToOrigPath = new Map<string, string>();
  const recordOrigPaths = (origs: readonly string[]): void => {
    // plugin.specifier === the original config entry, so look up the name by that entry directly.
    for (const orig of origs) {
      const name = getPluginNameForSpecifier(orig);
      if (name !== undefined && !pluginNameToOrigPath.has(name)) pluginNameToOrigPath.set(name, orig);
    }
  };
  recordOrigPaths(providerModules);

  await loadPluginsWithDescriptions(resolvedPluginMods, services, path.dirname(configPath));

  // The pre-scan opened a manifest storageBackend directly, before the loader knew the plugin's name,
  // so the scoped register() that records a service key never ran. Attribute it now that names exist,
  // making the boot-opened backend unload-equal to a runtime register(): unloading that plugin reverts
  // storage to the host base and closes the backend.
  if (storageBootSpec !== undefined) {
    const name = getPluginNameForSpecifier(storageBootSpec);
    if (name !== undefined) recordServiceKey(name, 'StorageBackend');
  }

  // A provider adapter may be loaded via the plugins list (as a path) rather than a
  // provider config. Record those too, so the provider tool knows the YAML-valid path
  // for every loaded adapter, not just ones already referenced by a provider profile.
  recordOrigPaths(matbotConfig.plugins);

  // Register the provider management tool now that all adapter plugins are loaded and
  // their YAML specifiers are recorded — createProviderTool reads getRegisteredPlugins()
  // and pluginNameToOrigPath to build its description.
  toolReg.register(createProviderTool(matbotConfig.providers, pluginNameToOrigPath));

  // single_turn: the model-facing surface of the core singleTurn service. Registered here beside the
  // other core service-management tools (it needs the live `services` for `singleTurn`/`providers`).
  toolReg.register(createSingleTurnTool(services));

  // ── Server mode ───────────────────────────────────────────────────────────────

  if (serverMode) {
    process.stderr.write(`[${new Date().toISOString()} ${_pid}] [matbot] server running — press Ctrl+C to stop\n`);
    const shutdown = (): void => {
      process.stderr.write('\n[matbot] shutting down…\n');
      teardownPlugins()
      .then(async () => { await activeStorageBackend?.close?.(); process.exit(0); })
      .catch(() => process.exit(1));
    };
    process.once('SIGINT',  shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  // ── Provider resolution ───────────────────────────────────────────────────────

  const providerName = opts.provider ?? matbotConfig.defaultProvider ?? (matbotConfig.providers.keys().next().value as string);
  const rawConfig    = matbotConfig.providers.get(providerName);
  if (!rawConfig) {
    throw new Error(
      `Unknown provider "${providerName}". Available: ${[...matbotConfig.providers.keys()].join(', ')}`
    );
  }

  const providerConfig: ProviderConfig = {
    name:        rawConfig.name,
    module:      rawConfig.module,
    model:       rawConfig.model,
    ...(rawConfig.credentials !== undefined ? { credentials: await resolveCredentialsInteractive(rawConfig.credentials, vault) } : {}),
    ...(rawConfig.endpoint    !== undefined ? { endpoint: await vault.resolve(rawConfig.endpoint) } : {}),
    ...(rawConfig.parameters  !== undefined ? { parameters: rawConfig.parameters } : {}),
    ...(rawConfig.fallback    !== undefined ? { fallback:   rawConfig.fallback   } : {}),
  };

  // ── Session ───────────────────────────────────────────────────────────────────

  // The session owner is the boot identity established at the entry, not a fresh system principal —
  // so a single-turn run launched as a specific user (pod / `--principal` / background delegation)
  // owns its session as that user.
  const principal = currentPrincipal();
  let session: Session;

  if (opts.session && opts.session !== 'create') {
    const existing = await store.get(opts.session);
    if (!existing) {
      throw new Error(`Session "${opts.session}" not found.`);
    }
    session = existing;
  } else {
    session = createSession({ ownerPrincipal: principal });
    if (opts.system) {
      session = appendMessage(session, createMessage({
        role:    'system',
        content: [{ type: 'text', text: opts.system }],
        traceId: crypto.randomUUID(),
      }));
    }
  }

  if (isEphemeral) {
    process.stderr.write(`[${new Date().toISOString()} ${_pid}] provider: ${providerName}  (ephemeral)\n\n`);
  } else {
    process.stderr.write(`[${new Date().toISOString()} ${_pid}] provider: ${providerName}  session: ${session.id}\n\n`);
  }

  const runStore: Store<Session> = isEphemeral ? new MemoryStore<Session>() : store;
  // The runner loads the session before its first turn, so make sure it's resolvable: a fresh
  // ephemeral session has never been persisted. (Non-ephemeral sessions were loaded from runStore.)
  await runStore.set(session.id, session);
  // Reuse the shared runner over the persistent store; spin up a private one over the ephemeral
  // MemoryStore so a throwaway REPL session never shares a queue with the frontends.
  const cliRun: SessionRunner = isEphemeral ? makeRunner(runStore) : (sessionRunner ?? makeRunner(store));

  // ── Readline (shared by single-turn and REPL for tool prompts) ──────────────
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.on('SIGINT', () => { process.stderr.write('\n'); rl.close(); });

  const stdinPrompt = (async (p: string | FormField, defaultValue?: string): Promise<string> => {
    if (typeof p !== 'string') {
      const def = p.default;
      if (p.type === 'select' || p.type === 'confirm') {
        const opts = p.type === 'confirm' ? ['yes', 'no'] : (p.options ?? []);
        const hint = opts.map(o => def !== undefined && o.toLowerCase() === def.toLowerCase() ? o.toUpperCase() : o).join('/');
        const raw  = (await rl.question(`${p.label} [${hint}] `)).trim();
        if (!raw) return def ?? '';
        return opts.find(o => o.toLowerCase().startsWith(raw.toLowerCase())) ?? def ?? raw;
      }
      const suffix = def !== undefined ? ` [${def}] ` : ' ';
      return (await rl.question(`${p.label}${suffix}`)).trim() || def || '';
    }
    const suffix = defaultValue !== undefined ? ` [${defaultValue}] ` : ' ';
    const answer = await rl.question(`${p}${suffix}`);
    return answer.trim() || defaultValue || '';
  }) as PromptFn;

  // ── Single-turn ──────────────────────────────────────────────────────────────
  if (argPrompt !== undefined) {
    try {
      await runTurn(session, argPrompt, cliRun, providerConfig.name, principal, stdinPrompt);
    } finally {
      rl.close();
      await teardownPlugins();
      await activeStorageBackend?.close?.();
    }
    return;
  }

  // ── Interactive REPL ─────────────────────────────────────────────────────────
  try {
    for (;;) {
      let line: string;
      try {
        line = await rl.question('you: ');
      } catch {
        break;  // Ctrl+D / EOF
      }
      if (!line.trim()) continue;
      process.stderr.write('assistant: ');
      session = await runTurn(session, line, cliRun, providerConfig.name, principal, stdinPrompt);
    }
  } finally {
    rl.close();
    await teardownPlugins();
    await activeStorageBackend?.close?.();
  }

  if (!isEphemeral) {
    process.stderr.write(
      `\nTo resume: matbot --provider ${providerName} --session ${session.id}\n`
    );
  }
}

main().catch(e => {
  process.stderr.write(`Fatal: ${String(e)}\n`);
  process.exit(1);
});

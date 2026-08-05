#!/usr/bin/env node
import { loadConfig, loadConfigFromText, loadDotEnv } from './config.js';
import { installPlugin }                    from './install.js';
import { executeQuery }                     from '@matatbread/matbot-core/storage-base';
import { loadPluginsWithDescriptions, readPluginMeta, type PluginLoadRequest } from './plugin-description.js';
import { nodePluginResolver }               from './plugin-resolver.js';
import type { Principal, ProviderAdapter,
              ProviderConfig, Session,
              Store, StoreQuery, QueryResult, CASResult,
              MessageContent, FileStore, Usage } from '@matatbread/matbot-core';
import { appendMessage, createMessage,
         createSession,
         createSessionRunner,
         HookRegistry, SystemContextRegistryImpl, ToolRegistryImpl, ProviderRegistryImpl,
         instantiateProvider,
         teardownPlugins,
         unloadPlugin as unloadPluginFn,
         getPluginNameForSpecifier, getRegisteredPlugins, recordServiceKey,
         installPrincipalCarrier, installUsageCarrier, recordUsage, usageByProvider, addUsage, enterPrincipal, currentPrincipal,
         unifyServices, forwardingProxy, makeSwappable, singleTurnRequest,
         createMountTable, onContextQuiesce, flushIfQuiescent,
         createSingleTurnTool, createAboutMatbotTool,
         isMissingSecretError, createNotifier, notifyingStore,
         wireDescription}            from '@matatbread/matbot-core';
import type { MatbotMachine, MatbotServices, PluginSettings, Vault, SessionRunner, Notifier,
              MatbotPlugin, StorageBackend, KnowledgeIndex, PromptFn, FormField, SwapFn } from '@matatbread/matbot-core';
import { systemPrincipal }                 from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier }       from './principal-als.js';
import { createAlsUsageCarrier }           from './usage-als.js';
import { EnvFileVault }                     from './env-vault.js';
import { FilesystemStore }                 from '@matatbread/matbot-storage-filesystem';
import { FilesystemFileStore }             from '@matatbread/matbot-files-node';
import { createBuiltinTools, createProviderTool, classifySpecifier, materializeRemote } from '@matatbread/matbot-tool-plugin';
import { LookupKnowledgeIndex }               from '@matatbread/matbot-core';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync }                     from 'node:fs';
import { createInterface }                 from 'node:readline/promises';
import { createRequire, stripTypeScriptTypes } from 'node:module';
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
  return dim(`${String.fromCodePoint(0x1F4CC)} ${part.creator}: ${JSON.stringify(part.data)}`);
}

/** Render one provider's usage as terse parts, omitting any zero count. Empty ⇒ nothing to show. */
function formatUsageParts(u: Usage): string[] {
  const parts: string[] = [];
  if (u.inputTokens         > 0) parts.push(`↑${u.inputTokens}`);
  if (u.outputTokens        > 0) parts.push(`↓${u.outputTokens}`);
  if ((u.cacheReadTokens     ?? 0) > 0) parts.push(`${u.cacheReadTokens} cached`);
  if ((u.cacheCreationTokens ?? 0) > 0) parts.push(`+${u.cacheCreationTokens} written`);
  if ((u.costUsd             ?? 0) > 0) parts.push(`≈$${u.costUsd!.toFixed(4)}`);
  return parts;
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
 *  - remote → fetch the module graph into `.plugins/` (idempotent; a restart loads from cache, but
 *             `forceRefresh` from a reload evicts the subtree first to re-download changed source) and
 *             point at the cached entry — bare imports then resolve up to the host's node_modules;
 *  - npm / tarball / git → resolved through the project's module graph (pnpm installs them); a bare
 *             name passes through if not yet on disk so loadPlugins can emit the warning.
 *
 * This is the single funnel for both startup and runtime (`plugin add` / hot-load) resolution.
 */
// Resolve npm specifiers against the CLI's own install as well as the config dir. The bundled
// provider adapters are dependencies of the CLI, not of an arbitrary config dir, so a source
// checkout never symlinks them into `<configDir>/node_modules` — only the CLI's own require reaches
// them (the same anchor discoverProviders uses). The first-run wizard stores the bare package name
// (portable once matbot is installed), so without this anchor no turn could load it in a checkout.
const appRequire = createRequire(import.meta.url);

/** Resolve `spec` through `req`, returning the resolved path or undefined when it isn't installed. */
function tryResolve(req: ReturnType<typeof createRequire>, spec: string): string | undefined {
  try { return req.resolve(spec); } catch { return undefined; }
}

async function resolvePluginSpecifiers(specifiers: readonly string[], configDir: string, forceRefresh = false): Promise<PluginLoadRequest[]> {
  const req = createRequire(path.join(configDir, '_'));
  const dotPlugins = path.join(configDir, '.plugins');
  const results: PluginLoadRequest[] = [];

  for (const spec of specifiers) {
    const classified = await classifySpecifier(spec, configDir);
    let importSpec: string;

    if (classified.kind === 'remote') {
      try {
        importSpec = pathToFileURL(await materializeRemote(spec, dotPlugins, configDir, forceRefresh)).href;
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
      // Prefer the config dir (a package the user installed in their own project); fall back to the
      // CLI's own install so bundled adapters referenced by bare name still resolve in a source checkout.
      const entry = tryResolve(req, spec) ?? tryResolve(appRequire, spec);
      if (entry === undefined) {
        results.push({ spec, importSpec: spec });  // not on disk — let loadPlugins emit the warning
        continue;
      }
      importSpec = pathToFileURL(entry).href;
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
      if (!isMissingSecretError(e)) throw e;
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
  /** `--dump-tools [path]`: serialize the live tool registry to this file and exit (default tools-dump.json). */
  dumpTools?:  string;
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
      case '--dump-tools':  {
        const v = args[i + 1];
        if (v !== undefined && !v.startsWith('-')) { opts.dumpTools = v; i++; }
        else opts.dumpTools = 'tools-dump.json';
      } break;
      case '--help': printHelp(); process.exit(0);
      case '--version': case '-v': process.stdout.write(versionBanner() + '\n'); process.exit(0);
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

// Walk up from a resolved module entry to the owning package.json (a package's `exports` may not
// expose package.json), returning the `name`d package's version.
function pkgVersionAt(entryPath: string, name: string): string {
  let dir = path.dirname(entryPath);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === name) return pkg.version ?? '?';
    } catch { /* no package.json here — keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) return '?';
    dir = parent;
  }
}

function selfVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: string };
    return pkg.version ?? '?';
  } catch { return '?'; }
}

// One line naming the CLI version and the *resolved* singleton versions. plugin-api is resolved
// *through* core (cli → core → plugin-api), which is both how the import graph actually reaches it and
// the exact instance the principal carrier lives in. A mismatch means two physical copies of a host
// singleton are loaded (a skewed / in-place-upgraded install) — the condition that splits shared
// module state — so we surface it loudly here rather than let it fail obscurely at the first read.
function versionBanner(): string {
  const cli = selfVersion();
  let core = '?', api = '?';
  try {
    const coreEntry = createRequire(import.meta.url).resolve('@matatbread/matbot-core');
    core = pkgVersionAt(coreEntry, '@matatbread/matbot-core');
    try {
      const apiEntry = createRequire(coreEntry).resolve('@matatbread/matbot-plugin-api');
      api = pkgVersionAt(apiEntry, '@matatbread/matbot-plugin-api');
    } catch { /* plugin-api unresolved from core — leave '?' */ }
  } catch { /* core unresolved — leave '?' */ }
  let line = `matbot v${cli} (core ${core}, plugin-api ${api}, isSubAgent ${isBackground})`;
  if ((core !== cli && core !== '?') || (api !== cli && api !== '?')) {
    line += '\n⚠ version skew: the CLI and a shared singleton resolve to different copies. Run a clean '
          + 'reinstall (rm -rf node_modules package-lock.json && npm i) — duplicate copies can split shared state.';
  }
  return line;
}

function printHelp(): void {
  process.stderr.write(`
matbot — AI CLI

Usage:
  matbot [options] [prompt]
  matbot start [options]      Headless server mode: load plugins and wait for a frontend

Options:
  --provider    <name>      Provider key from matbot.yaml (default: first in file)
  --session     <id>|create Resume an existing session, or "create" to start a new persistent one
  --system      <text>      System prompt injected at session start
  --config      <path>      Config file path (default: ./matbot.yaml)
  --prompt-file <path>      Read prompt from file; run single turn and exit
  --ephemeral               Force ephemeral even when --session is given
  --dump-tools  [path]      Serialize the live tool registry (wire descriptions with folded TS
                            contracts + inputSchema) to a JSON file and exit (default tools-dump.json)
  --principal   <id|json>   Boot identity: an id (type "user") or JSON {"id","type"}.
                            Overrides MATBOT_PRINCIPAL and config principal:.
  --help                    Show this help
  --version, -v             Print the CLI + resolved core/plugin-api versions and exit

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
  let thinkingTicks = 0;
  let turnTraceId: string | undefined;

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
    turnTraceId = view.traceId;
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
        case 'tool:progress': write(`\r[${ev.pct}%]${ev.message ? ' ' + ev.message : ''}`); break;
        case 'tool:end':    write(`\n`); break;
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
  // Per-provider token accounting for this turn, from the persisted session (so it includes spend by
  // tools that ran their own completions — single_turn, ask_inner_voice, dream_time), eliding zero counts.
  const turnUsage = usageByProvider(updated.messages.filter(m => m.traceId === turnTraceId));
  const lines = [...turnUsage]
    .map(([prov, u]) => ({ prov, parts: formatUsageParts(u) }))
    .filter(e => e.parts.length > 0);
  if (lines.length === 1 && lines[0] !== undefined) {
    write(`[tokens · ${lines[0].prov}] ${lines[0].parts.join(' ')}\n`);
  } else if (lines.length > 1) {
    write('[tokens]\n');
    for (const e of lines) write(`  ${e.prov}: ${e.parts.join(' ')}\n`);
  }

  return updated;
}

// ── Main ───────────────────────────────────────────────────────────────────────

// ── Setup wizard ───────────────────────────────────────────────────────────────

interface ProviderPackage { type: string; name: string; dir: string; }

// The provider adapters the CLI ships with (its dependencies). Resolved through the module graph
// rather than a directory scan, so discovery works identically when installed (node_modules) and in
// the monorepo (workspace symlinks). A user can `plugin add` other providers after setup.
// Listing a name here is not enough: it must also be a dependency of this package, or nothing links
// it into the CLI's node_modules and the resolve below silently skips it.
const BUNDLED_PROVIDERS = [
  '@matatbread/matbot-provider-anthropic',
  '@matatbread/matbot-provider-openai-compat',
  '@matatbread/matbot-provider-google',
  '@matatbread/matbot-provider-customer-services',
  '@matatbread/matbot-provider-chatjimmy'
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

    // Reference the provider by package name — the location-independent form. It resolves via
    // node_modules when matbot is installed, and in a source checkout via resolvePluginSpecifiers'
    // CLI-anchored fallback (the bundled adapters are the CLI's own dependencies, not the config
    // dir's), so the written config is portable either way.
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
  installUsageCarrier(createAlsUsageCarrier());
  enterPrincipal(resolveBootPrincipal(opts, matbotConfig));

  process.stderr.write(`[${new Date().toISOString()} ${_pid}] [matbot] ${versionBanner()}\n`);

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

  // The live provider registry: seeded from matbot.yaml, mutated in place by canonicalisation, the
  // `provider` tool, and (once a storage backend takes over) profiles replayed from its medium. Its
  // ReadonlyMap surface serves every read-only consumer; `register`/`remove` are the write path.
  const providers = new ProviderRegistryImpl(matbotConfig.providers);

  // Resolve plugin specifiers here so we can pre-scan for a storage backend before
  // creating stores. Node caches the imported modules, so loadPlugins below is free.
  const providerModules: string[] = [];
  const seenProviderModules = new Set<string>();
  for (const cfg of providers.values()) {
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
  // The boot notification bus: in-process fan-out, everything the host itself publishes attributed to
  // `core`. Swappable like the vault — register('Notifier', …) points this at a distributed impl.
  let activeNotifier: Notifier = createNotifier('core');
  const notifierProxy       = forwardingProxy<Notifier>(() => activeNotifier);
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

  // sessions and fileStore are stable proxy references — safe to capture anywhere. Sessions are wrapped
  // so every write announces itself: the namespace has many writers (the turn pump's title derivation and
  // persists, session_action rename/hide/unhide, session_edit fork/split, a session minted over HTTP), and
  // one wrapper covers them all — including the next writer to arrive.
  const store     = notifyingStore(createStore<Session>('sessions'), notifierProxy, 'sessions', 'session');

  // Boot defaults, captured for revert-on-unregister: a plugin that swaps a core service in via
  // register() reverts to these when it is unloaded, instead of leaving a dangling reference to the
  // now-gone impl. (bootBackend/bootFileStore are captured above, before the pre-scan, so a
  // config-supplied backend never poses as the host base.)
  const bootVault                  = activeVault;
  const bootKnowledge              = knowledgeImpl;
  const bootNotifier               = activeNotifier;

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
  const toolReg = new ToolRegistryImpl(createBuiltinTools(), notifierProxy);

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
      else if (key === 'Notifier')       activeNotifier = value as Notifier;
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
      else if (key === 'Notifier')       activeNotifier = bootNotifier;
      else serviceRegistry.delete(key);
      if (key !== 'StorageBackend') { mountTable.markDirty(key as keyof MatbotServices); flushIfQuiescent(); }
    },
    registerFrontend() { /* bound per-plugin in setupPlugin's scopedServices; base is a no-op */ },

    async complete(req) {
      const rawCfg = providers.get(req.provider);
      if (rawCfg === undefined) {
        throw new Error(
          `complete(): unknown provider "${req.provider}". ` +
          `Available: ${[...providers.keys()].join(', ')}`,
        );
      }
      const resolved: ProviderConfig = {
        ...rawCfg,
        // Per-call overrides shallow-merged over the config's own parameters (request wins).
        ...(req.parameters     !== undefined ? { parameters: { ...rawCfg.parameters, ...req.parameters } } : {}),
        ...(rawCfg.credentials !== undefined ? { credentials: await resolveCredentials(rawCfg.credentials, vault) } : {}),
        ...(rawCfg.endpoint    !== undefined ? { endpoint: await vault.resolve(rawCfg.endpoint) } : {}),
      };
      const adpt = await instantiateProvider(services, resolved);
      if (adpt === null) throw new Error(`complete(): provider "${req.provider}" has no loadable adapter (module "${resolved.module}").`);
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
      // Folded exactly as the runner folds a turn's usage, because an adapter may report one call's
      // usage in several parts: anthropic sends input + cache counts on `message_start` and output on
      // `message_delta`. Taking the last event instead of folding therefore reported inputTokens 0 and
      // no cache figures for every out-of-band completion against it.
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      for await (const ev of adpt.complete(msgs, resolved, [], signal)) {
        if (ev.type === 'text-delta') text += ev.delta;
        if (ev.type === 'usage')      usage = addUsage(usage, ev);
      }
      // Report into the ambient usage sink: a tool running this completion (singleTurn/complete) has
      // its spend attributed to the tool call by the runner. No-op outside any tool scope.
      recordUsage(req.provider, usage);
      return { text, usage };
    },
    async singleTurn(req) {
      return this.complete(singleTurnRequest(req));
    },
    async loadPlugin(specifier: string, prompt?: PromptFn, refresh = false) {
      // refresh re-downloads a changed remote source rather than re-importing the stale cached subtree
      // (the file:// cache-bust only re-evaluates bytes, it can't refetch them). Default off: a
      // programmatic load stays cache-first and offline-tolerant. `plugin reload` opts in.
      const resolved = await resolvePluginSpecifiers([specifier], path.dirname(configPath), refresh);
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
    providers,
    mounted:   mountTable.mounted,
    get StorageBackend() { return activeStorageBackend === undefined ? undefined : storageBackendProxy; },
    sessions:  store,
    get run() { return sessionRunner; },
    files:     fileStore,
    Vault:     vault,
    Notifier:  notifierProxy,
    hooks:          hookReg,
    tools:          toolReg,
    systemContext:  systemContextReg,
    workdir:    workDir,
    configPath,
    isSubAgent: () => isBackground,
    get KnowledgeIndex() { return knowledgeProxy; },
    TypeScriptStripper: { strip: (source: string) => stripTypeScriptTypes(source) },
  };
  const services: MatbotMachine = unifyServices(baseServices);

  // resolveProvider reads the registry lazily (per turn), so it sees both the canonicalised module
  // names set below and any live `provider add/remove` edits. instantiateProvider force-loads the
  // adapter module if its factory isn't registered yet (a runtime-contributed profile), warning and
  // yielding null — rather than throwing — if it can't be found.
  const resolveProvider = async (name: string): Promise<{ adapter: ProviderAdapter; config: ProviderConfig } | null> => {
    const cfg = providers.get(name);
    if (cfg === undefined) return null;
    const resolved: ProviderConfig = {
      ...cfg,
      ...(cfg.credentials !== undefined ? { credentials: await resolveCredentials(cfg.credentials, vault) } : {}),
      ...(cfg.endpoint    !== undefined ? { endpoint: await vault.resolve(cfg.endpoint) } : {}),
    };
    const adapter = await instantiateProvider(services, resolved);
    return adapter === null ? null : { adapter, config: resolved };
  };

  // One runner per store: frontends share this one over the persistent sessions store, but the CLI
  // can instantiate its own over an ephemeral MemoryStore (see main). That a SessionRunner composes
  // over *any* Store is the point — nothing about the agentic loop is bound to a single backend.
  const makeRunner = (sessionStore: Store<Session>): SessionRunner => createSessionRunner({
    store:         sessionStore,
    resolveProvider,
    tools:         toolReg,
    toolTypeIndex: () => services.ToolTypeIndex,   // resolved live: the tool-types plugin registers it after boot
    toolPresenter: () => services.ToolPresenter,   // resolved live: a tool-search/deferral plugin registers it after boot
    steeringPolicy: () => services.SteeringPolicy, // resolved live: a steering plugin registers it after boot
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

  // Historically loaded provider plugins first so their factories were registered (by plugin name)
  // before any frontend's setup() resolved an adapter. No consumer resolves adapters at setup() now —
  // frontends and the central complete()/singleTurn() all go through instantiateProvider, which
  // force-loads the adapter module on first use. Pre-scan disabled; restore this line to re-enable it.
  // await loadPluginsWithDescriptions(resolvedProviderMods, services, path.dirname(configPath));

  // No canonicalisation of stored profiles: `instantiateProvider` resolves a specifier to its loaded
  // plugin's factory at use time and leaves the profile's `module` exactly as written, so `provider list`
  // reports the source truth (a yaml path stays a yaml path) instead of drifting to the package name once
  // a profile is touched.

  // Map plugin name → the original module specifier written in matbot.yaml. Used by the provider
  // tool as the write-back fallback for a local adapter that has no resolvable package name, and to
  // match an LLM-supplied path against a loaded adapter.
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

  // Whether an adapter's canonical package name is resolvable at load time — the same two-anchor
  // resolution the loader uses (config dir, then the CLI's own install for a bundled adapter). Only
  // the host can answer this, so the provider tool takes it as a predicate: it prefers the package
  // name (location-independent) whenever it resolves, falling back to a path for a local-only adapter
  // that has no resolvable name. Pure string resolution — independent of whether the adapter, which
  // may load lazily on first use, is registered yet.
  const configRequire = createRequire(path.join(path.dirname(configPath), '_'));
  const providerNameResolves = (name: string): boolean =>
    tryResolve(configRequire, name) !== undefined || tryResolve(appRequire, name) !== undefined;

  // Register the provider management tool now that all adapter plugins are loaded and
  // their YAML specifiers are recorded — createProviderTool reads getRegisteredPlugins()
  // and pluginNameToOrigPath to build its description.
  toolReg.register(createProviderTool(providers, pluginNameToOrigPath, providerNameResolves));

  // single_turn: the model-facing surface of the core singleTurn service. Registered here beside the
  // other core service-management tools (it needs the live `services` for `singleTurn`/`providers`).
  toolReg.register(createSingleTurnTool(services));

  // about_matbot: the harness's own version + description. The harness isn't a plugin (no `plugin list`
  // row), so this singleton fact gets a dedicated tool; the app passes its own package version.
  toolReg.register(createAboutMatbotTool(selfVersion()));

  // ── Dump tools (one-shot) ───────────────────────────────────────────────────────
  // `--dump-tools [path]`: serialize the live registry and exit. Each tool's `description` is the WIRE
  // description — its raw description with the ToolContracts / `toolContract` TS shapes folded in by
  // ToolTypeIndex.wireContracts(), exactly as the model sees it — plus its `inputSchema` and any
  // soft-tool `toolContract`. Runs here so every plugin + core tool is registered and the type index is
  // populated; exits before the server/REPL. Used to build corpora for the tool-search work.
  if (opts.dumpTools !== undefined) {
    const wire = await services.ToolTypeIndex?.wireContracts();
    const dump = toolReg.list().map(t => {
      const wc = wire?.[t.name];
      return {
        name:        t.name,
        description: wireDescription(t.description, wc),
        inputSchema: t.inputSchema,
        ...(t.toolContract !== undefined ? { toolContract: t.toolContract } : {}),
      };
    });
    const outPath = path.resolve(opts.dumpTools);
    await writeFile(outPath, JSON.stringify(dump, null, 2), 'utf8');
    process.stderr.write(`[matbot] dumped ${dump.length} tools → ${outPath}\n`);
    process.exit(0);
  }

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

  const providerName = opts.provider ?? matbotConfig.defaultProvider ?? (providers.keys().next().value as string);
  const rawConfig    = providers.get(providerName);
  if (!rawConfig) {
    throw new Error(
      `Unknown provider "${providerName}". Available: ${[...providers.keys()].join(', ')}`
    );
  }

  const providerConfig: ProviderConfig = {
    name:        rawConfig.name,
    module:      rawConfig.module,
    model:       rawConfig.model,
    ...(rawConfig.credentials !== undefined ? { credentials: await resolveCredentialsInteractive(rawConfig.credentials, vault) } : {}),
    ...(rawConfig.endpoint    !== undefined ? { endpoint: await vault.resolve(rawConfig.endpoint) } : {}),
    ...(rawConfig.parameters  !== undefined ? { parameters: rawConfig.parameters } : {}),
    ...(rawConfig.maxRounds   !== undefined ? { maxRounds:  rawConfig.maxRounds  } : {}),
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
    session = createSession();
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

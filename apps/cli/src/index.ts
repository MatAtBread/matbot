#!/usr/bin/env node
import { loadConfig, loadConfigFromText, loadDotEnv } from './config.js';
import { installPlugin }                    from './install.js';
import { executeQuery }                    from '@matatbread/matbot-core/storage-base';
import { loadPluginsWithDescriptions, readPluginMeta, type PluginLoadRequest } from './plugin-description.js';
import { nodePluginResolver }               from './plugin-resolver.js';
import type { Principal, ProviderConfig, Session,
              Store, StoreQuery, QueryResult, CASResult,
              MessageContent, UserContent, Usage } from '@matatbread/matbot-core';
import { appendMessage, createMessage,
         createSession,
         ProviderRegistryImpl,
         teardownPlugins,
         unloadPlugin as unloadPluginFn,
         getPluginNameForSpecifier, getRegisteredPlugins,
         installPrincipalCarrier, installUsageCarrier, usageByProvider, enterPrincipal, currentPrincipal,
         assembleMachine, preScanStorage,
         isMissingSecretError, optionValue, optionLabel,
         CONFIRM_YES, CONFIRM_NO,
         wireDescription}            from '@matatbread/matbot-core';
import type { Vault, SessionRunner, PromptFn, FormField } from '@matatbread/matbot-core';
import { defaultGate }                     from '@matatbread/matbot-default-gate';
import { systemPrincipal }                 from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier }       from './principal-als.js';
import { createAlsUsageCarrier }           from './usage-als.js';
import { EnvFileVault }                     from './env-vault.js';
import { createVmFunctionRunner, FUNCTION_SYNC_LIMIT_MS } from './function-runner.js';
import { FilesystemStorageBackend }        from '@matatbread/matbot-storage-filesystem';
import { createBuiltinTools, createProviderTool, classifySpecifier, materializeRemote, remoteDependencyNotes,
         findDuplicateSingletons, describeDuplicateSingleton, type MaterializedRemote } from '@matatbread/matbot-tool-plugin';
import { access, mkdir, readFile, writeFile }          from 'node:fs/promises';
import { readFileSync, realpathSync }       from 'node:fs';
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
    if (isBackground && level !== 'error') return;
    // Diagnostics are harness chatter: open yellow on the prefix and close it as a trailing argument,
    // so any object args in between are still coloured rather than only the first one.
    const on = level === 'log' ? ttyOut : ttyErr;
    if (on) orig(`\x1b[33m[${new Date().toISOString()} ${_pid}] ${label}`, ...args, '\x1b[0m');
    else    orig(`[${new Date().toISOString()} ${_pid}] ${label}`, ...args);
  };
}
// Colour only when writing to an interactive terminal — piped/background output stays clean. The two
// streams are asked separately because they carry different things: the assistant's answer is the only
// thing on stdout (so it survives a pipe uncoloured), everything else is stderr.
const ttyErr = !isBackground && process.stderr.isTTY === true;
const ttyOut = !isBackground && process.stdout.isTTY === true;
// Whitespace-only text is left alone so a bare newline doesn't carry a pair of escapes.
const paint = (on: boolean, code: string) => (s: string): string =>
  (on && s.trim() !== '' ? `\x1b[${code}m${s}\x1b[0m` : s);

const yellow  = paint(ttyErr, '33');   // tools, thinking, markers, accounting — the machinery
const dim     = paint(ttyErr, '2');
const cyanErr = paint(ttyErr, '36');   // the assistant, on the stderr side (its label)
const cyanOut = paint(ttyOut, '36');   // the assistant's own words

// Everything written through `write` is harness chatter, hence yellow.
const write = isBackground ? (_text: string) => {} : (text: string) => process.stderr.write(yellow(text));

// A prompt is chatter, but the line the user types back is theirs: leave the colour OPEN past the
// prompt so readline's echo is white, and close it once the answer is in. Node measures prompt width
// with ANSI stripped, so the trailing escape doesn't upset wrapping.
const askPrompt = (prompt: string): string => (ttyErr ? `\x1b[33m${prompt}\x1b[0m\x1b[37m` : prompt);
const endInput  = (): void => { if (ttyErr) process.stderr.write('\x1b[0m'); };

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
  // Deferred to after the loop: a remote plugin's dependency may be another remote plugin configured
  // LATER, whose files (and name link) do not exist while this one is being fetched.
  const materialized: { spec: string; m: MaterializedRemote }[] = [];
  const adviceBySpec = new Map<string, string>();

  for (const spec of specifiers) {
    const classified = await classifySpecifier(spec, configDir);
    let importSpec: string;

    if (classified.kind === 'http') {
      // A specifier that still works but should be rewritten: said once at boot, and carried as a note so
      // it is also attached to the failure if this plugin turns out not to load.
      if (classified.advice !== undefined) {
        console.warn(`[matbot] ${classified.advice}`);
        adviceBySpec.set(spec, classified.advice);
      }
      try {
        const m = await materializeRemote(spec, dotPlugins, configDir, forceRefresh);
        importSpec = pathToFileURL(m.entry).href;
        materialized.push({ spec, m });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(`[matbot] Could not fetch remote plugin "${spec}": ${reason}`);
        // Unresolved: loadPlugins reports the failure, but importing an http URL fails on the scheme
        // and says nothing about the fetch — so hand it the reason we already have.
        results.push({ spec, importSpec: spec, notes: [`could not be fetched: ${reason}`] });
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
      ...(meta.version  !== undefined ? { version:  meta.version }  : {}),
      ...(meta.runtimes !== undefined ? { runtimes: meta.runtimes } : {}),
    });
  }

  // Every remote is now on disk, so an unsatisfied dependency really is unsatisfied. Warned here
  // because the plugin may well load anyway (an unused declaration, an import the regex over-collected);
  // carried as `notes` so that IF it does fail, the recorded failure says why rather than naming a file.
  for (const { spec, m } of materialized) {
    const notes = await remoteDependencyNotes(m);
    for (const note of notes) console.warn(`[matbot] Plugin "${spec}" ${note}`);
    const advice = adviceBySpec.get(spec);
    const all = advice !== undefined ? [...notes, advice] : notes;
    if (all.length === 0) continue;
    const entry = results.find(r => r.spec === spec);
    if (entry !== undefined) entry.notes = all;
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
          const value = await rl.question(askPrompt(`Secret required — ${name}: `)).finally(endInput);
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

const SINGLETONS = ['@matatbread/matbot-core', '@matatbread/matbot-plugin-api'];

// Walk up from a resolved module entry to the owning package.json (a package's `exports` may not
// expose package.json), returning the `name`d package's real directory and version.
function packageAt(entryPath: string, name: string): { root: string; version: string } | undefined {
  let dir = path.dirname(entryPath);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === name) return { root: realpathSync(dir), version: pkg.version ?? '?' };
    } catch { /* no package.json here — keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function selfPackage(): { version?: string; dependencies?: Record<string, string> } {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: string; dependencies?: Record<string, string> };
  } catch { return {}; }
}

function selfVersion(): string {
  return selfPackage().version ?? '?';
}

function resolvePackage(from: string, name: string): { root: string; version: string } | undefined {
  try { return packageAt(createRequire(from).resolve(name), name); } catch { return undefined; }
}

// The singletons as reached from the CLI and from each of its own dependencies — every importer the
// CLI brings, so a nested copy under one of them is found.
function singletonCopies(dependencies: readonly string[]): Map<string, Set<string>> {
  const self = fileURLToPath(import.meta.url);
  const importers = [self, ...dependencies.flatMap(d => {
    try { return [createRequire(self).resolve(d)]; } catch { return []; }
  })];
  const copies = new Map<string, Set<string>>();
  for (const name of SINGLETONS) {
    const roots = new Set<string>();
    for (const from of importers) {
      const at = resolvePackage(from, name);
      if (at) roots.add(at.root);
    }
    copies.set(name, roots);
  }
  return copies;
}

// One line naming the CLI version and the *resolved* singleton versions. plugin-api is resolved
// *through* core (cli → core → plugin-api), which is how the import graph actually reaches it and the
// exact instance the principal carrier lives in. The warning compares resolved DIRECTORIES, never
// version numbers: packages are versioned independently (a frontend release bumps the CLI and not core),
// so differing numbers are normal, while two physical copies of a singleton are what split shared
// module state — and they can carry the same version.
function versionBanner(): string {
  const pkg = selfPackage();
  const core = resolvePackage(fileURLToPath(import.meta.url), '@matatbread/matbot-core');
  const api = core ? resolvePackage(path.join(core.root, 'package.json'), '@matatbread/matbot-plugin-api') : undefined;
  let line = `matbot v${pkg.version ?? '?'} (core ${core?.version ?? '?'}, plugin-api ${api?.version ?? '?'}, isSubAgent ${isBackground})`;
  for (const [name, roots] of singletonCopies(Object.keys(pkg.dependencies ?? {}))) {
    if (roots.size < 2) continue;
    line += `\n⚠ duplicate singleton: ${name} resolves to ${roots.size} copies (${[...roots].join(', ')}). Run a clean `
          + 'reinstall (rm -rf node_modules package-lock.json && npm i) — duplicate copies split shared state.';
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
  content:      string | UserContent[],
  run:          SessionRunner,
  providerName: string,
  principal:    Principal,
  promptFn:     PromptFn,
): Promise<Session> {
  const ac       = new AbortController();
  // Ctrl-C aborts the running turn (and drops anything queued) through the runner.
  const onSigint = (): void => { run.abort(session.id); };
  process.once('SIGINT', onSigint);

  const contentArr: UserContent[] = typeof content === 'string'
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
          // Per delta rather than one span opened at the turn's start: tool output interleaves, and
          // each of those ends with a reset that would otherwise drop the assistant back to default.
          process.stdout.write(cyanOut(ev.delta));
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
          if (text) { write(`[context] ${text}\n`); process.stderr.write(cyanErr('assistant: ')); }
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
                // The FIELD, not a label + a hand-built hint: passing a synthesised string took the
                // free-text branch of the prompt, so a form's select answer came back as whatever was
                // typed — unresolved, and never the option's value. One resolver, every path.
                values[field.name] = await promptFn(field);
              }
              process.removeListener('SIGINT', onSigint);
              ac.abort();
              return await runTurn(ev.session, [{ type: 'form-response', values }], run, providerName, principal, promptFn);
            }
          } else {
            process.stderr.write(yellow(`\n[aborted: ${ev.reason}]\n`));
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
        case 'error': clearThinking(); process.stderr.write(yellow(`\n[error: ${ev.error}]\n`)); break;
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
    try { return (await rl.question(askPrompt(`${question}: `))).trim(); } finally { endInput(); }
  };

  try {
    process.stderr.write(yellow('\nNo providers configured. Let\'s set one up.\n\n'));

    const discovered = await discoverProviders();
    if (discovered.length === 0) {
      throw new Error('No provider packages found. Cannot continue setup.');
    }

    process.stderr.write(yellow('Available provider types:\n'));
    for (let i = 0; i < discovered.length; i++) {
      process.stderr.write(yellow(`  ${i + 1}. ${discovered[i]!.type}  (${discovered[i]!.name})\n`));
    }
    process.stderr.write(yellow('\n'));

    let chosen!: ProviderPackage;
    for (;;) {
      const choice = await ask(`Choose a type [1-${discovered.length}]`);
      const n = parseInt(choice, 10);
      if (n >= 1 && n <= discovered.length) { chosen = discovered[n - 1]!; break; }
      process.stderr.write(yellow(`Please enter a number between 1 and ${discovered.length}.\n`));
    }

    let providerName = '';
    for (;;) {
      providerName = await ask(`Provider name (how this LLM key is named in ${configPath} and presented to you)`);
      if (providerName) break;
      process.stderr.write(yellow('Provider name is required.\n'));
    }

    let model = '';
    for (;;) {
      model = await ask('Model name');
      if (model) break;
      process.stderr.write(yellow('Model name is required.\n'));
    }

    let endpoint = await ask('Endpoint URL');
    let apiKey = await ask('API key');

    if (endpoint && !endpoint.startsWith('http')) {
      process.stderr.write(yellow(`\nTesting ${endpoint}… `));
      const reachable = await testEndpointReachable(endpoint);
      if (!reachable) {
        process.stderr.write(yellow('reachable\n'));
      } else {
        process.stderr.write(yellow(reachable + '\n'));
        const cont = await ask('Continue with this endpoint anyway? [y/N]');
        if (cont.toLowerCase() !== 'y') {
          process.stderr.write(yellow('Setup cancelled.\n'));
          process.exit(1);
        }
      }
    }
    const configDir = path.dirname(configPath);
    const varName   = `MATBOT_API_KEY_${providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

    // What was typed at the API key prompt may be the NAME of a key the .env already holds rather
    // than a secret, and nothing here can tell the two apart — which is what createSecret is for.
    // Writing .env by hand bypassed it, so naming an existing key minted a synthetic
    // MATBOT_API_KEY_* whose value was that key's name.
    const wizardVault = new EnvFileVault(
      path.join(configDir, '.env'),
      process.env as Record<string, string | undefined>,
    );
    const keyName = apiKey ? await wizardVault.createSecret(varName, apiKey) : undefined;
    // The boot vault is built from process.env, so carry the secret across. Resolve rather than
    // reuse `apiKey`: where that was a reference, the string is a key name, and assigning it
    // would overwrite the very key being referenced.
    if (keyName !== undefined) process.env[keyName] = await wizardVault.resolve(`\${${keyName}}`);

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
      ...(keyName !== undefined ? ['    credentials:', `      apiKey: \${${keyName}}`] : []),
    ].join('\n') + '\n';

    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, yaml, 'utf8');
    process.stderr.write(yellow(`\nConfiguration written to ${configPath}\n\n`));

    return {
      plugins:   [],
      providers: new Map([[providerName, {
        name:        providerName,
        module:      moduleSpec,
        model,
        // The placeholder, not the typed string: this run must resolve the same key the written
        // config names, or a reference would be posted to the endpoint as if it were the secret.
        ...(keyName !== undefined ? { credentials: { apiKey: `\${${keyName}}` } } : {}),
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
      process.stderr.write(yellow('Usage: matbot install <package>\n'));
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

  process.stderr.write(yellow(`[${new Date().toISOString()} ${_pid}] [matbot] ${versionBanner()}\n`));

  const configDir = path.dirname(configPath);
  const dotData   = path.join(configDir, '.data');

  // Resolve plugin specifiers here so we can pre-scan for a storage backend before any store exists.
  // A plugin with storageBackend replaces the host's filesystem stores, so it must be listed before any
  // plugin whose setup() calls createStore.
  const providers            = new ProviderRegistryImpl(matbotConfig.providers);
  const providerModules      = [...new Set([...providers.values()].map(cfg => cfg.module))];
  const resolvedProviderMods = await resolvePluginSpecifiers(providerModules, configDir);
  const resolvedPluginMods   = await resolvePluginSpecifiers(matbotConfig.plugins, configDir);
  const preScanned           = await preScanStorage([...resolvedProviderMods, ...resolvedPluginMods], dotData);

  // Model-authored code shares the one event loop with every session and frontend, so a loop in a
  // tool_function that never awaits would freeze the daemon. Seeded, like MediaStore, so a plugin may
  // replace it and unregistering reverts here. `function_timeout_ms: 0` seeds none: bodies then run directly
  // and unbounded — what a host with no runner does — which is kept reachable for testing.
  const functionTimeoutMs = matbotConfig.functionTimeoutMs ?? FUNCTION_SYNC_LIMIT_MS;
  const functionRunner = functionTimeoutMs > 0 ? createVmFunctionRunner(functionTimeoutMs) : undefined;
  if (functionRunner === undefined) console.warn('[matbot] function_timeout_ms is 0: tool_function bodies run unbounded, and one that loops without awaiting will freeze this process.');

  const { services, makeRunner, loaded } = assembleMachine({
    // The same layout the filesystem storage plugin names: a directory per namespace under `.data`.
    bootBackend:     new FilesystemStorageBackend(dotData),
    preScanned,
    vault:           new EnvFileVault(path.join(configDir, '.env'), process.env as Record<string, string | undefined>),
    providers,
    gate:            defaultGate,
    defaultSettings: matbotConfig.defaultSettings,
    ...(functionRunner !== undefined ? { seed: { FunctionRunner: functionRunner } } : {}),
    builtinTools:    createBuiltinTools(),
    version:         selfVersion(),
    host: machine => ({
      async loadPlugin(specifier: string, prompt?: PromptFn, refresh = false) {
        // refresh re-downloads a changed remote source rather than re-importing the stale cached subtree
        // (the file:// cache-bust only re-evaluates bytes, it can't refetch them). Default off: a
        // programmatic load stays cache-first and offline-tolerant. `plugin reload` opts in.
        const resolved = await resolvePluginSpecifiers([specifier], configDir, refresh);
        const plugin   = (await loadPluginsWithDescriptions(resolved, machine(), configDir, /* bustCache */ true, prompt, /* onLoadError */ 'throw'))[0];
        if (plugin === undefined) throw new Error(`No plugin loaded for specifier "${specifier}"`);
        return plugin;
      },
      async unloadPlugin(specifier: string): Promise<boolean> {
        // A loaded plugin records its config-level specifier (= the matbot.yaml entry) and its canonical
        // name; accept either.
        const name = getPluginNameForSpecifier(specifier)
          ?? (getRegisteredPlugins().some(p => p.name === specifier) ? specifier : undefined);
        if (name === undefined) {
          console.warn(`[matbot] No loaded plugin found for "${specifier}"`);
          return false;
        }
        return unloadPluginFn(name, machine());
      },
      resolver:   nodePluginResolver(configDir),
      workdir:    path.join(dotData, 'bash-cwd'),
      configPath,
      isSubAgent: () => isBackground,
      TypeScriptStripper: { strip: (source: string) => stripTypeScriptTypes(source) },
    }),
  });
  const vault = services.Vault;
  const store = services.sessions!;

  // Historically loaded provider plugins first so their factories were registered (by plugin name)
  // before any frontend's setup() resolved an adapter. No consumer resolves adapters at setup() now —
  // frontends and the central complete()/singleTurn() all go through instantiateProvider, which
  // force-loads the adapter module on first use, and leaves each profile's `module` exactly as written,
  // so `provider list` reports the source truth.

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

  await loadPluginsWithDescriptions(resolvedPluginMods, services, configDir);
  loaded();

  // Said once, now that the installed set is known and before anything uses it. A second copy of a host
  // singleton is survivable by design — which is precisely why nothing else would ever mention it — and
  // it is not repaired here: replacing a package-manager-installed directory with a symlink invites the
  // next `install` to undo it. `plugin list` reports the same thing on demand.
  for (const dup of await findDuplicateSingletons({
    configDir,
    plugins:   getRegisteredPlugins(),
  })) console.warn(`[matbot] ${describeDuplicateSingleton(dup)}`);

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
  const configRequire = createRequire(path.join(configDir, '_'));
  const providerNameResolves = (name: string): boolean =>
    tryResolve(configRequire, name) !== undefined || tryResolve(appRequire, name) !== undefined;

  // Register the provider management tool now that all adapter plugins are loaded and
  // their YAML specifiers are recorded — createProviderTool reads getRegisteredPlugins()
  // and pluginNameToOrigPath to build its description.
  services.tools.register(createProviderTool(providers, pluginNameToOrigPath, providerNameResolves));

  // ── Dump tools (one-shot) ───────────────────────────────────────────────────────
  // `--dump-tools [path]`: serialize the live registry and exit. Each tool's `description` is the WIRE
  // description — its raw description with the ToolContracts / `toolContract` TS shapes folded in by
  // ToolTypeIndex.wireContracts(), exactly as the model sees it — plus its `inputSchema` and any
  // soft-tool `toolContract`. Runs here so every plugin + core tool is registered and the type index is
  // populated; exits before the server/REPL. Used to build corpora for the tool-search work.
  if (opts.dumpTools !== undefined) {
    const wire = await services.ToolTypeIndex?.wireContracts();
    const dump = services.tools.list().map(t => {
      const wc = wire?.[t.name];
      return {
        name:        t.name,
        description: wireDescription(t.description, wc),
        inputSchema: t.inputSchema,
        // Also unfolded, because the two artefacts on this object are what `check-tool-contracts.mjs`
        // compares — and recovering the contract by regexing it back out of the prose it was just
        // folded into would break on any description that happens to contain the same fence.
        ...(wc !== undefined ? { wireContract: wc } : {}),
        ...(t.toolContract !== undefined ? { toolContract: t.toolContract } : {}),
      };
    });
    const outPath = path.resolve(opts.dumpTools);
    await writeFile(outPath, JSON.stringify(dump, null, 2), 'utf8');
    process.stderr.write(yellow(`[matbot] dumped ${dump.length} tools → ${outPath}\n`));
    process.exit(0);
  }

  // ── Server mode ───────────────────────────────────────────────────────────────

  if (serverMode) {
    process.stderr.write(yellow(`[${new Date().toISOString()} ${_pid}] [matbot] server running — press Ctrl+C to stop\n`));
    const shutdown = (): void => {
      process.stderr.write(yellow('\n[matbot] shutting down…\n'));
      teardownPlugins()
      .then(async () => { await services.StorageBackend?.close?.(); process.exit(0); })
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
    process.stderr.write(yellow(`[${new Date().toISOString()} ${_pid}] provider: ${providerName}  (ephemeral)\n\n`));
  } else {
    process.stderr.write(yellow(`[${new Date().toISOString()} ${_pid}] provider: ${providerName}  session: ${session.id}\n\n`));
  }

  const runStore: Store<Session> = isEphemeral ? new MemoryStore<Session>() : store;
  // The runner loads the session before its first turn, so make sure it's resolvable: a fresh
  // ephemeral session has never been persisted. (Non-ephemeral sessions were loaded from runStore.)
  await runStore.set(session.id, session);
  // Reuse the shared runner over the persistent store; spin up a private one over the ephemeral
  // MemoryStore so a throwaway REPL session never shares a queue with the frontends.
  const cliRun: SessionRunner = isEphemeral ? makeRunner(runStore) : services.run!;

  // ── Readline (shared by single-turn and REPL for tool prompts) ──────────────
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.on('SIGINT', () => { endInput(); process.stderr.write('\n'); rl.close(); });

  // Every read goes through here so the answer's colour is always closed, including on a throw.
  const ask = async (prompt: string): Promise<string> => {
    try { return await rl.question(askPrompt(prompt)); } finally { endInput(); }
  };

  const stdinPrompt = (async (p: string | FormField, defaultValue?: string): Promise<string> => {
    if (typeof p !== 'string') {
      const def = p.default;
      if (p.type === 'select' || p.type === 'confirm') {
        const opts = p.type === 'confirm' ? [CONFIRM_YES, CONFIRM_NO] : (p.options ?? []);
        // Typed against the LABEL (it is what was shown), answered with the VALUE (it is what the
        // caller branches on). For a bare-string option the two are the same, which is every option
        // in the repo bar the permission gate's — so this is one indirection, not a new mode.
        const hint = opts.map(o => {
          const label = optionLabel(o);
          return def !== undefined && optionValue(o).toLowerCase() === def.toLowerCase() ? label.toUpperCase() : label;
        }).join('/');
        const raw  = (await ask(`${p.label} [${hint}] `)).trim();
        if (!raw) return def ?? '';
        const picked = opts.find(o => optionLabel(o).toLowerCase().startsWith(raw.toLowerCase()));
        // An unmatched answer falls back to the default rather than being returned verbatim: the caller
        // is branching on a token it published, and prose it never offered can only be a miss.
        return picked !== undefined ? optionValue(picked) : def ?? raw;
      }
      const suffix = def !== undefined ? ` [${def}] ` : ' ';
      return (await ask(`${p.label}${suffix}`)).trim() || def || '';
    }
    const suffix = defaultValue !== undefined ? ` [${defaultValue}] ` : ' ';
    const answer = await ask(`${p}${suffix}`);
    return answer.trim() || defaultValue || '';
  }) as PromptFn;

  // ── Single-turn ──────────────────────────────────────────────────────────────
  if (argPrompt !== undefined) {
    try {
      await runTurn(session, argPrompt, cliRun, providerConfig.name, principal, stdinPrompt);
    } finally {
      rl.close();
      await teardownPlugins();
      await services.StorageBackend?.close?.();
    }
    return;
  }

  // ── Interactive REPL ─────────────────────────────────────────────────────────
  try {
    for (;;) {
      let line: string;
      try {
        line = await rl.question(askPrompt('you: '));
      } catch {
        endInput();
        break;  // Ctrl+D / EOF
      }
      endInput();
      if (!line.trim()) continue;
      process.stderr.write(cyanErr('assistant: '));
      session = await runTurn(session, line, cliRun, providerConfig.name, principal, stdinPrompt);
    }
  } finally {
    rl.close();
    await teardownPlugins();
    await services.StorageBackend?.close?.();
  }

  if (!isEphemeral) {
    process.stderr.write(yellow(
      `\nTo resume: matbot --provider ${providerName} --session ${session.id}\n`
    ));
  }
}

main().catch(e => {
  process.stderr.write(yellow(`Fatal: ${String(e)}\n`));
  process.exit(1);
});

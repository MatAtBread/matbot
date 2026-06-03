#!/usr/bin/env node
import { loadConfig, loadConfigFromText, loadDotEnv } from './config.js';
import { installPlugin }                    from './install.js';
import type { Principal, ProviderAdapter,
              ProviderConfig, Session,
              Store, StoreQuery, QueryResult, CASResult,
              Tool, MessageContent, FileStore } from '@matatbread/matbot-core';
import { appendMessage, createMessage,
         createSession, runSession,
         HookRegistry, SystemContextRegistryImpl,
         loadPlugins,
         registerPlugin,
         resolveProviderFactory,
         teardownPlugins,
         unloadPlugin as unloadPluginFn,
         getPluginNameForSpecifier }       from '@matatbread/matbot-core';
import type { MatbotServices, PluginSettings, ToolRegistry, Vault,
              MatbotPlugin, StorageBackend, KnowledgeIndex } from '@matatbread/matbot-core';
import { systemPrincipal, VaultImpl }      from '@matatbread/matbot-security';
import { FilesystemStore }                 from '@matatbread/matbot-storage-filesystem';
import { FilesystemFileStore }             from '@matatbread/matbot-files-node';
import { createBuiltinTools, createProviderTool } from '@matatbread/matbot-tool-plugin';
import { LookupKnowledgeIndex }               from '@matatbread/matbot-knowledge';
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
 * Resolve plugin specifiers to file: URLs rooted at the config directory.
 *
 * Local paths (./foo or /abs) are checked for a package.json; if found,
 * exports["."] is resolved so matbot.yaml can reference the package folder
 * rather than a deep src/ path.
 */
async function resolvePluginSpecifiers(specifiers: readonly string[], configDir: string): Promise<string[]> {
  const req = createRequire(path.join(configDir, '_'));
  const results: string[] = [];

  for (const spec of specifiers) {
    if (spec.startsWith('.') || path.isAbsolute(spec)) {
      const absDir = path.resolve(configDir, spec);
      try {
        const pkg  = JSON.parse(await readFile(path.join(absDir, 'package.json'), 'utf8')) as Record<string, unknown>;
        const main = resolveExportsEntry(pkg['exports']);
        if (typeof main === 'string') {
          results.push(pathToFileURL(path.resolve(absDir, main)).href);
          continue;
        }
      } catch { /* no package.json or unparseable — fall through */ }
      results.push(pathToFileURL(absDir).href);
    } else {
      try {
        results.push(pathToFileURL(req.resolve(spec)).href);
      } catch {
        results.push(spec);  // let loadPlugins emit the warning
      }
    }
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

  async query(_q: StoreQuery<T>): Promise<QueryResult<T>> {
    const items = [...this.items.values()].map(doc => ({ doc }));
    return { items, total: items.length };
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
      case '--ephemeral':   opts.ephemeral = true; break;
      case '--help': printHelp(); process.exit(0);
      default:
        if (!arg.startsWith('-')) positional.push(arg);
    }
  }

  return { opts, prompt: positional.length ? positional.join(' ') : undefined };
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
  --help                    Show this help

Sessions are ephemeral by default (discarded on exit). Use --session create to persist,
or --session <id> to resume a previously persisted session.

If [prompt] and --prompt-file are both omitted, starts an interactive REPL.
`.trimStart());
}

// ── Single turn ────────────────────────────────────────────────────────────────

async function runTurn(
  session:        Session,
  content:        string | MessageContent[],
  providerConfig: ProviderConfig,
  adapter:        ProviderAdapter,
  tools:          ReadonlyMap<string, Tool>,
  store:          Store<Session>,
  principal:      Principal,
  workdir:        string,
  files:          FileStore,
  hooks:          HookRegistry,
  systemContext:  SystemContextRegistryImpl,
  promptFn:       (question: string, defaultValue?: string) => Promise<string>,
  loadPluginFn:   (specifier: string) => Promise<MatbotPlugin>,
  unloadPluginFn: (specifier: string) => Promise<void>,
  configPath:     string,
  vault:          Vault,
): Promise<Session> {
  const traceId  = crypto.randomUUID();
  const ac       = new AbortController();
  const onSigint = (): void => { ac.abort(); };
  process.once('SIGINT', onSigint);

  // Normalise content, construct and pre-persist the user message so the
  // session is readable mid-run if resumed from another client.
  const contentArr: MessageContent[] = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content;
  const userMsg = createMessage({ role: 'user', content: contentArr, traceId });

  if (!session.title && !session.messages.some(m => m.role === 'user')) {
    const text = contentArr
      .filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
      .map(c => c.text).join(' ').trim();
    if (text) {
      const words = text.split(/\s+/).slice(0, 8).join(' ');
      session = { ...session, title: words.length > 60 ? `${words.slice(0, 60)}…` : words };
    }
  }

  session = appendMessage(session, userMsg);
  await store.set(session.id, session);

  let updated       = session;
  let totalIn       = 0;
  let totalOut      = 0;
  let totalCostUsd  = 0;
  let thinkingTicks = 0;

  const clearThinking = (): void => {
    if (thinkingTicks > 0) { process.stderr.write('\n'); thinkingTicks = 0; }
  };

  try {
    for await (const ev of runSession({
      session,
      config:         { principal, provider: providerConfig.name, traceId },
      provider:       adapter,
      providerConfig,
      tools,
      store,
      hooks,
      systemContext,
      signal:         ac.signal,
      workdir,
      files,
      configPath,
      vault,
      prompt:       promptFn,
      loadPlugin:   loadPluginFn,
      unloadPlugin: unloadPluginFn,
    })) {
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
          const text = ev.content
            .filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
            .map(c => c.text).join('');
          if (text) write(`you: ${text}\nassistant: `);
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
              updated = await runTurn(
                ev.session, [{ type: 'form-response', values }],
                providerConfig, adapter, tools, store, principal, workdir, files,
                hooks, systemContext, promptFn, loadPluginFn, unloadPluginFn, configPath, vault,
              );
              return updated;
            }
          } else {
            process.stderr.write(`\n[aborted: ${ev.reason}]\n`);
          }
          break;
        }
        case 'error': clearThinking(); process.stderr.write(`\n[error: ${ev.error}]\n`); break;
        default: break;
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  write('\n');
  if (totalIn > 0 || totalOut > 0) {
    const cost = totalCostUsd > 0 ? ` ≈$${totalCostUsd.toFixed(4)}` : '';
    write(`[↑${totalIn} ↓${totalOut} tokens${cost}]\n`);
  }

  return updated;
}

// ── Main ───────────────────────────────────────────────────────────────────────

interface SettingsDoc {
  id:      string;
  version: string;
  data:    Record<string, unknown>;
}

function isSettingsDoc(v: unknown): v is SettingsDoc {
  return typeof v === 'object' && v !== null &&
    typeof (v as SettingsDoc).id      === 'string' &&
    typeof (v as SettingsDoc).version === 'string' &&
    typeof (v as SettingsDoc).data    === 'object' && (v as SettingsDoc).data !== null;
}

function makePluginSettings(store: Store<SettingsDoc>, pluginName: string): PluginSettings {
  // Handles migration from the old flat-object format (pre-Store).
  const getDoc = async (): Promise<SettingsDoc | null> => {
    const raw = await store.get(pluginName);
    if (raw === null) return null;
    if (isSettingsDoc(raw)) return raw;
    // Old format: flat { key: value } — wrap it so subsequent writes upgrade the file.
    return { id: pluginName, version: '0', data: raw as unknown as Record<string, unknown> };
  };

  return {
    async get<T>(key: string): Promise<T | undefined> {
      return (await getDoc())?.data[key] as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      for (;;) {
        const doc  = await getDoc();
        const data = { ...(doc?.data ?? {}), [key]: value as unknown };
        const next: SettingsDoc = { id: pluginName, version: Date.now().toString(), data };
        // version '0' means migrated-but-not-yet-written — use set to upgrade the file.
        if (doc === null || doc.version === '0') { await store.set(pluginName, next); return; }
        const r = await store.cas(pluginName, doc.version, next);
        if (r.ok) return;
      }
    },
    async delete(key: string): Promise<void> {
      for (;;) {
        const doc = await getDoc();
        if (doc === null) return;
        const data = { ...doc.data };
        delete data[key];
        const next: SettingsDoc = { id: pluginName, version: Date.now().toString(), data };
        if (doc.version === '0') { await store.set(pluginName, next); return; }
        const r = await store.cas(pluginName, doc.version, next);
        if (r.ok) return;
      }
    },
  };
}

// ── Setup wizard ───────────────────────────────────────────────────────────────

interface ProviderPackage { type: string; name: string; dir: string; }

async function discoverProviders(): Promise<ProviderPackage[]> {
  const thisDir      = path.dirname(fileURLToPath(import.meta.url));
  const providersDir = path.resolve(thisDir, '../../../packages/plugins/providers');
  let entries: string[];
  try { entries = await readdir(providersDir); } catch { return []; }
  const results: ProviderPackage[] = [];
  for (const entry of entries) {
    const dir = path.join(providersDir, entry);
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
      if (typeof pkg['name'] === 'string') results.push({ type: entry, name: pkg['name'] as string, dir });
    } catch { /* skip entries without a readable package.json */ }
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

    // Write a relative path so the config is self-contained regardless of where matbot is installed.
    const relDir = path.relative(configDir, chosen.dir).replace(/\\/g, '/');
    const moduleSpec = relDir.startsWith('.') ? relDir : `./${relDir}`;

    const yaml = [
      'providers:',
      `  ${providerName}:`,
      `    module: ${moduleSpec}`,
      `    endpoint: ${endpoint}`,
      `    model: ${model}`,
      `    credentials:`,
      `      apiKey: \${env:${envVarName}}`,
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

  const vault = new VaultImpl({}, process.env as Record<string, string | undefined>);

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
  const knowledgeProxy = new Proxy({} as KnowledgeIndex, {
    get(_t, prop: string | symbol) {
      return (knowledgeImpl as unknown as Record<string | symbol, unknown>)[prop];
    },
  });
  for (const spec of allSpecifiers) {
    try {
      const mod  = await import(/* @vite-ignore */ spec) as Record<string, unknown>;
      const plug = (mod['plugin'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['plugin']) as MatbotPlugin | undefined;
      if (plug?.storageBackend !== undefined) {
        activeStorageBackend = await plug.storageBackend.open(dotData);
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

  // Each Store and FileStore is a forwarding proxy backed by a mutable `current` target.
  // Callers may freely capture references — all method calls route through the proxy to
  // whichever backend is current. replaceStorageBackend() calls each proxy's swap fn.
  type AnyStore = Store<{ id: string; version: string }>;
  type SwapFn<T extends object> = (next: T) => void;

  // Returns [proxy, swap]. The proxy forwards every property access to `current`.
  // Binding the method to `current` (not the proxy) ensures `this` is always the real store.
  function makeSwappable<T extends object>(initial: T): [T, SwapFn<T>] {
    let current = initial;
    const proxy = new Proxy({} as T, {
      get(_, prop) {
        const val = Reflect.get(current, prop, current);
        return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(current) : val;
      },
      has(_, prop) { return Reflect.has(current, prop); },
    });
    return [proxy, (next: T) => { current = next; }];
  }

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
  const [fileStore, swapFiles] = makeSwappable<FileStore>(
    activeStorageBackend?.fileStore ?? new FilesystemFileStore(filesDir),
  );
  const settingsStore = createStore<SettingsDoc>('settings');

  // toolMap is shared: plugins register into it via services, runSession reads it
  const toolMap = new Map<string, Tool>(createBuiltinTools().map(t => [t.name, t]));
  const toolReg: ToolRegistry = {
    register: (t: Tool) => { toolMap.set(t.name, t); },
    remove:   (n: string) => { toolMap.delete(n); },
    resolve:  (n) => toolMap.get(n) ?? null,
    list:     () => [...toolMap.values()],
    removeByPlugin: (pluginName: string) => {
      for (const [name, tool] of toolMap) {
        if (tool.pluginName === pluginName) toolMap.delete(name);
      }
    },
  };

  // hookReg is shared: plugins register hooks via services, runSession fires them
  const hookReg = new HookRegistry();
  const systemContextReg = new SystemContextRegistryImpl();

  const pluginSettingsCache = new Map<string, PluginSettings>();
  const serviceRegistry     = new Map<string, unknown>();

  const services: MatbotServices = {
    settings(pluginName: string): PluginSettings {
      let s = pluginSettingsCache.get(pluginName);
      if (s === undefined) {
        s = makePluginSettings(settingsStore, pluginName);
        pluginSettingsCache.set(pluginName, s);
      }
      return s;
    },

    createStore,

    get(key) { return serviceRegistry.get(key) as never; },
    register(key, svc) { serviceRegistry.set(key, svc); },
    unregisterService(key: string) { serviceRegistry.delete(key); },

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
    async loadPlugin(specifier: string) {
      const resolved = await resolvePluginSpecifiers([specifier], path.dirname(configPath));
      const plugins  = await loadPlugins(resolved, services, /* bustCache */ true);
      const plugin   = plugins[0];
      if (plugin === undefined) throw new Error(`No plugin loaded for specifier "${specifier}"`);
      return plugin;
    },
    async unloadPlugin(specifier: string) {
      const resolved = await resolvePluginSpecifiers([specifier], path.dirname(configPath));
      const spec     = resolved[0];
      if (spec === undefined) return;
      const name = getPluginNameForSpecifier(spec);
      if (name === undefined) {
        console.warn(`[matbot] No loaded plugin found for specifier "${specifier}"`);
        return;
      }
      await unloadPluginFn(name, services);
    },
    providers: matbotConfig.providers,
    get storageBackend() { return activeStorageBackend; },
    sessions:  store,
    files:     fileStore,
    vault,
    hooks:          hookReg,
    tools:          toolReg,
    systemContext:  systemContextReg,
    workdir:    workDir,
    configPath,
    async replaceStorageBackend(next: StorageBackend): Promise<void> {
      // Swap every cached store proxy to the new backend.
      for (const [ns, [, swap]] of storeProxies) swap(next.createStore(ns));
      swapFiles(next.fileStore);
      const old = activeStorageBackend;
      activeStorageBackend = next;
      await old?.close?.();
    },

    knowledge: knowledgeProxy,
    replaceKnowledgeBackend(impl: KnowledgeIndex) {
      const prev = knowledgeImpl;
      knowledgeImpl = impl;
      if (prev.entries !== undefined) {
        for (const entry of prev.entries()) void impl.index(entry);
      }
    },
  };

  // Load provider plugins first so module names can be canonicalised before any
  // frontend plugin's setup() calls resolveProviderFactory(cfg.module).
  await loadPlugins(resolvedProviderMods, services);

  // Canonicalise each provider config's module to the loaded plugin's name so that
  // resolveProviderFactory() (keyed by plugin.name) finds the factory regardless of
  // whether the config used an npm name, a relative path, or a file URL.
  for (const [key, cfg] of matbotConfig.providers) {
    const idx        = providerModules.indexOf(cfg.module);
    const resolved   = idx !== -1 ? resolvedProviderMods[idx] : undefined;
    const pluginName = resolved !== undefined ? getPluginNameForSpecifier(resolved) : undefined;
    if (pluginName !== undefined && pluginName !== cfg.module) {
      matbotConfig.providers.set(key, { ...cfg, module: pluginName });
    }
  }

  // Map plugin name → the original module specifier written in matbot.yaml.
  // Used by the provider tool so its description and list output show YAML-valid paths,
  // not the internal plugin names that the canonicalisation step produces.
  const pluginNameToOrigPath = new Map<string, string>();
  for (let i = 0; i < providerModules.length; i++) {
    const orig     = providerModules[i];
    const resolved = resolvedProviderMods[i];
    if (orig === undefined || resolved === undefined) continue;
    const name = getPluginNameForSpecifier(resolved);
    if (name !== undefined && !pluginNameToOrigPath.has(name)) pluginNameToOrigPath.set(name, orig);
  }

  // Register the provider management tool now that adapter plugins are loaded —
  // createProviderTool reads getRegisteredPlugins() to build its description.
  toolReg.register(createProviderTool(matbotConfig.providers, pluginNameToOrigPath));

  await loadPlugins(resolvedPluginMods, services);

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
    ...(rawConfig.credentials !== undefined ? { credentials: await resolveCredentials(rawConfig.credentials, vault) } : {}),
    ...(rawConfig.endpoint    !== undefined ? { endpoint: await vault.resolve(rawConfig.endpoint) } : {}),
    ...(rawConfig.parameters  !== undefined ? { parameters: rawConfig.parameters } : {}),
    ...(rawConfig.fallback    !== undefined ? { fallback:   rawConfig.fallback   } : {}),
  };

  const adapter: ProviderAdapter = resolveProviderFactory(providerConfig.module)(providerConfig);

  // ── Session ───────────────────────────────────────────────────────────────────

  const principal = systemPrincipal();
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

  // ── Readline (shared by single-turn and REPL for tool prompts) ──────────────
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.on('SIGINT', () => { process.stderr.write('\n'); rl.close(); });

  const stdinPrompt = async (question: string, defaultValue?: string): Promise<string> => {
    const suffix = defaultValue !== undefined ? ` [${defaultValue}] ` : ' ';
    const answer = await rl.question(`${question}${suffix}`);
    return answer.trim() || defaultValue || '';
  };

  // ── Single-turn ──────────────────────────────────────────────────────────────
  if (argPrompt !== undefined) {
    try {
      await runTurn(session, argPrompt, providerConfig, adapter, toolMap, runStore, principal, workDir, fileStore, hookReg, systemContextReg, stdinPrompt, services.loadPlugin.bind(services), services.unloadPlugin.bind(services), configPath, vault);
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
      session = await runTurn(session, line, providerConfig, adapter, toolMap, runStore, principal, workDir, fileStore, hookReg, systemContextReg, stdinPrompt, services.loadPlugin.bind(services), services.unloadPlugin.bind(services), configPath, vault);
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

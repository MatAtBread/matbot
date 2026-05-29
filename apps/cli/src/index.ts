#!/usr/bin/env node
import { loadConfig, loadDotEnv }           from './config.js';
import { installPlugin }                    from './install.js';
import type { Principal, ProviderAdapter,
              ProviderConfig, Session,
              Store, Tool, MessageContent, FileStore } from '@matatbread/matbot-core';
import { appendMessage, createMessage,
         createSession, runSession,
         HookRegistry, SystemContextRegistryImpl,
         loadPlugins,
         registerPlugin,
         resolveProviderFactory,
         teardownPlugins,
         unloadPlugin as unloadPluginFn,
         getPluginNameForSpecifier }       from '@matatbread/matbot-core';
import type { MatbotServices, PluginSettings, ToolRegistry, Vault } from '@matatbread/matbot-core';
import { systemPrincipal, VaultImpl }      from '@matatbread/matbot-security';
import { FilesystemStore }                 from '@matatbread/matbot-storage-filesystem';
import { FilesystemFileStore }             from '@matatbread/matbot-files-node';
import { createBuiltinTools }              from '@matatbread/matbot-tool-plugin';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface }                 from 'node:readline/promises';
import { createRequire }                   from 'node:module';
import { pathToFileURL }                   from 'node:url';
import process                             from 'node:process';
import path                                from 'node:path';

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

// ── Arg parsing ────────────────────────────────────────────────────────────────

interface CliOpts {
  provider?: string;
  session?:  string;
  system?:   string;
  config:    string;
}

function parseArgs(argv: string[]): { opts: CliOpts; prompt: string | undefined } {
  const args = argv.slice(2);
  const opts: CliOpts = { config: './matbot.yaml' };
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case '--provider': { const v = args[++i]; if (v !== undefined) opts.provider = v; } break;
      case '--session':  { const v = args[++i]; if (v !== undefined) opts.session  = v; } break;
      case '--system':   { const v = args[++i]; if (v !== undefined) opts.system   = v; } break;
      case '--config':   { const v = args[++i]; if (v !== undefined) opts.config   = v; } break;
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
  --provider <name>   Provider key from matbot.yaml (default: first in file)
  --session  <id>     Resume an existing session
  --system   <text>   System prompt injected at session start
  --config   <path>   Config file path (default: ./matbot.yaml)
  --help              Show this help

If [prompt] is omitted, starts an interactive REPL.
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
  loadPluginFn:   (specifier: string) => Promise<void>,
  unloadPluginFn: (specifier: string) => Promise<void>,
  configPath:     string,
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
          process.stderr.write(`\r[thinking… ×${thinkingTicks}]`);
          break;
        case 'tool:start':
          clearThinking();
          process.stderr.write(`\n⚙  ${ev.name} ${JSON.stringify(ev.input)}\n`);
          break;
        case 'tool:stdout': process.stderr.write(ev.chunk); break;
        case 'tool:stderr': process.stderr.write(ev.chunk); break;
        case 'tool:end':    process.stderr.write(`\n`); break;
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
          if (text) process.stderr.write(`you: ${text}\nassistant: `);
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
              process.stderr.write('\n');
              const values: Record<string, string> = {};
              for (const field of formPart.fields) {
                const hint = field.options ? ` [${field.options.join('/')}]` : '';
                values[field.name] = await promptFn(`${field.label}${hint}`, field.default);
              }
              process.removeListener('SIGINT', onSigint);
              updated = await runTurn(
                ev.session, [{ type: 'form-response', values }],
                providerConfig, adapter, tools, store, principal, workdir, files,
                hooks, systemContext, promptFn, loadPluginFn, unloadPluginFn, configPath,
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

  process.stdout.write('\n');
  if (totalIn > 0 || totalOut > 0) {
    const cost = totalCostUsd > 0 ? ` ≈$${totalCostUsd.toFixed(4)}` : '';
    process.stderr.write(`[↑${totalIn} ↓${totalOut} tokens${cost}]\n`);
  }

  return updated;
}

// ── Session picker ─────────────────────────────────────────────────────────────

async function pickSession(store: Store<Session>): Promise<Session | null> {
  if (!process.stdin.isTTY) return null;

  const { items } = await store.query({});
  if (items.length === 0) return null;

  const sessions = items
    .map(i => i.doc)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const label = (s: Session): string => {
    const when   = new Date(s.updatedAt).toLocaleString();
    const hidden = s.status === 'archived' ? '[hidden] ' : '';
    if (s.title) return `${when}  ${hidden}${s.title}`;
    const first    = s.messages.find(m => m.role === 'user');
    const textPart = first?.content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
    const preview  = textPart?.text ?? s.id;
    return `${when}  ${hidden}${preview.length > 55 ? preview.slice(0, 55) + '…' : preview}`;
  };

  const options = ['New conversation', ...sessions.map(label)];
  let cursor    = 0;

  const render = (first: boolean): void => {
    if (!first) process.stderr.write(`\x1b[${options.length}A`);
    for (let i = 0; i < options.length; i++) {
      const archived = i > 0 && sessions[i - 1]?.status === 'archived';
      const pre  = archived ? '\x1b[2m' : '';
      const post = archived ? '\x1b[0m' : '';
      process.stderr.write(`\x1b[2K${i === cursor ? '> ' : '  '}${pre}${options[i]!}${post}\n`);
    }
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  render(true);

  return new Promise<Session | null>(resolve => {
    const cleanup = (): void => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    const onData = (data: Buffer): void => {
      const key = data.toString();
      if (key === '\x1b[A') {
        cursor = Math.max(0, cursor - 1);
        render(false);
      } else if (key === '\x1b[B') {
        cursor = Math.min(options.length - 1, cursor + 1);
        render(false);
      } else if (key === '\r' || key === '\n') {
        cleanup();
        process.stderr.write(`\x1b[${options.length}A\x1b[J`);
        process.stderr.write(`  ${options[cursor]!}\n\n`);
        resolve(cursor === 0 ? null : (sessions[cursor - 1] ?? null));
      } else if (key === '\x03') {
        cleanup();
        process.stderr.write('\n');
        process.exit(0);
      }
    };

    process.stdin.on('data', onData);
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────

function makePluginSettings(settingsDir: string, pluginName: string): PluginSettings {
  const file = path.join(settingsDir, `${pluginName}.json`);
  let cache: Record<string, unknown> | undefined;

  const load = async (): Promise<Record<string, unknown>> => {
    if (cache !== undefined) return cache;
    try {
      cache = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      cache = {};
    }
    return cache;
  };

  const save = async (data: Record<string, unknown>): Promise<void> => {
    await mkdir(settingsDir, { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
    cache = data;
  };

  return {
    async get<T>(key: string): Promise<T | undefined> {
      return (await load())[key] as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      await save({ ...(await load()), [key]: value });
    },
    async delete(key: string): Promise<void> {
      const data = { ...(await load()) };
      delete data[key];
      await save(data);
    },
  };
}

async function main(): Promise<void> {
  const serverMode = process.argv[2] === 'server';

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

  const { opts, prompt: argPrompt } = parseArgs(process.argv);

  // Resolve config path — walk up if using the default name
  const configPath = opts.config === './matbot.yaml'
    ? (await findUp('matbot.yaml')) ?? path.resolve('matbot.yaml')
    : path.resolve(opts.config);

  // Chdir to the project root so relative paths and tool defaults resolve correctly
  // regardless of where the CLI process was launched from (e.g. pnpm changes cwd to apps/cli).
  process.chdir(path.dirname(configPath));

  // Load .env from same directory as config before anything reads process.env
  await loadDotEnv(path.dirname(configPath));

  // Load config
  const matbotConfig = await loadConfig(
    configPath,
    process.env as Record<string, string | undefined>,
  );

  if (matbotConfig.providers.size === 0) {
    throw new Error('No providers found in config.');
  }

  // ── Plugin setup ─────────────────────────────────────────────────────────────

  const vault = new VaultImpl({}, process.env as Record<string, string | undefined>);

  // ── Stores (created early so plugins like frontend-web can use them) ──────────

  const dotData     = path.join(path.dirname(configPath), '.data');
  const dataDir     = path.join(dotData, 'sessions');
  const workDir     = path.join(dotData, 'workspace');
  const filesDir    = path.join(dotData, 'files');
  const settingsDir = path.join(dotData, 'settings');
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(workDir, { recursive: true }), mkdir(filesDir, { recursive: true })]);
  const store     = new FilesystemStore<Session>(dataDir);
  const fileStore = new FilesystemFileStore(filesDir);

  // toolMap is shared: plugins register into it via services, runSession reads it
  const toolMap = new Map<string, Tool>(createBuiltinTools().map(t => [t.name, t]));
  const toolReg: ToolRegistry = {
    register: (t: Tool) => { toolMap.set(t.name, t); },
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
        s = makePluginSettings(settingsDir, pluginName);
        pluginSettingsCache.set(pluginName, s);
      }
      return s;
    },

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
      const resolved: ProviderConfig = { ...rawCfg, credentials: await resolveCredentials(rawCfg.credentials, vault) };
      const adpt = resolveProviderFactory(resolved.type)(resolved);
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
      await loadPlugins(resolved, services, /* bustCache */ true);
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
    sessions:  store,
    files:     fileStore,
    vault,
    hooks:          hookReg,
    tools:          toolReg,
    systemContext:  systemContextReg,
    workdir:    workDir,
    configPath,
  };

  // Collect provider plugin modules (unique, preserving first-seen order) and
  // prepend them to the user's plugin list so they're registered before any
  // user plugin whose setup() might call services.complete().
  const providerModules: string[] = [];
  const seenProviderModules = new Set<string>();
  for (const cfg of matbotConfig.providers.values()) {
    const mod = cfg.module ?? `@matatbread/matbot-provider-${cfg.type}`;
    if (!seenProviderModules.has(mod)) {
      seenProviderModules.add(mod);
      providerModules.push(mod);
    }
  }

  const allSpecifiers = [
    ...await resolvePluginSpecifiers(providerModules,        path.dirname(configPath)),
    ...await resolvePluginSpecifiers(matbotConfig.plugins,   path.dirname(configPath)),
  ];
  await loadPlugins(allSpecifiers, services);

  // ── Server mode ───────────────────────────────────────────────────────────────

  if (serverMode) {
    process.stderr.write('[matbot] server running — press Ctrl+C to stop\n');
    const shutdown = (): void => {
      process.stderr.write('\n[matbot] shutting down…\n');
      teardownPlugins().then(() => process.exit(0)).catch(() => process.exit(1));
    };
    process.once('SIGINT',  shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  // ── Provider resolution ───────────────────────────────────────────────────────

  const providerName = opts.provider ?? (matbotConfig.providers.keys().next().value as string);
  const rawConfig    = matbotConfig.providers.get(providerName);
  if (!rawConfig) {
    throw new Error(
      `Unknown provider "${providerName}". Available: ${[...matbotConfig.providers.keys()].join(', ')}`
    );
  }

  const providerConfig: ProviderConfig = {
    name:        rawConfig.name,
    type:        rawConfig.type,
    model:       rawConfig.model,
    credentials: await resolveCredentials(rawConfig.credentials, vault),
    ...(rawConfig.endpoint   !== undefined ? { endpoint:   rawConfig.endpoint   } : {}),
    ...(rawConfig.parameters !== undefined ? { parameters: rawConfig.parameters } : {}),
    ...(rawConfig.fallback   !== undefined ? { fallback:   rawConfig.fallback   } : {}),
  };

  const adapter: ProviderAdapter = resolveProviderFactory(providerConfig.type)(providerConfig);

  // ── Session ───────────────────────────────────────────────────────────────────

  const principal = systemPrincipal();
  let session: Session;

  if (opts.session) {
    const existing = await store.get(opts.session);
    if (!existing) {
      throw new Error(`Session "${opts.session}" not found.`);
    }
    session = existing;
  } else {
    const picked = argPrompt === undefined ? await pickSession(store) : null;
    session = picked ?? createSession({ ownerPrincipal: principal });
    if (!picked && opts.system) {
      session = appendMessage(session, createMessage({
        role:    'system',
        content: [{ type: 'text', text: opts.system }],
        traceId: crypto.randomUUID(),
      }));
    }
  }

  process.stderr.write(`provider: ${providerName}  session: ${session.id}\n\n`);

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
    await runTurn(session, argPrompt, providerConfig, adapter, toolMap, store, principal, workDir, fileStore, hookReg, systemContextReg, stdinPrompt, services.loadPlugin.bind(services), services.unloadPlugin.bind(services), configPath);
    rl.close();
    return;
  }

  // ── Interactive REPL ─────────────────────────────────────────────────────────
  const printResume = (): void => {
    process.stderr.write(
      `\nTo resume: matbot --provider ${providerName} --session ${session.id}\n`
    );
  };

  for (;;) {
    let line: string;
    try {
      line = await rl.question('you: ');
    } catch {
      break;  // Ctrl+D / EOF
    }
    if (!line.trim()) continue;
    process.stderr.write('assistant: ');
    session = await runTurn(session, line, providerConfig, adapter, toolMap, store, principal, workDir, fileStore, hookReg, systemContextReg, stdinPrompt, services.loadPlugin.bind(services), services.unloadPlugin.bind(services), configPath);
  }

  rl.close();
  printResume();
}

main().catch(e => {
  process.stderr.write(`Fatal: ${String(e)}\n`);
  process.exit(1);
});

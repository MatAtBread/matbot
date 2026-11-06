import type { ProviderConfig, Session, Store, SessionRunner, Vault } from '@matatbread/matbot-core';
import { appendMessage, createMessage, createSession, currentPrincipal, teardownPlugins,
         isMissingSecretError } from '@matatbread/matbot-core';
import { MemoryStore }       from '@matatbread/matbot-core/storage-base';
import { createInterface }   from 'node:readline/promises';
import process               from 'node:process';
import type { CliOpts }      from './args.js';
import type { MatbotConfig } from './config.js';
import type { BootedMachine } from './boot.js';
import { runTurn }           from './turn.js';
import { askPrompt, cyanErr, endInput, isBackground, stamp, terminalPrompt, yellow } from './terminal.js';

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

/** Talk to the machine from the terminal: one turn when `prompt` is given, else a REPL until EOF. */
export async function converse(
  opts:    CliOpts,
  config:  MatbotConfig,
  { services, makeRunner, providers }: BootedMachine,
  prompt:  string | undefined,
): Promise<void> {
  const vault = services.Vault;
  const store = services.sessions!;

  // Ephemeral by default; opt into persistence with --session <id|create>.
  // config ephemeral:true (e.g. background sub-agents) is a hard override.
  const isEphemeral = opts.ephemeral || config.ephemeral === true || opts.session === undefined;

  // ── Provider resolution ───────────────────────────────────────────────────────

  const providerName = opts.provider ?? config.defaultProvider ?? (providers.keys().next().value as string);
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
    process.stderr.write(yellow(`${stamp()} provider: ${providerName}  (ephemeral)\n\n`));
  } else {
    process.stderr.write(yellow(`${stamp()} provider: ${providerName}  session: ${session.id}\n\n`));
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

  // A background job has nobody at its terminal: its stdin was the config it was handed, and what it writes
  // is a log. So its turns get no prompt at all, which is what tells a permission gate that nobody can be
  // asked — it refuses, as at any other unattended door, and the refusal is logged for someone to act on.
  // Handing it the terminal prompt instead printed the question into the log and read the answer from a
  // closed pipe.
  const turnPrompt = isBackground ? undefined : terminalPrompt(rl).prompt;

  // ── Single-turn ──────────────────────────────────────────────────────────────
  if (prompt !== undefined) {
    try {
      await runTurn(session, prompt, cliRun, providerConfig.name, principal, turnPrompt);
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
      session = await runTurn(session, line, cliRun, providerConfig.name, principal, turnPrompt);
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

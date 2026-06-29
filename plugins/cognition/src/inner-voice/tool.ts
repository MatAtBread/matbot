/**
 * The `ask_inner_voice` tool: consult a second model (the "Matbot₂" critic of the Inner voice skill)
 * and return its critique. It is a thin wrapper over the core `singleTurn` service that resolves WHICH
 * provider plays the inner voice — the `innerVoiceProvider` setting (cognition_config) if set, else the
 * current turn's own provider. Owning this here, rather than having the skill call the generic
 * `single_turn` tool with a hard-coded provider name, keeps the provider an alias the user configures
 * (no duplicate provider profile to satisfy a literal) and severs cognition's dependency on skills'
 * toolset — the Inner voice skill content carries no provider name at all.
 *
 * Falling back to the turn provider means a same-model self-critique when nothing is pinned — degraded
 * (the value is a *different-lineage* perspective) but functional. Pin a different-lineage model via
 * cognition_config to get the genuine second opinion.
 */
import type { Tool, ToolExecutor, ToolContext, ToolEvent, MatbotMachine, Session } from '@matatbread/matbot-plugin-api';
import {
  type DreamSettings,
  DEFAULT_DREAM_SETTINGS,
  DREAM_SETTINGS_KEY,
  validateDreamSettings,
} from '../dream/types.js';

export const INNER_VOICE_PROVIDER_KEY = 'innerVoiceProvider';
export const DREAM_RANKER_PROVIDER_KEY = 'dreamRankerProvider';
export const DREAM_MERGER_PROVIDER_KEY = 'dreamMergerProvider';

/** Every provider pin `cognition_config` understands. One flat list so the get/set/clear logic and
 *  the input schema's enum can't drift apart. */
const PROVIDER_SETTING_KEYS = [
  INNER_VOICE_PROVIDER_KEY,
  DREAM_RANKER_PROVIDER_KEY,
  DREAM_MERGER_PROVIDER_KEY,
] as const;

/** Every DreamSettings field `cognition_config` understands, alongside the provider pins above. */
const DREAM_SETTING_KEYS = ['strongThreshold', 'weakThreshold', 'maxClusterSize', 'blocklist', 'weakDeferralMs', 'maxMergesPerPass', 'maxEnrichmentsPerPass'] as const;

/** How many back-to-back `ask_inner_voice` consults are allowed before further ones short-circuit.
 *  At the (BACKOFF_LIMIT + 1)th consecutive call we stop critiquing and tell Matbot₁ to proceed —
 *  the model has had its second opinion N times running without acting on it (a self-critique spin). */
const BACKOFF_LIMIT = 3;

const TOOL_NAME = 'ask_inner_voice';

/**
 * Count the trailing run of consecutive `ask_inner_voice` invocations ending at the current call
 * (which is already appended to `session` before the tool executes). "Consecutive" means no other
 * tool ran in between and no new user turn began: a different tool call, a user message, or an
 * assistant turn that produced a final answer (no tool calls) all break the run. Markers and
 * tool-result messages are transparent. So three separate user requests that each consult the inner
 * voice once do NOT count as a run — only an uninterrupted self-critique spin within a turn does.
 */
function consecutiveInnerVoiceCalls(session: Session): number {
  let count = 0;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i]!;
    if (m.role === 'tool' || m.role === 'marker') continue;
    if (m.role !== 'assistant') break; // user (or any non-assistant) turn resets the run
    let aiv = 0, other = 0;
    for (const c of m.content) {
      if (c.type !== 'tool-call') continue;
      if (c.name === TOOL_NAME) aiv++; else other++;
    }
    count += aiv;
    if (other > 0 || aiv === 0) break; // a different tool, or a final answer, ends the run
  }
  return count;
}

export function createAskInnerVoiceTool(services: MatbotMachine): Tool {
  const executor: ToolExecutor = {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const args = input as { prompt?: string; system?: string };
      if (typeof args.prompt !== 'string') { yield { type: 'error', message: 'ask_inner_voice requires a string "prompt".' }; return; }

      if (consecutiveInnerVoiceCalls(ctx.session) > BACKOFF_LIMIT) {
        yield { type: 'stdout', chunk: "" }; // keep the UI render parity with a real critique
        yield { type: 'result', value: { text:
          `You have already consulted the inner voice ${BACKOFF_LIMIT} times in a row without acting on ` +
          `its feedback. Stop consulting it and proceed: act on the critiques you have already received ` +
          `and deliver your answer directly.` } };
        return;
      }

      const pinned   = await services.settings().get<string>(INNER_VOICE_PROVIDER_KEY);
      const provider = (pinned !== undefined && services.providers.has(pinned)) ? pinned : ctx.provider;
      if (!provider) {
        yield { type: 'error', message: 'ask_inner_voice has no provider — none is pinned (cognition_config) and there is no current turn provider to fall back to.' };
        return;
      }
      const res = await services.singleTurn({
        provider,
        prompt: args.prompt,
        signal: ctx.signal,
        ...(typeof args.system === 'string' ? { system: args.system } : {}),
      });
      yield { type: 'stdout', chunk: "" }; // No function, except to make the UI render the result
      // Usage is accounting, not conversation: it is captured ambiently (the host's complete() reports
      // it into the turn's usage sink, attributed to this tool call) — the model gets only the text.
      yield { type: 'result', value: { text: res.text } };
    },
  };

  return {
    name: 'ask_inner_voice',
    description:
      'Consult the Inner voice — a second model that constructively critiques your draft response — and ' +
      'return its critique. This is a one-shot call to a SEPARATE model (not your own response): send a ' +
      '`prompt` summarising the problem and your draft, plus an optional `system` framing, and get back ' +
      'its text. Which provider answers is configured (cognition_config `innerVoiceProvider`) ' +
      "— ideally a different training lineage; absent, it uses the current turn's model. You do not name a " +
      'provider here.\n\n' +
      'Parameters (TypeScript):\n' +
      '```ts\n' +
      '{ prompt: string; system?: string }  // -> { text }\n' +
      '```',
    inputSchema: {
      type:       'object',
      required:   ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'The problem summary and your draft response for the inner voice to critique.' },
        system: { type: 'string', description: 'Optional system prompt framing the inner voice (e.g. the Matbot₂ instructions).' },
      },
    },
    executor,
  };
}

/** Provider pins `cognition_config` exposes, beyond dream-time's own {@link DreamSettings}. Each is
 *  an alias for an already-configured provider (see the provider tool), never a new profile to
 *  stand up. `null` means unpinned. Unlike the DreamSettings fields below, "unpinned" has no fixed
 *  effective value to report — the relevant call falls back to ITS OWN calling turn's provider —
 *  so `get` reports the raw pin (or `null`), not a resolved value. */
export interface CognitionProviderConfig {
  innerVoiceProvider:  string | null;
  dreamRankerProvider: string | null;
  dreamMergerProvider: string | null;
}

/** The full shape `cognition_config` reads and writes: the three provider pins above plus
 *  dream-time's tunables, flattened into one object so several settings can change in one `set`
 *  call. This is also exactly what `get` returns, DreamSettings fields defaults-merged — one call
 *  teaches the model both the current values and the object's shape. */
export type CognitionConfig = CognitionProviderConfig & DreamSettings;

async function readEffectiveConfig(services: MatbotMachine): Promise<CognitionConfig & { available: string[] }> {
  const settings = services.settings();
  const [innerVoiceProvider, dreamRankerProvider, dreamMergerProvider, storedDream] = await Promise.all([
    settings.get<string>(INNER_VOICE_PROVIDER_KEY),
    settings.get<string>(DREAM_RANKER_PROVIDER_KEY),
    settings.get<string>(DREAM_MERGER_PROVIDER_KEY),
    settings.get<Partial<DreamSettings>>(DREAM_SETTINGS_KEY),
  ]);
  return {
    innerVoiceProvider:  innerVoiceProvider ?? null,
    dreamRankerProvider: dreamRankerProvider ?? null,
    dreamMergerProvider: dreamMergerProvider ?? null,
    ...DEFAULT_DREAM_SETTINGS,
    ...(storedDream ?? {}),
    available: [...services.providers.keys()],
  };
}

export function createCognitionConfigTool(services: MatbotMachine): Tool {
  const executor: ToolExecutor = {
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const args     = input as Record<string, unknown> & { action?: string };
      const settings = services.settings();

      switch (args.action) {
        case 'get': {
          yield { type: 'result', value: await readEffectiveConfig(services) };
          return;
        }

        case 'set': {
          // Validate everything first; commit nothing until every check has passed, so a bad
          // field never leaves an earlier field in the same call persisted (true all-or-nothing).
          const providerWrites: { key: typeof PROVIDER_SETTING_KEYS[number]; value: string | null }[] = [];

          for (const key of PROVIDER_SETTING_KEYS) {
            if (!(key in args)) continue;
            const v = args[key];
            if (v === null) {
              providerWrites.push({ key, value: null });
            } else if (typeof v === 'string' && services.providers.has(v)) {
              providerWrites.push({ key, value: v });
            } else if (typeof v === 'string') {
              const available = [...services.providers.keys()];
              yield { type: 'error', message: `Unknown provider "${v}" for "${key}". Configured providers: ${available.join(', ') || '(none)'}.` };
              return;
            } else {
              yield { type: 'error', message: `"${key}" must be a configured provider name, or null to unpin.` };
              return;
            }
          }

          let nextDream: Partial<DreamSettings> | undefined;
          if (DREAM_SETTING_KEYS.some(k => k in args)) {
            const stored = (await settings.get<Partial<DreamSettings>>(DREAM_SETTINGS_KEY)) ?? {};
            const next: Partial<DreamSettings> = { ...stored };

            if ('strongThreshold' in args) {
              const v = args.strongThreshold;
              if (v === null) delete next.strongThreshold;
              else if (typeof v === 'number') next.strongThreshold = v;
              else { yield { type: 'error', message: '"strongThreshold" must be a number, or null to reset to default.' }; return; }
            }
            if ('weakThreshold' in args) {
              const v = args.weakThreshold;
              if (v === null) delete next.weakThreshold;
              else if (typeof v === 'number') next.weakThreshold = v;
              else { yield { type: 'error', message: '"weakThreshold" must be a number, or null to reset to default.' }; return; }
            }
            if ('maxClusterSize' in args) {
              const v = args.maxClusterSize;
              if (v === null) delete next.maxClusterSize;
              else if (typeof v === 'number' && Number.isInteger(v)) next.maxClusterSize = v;
              else { yield { type: 'error', message: '"maxClusterSize" must be an integer, or null to reset to default.' }; return; }
            }
            if ('blocklist' in args) {
              const v = args.blocklist;
              if (v === null) delete next.blocklist;
              else if (Array.isArray(v) && v.every(x => typeof x === 'string')) next.blocklist = v;
              else { yield { type: 'error', message: '"blocklist" must be an array of strings, or null to reset to default.' }; return; }
            }
            if ('weakDeferralMs' in args) {
              const v = args.weakDeferralMs;
              if (v === null) delete next.weakDeferralMs;
              else if (typeof v === 'number') next.weakDeferralMs = v;
              else { yield { type: 'error', message: '"weakDeferralMs" must be a number, or null to reset to default.' }; return; }
            }
            if ('maxMergesPerPass' in args) {
              const v = args.maxMergesPerPass;
              if (v === null) delete next.maxMergesPerPass;
              else if (typeof v === 'number' && Number.isInteger(v)) next.maxMergesPerPass = v;
              else { yield { type: 'error', message: '"maxMergesPerPass" must be an integer, or null to reset to default.' }; return; }
            }
            if ('maxEnrichmentsPerPass' in args) {
              const v = args.maxEnrichmentsPerPass;
              if (v === null) delete next.maxEnrichmentsPerPass;
              else if (typeof v === 'number' && Number.isInteger(v)) next.maxEnrichmentsPerPass = v;
              else { yield { type: 'error', message: '"maxEnrichmentsPerPass" must be an integer, or null to reset to default.' }; return; }
            }

            try {
              validateDreamSettings({ ...DEFAULT_DREAM_SETTINGS, ...next });
            } catch (e) {
              yield { type: 'error', message: (e as Error).message };
              return;
            }
            nextDream = next;
          }

          if (providerWrites.length === 0 && nextDream === undefined) {
            yield { type: 'error', message: 'action "set" requires at least one setting to update.' };
            return;
          }

          // Every check passed — commit.
          await Promise.all([
            ...providerWrites.map(({ key, value }) => value === null ? settings.delete(key) : settings.set(key, value)),
            ...(nextDream !== undefined ? [settings.set(DREAM_SETTINGS_KEY, nextDream)] : []),
          ]);

          yield { type: 'result', value: await readEffectiveConfig(services) };
          return;
        }

        case 'clear': {
          await Promise.all([
            settings.delete(INNER_VOICE_PROVIDER_KEY),
            settings.delete(DREAM_RANKER_PROVIDER_KEY),
            settings.delete(DREAM_MERGER_PROVIDER_KEY),
            settings.delete(DREAM_SETTINGS_KEY),
          ]);
          yield { type: 'result', value: await readEffectiveConfig(services) };
          return;
        }

        default:
          yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: get, set, clear.` };
      }
    },
  };

  return {
    name: 'cognition_config',
    description:
      'Configure the cognition subsystem: three provider pins plus dream-time\'s tunable thresholds, ' +
      'in one consolidated settings object so several can change in a single call.\n\n' +
      'Provider pins — each an alias for an already-configured provider (see the provider tool), never ' +
      'a new profile to stand up:\n' +
      '  - `innerVoiceProvider` — answers ask_inner_voice (the Inner voice critic). Ideally a DIFFERENT ' +
      "training lineage than your main model; unpinned, it uses the current turn's own model " +
      '(same-lineage, so degraded).\n' +
      '  - `dreamRankerProvider` — scores (fact, skill) pairs inside dream_time. Unpinned, it uses the ' +
      "calling turn's own provider.\n" +
      '  - `dreamMergerProvider` — splices facts into skill prose inside dream_time. Unpinned, it uses ' +
      "the calling turn's own provider. Pin this (and/or the ranker) to a provider with a larger " +
      'context window if dream_time is erroring out on large skills.\n\n' +
      "Dream-time tunables, consumed at the start of every dream_time run:\n" +
      '  - `strongThreshold` — minimum score [0,1] to trigger a merge (default 0.75).\n' +
      '  - `weakThreshold` — minimum score [0,1] to record as a weak match and defer rather than ' +
      'retire (default 0.5); below this the fact retires as unroutable. Must stay <= strongThreshold.\n' +
      '  - `maxClusterSize` — cap on facts merged into a SINGLE skill in one dream_time pass ' +
      '(default 5).\n' +
      '  - `maxMergesPerPass` — cap on facts merged across ALL skills in one dream_time pass ' +
      '(default 20). One pass ranks the whole backlog in a single call, so raising this drains the ' +
      'backlog faster at the cost of more merge calls per pass, not more ranking.\n' +
      '  - `maxEnrichmentsPerPass` — cap on how many unroutable ("none") facts get a provenance-' +
      'enriched second look per pass (default 10); facts over the cap are deferred, not retired. ' +
      '0 disables enrichment.\n' +
      '  - `blocklist` — skill names never offered to the ranker (default ["Inner voice"]); ' +
      'case-sensitive exact match.\n' +
      '  - `weakDeferralMs` — milliseconds a weakly-routed fact is excluded from selection before ' +
      'reconsideration (default 36 hours).\n\n' +
      '`get` returns the EFFECTIVE settings — every key above, defaults already applied where unset — ' +
      'plus `available` (configured provider names). Call it first to learn current values and the ' +
      "object's shape before calling `set`.\n\n" +
      '`set` accepts a partial patch with any subset of the keys above. A key that is OMITTED is left ' +
      'unchanged; a key given as `null` resets it to its default (or, for a provider pin, unpins it). ' +
      'An invalid patch (e.g. weakThreshold > strongThreshold, an unconfigured provider name, ' +
      'maxClusterSize < 1) is rejected with an error and nothing from that call is persisted — `set` ' +
      'is all-or-nothing, never partially applied.\n\n' +
      '`clear` takes no parameters and resets every setting above to its default in one call.\n\n' +
      'Parameters (TypeScript):\n' +
      '```ts\n' +
      'interface CognitionConfig {\n' +
      '  innerVoiceProvider:  string | null;\n' +
      '  dreamRankerProvider: string | null;\n' +
      '  dreamMergerProvider: string | null;\n' +
      '  strongThreshold:     number;   // [0, 1]\n' +
      '  weakThreshold:       number;   // [0, 1], <= strongThreshold\n' +
      '  maxClusterSize:        number;   // integer >= 1, per-skill\n' +
      '  maxMergesPerPass:      number;   // integer >= 1, across all skills\n' +
      '  maxEnrichmentsPerPass: number;   // integer >= 0\n' +
      '  blocklist:           string[];\n' +
      '  weakDeferralMs:      number;   // milliseconds, >= 0\n' +
      '}\n\n' +
      'type CognitionConfigAction =\n' +
      "  | { action: 'get' }    // -> CognitionConfig & { available: string[] }\n" +
      "  | ({ action: 'set' } & Partial<{ [K in keyof CognitionConfig]: CognitionConfig[K] | null }>)\n" +
      '                         // -> CognitionConfig & { available: string[] }; throws on an invalid combination\n' +
      "  | { action: 'clear' }; // -> CognitionConfig & { available: string[] }\n" +
      '```',
    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action:              { type: 'string', enum: ['get', 'set', 'clear'], description: 'The operation to perform.' },
        innerVoiceProvider:  { type: ['string', 'null'], description: '"set": a configured provider name, or null to unpin. Omit to leave unchanged.' },
        dreamRankerProvider: { type: ['string', 'null'], description: '"set": a configured provider name, or null to unpin. Omit to leave unchanged.' },
        dreamMergerProvider: { type: ['string', 'null'], description: '"set": a configured provider name, or null to unpin. Omit to leave unchanged.' },
        strongThreshold:     { type: ['number', 'null'], description: '"set": minimum score [0,1] to trigger a merge, or null to reset to default. Omit to leave unchanged.' },
        weakThreshold:       { type: ['number', 'null'], description: '"set": minimum score [0,1] for a weak match, or null to reset to default. Omit to leave unchanged.' },
        maxClusterSize:        { type: ['number', 'null'], description: '"set": cap on facts merged into a single skill per pass, or null to reset to default. Omit to leave unchanged.' },
        maxMergesPerPass:      { type: ['number', 'null'], description: '"set": cap on facts merged across all skills per pass, or null to reset to default. Omit to leave unchanged.' },
        maxEnrichmentsPerPass: { type: ['number', 'null'], description: '"set": cap on "none" facts given an enriched second look per pass (0 disables), or null to reset to default. Omit to leave unchanged.' },
        blocklist:           { type: ['array', 'null'], items: { type: 'string' }, description: '"set": skill names never offered to the ranker, or null to reset to default. Omit to leave unchanged.' },
        weakDeferralMs:      { type: ['number', 'null'], description: '"set": deferral window in milliseconds, or null to reset to default. Omit to leave unchanged.' },
      },
    },
    executor,
  };
}

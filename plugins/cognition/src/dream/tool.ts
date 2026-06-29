/**
 * The `dream_time` tool: one pass of background memory consolidation, exposed to the model.
 *
 * Zero-input tool. Everything it needs is already in `MatbotMachine` (the skill manager, the
 * stores, the provider list) and `ToolContext` (the active provider, the abort signal). Returns a
 * single result event carrying the fully-assembled {@link DreamRun} record; the same record is
 * also persisted to the `dream_runs` store, so observability survives the conversation that
 * triggered it.
 *
 * The deterministic spine lives in `./runOnce.ts`. This file is the thin tool-shaped wrapper:
 *
 *   • A process-local mutex serialises runs. Two `dream_time` calls in flight at once is a
 *     hazard (they would race on `SkillManager.save` and on per-fact CAS writes), and there is no
 *     legitimate reason to run them in parallel — one consolidation pass at a time is the design.
 *
 *   • The ranker and merger each resolve their own provider independently — `dreamRankerProvider`
 *     / `dreamMergerProvider` (cognition_config) if pinned, else `ctx.provider` (the model driving
 *     the calling turn). Unpinned, a user on a cheap model gets cheap dream-time and a user on a
 *     thinky model gets thinky dream-time — no config needed to get started. Pinning matters most
 *     for the merger: it sees a whole skill's prose plus the fact, so a small-context provider can
 *     truncate and fail on a large skill even when the same provider ranks fine (ranking only ever
 *     sees short summaries, never full skill prose).
 *
 *   • The DreamRun is persisted BEFORE being returned. If the persist fails, the caller still
 *     sees the result; if the caller is aborted before reading the result, the run is still
 *     recorded. Belt and braces, because the cost of a missing run record is "we can't reason
 *     about why dream-time did what it did", which is exactly what this whole exercise was for.
 */

import type { MatbotMachine, Tool, ToolExecutor, ToolResultOf, ToolContext } from '@matatbread/matbot-plugin-api';
import { runOnce } from './runOnce.js';
import { createLlmRanker } from './llmRanker.js';
import { createLlmMerger } from './llmMerger.js';
import type { DreamRun } from './types.js';
import { DREAM_RANKER_PROVIDER_KEY, DREAM_MERGER_PROVIDER_KEY } from '../inner-voice/tool.js';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolResults {
    dream_time: DreamRun;
  }
}

// Process-local mutex. A Promise the next caller awaits; the chain extends with every call and
// settles in order. Simple, correct, no third-party dependency.
let runChain: Promise<unknown> = Promise.resolve();

function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = runChain.then(fn, fn);   // run regardless of prior settle state
  runChain = next.catch(() => undefined); // don't let one failure poison the chain
  return next;
}

export function createDreamTimeTool(services: MatbotMachine): Tool<ToolResultOf<'dream_time'>> {
  const executor: ToolExecutor<ToolResultOf<'dream_time'>> = {
    async *execute(_input: unknown, ctx: ToolContext) {
      if (ctx.provider === undefined) {
        yield {
          type:    'error',
          message: 'dream_time needs a provider in ToolContext (the model driving the current turn). ' +
                   'None was present. This usually means the tool was invoked outside a normal turn.',
        };
        return;
      }
      if (!services.providers.has(ctx.provider)) {
        yield {
          type:    'error',
          message: `dream_time was invoked with provider "${ctx.provider}", but no such provider is ` +
                   `configured. Configured providers: ${[...services.providers.keys()].join(', ') || '(none)'}.`,
        };
        return;
      }

      // Ranker and merger each resolve their own provider pin independently, falling back to the
      // calling turn's provider when unset or stale (the pinned name no longer exists). This
      // matters most for the merger, which sees a whole skill's prose plus the fact — a
      // small-context provider can truncate and fail there even though the same provider ranks
      // fine (ranking only ever sees short summaries).
      const [rankerPinned, mergerPinned] = await Promise.all([
        services.settings().get<string>(DREAM_RANKER_PROVIDER_KEY),
        services.settings().get<string>(DREAM_MERGER_PROVIDER_KEY),
      ]);
      const rankerProvider = (rankerPinned !== undefined && services.providers.has(rankerPinned)) ? rankerPinned : ctx.provider;
      const mergerProvider = (mergerPinned !== undefined && services.providers.has(mergerPinned)) ? mergerPinned : ctx.provider;

      const ranker = createLlmRanker(services, rankerProvider);
      const merger = createLlmMerger(services, mergerProvider);

      let run: DreamRun;
      try {
        run = await serialise(() => runOnce(services, ranker, merger, ctx.signal));
      } catch (e) {
        // runOnce catches its own pipeline errors into the run record. A throw here is something
        // unexpected — a setup-shaped failure (missing SkillManager, malformed settings,
        // metadata-gap assertion) or the mutex chain itself misbehaving. Surface it as a tool
        // error so the caller sees it; nothing was written to the dream_runs store.
        yield { type: 'error', message: `dream_time failed before producing a run record: ${(e as Error).message ?? String(e)}` };
        return;
      }

      // Persist the run record. Failures here are logged but do NOT block returning the result —
      // the caller still gets the in-memory record, just without store-side history. A persist
      // failure on its own should not look like a pipeline failure.
      try {
        const dreamRuns = services.createStore<DreamRun>('dream_runs');
        await dreamRuns.set(run.id, run);
      } catch (e) {
        console.warn('[dream/tool] failed to persist DreamRun:', (e as Error).message ?? e);
      }

      yield { type: 'result', value: run };
    },
  };

  return {
    name: 'dream_time',
    description:
      'Run one pass of background memory consolidation. Scores every unassigned fact in the ' +
      'remembered_facts store against every existing skill (minus a small blocklist) in a single ' +
      'ranking, then acts on the whole backlog at once: facts whose top skill clears the "strong" ' +
      'threshold are spliced into that skill (grouped by skill, contradictions flagged inline), up ' +
      'to a configured per-pass merge budget and per-skill cluster cap. Anything above the budget ' +
      'waits for the next pass.\n\n' +
      'Facts that score too low to route anywhere ("none") get one extra look enriched with the ' +
      'surrounding conversation before being retired permanently — a bare fact can under-score in ' +
      'isolation but route cleanly once disambiguated (enrichment itself is budgeted per pass; ' +
      'facts over that budget are deferred, not retired). Facts that route only weakly (a sound ' +
      'fact, just no confident skill home yet) are deferred rather than retired — they become ' +
      'eligible again after a cooldown, since the skill landscape may change later. A merge that ' +
      'fails outright (unparseable response, truncation) quarantines the culprit fact so it stops ' +
      'blocking the queue (needs a config fix, e.g. a provider swap, not an automatic retry) and ' +
      'the pass carries on with the other skills.\n\n' +
      'Takes no parameters. Intended to be invoked via the `background` tool on a schedule, not ' +
      'inline during a conversation. The ranker and merger each resolve their own provider — ' +
      '`dreamRankerProvider` / `dreamMergerProvider` via the cognition_config tool if pinned, else ' +
      "the active provider (the model driving the calling turn).\n\n" +
      'Returns a structured DreamRun record describing what the pass did (the same record is ' +
      'also persisted to the `dream_runs` store, queryable via `dream_runs_action` if exposed).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    executor,
  };
}

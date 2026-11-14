/**
 * The `dream_time` tool: one pass of background memory consolidation, exposed to the model.
 *
 * Zero-input tool. Everything it needs is already in `MatbotMachine` (the skill manager, the
 * stores, the provider list) and `ToolContext` (the active provider, the abort signal). Streams
 * `progress` events as the pass advances — a backlog drains as many sequential LLM calls, so a run
 * is a long, otherwise-silent wait — then a single result event carrying the fully-assembled
 * {@link DreamRun} record; the same record is also persisted to the `dream_runs` store, so
 * observability survives the conversation that triggered it.
 *
 * The deterministic spine lives in `./runOnce.ts`. This file is the thin tool-shaped wrapper:
 *
 *   • A lease (`./lease.ts`) admits one pass at a time across processes. Two passes at once race on
 *     `SkillManager.save` and on per-fact writes, and a scheduled pass runs in a job's own process
 *     beside any started in the server, so a mutex in one process is not enough. A pass that finds
 *     the lease held is skipped, not queued.
 *
 *   • The ranker and merger each resolve their own provider independently — `dreamRankerProvider`
 *     / `dreamMergerProvider` (cognition_config) if pinned, else `ctx.provider` (the model driving
 *     the calling turn). With both pinned, a call with no turn behind it (`POST /tools/dream_time`)
 *     runs too. Unpinned, a user on a cheap model gets cheap dream-time and a user on a
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

import type { MatbotMachine, Tool, ToolExecutor, ToolContract, NoParams, ToolResultOf, ToolContext } from '@matatbread/matbot-plugin-api';
import { runOnce } from './runOnce.js';
import { createLlmRanker } from './llmRanker.js';
import { createLlmMerger } from './llmMerger.js';
import type { DreamRun } from './types.js';
import { acquireLease, type DreamLease } from './lease.js';
import { DREAM_RANKER_PROVIDER_KEY, DREAM_MERGER_PROVIDER_KEY } from '../inner-voice/tool.js';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    dream_time: ToolContract<DreamRun, NoParams>;
  }
}

export function createDreamTimeTool(services: MatbotMachine): Tool<ToolResultOf<'dream_time'>> {
  const executor: ToolExecutor<ToolResultOf<'dream_time'>> = {
    async *execute(_input: unknown, ctx: ToolContext) {
      // Ranker and merger each resolve their own provider pin independently, falling back to the
      // calling turn's provider when unset or stale (the pinned name no longer exists). This
      // matters most for the merger, which sees a whole skill's prose plus the fact — a
      // small-context provider can truncate and fail there even though the same provider ranks
      // fine (ranking only ever sees short summaries).
      const [rankerPinned, mergerPinned] = await Promise.all([
        services.settings().get<string>(DREAM_RANKER_PROVIDER_KEY),
        services.settings().get<string>(DREAM_MERGER_PROVIDER_KEY),
      ]);
      const turn = ctx.provider !== undefined && services.providers.has(ctx.provider) ? ctx.provider : undefined;
      const rankerProvider = (rankerPinned !== undefined && services.providers.has(rankerPinned)) ? rankerPinned : turn;
      const mergerProvider = (mergerPinned !== undefined && services.providers.has(mergerPinned)) ? mergerPinned : turn;
      if (rankerProvider === undefined || mergerProvider === undefined) {
        yield {
          type:    'error',
          message: `dream_time has no provider for its ${rankerProvider === undefined ? 'ranker' : 'merger'}: none is pinned ` +
                   '(cognition_config dreamRankerProvider / dreamMergerProvider) and ' +
                   (ctx.provider === undefined ? 'there is no calling turn to borrow one from.'
                     : `the calling turn's "${ctx.provider}" is not configured. Configured providers: ${[...services.providers.keys()].join(', ') || '(none)'}.`),
          failure: 'invalid',
        };
        return;
      }

      const ranker = createLlmRanker(services, rankerProvider);
      const merger = createLlmMerger(services, mergerProvider);

      const lease = await acquireLease(services.createStore<DreamLease>('dream_lease'), crypto.randomUUID());
      if (!lease.held) {
        yield {
          type:    'error',
          message: `Another dream_time pass is running (it took the lease at ${lease.by.acquiredAt}; ` +
                   `it lapses at ${lease.by.expiresAt} unless renewed), so this pass did not run.`,
          failure: 'unavailable',
        };
        return;
      }

      let run: DreamRun;
      try {
        // Drain the pipeline generator, streaming its progress out as tool progress events so a long
        // pass (a backlog of merges is many sequential LLM calls) isn't a silent wait. The generator's
        // RETURN value (step.value once done) is the fully-assembled DreamRun.
        const gen = runOnce(services, ranker, merger, AbortSignal.any([ctx.signal, lease.lost]));
        let step = await gen.next();
        while (!step.done) {
          yield { type: 'progress', pct: step.value.pct, message: step.value.message };
          step = await gen.next();
        }
        run = step.value;
      } catch (e) {
        // runOnce catches its own pipeline errors into the run record. A throw here is something
        // unexpected — a setup-shaped failure (missing SkillManager, malformed settings,
        // metadata-gap assertion). Surface it as a tool error; nothing was written to the store.
        yield { type: 'error', message: `dream_time failed before producing a run record: ${(e as Error).message ?? String(e)}` };
        return;
      } finally {
        await lease.release().catch(e => console.warn('[dream/tool] releasing the lease failed:', (e as Error).message ?? e));
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

      yield { type: 'progress', pct: 100, message: 'Yawn & stretch' };
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
      'eligible again after a cooldown, since the skill landscape may change later; after ' +
      '`weakVerdictsBeforeBacklog` weak verdicts (default 4) a fact moves to the backlog (`__backlog__`) ' +
      'and is not re-ranked, awaiting clustering into new skills — unless every address, number and ' +
      'quoted identifier in it already appears in that skill, when it is retired as already known (`__known__`). ' +
      'One pass runs at a time, across processes: a call made while another pass is running is skipped. A merge that ' +
      'fails outright (unparseable response, truncation) quarantines the culprit fact so it stops ' +
      'blocking the queue (needs a config fix, e.g. a provider swap, not an automatic retry) and ' +
      'the pass carries on with the other skills. A fact that restates one already merged or retired ' +
      '(the same text, ignoring case, spacing and trailing punctuation) is retired as a duplicate without ' +
      'being ranked, and of several identical new facts only the oldest is ranked; the rest follow it.\n\n' +
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

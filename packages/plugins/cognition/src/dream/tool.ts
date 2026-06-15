/**
 * The `dream_time` tool: one pass of background memory consolidation, exposed to the model.
 *
 * Zero-input tool. Everything it needs is already in `MatbotServices` (the skill manager, the
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
 *   • The active provider (`ctx.provider`) is the model used for both the ranker and the merger.
 *     Inheriting the caller's choice means a user running on a cheap model gets cheap dream-time
 *     and a user running on a thinky model gets thinky dream-time — no separate provider config to
 *     reason about. If we later want to specialise, the wiring is here in one place.
 *
 *   • The DreamRun is persisted BEFORE being returned. If the persist fails, the caller still
 *     sees the result; if the caller is aborted before reading the result, the run is still
 *     recorded. Belt and braces, because the cost of a missing run record is "we can't reason
 *     about why dream-time did what it did", which is exactly what this whole exercise was for.
 */

import type { MatbotServices, Tool, ToolExecutor, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import { runOnce } from './runOnce.js';
import { createLlmRanker } from './llmRanker.js';
import { createLlmMerger } from './llmMerger.js';
import type { DreamRun } from './types.js';

console.warn('[cognition] MARKER-G: dream/tool.ts module imported');

// Process-local mutex. A Promise the next caller awaits; the chain extends with every call and
// settles in order. Simple, correct, no third-party dependency.
let runChain: Promise<unknown> = Promise.resolve();

function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = runChain.then(fn, fn);   // run regardless of prior settle state
  runChain = next.catch(() => undefined); // don't let one failure poison the chain
  return next;
}

export function createDreamTimeTool(services: MatbotServices): Tool {
  const executor: ToolExecutor = {
    async *execute(_input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
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

      const ranker = createLlmRanker(services, ctx.provider);
      const merger = createLlmMerger(services, ctx.provider);

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
      'Run one pass of background memory consolidation. Picks the oldest unassigned fact from ' +
      'the remembered_facts store, scores it against every existing skill (minus a small ' +
      'blocklist), and — if the top skill clears the configured "strong" threshold — splices the ' +
      'fact in, flagging any contradictions inline. Will also batch-merge other unassigned facts ' +
      'whose top skill is the same one, up to a configured cluster cap. Facts that fail to route ' +
      'anywhere are marked considered (so the next pass does not reconsider them); facts that ' +
      'route only weakly are left for a future pass.\n\n' +
      'Takes no parameters. Intended to be invoked via the `background` tool on a schedule, not ' +
      'inline during a conversation. Uses the active provider (the model driving the calling ' +
      'turn) for the ranking and merging judgement calls.\n\n' +
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

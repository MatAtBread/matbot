import type {
  MatbotPluginSpec, MatbotMachine, Tool, ToolContext, ToolContract, ToolExecutor, ToolResultOf, Session,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

import { buildUnits, deriveKeys, selectEvidence, renderExtracts, wordRe, type KeyGroup, type KeyHit, type Unit } from './evidence.js';
import { createProvenanceConfigTool } from './config.js';
import { CLASSIFIER_PROVIDER_KEY, IGNORE_TOOLS_KEY, DEFAULT_IGNORE_TOOLS } from './keys.js';

/**
 * Where did a claim come from? Not whether it is true — provenance, which unlike truth is a CLOSED
 * question: anything not in this session came from the model's weights or from nowhere. The session is
 * therefore the provenance record, and the answer is found by searching it, never by asking the model
 * how it knows — it cannot tell recall from invention, both being "it felt right".
 *
 * `unsourced` means "not sourced HERE", never "false": training data is a legitimate origin, and what
 * to do about an unsourced claim (retract? annotate? ignore?) is the caller's policy, not this tool's.
 */
declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    determine_provenance: ToolContract<
      { results: ProvenanceResult[] },
      {
        claims:       Array<{ claim: string; keys?: string[] }>;
        probe?:       boolean;
        sessionId?:   string;
        provider?:    string;
        ignoreTools?: string[];
      }
    >;
  }
}

export type Verdict = 'retrieved' | 'given' | 'derived' | 'model-prior' | 'unsourced' | 'vetoed';

export interface ProvenanceResult {
  claim:      string;
  verdict:    Verdict;
  /** The cold probe's answer, when one was run. */
  probe?:     'true' | 'false' | 'dontknow';
  /** The extracts the verdict rests on — verbatim, so a wrong verdict stays checkable. */
  citations:  Unit[];
  /** Per-key diagnostic: which of the claim's discriminating terms were seen in the session and
   *  where. Present on every verdict, but most informative for `vetoed` (the offender is the entry
   *  with `found: false`) and `unsourced` (nothing here matched at all). */
  keyHits:    KeyHit[];
}

interface ProvenanceInput {
  claims?:      Array<{ claim?: unknown; keys?: unknown }>;
  probe?:       boolean;
  sessionId?:   string;
  provider?:    string;
  ignoreTools?: string[];
}

const MAX_CLAIMS   = 8;
const PROMPT_CHARS = 8000;

function asJson(text: string): Record<string, unknown> | null {
  const found = text.match(/\{[\s\S]*\}/);
  const raw = found?.[0];
  if (raw === undefined) return null;
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
}

function makeTool(services: MatbotMachine): Tool<ToolResultOf<'determine_provenance'>> {
  const executor: ToolExecutor<ToolResultOf<'determine_provenance'>> = {
    async *execute(input: unknown, ctx: ToolContext) {
      const args = (input ?? {}) as ProvenanceInput;
      const wanted = (args.claims ?? [])
        .filter((c): c is { claim: string; keys?: string[] } => typeof c?.claim === 'string' && c.claim.length > 0)
        .slice(0, MAX_CLAIMS);
      if (wanted.length === 0) { yield { type: 'result', value: { results: [] } }; return; }

      // ctx.session, not a re-read: mid-turn it is the live session, which the store is not — it holds
      // the very answer under examination. A different session is a read, and only then is the store
      // needed at all.
      let session: Session = ctx.session;
      if (args.sessionId !== undefined && args.sessionId !== ctx.session.id) {
        const store = services.sessions;
        if (!store) { yield { type: 'error', message: 'No session store: `sessionId` can only name the current session.' }; return; }
        const other = await store.get(args.sessionId);
        if (!other) { yield { type: 'error', message: `Session "${args.sessionId}" not found.` }; return; }
        session = other;
      }

      // Priority: caller param > pinned setting > coded default. An explicit empty array from either
      // source means "include everything" — distinct from omission, which falls through.
      const ignoreFromSettings = await services.settings().get<string[]>(IGNORE_TOOLS_KEY);
      const ignoreList =
        Array.isArray(args.ignoreTools) ? args.ignoreTools
        : Array.isArray(ignoreFromSettings) ? ignoreFromSettings
        : [...DEFAULT_IGNORE_TOOLS];
      const units = buildUnits(session, new Set(ignoreList));
      const located = wanted.map(c => {
        const given = Array.isArray(c.keys) && c.keys.length > 0;
        const groups: KeyGroup[] = given ? c.keys!.map(k => [k]) : deriveKeys(c.claim);
        const ev = selectEvidence(units, groups, c.claim, given);
        return { claim: c.claim, res: groups.map(g => g.map(wordRe)), ev };
      });

      // Omitted, singleTurn relays through the turn's own model — the convention. A pinned classifier
      // routes the READING onto a cheap model; it must never reach the probe below.
      const pinned = await services.settings().get<string>(CLASSIFIER_PROVIDER_KEY);
      const reader = args.provider
        ?? ((pinned !== undefined && services.providers.has(pinned)) ? pinned : ctx.provider);

      const accounted = new Map<string, string>();
      const relied    = new Map<string, number[]>();
      const withCites = located.filter(l => l.ev.units.length > 0);
      if (withCites.length > 0) {
        if (!reader) { yield { type: 'error', message: 'determine_provenance has no provider — none was given, none is pinned, and there is no current turn provider to fall back to.' }; return; }
        const read = await services.singleTurn({
          provider: reader,
          signal:   ctx.signal,
          system:   'You trace where a claim came from. Reply with JSON only - no prose, no code fences.',
          prompt:
            'Each block is a claim and extracts from the conversation it was made in. [TOOL:x] means a tool ' +
            'returned it, [USER] means the user said it; both are authoritative. A [USER] extract that ' +
            'merely quotes or asks ABOUT the claim is not evidence FOR it - ignore those.\n\n' +
            withCites.map(l => `CLAIM: ${l.claim}\nEXTRACTS:\n${renderExtracts(l.ev.units, l.res, PROMPT_CHARS)}`).join('\n\n') +
            '\n\nFor each claim answer how the extracts account for it:\n' +
            '  "stated"  - an extract states, paraphrases or clearly implies it (wording will differ: ' +
            '"son of the user" states "X is the user\'s son"; a list of attributes states any one of them)\n' +
            '  "derived" - no extract states it, but it follows by arithmetic or aggregation over them\n' +
            '  "no"      - the extracts say nothing that bears on it\n' +
            'When in doubt between "stated" and "no", answer "stated".\n' +
            'Also return "used": the numbers of the extracts your answer actually rests on, most telling ' +
            'first, and ONLY those - an extract that merely mentions the same name (a different person, a ' +
            'song title) or that asks about the claim rather than asserting it is not one of them.\n' +
            'Reply exactly: {"verdicts":[{"claim":"<claim verbatim>","how":"stated|derived|no","used":[0]}]}',
        });
        const verdicts = asJson(read.text ?? '')?.['verdicts'];
        for (const v of Array.isArray(verdicts) ? verdicts : []) {
          const row = v as { claim?: unknown; how?: unknown; used?: unknown };
          if (typeof row.claim !== 'string' || typeof row.how !== 'string') continue;
          accounted.set(row.claim, row.how);
          if (Array.isArray(row.used)) relied.set(row.claim, row.used.filter((n): n is number => typeof n === 'number'));
        }
      }

      const results: ProvenanceResult[] = [];
      for (const l of located) {
        // A vetoed search is decisive: a strict key is absent, so any material found on the OTHER
        // keys would be corroboration for a term the session does not mention. Report it distinctly
        // from "diffuse" absence so the caller can tell "this specific term isn't here" from "nothing
        // is here". Skip the reader (already skipped: cites was empty) and the cold probe (the veto
        // is about session content, not the model's prior).
        if (l.ev.vetoed) {
          results.push({ claim: l.claim, verdict: 'vetoed', citations: [], keyHits: l.ev.hits });
          continue;
        }

        // An unreadable verdict is not a verdict of "wrong": material was found, so treat it as stated.
        const how = l.ev.units.length > 0 ? (accounted.get(l.claim) ?? 'stated') : 'no';
        const used = relied.get(l.claim);
        const cited = (used !== undefined && used.length > 0)
          ? used.map(n => l.ev.units[n]).filter((u): u is Unit => u !== undefined)
          : l.ev.units.slice(0, 4);

        if (how === 'stated') {
          const fromTool = cited.some(u => u.from.startsWith('TOOL:'));
          results.push({ claim: l.claim, verdict: fromTool ? 'retrieved' : 'given', citations: cited.slice(0, 4), keyHits: l.ev.hits });
          continue;
        }
        if (how === 'derived') {
          results.push({ claim: l.claim, verdict: 'derived', citations: cited.slice(0, 4), keyHits: l.ev.hits });
          continue;
        }
        if (args.probe === false || !ctx.provider) {
          results.push({ claim: l.claim, verdict: 'unsourced', citations: [], keyHits: l.ev.hits });
          continue;
        }

        // Not introspection: a clean-room re-ask of the SAME model with none of this context. A
        // confabulation is context-driven and does not survive the context being removed; a fact from
        // the weights does. Always ctx.provider — it is that model's prior being measured, so a
        // verdict from a pinned classifier would answer a different question.
        const cold = await services.singleTurn({
          provider: ctx.provider,
          signal:   ctx.signal,
          prompt:   `Statement: "${l.claim}"\nIs this statement true, false, or do you not know? ` +
                    'Answer with exactly one word: TRUE, FALSE, or DONTKNOW.',
        });
        const word = (cold.text ?? '').toUpperCase();
        const asserted = word.includes('TRUE');
        results.push({
          claim:     l.claim,
          verdict:   asserted ? 'model-prior' : 'unsourced',
          probe:     asserted ? 'true' : (word.includes('FALSE') ? 'false' : 'dontknow'),
          citations: [],
          keyHits:   l.ev.hits,
        });
      }

      yield { type: 'result', value: { results } };
    },
  };

  return {
    name: 'determine_provenance',
    description:
      `Trace where claims came from — provenance, not truth. Searches a session's tool results and user messages for each claim's literal keys (proper nouns, numbers, and their formatting variants), reads what it finds, and for anything the session cannot account for re-asks the same model cold, with none of this context, to tell a fact from the weights apart from a confabulation.
Per claim it returns one of:
  retrieved   — a tool result in this session carries it (definitive)
  given       — the user said it
  derived     — computable from material that is here (the value is absent, its operands are not)
  model-prior — not here, but the model asserts it without this context
  unsourced   — not here, and the model does not assert it cold: confabulated
  vetoed      — you named a discriminating key that appears nowhere in the session, so the search stopped: this specific term isn't here (distinct from unsourced, which means nothing bearing on the claim is here at all)

Every result also carries \`keyHits\`: for each key the search used, whether it was seen and in which sources (\`USER\`, \`TOOL:<name>\`). Read \`keyHits\` to see which parts of a composed claim are retrieved and which are fabricated — a \`vetoed\` verdict names the offender as the entry with \`found: false\`.

Omit \`sessionId\` to trace against the specific session - this is more accurate and efficient that passing the current session ID. Pass \`sessionId\` to trace against another session.
Pass \`keys\` when you know the discriminating term: a key appearing nowhere then zeroes the search (verdict \`vetoed\`), which IS the answer. \`unsourced\` means NOT SOURCED HERE, never false — training data is a legitimate origin, and the policy for an unsourced claim is yours. Citations are returned verbatim so a verdict can be checked rather than trusted.
Pass \`ignoreTools\` to exclude specific tools' output from the search pool for this call (an empty array includes everything). Without it, the pin from \`provenance_config\` applies, else a coded default that excludes \`determine_provenance\` itself to prevent self-referential citations.`,
    inputSchema: {
      type:     'object',
      required: ['claims'],
      properties: {
        claims: {
          type:        'array',
          description: 'The claims to trace. `keys` are the literal terms that discriminate the claim (a name, a figure); omit to derive them. Split composite claims into multiple keys so the veto can identify the exact absent term.',
          items: {
            type:       'object',
            required:   ['claim'],
            properties: {
              claim: { type: 'string', description: 'One short claim, as asserted.' },
              keys:  { type: 'array', items: { type: 'string' }, description: 'Literal search terms. Every one must appear somewhere in the session or the claim is vetoed. Split composite terms (e.g. a path) into their discriminating parts so the veto pinpoints the offender.' },
            },
          },
        },
        probe:     { type: 'boolean', description: 'Set false to skip the cold re-ask; unsourced and model-prior are then both reported as unsourced.' },
        sessionId: { type: 'string',  description: 'Trace against another session. Defaults to the current session.' },
        provider:  { type: 'string',  description: 'Model for reading the extracts. Defaults to the pinned classifier, else the current turn\'s. Never applies to the cold probe.' },
        ignoreTools: { type: 'array', items: { type: 'string' }, description: 'Tool names whose output is excluded from the search pool for this call. Overrides the pin from provenance_config; that in turn overrides a coded default that excludes `determine_provenance`. Pass [] to include every tool.' },
      },
    },
    executor,
  };
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services: MatbotMachine) {
    services.tools.register(makeTool(services));
    services.tools.register(createProvenanceConfigTool(services));
  },
};

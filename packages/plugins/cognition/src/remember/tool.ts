/**
 * The `remember_fact` tool: the "Remember this" skill, compiled by hand into a direct side-effect.
 *
 * Where the skill made the model hand-copy provenance it had to go *fetch* (session get/list/get,
 * then a store write — four turns for one fact), this reads the triggering message and its
 * provenance straight off `ctx.session` (zero round-trips), makes ONE `singleTurn` to extract and
 * normalise the durable fact(s) — the single irreducibly-judgement step — and writes them to the
 * remembered_facts store. It yields NO result, so when a trigger fires it the model never wakes: a
 * silent side-effect. (It is also a normal tool the model may call directly to capture the turn.)
 *
 * Silent for now — the only trace is a console line. A visible breadcrumb needs a `marker` ToolEvent
 * (a separate, general primitive); see the slice notes.
 */

import type { MatbotServices, Tool, ToolExecutor, ToolContext, ToolEvent, Message } from '@matatbread/matbot-plugin-api';
import type { RememberedFact } from '../dream/types.js';

const EXTRACT_SYSTEM =
`You capture durable facts a user has EXPLICITLY asserted about themselves or their world, from a
single message, for recall in future conversations.

Be conservative. Extract only what the message plainly states — never infer, embellish, or read
between the lines. Most messages contain nothing durable; an empty array [] is the common, correct
answer. When in doubt, leave it out.

Rules:
- A correction IS a durable fact — record what the user asserts is actually true. This covers
  correcting the assistant's mistaken assumption (assistant assumed "Viz the software"; user says
  "I meant the comic" -> "The user was referring to Viz the comic") and the user correcting their own
  earlier statement ("actually it's Tuesday, not Monday"). Capture the corrected content itself, not
  the claim it replaced.
- Record only what is explicitly stated. Never infer feelings, preferences, or opinions that were not
  stated outright: "I meant the comic" is NOT "the user likes the comic"; a correction is not an
  endorsement. This inference is the main thing to avoid.
- Exclude greetings, questions, opinions without factual content, task instructions ("remember to
  restart the server"), and anything about the assistant or this conversation itself.

Output ONLY a JSON array of strings — each one self-contained fact, normalised to the third person
about the user where relevant ("my neighbours are X" -> "The user's neighbours are X"). Split
distinct facts into separate elements. Nothing durable -> [].`;

function textOf(msg: Message | undefined): string {
  return msg?.content.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
}

export function createRememberFactTool(services: MatbotServices): Tool {
  const executor: ToolExecutor = {
    async *execute(_input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      // The fact lives in the latest genuine (non-robo) user message; its id/createdAt are the
      // provenance, ctx.session.id the session. All ambient — nothing to fetch.
      const msg  = ctx.session.messages.findLast(m => m.role === 'user' && !m.content.every(c => c.origin === 'robo'));
      const text = textOf(msg);
      if (ctx.provider === undefined || msg === undefined || text.trim() === '') {
        console.warn('[remember_fact] nothing to remember (no provider, or no user message in context).');
        return;
      }

      let facts: string[] = [];
      try {
        const res = await services.singleTurn({ provider: ctx.provider, system: EXTRACT_SYSTEM, prompt: text, signal: ctx.signal });
        const m = res.text.match(/\[[\s\S]*\]/);
        const parsed = m ? JSON.parse(m[0]) : [];
        facts = Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : [];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[remember_fact] extraction failed:', msg);
        yield { type: 'error', message: `remember_fact extraction failed: ${msg}` };
        return;
      }

      if (facts.length === 0) {
        console.warn(`[remember_fact] no durable facts found in message ${msg.id}.`);
        return;
      }

      const store = services.createStore<RememberedFact>('remembered_facts');
      for (const fact of facts) {
        const doc: RememberedFact = {
          id:        crypto.randomUUID(),
          version:   Date.now().toString(),
          fact,
          sessionId: ctx.session.id,
          messageId: msg.id,
          createdAt: msg.createdAt,
        };
        await store.set(doc.id, doc);
      }

      console.warn(`[remember_fact] stored ${facts.length} fact(s) from message ${msg.id} (session ${ctx.session.id}):`);
      for (const f of facts) console.warn(`  • ${f}`);

      // A durable, LLM-invisible trace of what was captured — so a silent firing is auditable
      // post-mortem (which message, which facts). No `result` event: the model is not woken.
      yield { type: 'marker', creator: 'remember_fact', data: { messageId: msg.id, sessionId: ctx.session.id, facts } };
    },
  };

  return {
    name: 'remember_fact',
    description:
      'Store durable fact(s) the user wants remembered across conversations. Extracts them from the ' +
      'latest user message and reads provenance (session id, message id, timestamp) from context — ' +
      'takes no parameters. Writes one document per fact to the remembered_facts store. Returns ' +
      'nothing: fired by a trigger it runs as a silent side-effect (you are not involved); you may ' +
      'also call it directly to capture the current message.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    executor,
  };
}

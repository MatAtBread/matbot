import type {
  Tool, ToolExecutor, ToolContract, ToolResultOf, ToolContext, MatbotMachine, Message, MimeType, UserContent, FileStore, Usage,
} from '@matatbread/matbot-plugin-api';
import { collectBytes, encodeBase64, subTurnDepth, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
// The arm mapping is the runner's, not a copy of it: it decides which types may be sent at all, and a
// rule with two copies is one that gets fixed in one of them.
import { armFor, findAttachment } from './media.js';
import { MAX_SUB_TURN_DEPTH, runSubTurn, subTurnFrame, subTurnSeed, type SubTurnFailure, type SubTurnWork } from './sub-turn.js';

export { MAX_SUB_TURN_DEPTH, type SubTurnFailure, type SubTurnWork } from './sub-turn.js';

/** How many of one call's `turns` run at once; the rest wait for a free slot. They share a provider's rate
 *  limits, so a larger call takes longer rather than failing. Per call, not across the machine. */
export const MAX_CONCURRENT_TURNS = 4;

interface SubTurnBase {
  prompt:    string;
  context?:  string;
  provider?: string;
  attach?:   string[];
}
/** One request to a model, with no tools. */
export interface LanguageTurn extends SubTurnBase { tools?: false; system?: string; transcript?: never }
/** A full agent turn within the calling session. */
export interface AgentTurn extends SubTurnBase { tools: true; transcript?: boolean; system?: never }
export type SubTurn = LanguageTurn | AgentTurn;

export interface SubTurnAnswer { ok: true; text: string; usage: Usage }
export type SubTurnResult = SubTurnAnswer | SubTurnWork | SubTurnFailure;

/** What a turn returns when it succeeds, given the turn that asked: a tool turn's work, with `messages`
 *  exactly where it asked for a transcript. A turn whose `tools` is only known at run time may be either. */
export type SubTurnAnswered<T> =
  T extends { tools: true }
    ? Omit<SubTurnWork, 'messages'> & (T extends { transcript: true } ? { messages: Message[] } : { messages?: never })
    : T extends { tools?: false } ? SubTurnAnswer : SubTurnAnswer | SubTurnWork;

/** Without this, a generic `T` accepts a turn carrying a field it does not have, so a misspelt `provder`
 *  compiles and quietly runs on the default provider. (`system` with tools, and `transcript` without, are
 *  the union's own `never`s.) A plain key list, because a conditional on `T` here defeats the inference. */
export type ExactSubTurn<T> = T & Record<Exclude<keyof T, keyof LanguageTurn | keyof AgentTurn>, never>;

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    single_turn:
      | ToolContract<SubTurnAnswer | SubTurnWork, SubTurn, <const T extends SubTurn>(params: ExactSubTurn<T>) => Promise<SubTurnAnswered<T>>>
      | ToolContract<
          SubTurnResult[],
          { turns: SubTurn[] },
          <const T extends readonly SubTurn[]>(params: { turns: T & { [K in keyof T]: ExactSubTurn<T[K]> } }) =>
            Promise<{ -readonly [K in keyof T]: SubTurnAnswered<T[K]> | SubTurnFailure }>
        >;
  }
}

/**
 * Resolve `attach` names/ids to inline media for a turn without tools. An attachment of this session answers
 * to the id the model is shown beside it. Otherwise it is looked up by **id first, then name**, across the
 * MediaStore and then the turn's own file store: an id is unambiguous and a name is what a model actually has
 * to hand, and both stores are in play because session media and workspace files are separately owned. Such a
 * turn has no session and so no residency window — whatever is named is sent, once, and the caller's own
 * provider limits are the only ceiling.
 */
async function resolveAttachments(
  names:    readonly string[],
  messages: readonly Message[],
  stores:   ReadonlyArray<FileStore | undefined>,
  signal: AbortSignal | undefined,
): Promise<{ content: UserContent[]; missing: string[]; unsupported: string[] }> {
  const content: UserContent[] = [];
  const missing: string[] = [];
  const unsupported: string[] = [];
  for (const ref of names) {
    const attached = findAttachment(messages, ref);
    const wanted   = attached?.fileId ?? ref;
    let handle = null;
    for (const store of stores) {
      if (store === undefined) continue;
      handle = await store.get(wanted).catch(() => null) ?? await store.getByName(wanted).catch(() => null);
      if (handle !== null) break;
    }
    if (handle === null) { missing.push(ref); continue; }
    // A type no endpoint decodes is refused, not routed to an arm that will 400 the call. Reported
    // apart from `missing`: "no such file" would send the model hunting for a file it named correctly.
    const arm = armFor(handle.mimeType);
    if (arm === null) { unsupported.push(`${ref} (${handle.mimeType})`); continue; }
    const bytes = await collectBytes(handle.stream(signal));
    content.push({ type: arm, data: encodeBase64(bytes), mimeType: handle.mimeType as MimeType, name: attached?.name ?? handle.name });
  }
  return { content, missing, unsupported };
}

const COMMON = new Set(['prompt', 'context', 'provider', 'attach', 'tools']);

// Validators are optional and a minimal install has none, so this is the boundary for that install.
function refusal(where: string, turn: unknown): string | undefined {
  if (turn === null || typeof turn !== 'object' || Array.isArray(turn)) return `${where} is not a turn: { "prompt": "…" }.`;
  const t = turn as Record<string, unknown>;
  if (t['tools'] !== undefined && typeof t['tools'] !== 'boolean') return `${where}: "tools" is true or false.`;
  const tools = t['tools'] === true;
  for (const k of Object.keys(t)) {
    if (COMMON.has(k)) continue;
    if (k === 'system' && !tools) continue;
    if (k === 'transcript' && tools) continue;
    if (k === 'system') return `${where} has "system", which only a turn without tools takes. A turn with tools has this matbot's own system prompt, so put instructions in "context".`;
    if (k === 'transcript') return `${where} has "transcript", which only a turn with tools returns.`;
    return `${where} has an unknown field "${k}". A turn takes prompt, context, provider, attach and tools, and system (without tools) or transcript (with tools).`;
  }
  if (typeof t['prompt'] !== 'string' || t['prompt'] === '') return `${where} requires a non-empty string "prompt".`;
  if (t['context'] !== undefined && typeof t['context'] !== 'string') return `${where}: "context" is a string.`;
  if (t['transcript'] !== undefined && typeof t['transcript'] !== 'boolean') return `${where}: "transcript" is true or false.`;
  if (t['attach'] !== undefined && (!Array.isArray(t['attach']) || t['attach'].some(a => typeof a !== 'string'))) {
    return `${where}: "attach" is an array of file names or attachment ids, e.g. ["chart.png"].`;
  }
  return undefined;
}

interface Prepared { provider: string; tools: boolean; transcript: boolean; system?: string; content: UserContent[] }

/**
 * The model-facing surface of {@link MatbotMachine.singleTurn} and of a sub-turn: a prompt run apart from this
 * conversation, as one request to a model (the default) or, with `tools: true`, as a full agent turn within
 * the session (see `sub-turn.ts`). `turns` runs several at the same time.
 *
 * One tool, because the two questions a caller faces are independent: whether the work needs to act, and
 * whether its pieces can run at once. Two tools answering the first would each have to explain the second,
 * and a model reading "parallel" in one name picked it for language work that needed no tools at all.
 *
 * Concurrency is in the call because the runner executes a message's tool calls one after another, and must:
 * calls a model sends side by side may depend on one another (a write, then a run of what was written), which
 * nothing in the protocol rules out. Turns listed in one call are declared independent by the caller, which
 * is what makes running them at once sound. It also needs no `function-tools`, and leaves no sibling running
 * after the call returns.
 *
 * It lives in core because it is the model-facing surface of core services, and core is the one
 * cross-runtime home both the node app and the browser bundle register it from.
 */
export function createSingleTurnTool(machine: MatbotMachine): Tool<ToolResultOf<'single_turn'>> {
  const executor: ToolExecutor<ToolResultOf<'single_turn'>> = {
    async *execute(input: unknown, ctx: ToolContext) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        yield { type: 'error', message: 'single_turn takes one turn, { "prompt": "…" }, or several, { "turns": [{ "prompt": "…" }, …] }.' };
        return;
      }
      const args = input as Record<string, unknown>;
      let raw: unknown[];
      const many = 'turns' in args;
      if (many) {
        const stray = Object.keys(args).find(k => k !== 'turns');
        if (stray !== undefined) { yield { type: 'error', message: `single_turn takes one turn's fields or "turns", not both: move "${stray}" into a turn.` }; return; }
        if (!Array.isArray(args['turns']) || args['turns'].length === 0) { yield { type: 'error', message: '"turns" is a list of at least one turn: { "turns": [{ "prompt": "…" }] }.' }; return; }
        raw = args['turns'];
      } else {
        raw = [args];
      }

      // Everything a call can get wrong is reported before any turn starts, so a bad entry never leaves its
      // siblings having already acted.
      const prepared: Prepared[] = [];
      for (const [i, r] of raw.entries()) {
        const where = many ? `Turn ${i + 1}` : 'The turn';
        const why = refusal(where, r);
        if (why !== undefined) { yield { type: 'error', message: why }; return; }
        const turn = r as SubTurnBase & { tools?: boolean; system?: string; transcript?: boolean };
        const provider = turn.provider ?? ctx.provider;
        if (!provider) { yield { type: 'error', message: `${where} needs a "provider": none was given and there is no current turn provider to fall back to.` }; return; }
        if (!machine.providers.has(provider)) {
          const known = [...machine.providers.keys()].join(', ') || '(none configured)';
          yield { type: 'error', message: `${where} names an unknown provider "${provider}". Configured providers: ${known}.` };
          return;
        }
        const tools = turn.tools === true;
        const said: UserContent[] = [
          ...(turn.context !== undefined && turn.context !== '' ? [{ type: 'text', text: turn.context } as const] : []),
          { type: 'text', text: turn.prompt },
        ];
        const attach = turn.attach ?? [];
        if (tools) {
          // Session media only, by reference: the runner resolves it against this same session, and anything
          // else would be written into the session's media as the turn opened. The turn can open a file itself.
          const refs: UserContent[] = [];
          for (const ref of attach) {
            const found = findAttachment(ctx.session.messages, ref);
            if (found === undefined) {
              yield { type: 'error', message: `${where} attaches "${ref}", which is not an attachment of this conversation. A turn with tools takes attachments by the id shown beside them, and can open a stored file itself.` };
              return;
            }
            refs.push(found);
          }
          prepared.push({ provider, tools, transcript: turn.transcript === true, content: [subTurnFrame(ctx.session.id), ...refs, ...said] });
          continue;
        }
        // Media the store doesn't have is REPORTED, not silently dropped: a model answering about a file it
        // never saw is the failure that looks like a bad answer rather than a bad call.
        const { content, missing, unsupported } = attach.length > 0
          ? await resolveAttachments(attach, ctx.session.messages, [machine.MediaStore, ctx.files], ctx.signal)
          : { content: [], missing: [], unsupported: [] };
        if (missing.length > 0) {
          yield { type: 'error', message: `${where}: no such file(s): ${missing.join(', ')}. Attachments are looked up by attachment id, store id or name.` };
          return;
        }
        if (unsupported.length > 0) {
          yield { type: 'error', message:
            `${where}: no model endpoint decodes ${unsupported.join(', ')}, so sending it would fail ` +
            'the call. Convert it to PNG or JPEG, or read the file as text and put that in the context.' };
          return;
        }
        prepared.push({ provider, tools, transcript: false, content: [...content, ...said], ...(turn.system !== undefined ? { system: turn.system } : {}) });
      }

      const acting = prepared.some(p => p.tools);
      const principal = tryCurrentPrincipal();
      let seed: Message[] = [];
      if (acting) {
        if (principal === undefined) { yield { type: 'error', message: 'single_turn has no principal to run a turn with tools as.' }; return; }
        if (machine.ephemeral === undefined) { yield { type: 'error', message: 'This matbot cannot run a turn with tools beside this one.' }; return; }
        const depth = subTurnDepth(ctx.session.messages);
        if (depth >= MAX_SUB_TURN_DEPTH) {
          yield { type: 'error', message: `This turn is already ${depth} levels below the conversation, the most allowed, so it cannot start a turn with tools. Do this work in this turn.` };
          return;
        }
        seed = subTurnSeed(ctx.session.messages, depth + 1);
      }

      // Stops every turn however this generator ends, a caller abandoning it included.
      const stop = new AbortController();
      const signal = AbortSignal.any([ctx.signal, stop.signal]);
      const nothing: Usage = { inputTokens: 0, outputTokens: 0 };
      // A turn without tools records its spend ambiently, as any tool's completion does; a sub-turn's is
      // charged to the caller by `runSubTurn`.
      const runOne = async (p: Prepared): Promise<SubTurnResult> => {
        if (p.tools) return runSubTurn(machine, p, seed, principal!, ctx, signal);
        try {
          const { text, usage: { reported: _reported, ...usage } } = await machine.singleTurn({
            provider: p.provider, prompt: p.content, signal, ...(p.system !== undefined ? { system: p.system } : {}),
          });
          return { ok: true, text, usage };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e), usage: nothing };
        }
      };

      try {
        if (!many) {
          const result = await runOne(prepared[0]!);
          if (!result.ok) { yield { type: 'error', message: result.error }; return; }
          yield { type: 'result', value: result };
          return;
        }
        const results: Array<SubTurnResult | undefined> = prepared.map(() => undefined);
        let finished = 0;
        let wake: (() => void) | undefined;
        let next = 0;
        const worker = async (): Promise<void> => {
          for (let i = next++; i < prepared.length; i = next++) {
            results[i] = await runOne(prepared[i]!);
            finished++;
            wake?.();
          }
        };
        const workers = Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_TURNS, prepared.length) }, worker));
        let reported = 0;
        while (finished < prepared.length) {
          await new Promise<void>(resolve => {
            wake = resolve;
            if (finished > reported) resolve();
          });
          if (finished > reported && finished < prepared.length) {
            reported = finished;
            yield { type: 'progress', pct: Math.round(reported / prepared.length * 100), message: `${reported} of ${prepared.length} turns finished` };
          }
        }
        await workers;
        yield { type: 'result', value: results as SubTurnResult[] };
      } finally {
        stop.abort();
      }
    },
  };

  const turnProps = {
    prompt:     { type: 'string', description: 'The task.' },
    context:    { type: 'string', description: 'Everything the task needs that is not in `prompt`: the turn cannot see this conversation. Locations, constraints, decisions and the form of the answer.' },
    tools:      { type: 'boolean', description: 'true: a full agent turn that can act, with this turn\'s tools and permissions. Optional: off by default, one request to a model with no tools.' },
    provider:   { type: 'string', description: 'A configured provider to run it on. Optional: defaults to the current turn\'s provider.' },
    system:     { type: 'string', description: 'A system prompt, for a turn without tools. Optional.' },
    attach:     { type: 'array', items: { type: 'string' }, description: 'Files to send with it: an attachment of this conversation by the id shown beside it, or (without tools) a stored file by name or id, e.g. ["chart.png"]. Optional.' },
    transcript: { type: 'boolean', description: 'With tools: also return the turn\'s full `messages`. Optional: leave it off unless code will reduce them.' },
  };

  return {
    name: 'single_turn',
    description:
      'Run a prompt as a separate turn and get its answer back. The turn starts fresh: it does not see this ' +
      'conversation, so `context` must say everything it needs (locations, constraints, decisions, the form of ' +
      'the answer).\n\n' +
      'Without `tools` it is one request to a model, with no tools and no side effects: the cheapest option, and ' +
      'it sees only what you send. Use it for language work (summarising, classifying, extracting, translating, ' +
      'rewriting, critiquing), or for a second opinion from a different model, named by `provider` (omit it for ' +
      'the current one). `system` sets its system prompt.\n\n' +
      'With `tools: true` it is a full agent turn within this conversation: it has this turn\'s tools and ' +
      'permissions and CAN act (read and write files, run commands, call tools) over as many steps as it needs, ' +
      'carrying the caller\'s risk. Use it for a sub-task that has to act, or whose intermediate steps would flood ' +
      'this conversation.\n\n' +
      'To run several turns at the same time, pass them as `turns`; the results come back in the same order. Use ' +
      'it when a request holds pieces that are independent of each other and whose results are to be combined. ' +
      'Pieces that depend on one another go in order, in separate calls. Calls sent side by side in one message ' +
      'run one after another, so independent pieces go in one call.\n' +
      '  { "prompt": "Summarise this changelog for users", "context": "<the changelog>" }\n' +
      '  → { "ok": true, "text": "…", "usage": {…} }\n' +
      '  { "turns": [ { "prompt": "Run the typecheck", "context": "In /work/app, with `npm run typecheck`. Answer with a count of the errors.", "tools": true },\n' +
      '               { "prompt": "Summarise this changelog for users", "context": "<the changelog>" } ] }\n' +
      '  → [ { "ok": true, "text": "…", "toolCalls": […], "usage": {…} }, { "ok": false, "error": "…", "usage": {…} } ]\n' +
      `In \`turns\`, one failing does not stop the others, so check \`ok\`. At most ${MAX_CONCURRENT_TURNS} run at ` +
      'once and the rest wait. A turn with tools is a whole agent with its own context, so separate those where ' +
      'the work would otherwise be waiting (shell, HTTP, file scans), not merely for separate thoughts.\n\n' +
      '`attach` sends files: an attachment of this conversation by the id shown beside it, or (without tools) a ' +
      'stored file by name or id. An image in a format no endpoint decodes (HEIC, SVG, BMP, TIFF) is refused. ' +
      '`transcript: true` adds a tool turn\'s full `messages`: ask for it only from code that will reduce it, ' +
      'since a tool result stays in this conversation.',
    inputSchema: {
      type:       'object',
      properties: {
        ...turnProps,
        turns: { type: 'array', minItems: 1, description: 'Several turns to run at the same time, instead of one. Results come back in this order.', items: { type: 'object', required: ['prompt'], properties: turnProps } },
      },
    },
    executor,
  };
}

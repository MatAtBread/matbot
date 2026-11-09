import type {
  Tool, ToolEvent, ToolExecutor, ToolContract, ToolResultOf, ToolContext, MatbotMachine, Message, MessageContent, MimeType, UserContent, FileStore,
} from '@matatbread/matbot-plugin-api';
import { collectBytes, encodeBase64, failureOf, subTurnDepth, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { withFailureNote } from './runner.js';
// The arm mapping is the runner's, not a copy of it: it decides which types may be sent at all, and a
// rule with two copies is one that gets fixed in one of them.
import { armFor, findAttachment } from './media.js';
import { MAX_SUB_TURN_DEPTH, runSubTurn, subTurnFrame, subTurnSeed, type SubTurnFailure, type SubTurnWork } from './sub-turn.js';

export { MAX_SUB_TURN_DEPTH, type SubTurnFailure, type SubTurnWork } from './sub-turn.js';

function* markerEvents(carried: readonly MessageContent[][]): Iterable<ToolEvent<never>> {
  for (const c of carried.flat()) if (c.type === 'marker') yield { type: 'marker', creator: c.creator, data: c.data };
}

/** How many of one call's `turns` run at once; the rest wait for a free slot. They share a provider's rate
 *  limits, so a larger call takes longer rather than failing. Per call, not across the machine. */
export const MAX_CONCURRENT_TURNS = 4;

/** A turn as a model and the validators see it. The typed call signatures below narrow it to
 *  {@link LanguageTurn} | {@link AgentTurn}; the executor refuses the combinations they rule out. */
export interface SubTurn {
  prompt:      string;
  context?:    string;
  tools?:      boolean;
  provider?:   string;
  system?:     string;
  attach?:     string[];
  transcript?: boolean;
}
/** One request to a model, with no tools. */
export interface LanguageTurn extends Omit<SubTurn, 'tools' | 'transcript'> { tools?: false; transcript?: never }
/** A full agent turn within the calling session. */
export interface AgentTurn extends Omit<SubTurn, 'tools' | 'system'> { tools: true; system?: never }

/** Several turns. A field beside `turns` applies to every turn: `context` and `attach` are added to each
 *  turn's own, and the rest are defaults a turn can override. */
export interface SubTurns extends Omit<SubTurn, 'prompt'> { turns: SubTurn[] }

/** What a model is told a turn returns. Deliberately loose (`messages` is for code, which the call
 *  signatures type exactly): every name here is spelt out in every tool description of every turn. */
export interface SubTurnSucceeded { ok: true; text: string; toolCalls?: { name: string; input: unknown; isError: boolean }[]; messages?: unknown[] }
export type SubTurnResult = SubTurnSucceeded | SubTurnFailure;
export interface SubTurnAnswer { ok: true; text: string }

/** What a turn returns when it succeeds, given the turn that asked: a tool turn's work, with `messages`
 *  exactly where it asked for a transcript. A turn whose `tools` is only known at run time may be either. */
export type SubTurnAnswered<T> =
  T extends { tools: true }
    ? Omit<SubTurnWork, 'messages'> & (T extends { transcript: true } ? { messages: Message[] } : { messages?: never })
    : T extends { tools?: false } ? SubTurnAnswer : SubTurnAnswer | SubTurnWork;

/** Without this, a generic `T` accepts a turn carrying a field it does not have, so a misspelt `provder`
 *  compiles and quietly runs on the default provider. (`system` with tools, and `transcript` without, are
 *  the union's own `never`s.) A plain key list, because a conditional on `T` here defeats the inference. */
export type ExactSubTurn<T> = T & Record<Exclude<keyof T, keyof SubTurn>, never>;

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    single_turn:
      | ToolContract<SubTurnSucceeded, SubTurn, <const T extends LanguageTurn | AgentTurn>(params: ExactSubTurn<T>) => Promise<SubTurnAnswered<T>>>
      | ToolContract<
          (SubTurnSucceeded | SubTurnFailure)[],
          SubTurns,
          // Code says `tools` on each turn, which is what types each position; a model may also say it once.
          <const T extends readonly (LanguageTurn | AgentTurn)[]>(params: { turns: T & { [K in keyof T]: ExactSubTurn<T[K]> } } & Pick<SubTurn, 'context' | 'provider' | 'attach'>) =>
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

// A field beside `turns` is for every turn, which is how a model writes `tools: true` once for all of them.
// `context` and `attach` are each turn's as well as everyone's, so they add up; the rest are defaults a turn
// overrides. Whatever the merge produces is validated as the turn, so it can refuse nothing a turn could not.
function withShared(shared: Record<string, unknown>, turn: unknown): unknown {
  if (turn === null || typeof turn !== 'object' || Array.isArray(turn) || Object.keys(shared).length === 0) return turn;
  const own = turn as Record<string, unknown>;
  const context = [shared['context'], own['context']].filter(c => c !== undefined && c !== '');
  const attach  = [shared['attach'], own['attach']].filter(a => a !== undefined);
  return {
    ...shared, ...own,
    ...(context.length > 0 ? { context: context.length === 1 ? context[0] : context.join('\n\n') } : {}),
    ...(attach.length > 0 ? { attach: attach.length === 1 ? attach[0] : attach.flatMap(a => (Array.isArray(a) ? a : [a])) } : {}),
  };
}

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
// Every word here is sent in every turn, so it says what decides the call and leaves the shape to the
// contract text and the schema. Probed on DeepSeek and Gemini: without the example neither model delegated
// agentic work at all, and an example whose prompt read like a command ("Run `npm run typecheck`" beside
// "a task in words, not a tool call") had Gemini write turns as `bash` calls.
export const DESCRIPTION =
  'Run a prompt as a separate turn and return what it says. It does not see this conversation: put ' +
  'everything it needs in `context`.\n' +
  'Without `tools`: one request to a model, no tools. The cheapest way to summarise, classify, extract, ' +
  'translate or critique, or to ask another model (`provider`).\n' +
  'With `tools: true`: a full agent turn with your tools and permissions, which can act over many steps. For ' +
  'a sub-task that has to act, or whose steps would flood this conversation.\n' +
  '`turns: [...]` runs several at the same time and returns their results in order, each with `ok`. Use it ' +
  'for independent pieces whose results you will combine; calls side by side run one after another. ' +
  '"Review the code and run the typecheck, then report both":\n' +
  '  { "turns": [ { "prompt": "Review src/ for bugs", "context": "Code in /work/app. Bullet list.", "tools": true },\n' +
  '               { "prompt": "Run `npm run typecheck`", "context": "In /work/app. Count the errors.", "tools": true } ] }';

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
        const { turns, ...shared } = args;
        if ('prompt' in shared) { yield { type: 'error', message: 'With "turns", each turn has its own "prompt": move it into a turn.' }; return; }
        const stray = Object.keys(shared).find(k => !COMMON.has(k) && k !== 'system' && k !== 'transcript');
        if (stray !== undefined) { yield { type: 'error', message: `"${stray}" beside "turns" is not a turn field. A field there applies to every turn: context, provider, attach, tools, system or transcript.` }; return; }
        if (!Array.isArray(turns) || turns.length === 0) { yield { type: 'error', message: '"turns" is a list of at least one turn: { "turns": [{ "prompt": "…" }] }.' }; return; }
        raw = turns.map(t => withShared(shared, t));
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
        const turn = r as SubTurn;
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
      // A turn without tools records its spend ambiently, as any tool's completion does; a sub-turn's is
      // charged to the caller by `runSubTurn`.
      // What each turn's tools recorded, by position, yielded before the result so the runner stores it in
      // this session as this tool's own markers, in the order the turns were given.
      const carried: MessageContent[][] = prepared.map(() => []);
      const runOne = async (p: Prepared, i: number): Promise<SubTurnResult> => {
        if (p.tools) return runSubTurn(machine, p, seed, principal!, ctx, signal, markers => { carried[i] = markers; });
        try {
          const { text } = await machine.singleTurn({
            provider: p.provider, prompt: p.content, signal, ...(p.system !== undefined ? { system: p.system } : {}),
          });
          return { ok: true, text };
        } catch (e) {
          // The class goes in the text, not a field of its own: what a model reads of this tool is spelt out
          // in its contract on every turn, and a model reasons from the words anyway.
          return { ok: false, error: withFailureNote(e instanceof Error ? e.message : String(e), failureOf(e)) };
        }
      };

      try {
        if (!many) {
          const result = await runOne(prepared[0]!, 0);
          if (!result.ok) { yield { type: 'error', message: result.error }; return; }
          yield* markerEvents(carried);
          yield { type: 'result', value: result };
          return;
        }
        const results: Array<SubTurnResult | undefined> = prepared.map(() => undefined);
        let finished = 0;
        let wake: (() => void) | undefined;
        let next = 0;
        const worker = async (): Promise<void> => {
          for (let i = next++; i < prepared.length; i = next++) {
            results[i] = await runOne(prepared[i]!, i);
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
        yield* markerEvents(carried);
        yield { type: 'result', value: results as SubTurnResult[] };
      } finally {
        stop.abort();
      }
    },
  };

  const turnProps = {
    prompt:     { type: 'string', description: 'The task.' },
    context:    { type: 'string', description: 'What it needs to know. It cannot see this conversation.' },
    tools:      { type: 'boolean', description: 'true: a full agent turn that can act. Default: one request, no tools.' },
    provider:   { type: 'string', description: 'A configured provider. Default: the current one.' },
    system:     { type: 'string', description: 'A system prompt, without tools.' },
    attach:     { type: 'array', items: { type: 'string' }, description: 'Files to send: an attachment id from this conversation, or (without tools) a stored file name.' },
    transcript: { type: 'boolean', description: 'With tools: also return its messages, for code to reduce.' },
  };

  return {
    name: 'single_turn',
    description: DESCRIPTION,
    inputSchema: {
      type:       'object',
      properties: {
        ...turnProps,
        turns: { type: 'array', minItems: 1, description: 'Several turns, run at the same time; results come back in this order. A field beside `turns` applies to every turn.', items: { type: 'object', required: ['prompt'], properties: turnProps } },
      },
    },
    executor,
  };
}

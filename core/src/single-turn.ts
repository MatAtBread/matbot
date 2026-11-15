import type {
  Tool, ToolEvent, ToolExecutor, ToolContract, ToolResultOf, ToolContext, MatbotMachine, Message, MessageContent, MimeType, UserContent, FileStore,
} from '@matatbread/matbot-plugin-api';
import { collectBytes, describeProviders, encodeBase64, failureOf, subTurnDepth, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { withCallFrames } from '@matatbread/matbot-plugin-api/host';
import { withFailureNote } from './runner.js';
// The arm mapping is the runner's, not a copy of it: it decides which types may be sent at all, and a
// rule with two copies is one that gets fixed in one of them.
import { armFor, findAttachment } from './media.js';
import { MAX_SUB_TURN_DEPTH, runSubTurn, subTurnFrame, subTurnSeed } from './sub-turn.js';

export { MAX_SUB_TURN_DEPTH } from './sub-turn.js';

// A sub-turn's markers come back as this call's own, still carrying the frames the sub-turn's runner stamped
// on them, so the runner storing them puts `single_turn`'s frame ahead of the calls made inside the sub-turn.
function* markerEvents(carried: readonly MessageContent[]): Iterable<ToolEvent<never>> {
  for (const c of carried) {
    if (c.type !== 'marker') continue;
    const ev = { type: 'marker' as const, creator: c.creator, data: c.data };
    yield c.by !== undefined ? withCallFrames(ev, c.by) : ev;
  }
}

/** A turn as a model and the validators see it. `system` is for a turn without tools and `transcript` for one
 *  with them; the executor refuses either on the other kind. */
export interface SubTurn {
  prompt:      string;
  context?:    string;
  tools?:      boolean;
  provider?:   string;
  system?:     string;
  attach?:     string[];
  transcript?: boolean;
}

/** What a turn says. A turn with tools adds the calls it made, and its own messages when it asked for a
 *  `transcript`. Every name here is spelt out in every tool description of every turn. */
export interface SubTurnResult {
  text:       string;
  toolCalls?: { name: string; input: unknown; isError: boolean }[];
  messages?:  Message[];
}

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    single_turn: ToolContract<SubTurnResult, SubTurn>;
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
function refusal(turn: Record<string, unknown>): string | undefined {
  if (turn['tools'] !== undefined && typeof turn['tools'] !== 'boolean') return '"tools" is true or false.';
  const tools = turn['tools'] === true;
  for (const k of Object.keys(turn)) {
    if (COMMON.has(k)) continue;
    if (k === 'system' && !tools) continue;
    if (k === 'transcript' && tools) continue;
    if (k === 'system') return '"system" is only for a turn without tools. A turn with tools has this matbot\'s own system prompt, so put instructions in "context".';
    if (k === 'transcript') return '"transcript" is only returned by a turn with tools.';
    return `Unknown field "${k}". single_turn takes prompt, context, provider, attach and tools, and system (without tools) or transcript (with tools).`;
  }
  if (typeof turn['prompt'] !== 'string' || turn['prompt'] === '') return 'single_turn requires a non-empty string "prompt".';
  if (turn['context'] !== undefined && typeof turn['context'] !== 'string') return '"context" is a string.';
  if (turn['transcript'] !== undefined && typeof turn['transcript'] !== 'boolean') return '"transcript" is true or false.';
  if (turn['attach'] !== undefined && (!Array.isArray(turn['attach']) || turn['attach'].some(a => typeof a !== 'string'))) {
    return '"attach" is an array of file names or attachment ids, e.g. ["chart.png"].';
  }
  return undefined;
}

/**
 * The model-facing surface of {@link MatbotMachine.singleTurn} and of a sub-turn: a prompt run apart from this
 * conversation, as one request to a model (the default) or, with `tools: true`, as a full agent turn within
 * the session (see `sub-turn.ts`). It returns what that turn said, and nothing else.
 *
 * One turn per call. Running several at once, and where their answers go, is composition: a body holding the
 * promises of several calls knows exactly when they have all settled and can send each answer wherever it is
 * wanted, which a field here could only enumerate. It took a `turns` list during 0.5.0's development, which
 * read as the map-reduce primitive while having nowhere to put a result but its own return value.
 *
 * It lives in core because it is the model-facing surface of core services, and core is the one
 * cross-runtime home both the node app and the browser bundle register it from.
 */
// Every word here is sent in every turn, so it says what decides the call and leaves the shape to the
// contract text and the schema. Probed on DeepSeek and Gemini: without an example neither model delegated
// agentic work at all, and an example whose prompt read like a command ("Run `npm run typecheck`") had
// Gemini write a turn as a `bash` call.
export const DESCRIPTION =
  'Run a prompt as a separate turn and return what it says. It does not see this conversation: put ' +
  'everything it needs in `context`.\n' +
  'Without `tools`: one request to a model, no tools. The cheapest way to summarise, classify, extract, ' +
  'translate or critique, or to ask another model (`provider`).\n' +
  'With `tools: true`: a full agent turn with your tools and permissions, which can act over many steps. For ' +
  'a sub-task that has to act, or whose steps would flood this conversation:\n' +
  '  { "prompt": "Review src/ for bugs", "context": "Code in /work/app. Bullet list.", "tools": true }';

export function createSingleTurnTool(machine: MatbotMachine): Tool<ToolResultOf<'single_turn'>> {
  const executor: ToolExecutor<ToolResultOf<'single_turn'>> = {
    async *execute(input: unknown, ctx: ToolContext) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        yield { type: 'error', message: 'single_turn takes a turn: { "prompt": "…" }.' };
        return;
      }
      const why = refusal(input as Record<string, unknown>);
      if (why !== undefined) { yield { type: 'error', message: why }; return; }
      const turn = input as SubTurn;
      const provider = turn.provider ?? ctx.provider;
      if (!provider) { yield { type: 'error', message: 'single_turn needs a "provider": none was given and there is no current turn provider to fall back to.' }; return; }
      if (!machine.providers.has(provider)) {
        const known = describeProviders(machine.providers) || '(none configured)';
        yield { type: 'error', message: `Unknown provider "${provider}". Configured providers: ${known}.` };
        return;
      }
      const said: UserContent[] = [
        ...(turn.context !== undefined && turn.context !== '' ? [{ type: 'text', text: turn.context } as const] : []),
        { type: 'text', text: turn.prompt },
      ];
      const attach = turn.attach ?? [];

      if (turn.tools === true) {
        // Session media only, by reference: the runner resolves it against this same session, and anything
        // else would be written into the session's media as the turn opened. The turn can open a file itself.
        const refs: UserContent[] = [];
        for (const ref of attach) {
          const found = findAttachment(ctx.session.messages, ref);
          if (found === undefined) {
            yield { type: 'error', message: `"${ref}" is not an attachment of this conversation. A turn with tools takes attachments by the id shown beside them, and can open a stored file itself.` };
            return;
          }
          refs.push(found);
        }
        const principal = tryCurrentPrincipal();
        if (principal === undefined) { yield { type: 'error', message: 'single_turn has no principal to run a turn with tools as.' }; return; }
        if (machine.ephemeral === undefined) { yield { type: 'error', message: 'This matbot cannot run a turn with tools beside this one.' }; return; }
        const depth = subTurnDepth(ctx.session.messages);
        if (depth >= MAX_SUB_TURN_DEPTH) {
          yield { type: 'error', message: `This turn is already ${depth} levels below the conversation, the most allowed, so it cannot start a turn with tools. Do this work in this turn.` };
          return;
        }
        // What the turn's tools recorded is yielded before the result, so the runner stores it in this
        // session as this tool's own markers. Its spend is charged to the caller by `runSubTurn`.
        let carried: MessageContent[] = [];
        const work = await runSubTurn(machine, { provider, transcript: turn.transcript === true, content: [subTurnFrame(ctx.session.id), ...refs, ...said] },
          subTurnSeed(ctx.session.messages, depth + 1), principal, ctx, ctx.signal, markers => { carried = markers; });
        if ('error' in work) { yield { type: 'error', message: work.error }; return; }
        yield* markerEvents(carried);
        yield { type: 'result', value: work };
        return;
      }

      // Media the store doesn't have is REPORTED, not silently dropped: a model answering about a file it
      // never saw is the failure that looks like a bad answer rather than a bad call.
      const { content, missing, unsupported } = attach.length > 0
        ? await resolveAttachments(attach, ctx.session.messages, [machine.MediaStore, ctx.files], ctx.signal)
        : { content: [], missing: [], unsupported: [] };
      if (missing.length > 0) {
        yield { type: 'error', message: `No such file(s): ${missing.join(', ')}. Attachments are looked up by attachment id, store id or name.` };
        return;
      }
      if (unsupported.length > 0) {
        yield { type: 'error', message:
          `No model endpoint decodes ${unsupported.join(', ')}, so sending it would fail ` +
          'the call. Convert it to PNG or JPEG, or read the file as text and put that in the context.' };
        return;
      }
      // Its spend is recorded ambiently, as any tool's completion is.
      try {
        const { text } = await machine.singleTurn({
          provider, prompt: [...content, ...said], signal: ctx.signal, ...(turn.system !== undefined ? { system: turn.system } : {}),
        });
        yield { type: 'result', value: { text } };
      } catch (e) {
        // The class goes in the text, not a field of its own: what a model reads of this tool is spelt out
        // in its contract on every turn, and a model reasons from the words anyway.
        yield { type: 'error', message: withFailureNote(e instanceof Error ? e.message : String(e), failureOf(e)) };
      }
    },
  };

  return {
    name: 'single_turn',
    description: DESCRIPTION,
    inputSchema: {
      type:       'object',
      required:   ['prompt'],
      properties: {
        prompt:     { type: 'string', description: 'The task.' },
        context:    { type: 'string', description: 'What it needs to know. It cannot see this conversation.' },
        tools:      { type: 'boolean', description: 'true: a full agent turn that can act. Default: one request, no tools.' },
        provider:   { type: 'string', description: 'A configured provider. Default: the current one.' },
        system:     { type: 'string', description: 'A system prompt, without tools.' },
        attach:     { type: 'array', items: { type: 'string' }, description: 'Files to send: an attachment id from this conversation, or (without tools) a stored file name.' },
        transcript: { type: 'boolean', description: 'With tools: also return its messages, for code to reduce.' },
      },
    },
    executor,
  };
}

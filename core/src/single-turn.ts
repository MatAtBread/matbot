import type {
  Tool, ToolExecutor, ToolContract, ToolResultOf, ToolContext, MatbotMachine, MimeType, UserContent, FileStore,
} from '@matatbread/matbot-plugin-api';
import { collectBytes, encodeBase64 } from '@matatbread/matbot-plugin-api';
// The arm mapping is the runner's, not a copy of it: it decides which types may be sent at all, and a
// rule with two copies is one that gets fixed in one of them.
import { armFor } from './media.js';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    single_turn: ToolContract<{ text: string }, { provider?: string; prompt: string; system?: string; attach?: string[] }>;  // the consulted provider's reply text
  }
}

/**
 * Resolve `attach` names/ids to inline media for the one-shot. Looked up by **id first, then name**,
 * across the MediaStore and then the turn's own file store: an id is unambiguous and a name is what a
 * model actually has to hand, and both stores are in play because session media and workspace files are
 * separately owned. A one-shot has no session and so no residency window — whatever is named is sent,
 * once, and the caller's own provider limits are the only ceiling.
 */
async function resolveAttachments(
  names:  readonly string[],
  stores: ReadonlyArray<FileStore | undefined>,
  signal: AbortSignal | undefined,
): Promise<{ content: UserContent[]; missing: string[]; unsupported: string[] }> {
  const content: UserContent[] = [];
  const missing: string[] = [];
  const unsupported: string[] = [];
  for (const ref of names) {
    let handle = null;
    for (const store of stores) {
      if (store === undefined) continue;
      handle = await store.get(ref).catch(() => null) ?? await store.getByName(ref).catch(() => null);
      if (handle !== null) break;
    }
    if (handle === null) { missing.push(ref); continue; }
    // A type no endpoint decodes is refused, not routed to an arm that will 400 the call. Reported
    // apart from `missing`: "no such file" would send the model hunting for a file it named correctly.
    const arm = armFor(handle.mimeType);
    if (arm === null) { unsupported.push(`${ref} (${handle.mimeType})`); continue; }
    const bytes = await collectBytes(handle.stream(signal));
    content.push({ type: arm, data: encodeBase64(bytes), mimeType: handle.mimeType as MimeType, name: handle.name });
  }
  return { content, missing, unsupported };
}

/**
 * Exposes {@link MatbotMachine.singleTurn} to the model: a one-shot completion against a configured
 * provider, returning its reply. The intended use is consulting another model (e.g. a different-lineage
 * critic of the current draft, or any generation that should run on a specific provider) with a
 * well-defined interface, rather than the model improvising a bash/curl call.
 *
 * `provider` is optional: omitted, the call runs on the current turn's provider ({@link ToolContext.provider}).
 * This is the general case — name a provider to switch models, or leave it off to relay through the
 * model already in use. It lives in core (not in any plugin) because it is the model-facing surface of
 * a core service (`singleTurn`); core is also the one cross-runtime home both the node app and the
 * browser bundle register it from — the tool-plugin barrel (where `plugin`/`provider` live) is node-only.
 */
export function createSingleTurnTool(services: MatbotMachine): Tool<ToolResultOf<'single_turn'>> {
  const executor: ToolExecutor<ToolResultOf<'single_turn'>> = {
    async *execute(input: unknown, ctx: ToolContext) {
      const args = input as { provider?: string; prompt?: string; system?: string; attach?: unknown };
      if (typeof args.prompt !== 'string') { yield { type: 'error', message: 'single_turn requires a string "prompt".' }; return; }
      const provider = args.provider ?? ctx.provider;
      if (!provider) {
        yield { type: 'error', message: 'single_turn needs a "provider" — none was given and there is no current turn provider to fall back to.' };
        return;
      }
      if (!services.providers.has(provider)) {
        const known = [...services.providers.keys()].join(', ') || '(none configured)';
        yield { type: 'error', message: `Unknown provider "${provider}". Configured providers: ${known}.` };
        return;
      }
      // Attachments make the prompt a UserContent[] rather than a string. Media the store doesn't have
      // is REPORTED, not silently dropped: a consulted model answering about a file it never saw is the
      // failure that looks like a bad answer rather than a bad call.
      const attach = Array.isArray(args.attach) ? args.attach.filter((a): a is string => typeof a === 'string') : [];
      let prompt: string | UserContent[] = args.prompt;
      if (attach.length > 0) {
        const { content, missing, unsupported } = await resolveAttachments(attach, [services.MediaStore, ctx.files], ctx.signal);
        if (missing.length > 0) {
          yield { type: 'error', message: `single_turn: no such file(s): ${missing.join(', ')}. Attachments are looked up by store id or by name.` };
          return;
        }
        if (unsupported.length > 0) {
          yield { type: 'error', message:
            `single_turn: no model endpoint decodes ${unsupported.join(', ')}, so sending it would fail ` +
            'the call. Convert it to PNG or JPEG, or read the file as text and put that in the prompt.' };
          return;
        }
        prompt = [...content, { type: 'text', text: args.prompt }];
      }

      const res = await services.singleTurn({
        provider,
        prompt,
        signal: ctx.signal,
        ...(typeof args.system === 'string' ? { system: args.system } : {}),
      });
      // Usage is accounting, not conversation: it is captured ambiently (the host's complete() reports
      // it into the turn's usage sink, attributed to this tool call) — the model gets only the text.
      yield { type: 'result', value: { text: res.text } };
    },
  };

  return {
    name: 'single_turn',
    description:
      'Run a single-turn completion against a configured provider and return its reply. This is a ' +
      'one-shot call — not your own response: you send one `prompt` (and optional `system`), and get ' +
      'back its text. Use it to consult a different model — e.g. a second, ' +
      'different-lineage model critiquing your draft, or any generation that should run on a specific ' +
      'provider. `provider` is OPTIONAL: omit it to run on the current conversation\'s model, or name ' +
      'a configured provider to switch models (list or add providers with the provider tool). ' +
      '`attach` is an ARRAY OF STORED FILE NAMES OR IDS (e.g. ["chart.png"]) to send alongside the ' +
      'prompt, for the consulted model to look at. It is not a content type and not a way to forward ' +
      'media from THIS conversation — you can already see that; only name a file that exists in the ' +
      'workspace or media store. Whether the consulted provider can read a given file is its business; ' +
      'one it cannot take degrades to a text note. An image in a format no endpoint decodes (HEIC, ' +
      'SVG, BMP, TIFF) is refused outright rather than sent — convert it first, or read it as text.',
    inputSchema: {
      type:       'object',
      required:   ['prompt'],
      properties: {
        provider: { type: 'string', description: 'Name of a configured provider to run the completion against. Optional — defaults to the current turn\'s provider.' },
        prompt:   { type: 'string', description: 'The user message to send to that provider.' },
        system:   { type: 'string', description: 'Optional system prompt for the call.' },
        attach:   { type: 'array', items: { type: 'string' }, description: 'Optional array of stored FILE NAMES or store ids, e.g. ["diagram.png"]. Each is loaded and sent as inline media (image/document/audio) ahead of the prompt text. Not a content type — naming a file that does not exist is an error, not a request for one.' },
      },
    },
    executor,
  };
}

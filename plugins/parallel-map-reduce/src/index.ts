import type { MatbotMachine, MatbotPluginSpec, SessionAppender, Tool, ToolContext, ToolContract } from '@matatbread/matbot-plugin-api';
import { invokeTool, PLUGIN_API_VERSION, toolResult } from '@matatbread/matbot-plugin-api';

export const TOOL_NAME = 'parallel_map_reduce';

/** How many of a wave's turns run at once; the rest wait for a free slot. They share a provider's rate
 *  limits, so a larger wave takes longer rather than failing. Per wave. */
export const MAX_CONCURRENT_TURNS = 4;

/** What one turn is asked about, after `mapPrompt`: text, or a file for it to look at. */
export type MapItem = string | { attach: string };

export interface ParallelMapReduce {
  mapPrompt:    string;
  items:        MapItem[];
  reducePrompt: string;
  tools?:       boolean;
  provider?:    string;
  session?:     string;
}

export interface WaveStarted {
  wave:    string;
  started: number;
  session: string;
}

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    parallel_map_reduce: ToolContract<WaveStarted, ParallelMapReduce>;
  }
}

// Sent with every turn, so it says what decides the call. Probed on DeepSeek and Gemini beside the same
// guidance written as a pattern in tool_function's description: the tool was used where each item needed a
// model to read it, the pattern hardly at all, and neither for the trivial or coupled prompts. Gemini left
// `tools` out of every call whose turns had to read a file, which is why it defaults to true here.
export const DESCRIPTION =
  'Put the same question to each item of a set, each as its own sub-agent turn, run concurrently, then ' +
  'combine the answers in a later turn of this conversation. It returns at once: the answers do NOT come ' +
  'back to you. Each turn is asked `mapPrompt` followed by its item, and sees nothing else, so say in ' +
  '`mapPrompt` what the answers are for. As each turn finishes, its answer is appended to this conversation ' +
  '(a failure is appended too); once every turn has answered, `reducePrompt` is asked here as a new request, ' +
  'answered with all the answers in front of it and a count of how many arrived. Your turn can end ' +
  'meanwhile. Each turn can act with your tools unless `tools` is false. Every answer is read by the reduce, ' +
  'so ask for a short one. An item is text, or { "attach": "<attachment id>" } for a file to look at; for ' +
  'hundreds of items, build `items` in code rather than writing them out.\n' +
  'Use it when each item needs reading or work far larger than its answer — many conversations, documents ' +
  'or sites — so doing them here would flood this conversation or take too long. Not for items that ' +
  'constrain one another (an itinerary, a budget, a single argument): those need one mind. Not for a few ' +
  'small items you can answer directly.\n' +
  '"Which of my repositories still use Node 18?":\n' +
  '  { "mapPrompt": "Which Node version does the repository below target? Look at package.json, .nvmrc and CI config. Reply with the version and the file that says so.",\n' +
  '    "items": ["/repos/api-server", "/repos/web", …],\n' +
  '    "reducePrompt": "List the repositories above still on Node 18 or older, and what to change in each." }';

const FIELDS = new Set(['mapPrompt', 'items', 'reducePrompt', 'tools', 'provider', 'session']);

// Validators are optional and a minimal install has none, so this is the boundary for that install.
function refusal(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'parallel_map_reduce takes { "mapPrompt": "…", "items": ["…", …], "reducePrompt": "…" }.';
  const a = input as Record<string, unknown>;
  const stray = Object.keys(a).find(k => !FIELDS.has(k));
  if (stray !== undefined) return `Unknown field "${stray}". It takes mapPrompt, items, reducePrompt, tools, provider and session.`;
  if (typeof a['mapPrompt'] !== 'string' || a['mapPrompt'].trim() === '') return '"mapPrompt" is what each turn is asked, followed by its item: a non-empty string.';
  if (typeof a['reducePrompt'] !== 'string' || a['reducePrompt'].trim() === '') return '"reducePrompt" is the request to ask once every turn has answered: a non-empty string.';
  for (const k of ['provider', 'session'] as const) {
    if (a[k] !== undefined && typeof a[k] !== 'string') return `"${k}" is a string.`;
  }
  if (a['tools'] !== undefined && typeof a['tools'] !== 'boolean') return '"tools" is true or false.';
  if (!Array.isArray(a['items']) || a['items'].length === 0) return '"items" is a list of at least one item.';
  for (const [i, item] of a['items'].entries()) {
    if (typeof item === 'string') {
      if (item.trim() === '') return `Item ${i + 1} is empty.`;
      continue;
    }
    const ok = item !== null && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).length === 1 && typeof (item as { attach?: unknown }).attach === 'string' && (item as { attach: string }).attach !== '';
    if (!ok) return `Item ${i + 1} is neither text nor { "attach": "<attachment id>" }.`;
  }
  return undefined;
}

const WAVE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';   // no l/1/o/0: a wave id is read back by a model
function waveId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return 'w-' + [...bytes].map(b => WAVE_ALPHABET[b % WAVE_ALPHABET.length]).join('');
}

const LABEL_CHARS = 60;
// An item names its own answer: in its row, and in the tally if it failed. Its index tells two alike apart.
function labelOf(item: MapItem): string {
  const text = (typeof item === 'string' ? item : item.attach).replace(/\s+/g, ' ').trim();
  return text.length > LABEL_CHARS ? text.slice(0, LABEL_CHARS - 1) + '…' : text;
}

const NAMED_FAILURES = 10;
function failures(labels: readonly string[]): string {
  if (labels.length === 0) return '';
  const more = labels.length - NAMED_FAILURES;
  return `; failed: ${labels.slice(0, NAMED_FAILURES).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const said = (text: string) => [{ role: 'assistant' as const, content: [{ type: 'text' as const, text, origin: 'robo' as const }] }];

/**
 * The wave, run after the call has returned. Completion is causal: the reduce is asked from the settling of
 * the appends themselves, so it cannot start before them, and `queue` makes it wait for a turn still running
 * there, whose end writes any append that turn deferred. Nothing here may reject: the call that started it
 * has returned, so a rejection would have nobody to reach.
 */
async function runWave(
  machine:  MatbotMachine,
  ctx:      ToolContext,
  appender: SessionAppender,
  target:   string,
  wave:     string,
  args:     ParallelMapReduce,
): Promise<void> {
  const n = args.items.length;
  const failed: string[] = [];
  let answered = 0;
  let next = 0;
  const tools = args.tools ?? true;

  const one = async (i: number): Promise<void> => {
    const item = args.items[i]!;
    const label = labelOf(item);
    const head = `[${wave} ${i + 1}/${n} ${label}]`;
    let text: string;
    try {
      // The prompt leads and the item follows it, so every turn of the wave opens with the same text.
      const turn: { prompt: string; tools: boolean; attach?: string[]; provider?: string } = typeof item === 'string'
        ? { prompt: `${args.mapPrompt}\n\n${item}`, tools }
        : { prompt: args.mapPrompt, attach: [item.attach], tools };
      if (args.provider !== undefined) turn.provider = args.provider;
      const result = await toolResult(invokeTool(machine, 'single_turn', turn, ctx));
      const answer = (result as { text?: unknown } | null)?.text;
      text = `${head} ${typeof answer === 'string' ? answer : JSON.stringify(result)}`;
      answered++;
    } catch (e) {
      failed.push(label);
      text = `${head} failed: ${message(e)}`;
    }
    try { await appender.append(target, said(text)); }
    catch (e) { console.error(`[parallel_map_reduce] ${wave}: could not append the answer for item ${i + 1} to ${target}: ${message(e)}`); }
  };

  const worker = async (): Promise<void> => {
    for (let i = next++; i < n && !ctx.signal.aborted; i = next++) await one(i);
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_TURNS, n) }, worker));

  try {
    // Stopped by the person: what finished is in the conversation, and nothing more is started on their behalf.
    if (ctx.signal.aborted) {
      await appender.append(target, said(`[${wave}: stopped, ${answered} of ${n} answered]`));
      return;
    }
    await appender.append(target, [{
      role: 'user', mode: 'queue', from: `parallel_map_reduce wave ${wave}`,
      content: [{ type: 'text', text: `[${wave}: ${answered} of ${n} answered${failures(failed)}] ${args.reducePrompt}`, origin: 'robo' }],
    }]);
  } catch (e) {
    console.error(`[parallel_map_reduce] ${wave}: could not ask for the reduce in ${target}: ${message(e)}`);
  }
}

export function makeParallelMapReduceTool(machine: MatbotMachine): Tool<WaveStarted> {
  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      required: ['mapPrompt', 'items', 'reducePrompt'],
      properties: {
        mapPrompt: { type: 'string', description: 'Asked of every item: each turn sees this, then its item, and nothing else.' },
        items: {
          type: 'array', minItems: 1, description: 'One sub-agent turn per item, run concurrently. An item also names its answer.',
          items: { anyOf: [
            { type: 'string' },
            { type: 'object', required: ['attach'], properties: { attach: { type: 'string', description: 'An attachment id from this conversation, or (with tools false) a stored file name.' } } },
          ] },
        },
        reducePrompt: { type: 'string', description: 'Asked in this conversation once every turn has answered, with their answers in front of it. Write it to stand alone.' },
        tools:    { type: 'boolean', description: 'Default true: each turn is a full agent turn that can act with your tools. false: one request with no tools, when mapPrompt and the item hold everything it needs.' },
        provider: { type: 'string', description: 'A configured provider for the turns. Default: the current one.' },
        session:  { type: 'string', description: 'The conversation to append to and ask in. Default: this one.' },
      },
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const why = refusal(input);
        if (why !== undefined) { yield { type: 'error', message: why, failure: 'invalid' }; return; }
        const args = input as ParallelMapReduce;
        const appender = ctx.appender ?? machine.SessionAppender;
        if (appender === undefined) { yield { type: 'error', message: 'Nothing here can append to a conversation, so a wave has nowhere to report.' }; return; }
        // As `session_action append` decides it: a job's own session, or a door's (`#http`), is nobody's
        // conversation, so a run with no conversation of its own must name one.
        const throwaway = machine.isSubAgent() || ctx.appender !== undefined || ctx.session.id.startsWith('#');
        const target = args.session ?? appender.defaultSessionId ?? (throwaway ? undefined : ctx.session.id);
        if (target === undefined) { yield { type: 'error', message: 'This run reports to no conversation, so name the one to append to ("session").', failure: 'invalid' }; return; }
        if (machine.tools.resolve('single_turn') === null) { yield { type: 'error', message: 'single_turn is not registered here, so there is nothing to run a turn with.' }; return; }

        const wave = waveId();
        void runWave(machine, ctx, appender, target, wave, args)
          .catch(e => console.error(`[parallel_map_reduce] ${wave}: ${message(e)}`));
        yield { type: 'result', value: { wave, started: args.items.length, session: target } };
      },
    },
  };
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: { description: 'Ask one question of each item of a set as concurrent sub-agent turns, append each answer to the conversation, then ask it to combine them (`parallel_map_reduce`).' },
  async setup(machine: MatbotMachine) {
    machine.tools.register(makeParallelMapReduceTool(machine));
  },
};

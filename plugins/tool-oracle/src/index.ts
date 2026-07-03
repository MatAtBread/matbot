import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, Message, MessageContent, Tool, ToolPresenter, PresentContext } from '@matatbread/matbot-plugin-api';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Oracle instrument. Presents ALL tools unchanged so the model's tool choice is UNBIASED (nothing is
// hidden or reordered by us), and appends two record types to a JSONL for offline analysis:
//   { t:'turn', ... request }        — every turn's request (incl. no-tool turns = negatives)
//   { t:'call', ... request, tool }  — the tool the model actually picked (the oracle label)
// From this we can bake off cheap local filters (keyword/tf-idf/BM25/embedding) against what the model
// itself chose, and mine the disagreements (where a filter might beat the model). The pass-through
// ToolPresenter is deliberately the same seam the real relevance filter will later occupy — swap the
// body from "return tools" to "rank + cull" and the instrument becomes the production filter.

const TAG = '[tool-oracle]';

function textOf(content: readonly MessageContent[]): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && (c as { origin?: string }).origin !== 'robo')
    .map(c => c.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lastUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return textOf(messages[i]!.content);
  }
  return '';
}

// A turn's first provider call: the freshest non-marker message is the user turn (later iterations end
// in a tool-result). Lets us log one 'turn' record per turn rather than one per agentic iteration.
function isTurnStart(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === 'marker') continue;
    return role === 'user';
  }
  return false;
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services) {
    const dir     = join(dirname(services.configPath ?? '.'), '.data');
    const logPath = join(dir, 'tool-oracle.jsonl');
    await mkdir(dir, { recursive: true }).catch(() => {});
    // Best-effort, fire-and-forget: instrumentation must never slow or break a turn.
    const log = (rec: unknown): void => { void appendFile(logPath, JSON.stringify(rec) + '\n', 'utf8').catch(() => {}); };
    console.warn(`${TAG} active — presenting ALL tools (unbiased); logging (request -> tool) to ${logPath}`);

    const presenter: ToolPresenter = {
      present(tools: readonly Tool[], ctx: PresentContext): readonly Tool[] {
        try {
          const msgs = ctx.session.messages;
          if (isTurnStart(msgs)) {
            log({ t: 'turn', ts: new Date().toISOString(), session: ctx.session.id, provider: ctx.provider,
                  request: lastUserText(msgs), toolCount: tools.length });
          }
        } catch { /* never let instrumentation break a turn */ }
        return tools;   // oracle: unbiased, present everything
      },
    };
    await services.register('ToolPresenter', presenter);

    services.hooks.register({
      on: 'toolcall',
      handler(ctx) {
        try {
          log({ t: 'call', ts: new Date().toISOString(), session: ctx.session.id, provider: ctx.config.provider,
                request: lastUserText(ctx.session.messages), tool: ctx.toolCall.name, input: ctx.toolCall.input });
        } catch { /* observer only */ }
      },
    });
  },
};

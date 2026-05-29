import type { Tool, ToolEvent, ToolContext, MatbotPlugin } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

interface ScheduleInput {
  delayMs:  number;
  message?: string;
}

const executor = {
  async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const { delayMs, message = 'scheduled' } = input as ScheduleInput;

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        yield { type: 'error', message: 'Schedule aborted' };
        return;
      }
      yield { type: 'error', message: String(e) };
      return;
    }

    yield { type: 'result', value: { firedAt: new Date().toISOString(), message } };
  },
};

export const scheduleTool: Tool = {
  name:        'schedule',
  description: 'Wait for a specified duration, then return a result.',
  inputSchema: {
    type:       'object',
    required:   ['delayMs'],
    properties: {
      delayMs: { type: 'number', description: 'Milliseconds to wait before returning.' },
      message: { type: 'string', description: 'Optional message to include in the result.' },
    },
  },
  executor,
};

export const plugin: MatbotPlugin = {
  name:       'schedule',
  apiVersion: PLUGIN_API_VERSION,
  tools:      [scheduleTool],
};

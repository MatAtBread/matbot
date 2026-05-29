import type { Tool, ToolEvent, ToolContext, MatbotPlugin } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

interface HttpInput {
  url:           string;
  method?:       string;
  headers?:      Record<string, string>;
  body?:         string;
  responseType?: 'text' | 'json';
}

const executor = {
  async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const { url, method = 'GET', headers = {}, body, responseType = 'text' } = input as HttpInput;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: ctx.signal,
      });
    } catch (e) {
      yield { type: 'error', message: String(e) };
      return;
    }

    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      yield { type: 'error', message: `Failed to read response: ${String(e)}` };
      return;
    }

    if (!res.ok) {
      yield { type: 'error', message: `HTTP ${res.status}: ${text}`, code: res.status };
      return;
    }

    if (responseType === 'json') {
      try {
        yield { type: 'result', value: JSON.parse(text) as unknown };
      } catch {
        yield { type: 'error', message: `Non-JSON response: ${text.slice(0, 200)}` };
      }
    } else {
      yield { type: 'result', value: text };
    }
  },
};

export const httpTool: Tool = {
  name:        'http',
  description: 'Make an HTTP request and return the response body.',
  requires:    ['network'],
  inputSchema: {
    type:       'object',
    required:   ['url'],
    properties: {
      url:          { type: 'string', description: 'The URL to request.' },
      method:       { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], default: 'GET' },
      headers:      { type: 'object', additionalProperties: { type: 'string' } },
      body:         { type: 'string', description: 'Request body for POST/PUT/PATCH.' },
      responseType: { type: 'string', enum: ['text', 'json'], default: 'text' },
    },
  },
  executor,
};

export const plugin: MatbotPlugin = {
  name:       'http',
  apiVersion: PLUGIN_API_VERSION,
  tools:      [httpTool],
};

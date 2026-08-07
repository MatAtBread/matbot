import type { Tool, ToolEvent, ToolContext, ToolContract, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

// Single arm: the request params paired with `unknown` (the body is parsed text or arbitrary JSON). The
// params are inlined structurally (not a `HttpInput` reference) so the derived wire text shows real fields.
declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    http: ToolContract<unknown, { url: string; method?: string; headers?: Record<string, string>; body?: string; responseType?: 'text' | 'json' }>;
  }
}

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
  inputSchema: {
    type:       'object',
    required:   ['url'],
    properties: {
      url:          { type: 'string', description: 'The URL to request.' },
      // The executor hands `method` straight to `fetch`, which takes any verb; this enum is the model's
      // guardrail, not the tool's limit, so it lists the ones worth offering rather than the ones that work.
      // It was five, which made `json-validation` reject the HEAD and OPTIONS requests the tool supports.
      method:       { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'], default: 'GET' },
      headers:      { type: 'object', additionalProperties: { type: 'string' } },
      body:         { type: 'string', description: 'Request body for POST/PUT/PATCH.' },
      responseType: { type: 'string', enum: ['text', 'json'], default: 'text' },
    },
  },
  executor,
};

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools:      [httpTool],
};

import type { Tool, ToolContext, ToolEvent, ToolContract } from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    web_user_environment: ToolContract<unknown, { expression: string }>;  // the expression's JSON-serialisable value
  }
}

// Round-trip a JavaScript expression to the session's attached browser, where it runs in a sandboxed
// Worker, and resolve with the (JSON-serialisable) value. Rejects on timeout, abort, a non-attached
// session, or an error/non-serialisable result reported by the browser. server.ts supplies the impl.
export type EvalInBrowser = (sessionId: string, callId: string, expression: string, signal: AbortSignal) => Promise<unknown>;

const DESCRIPTION = `Read a fact about the user's browser environment by evaluating a JavaScript expression in their browser and returning its value. Use this for ambient environment facts — current local time/date, timezone, locale/language, device or user-agent — instead of asking the user.

The expression runs in a sandboxed Web Worker, so this is read-only introspection of the standard web platform:
- **Available**: \`Date\`, \`Intl\` (e.g. timezone via \`Intl.DateTimeFormat().resolvedOptions().timeZone\`), \`navigator.language\` / \`navigator.languages\`, \`navigator.userAgent\` / \`navigator.userAgentData\`, and other Worker-global APIs.
- **Not available**: the DOM (no \`document\` / \`window\` / \`screen\`), page or app state, \`localStorage\` / cookies, and permission-gated sensors such as geolocation. Reaching for these throws.

## Input
\`{ "expression": string }\` — a single JavaScript expression that evaluates to the value you want. It may be an async expression (a returned Promise is awaited) or an IIFE for multi-step logic; do not use a bare \`return\` at the top level. The result must be JSON-serialisable (no functions, DOM nodes, or cyclic objects).

## Examples
\`\`\`json
{ "expression": "Intl.DateTimeFormat().resolvedOptions().timeZone" }
{ "expression": "({ now: new Date().toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: navigator.language })" }
{ "expression": "navigator.userAgent" }
\`\`\`

Requires a live browser attached to the session; in a headless or non-browser context the call returns an error.`;

export function makeWebEnvTool(evalInBrowser: EvalInBrowser): Tool {
  return {
    name: 'web_user_environment',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      required: ['expression'],
      properties: {
        expression: { type: 'string', description: 'A JavaScript expression, evaluated in a sandboxed browser Worker, whose JSON-serialisable value is returned.' },
      },
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const { expression } = (input ?? {}) as { expression?: unknown };
        if (typeof expression !== 'string' || expression.trim() === '') {
          yield { type: 'error', message: 'Missing required field "expression" (a JavaScript expression string).' };
          return;
        }
        try {
          const value = await evalInBrowser(ctx.session.id, ctx.callId, expression, ctx.signal);
          yield { type: 'result', value };
        } catch (e) {
          yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
        }
      },
    },
  };
}

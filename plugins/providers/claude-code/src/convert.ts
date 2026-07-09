import type { Message, Tool, JSONSchema } from '@matatbread/matbot-plugin-api';

/**
 * The structured-completion protocol.
 *
 * Claude Code (the `claude` CLI) is an *agent*: whenever it decides to call a tool it executes that
 * tool itself and continues its own loop. The subscription is only reachable through that agent, so
 * there is no "return an unexecuted tool_use" mode (that lives on the raw Messages API, which needs a
 * Console API key). To keep matbot's runner in charge of the loop and of tool execution, we reduce the
 * CLI to a *single-turn completion*: it emits one JSON object describing EITHER a tool call it wants
 * matbot to make, OR a final answer. `--json-schema` structurally forces the reply into this shape, so
 * the model cannot emit — and the CLI cannot execute — a native tool_use. matbot parses the object,
 * runs the tool through its own registry + hooks, appends the result, and calls the provider again.
 */

/** One structured reply from the model. */
export type ClaudeReply =
  | { kind: 'tool_use'; tool: string; arguments?: Record<string, unknown> }
  | { kind: 'final'; text: string };

/** The union JSON schema handed to `--json-schema`. When no tools are advertised the model can only
 *  finish, so the schema collapses to the final arm (a tool arm would be dead weight and, worse,
 *  invite hallucinated tool names). */
export function buildSchema(hasTools: boolean): JSONSchema {
  if (!hasTools) {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['final'] },
        text: { type: 'string' },
      },
      required: ['kind', 'text'],
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['tool_use', 'final'] },
      // kind === 'tool_use'
      tool: { type: 'string', description: 'The exact name of the tool to call.' },
      arguments: { type: 'object', additionalProperties: true, description: 'Arguments for the tool.' },
      // kind === 'final'
      text: { type: 'string', description: 'The final answer for the user.' },
    },
    required: ['kind'],
  };
}

/** Human-readable name for the model's benefit; the id is matbot's pairing key, not shown. */
function argsString(input: unknown): string {
  try { return JSON.stringify(input ?? {}); } catch { return '{}'; }
}

/**
 * Compose the single prompt sent to the CLI on stdin: matbot's system context, the tool catalogue,
 * the protocol rules, then the conversation transcript. Everything rides in the prompt body (not
 * `--system-prompt`) so there is no argv size limit; a short fixed persona override is passed
 * separately (see {@link SYSTEM_OVERRIDE}). Structured output enforces the reply shape regardless of
 * where the instructions sit.
 */
export function composePrompt(messages: Message[], tools: readonly Tool[]): string {
  const out: string[] = [];

  const systemText = messages
    .filter(m => m.role === 'system')
    .flatMap(m => m.content)
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text)
    .join('\n\n')
    .trim();
  if (systemText) out.push(systemText);

  if (tools.length > 0) {
    const catalogue = tools.map(t =>
      `- ${t.name}: ${t.description}\n  arguments schema: ${JSON.stringify(t.inputSchema)}`,
    ).join('\n');
    out.push(
      'You have access to the following tools. You do NOT execute them yourself — you request a call ' +
      'and the result is provided back to you on the next turn:\n' + catalogue,
    );
    out.push(
      'Protocol (MANDATORY): reply with exactly one JSON object matching the provided schema.\n' +
      '- To call a tool: {"kind":"tool_use","tool":"<name>","arguments":{...}} — one tool per reply.\n' +
      '- When you can answer the user: {"kind":"final","text":"<your answer>"}.\n' +
      'Never fabricate a tool result; request the tool and wait. Prefer a tool call when the answer ' +
      'depends on information a tool can provide.',
    );
  } else {
    out.push('Reply with exactly one JSON object: {"kind":"final","text":"<your answer>"}.');
  }

  out.push('=== Conversation ===');
  out.push(renderTranscript(messages));
  out.push('=== End of conversation ===');
  out.push('Produce your single JSON reply now.');

  return out.join('\n\n');
}

/** Render the non-system history as plain text, resolving tool-result blocks back to the tool name
 *  they answer (matbot stores the name on the assistant `tool-call`, not on the `tool-result`). */
function renderTranscript(messages: Message[]): string {
  const nameById = new Map<string, string>();
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'marker') continue;

    for (const c of msg.content) {
      switch (c.type) {
        case 'text':
          if (c.text.trim()) lines.push(`${msg.role === 'assistant' ? 'Assistant' : 'User'}: ${c.text}`);
          break;
        case 'tool-call':
          nameById.set(c.id, c.name);
          lines.push(`Assistant requested tool "${c.name}" with arguments ${argsString(c.input)}`);
          break;
        case 'tool-result': {
          const name = nameById.get(c.id) ?? 'unknown';
          const body = (() => { try { return JSON.stringify(c.result ?? null); } catch { return '"<unserialisable>"'; } })();
          lines.push(`Tool "${name}" ${c.isError ? 'ERRORED' : 'returned'}: ${body}`);
          break;
        }
        case 'image':
        case 'image-url':
          lines.push(`${msg.role === 'assistant' ? 'Assistant' : 'User'}: [image omitted]`);
          break;
        case 'document':
          lines.push(`User: [document: ${c.name ?? c.mimeType}]`);
          break;
        case 'refusal':
          lines.push(`Assistant: [refusal] ${c.text}`);
          break;
        // thinking / reasoning / redacted-thinking / audio / file-ref / form / marker / unknown — omit
      }
    }
  }

  return lines.join('\n');
}

/** Short persona override so the CLI drops Claude Code's default coding-agent system prompt without us
 *  paying argv cost for the (potentially large) real instructions, which ride on stdin instead. */
export const SYSTEM_OVERRIDE =
  'You are matbot operating under a strict single-reply JSON protocol. Follow the instructions and ' +
  'schema given in the message exactly. Do not use any tools yourself.';

import type {
  ProviderAdapter, ProviderConfig, Message, Tool, CompletionEvent, HealthStatus,
} from '@matatbread/matbot-plugin-api';
import { spawn } from 'node:child_process';
import { buildSchema, composePrompt, SYSTEM_OVERRIDE, type ClaudeReply } from './convert.js';

const DEFAULT_BIN = 'claude';

/** One `claude -p` result, as emitted by `--output-format stream-json`'s terminal `result` event. */
interface CliResult {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * Drives the local Claude Code CLI as a single-turn structured completion. matbot's runner owns the
 * agentic loop and executes every tool through its own registry + hooks; this adapter only turns one
 * `messages`-in / `CompletionEvent`s-out call into one `claude -p` invocation that emits either a
 * tool-call intent or a final answer (see convert.ts for the protocol). Auth is whatever the CLI is
 * logged in as — a Claude subscription (`claude setup-token`) or an API key — so nothing about
 * credentials lives here.
 */
export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly name = 'claude-code';

  complete(
    messages: Message[],
    config:   ProviderConfig,
    tools:    readonly Tool[],
    signal:   AbortSignal,
  ): AsyncIterable<CompletionEvent> {
    return this.stream(messages, config, tools, signal);
  }

  private async *stream(
    messages: Message[],
    config:   ProviderConfig,
    tools:    readonly Tool[],
    signal:   AbortSignal,
  ): AsyncIterable<CompletionEvent> {
    const bin    = (config.credentials?.['bin'] ?? config.endpoint ?? DEFAULT_BIN) as string;
    const schema = buildSchema(tools.length > 0);
    const prompt = composePrompt(messages, tools);

    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--tools', '',                       // Claude Code executes nothing; matbot owns tools
      '--setting-sources', '',             // ignore user/project/local settings for determinism
      '--no-session-persistence',
      '--disable-slash-commands',
      '--strict-mcp-config',               // no MCP servers
      '--json-schema', JSON.stringify(schema),
      '--system-prompt', SYSTEM_OVERRIDE,
    ];
    if (config.model) args.push('--model', config.model);
    const effort = config.parameters?.['effort'];
    if (typeof effort === 'string') args.push('--effort', effort);

    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] });

    const onAbort = () => child.kill('SIGTERM');
    if (signal.aborted) child.kill('SIGTERM');
    else signal.addEventListener('abort', onAbort, { once: true });

    // Feed the single user turn, then close stdin so the CLI runs to completion.
    child.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    }) + '\n');
    child.stdin.end();

    try {
      let cliResult: CliResult | undefined;
      let spawnError: Error | undefined;
      child.on('error', (e: Error) => { spawnError = e; });

      for await (const line of readLines(child.stdout)) {
        let ev: { type?: string } & Record<string, unknown>;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'result') { cliResult = ev as CliResult; }
      }

      if (spawnError) {
        throw new Error(
          `Could not launch "${bin}". Install Claude Code and run \`${bin} setup-token\` (or set ` +
          `credentials.bin to its path). Cause: ${spawnError.message}`,
        );
      }
      if (signal.aborted) return;   // runner treats an aborted turn on its own; emit nothing
      if (!cliResult) throw new Error('claude-code: CLI produced no result event.');
      if (cliResult.is_error) {
        throw new Error(`claude-code: CLI reported an error (${cliResult.subtype ?? 'unknown'}): ${cliResult.result ?? ''}`);
      }

      // Usage first, so cost accounting lands even if reply parsing degrades.
      const u = cliResult.usage;
      if (u) {
        yield {
          type: 'usage',
          inputTokens:  u.input_tokens  ?? 0,
          outputTokens: u.output_tokens ?? 0,
          ...(cliResult.total_cost_usd            !== undefined ? { costUsd:             cliResult.total_cost_usd } : {}),
          ...(u.cache_read_input_tokens     !== undefined ? { cacheReadTokens:     u.cache_read_input_tokens } : {}),
          ...(u.cache_creation_input_tokens !== undefined ? { cacheCreationTokens: u.cache_creation_input_tokens } : {}),
        };
      }

      const reply = parseReply(cliResult.result);
      if (reply.kind === 'tool_use') {
        yield { type: 'tool-call', id: crypto.randomUUID(), name: reply.tool, input: reply.arguments ?? {} };
      } else {
        if (reply.text) yield { type: 'text-delta', delta: reply.text };
      }
      yield { type: 'done' };
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    }
  }

  async health(): Promise<HealthStatus> {
    return new Promise((resolve) => {
      const child = spawn(DEFAULT_BIN, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      const started = Date.now();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ status: 'down', reason: 'claude --version timed out' }); }, 5000);
      child.on('error', (e) => { clearTimeout(timer); resolve({ status: 'down', reason: `claude CLI not found: ${e.message}` }); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? { status: 'ok', latencyMs: Date.now() - started } : { status: 'down', reason: `claude --version exited ${code}` });
      });
    });
  }
}

/** Parse the structured reply, degrading a malformed/unstructured body to a final answer rather than
 *  bricking the turn (a hallucinated non-JSON reply becomes the user-visible text). */
function parseReply(raw: string | undefined): ClaudeReply {
  const text = (raw ?? '').trim();
  if (!text) return { kind: 'final', text: '' };
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return { kind: 'final', text }; }
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    if (o['kind'] === 'tool_use' && typeof o['tool'] === 'string') {
      const a = o['arguments'];
      return { kind: 'tool_use', tool: o['tool'], ...(a && typeof a === 'object' ? { arguments: a as Record<string, unknown> } : {}) };
    }
    if (o['kind'] === 'final' && typeof o['text'] === 'string') {
      return { kind: 'final', text: o['text'] };
    }
  }
  return { kind: 'final', text };
}

/** Yield complete newline-delimited lines from a readable stream. */
async function* readLines(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  let buf = '';
  for await (const chunk of stream) {
    buf += chunk.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) yield line;
    }
  }
  if (buf.trim()) yield buf;
}

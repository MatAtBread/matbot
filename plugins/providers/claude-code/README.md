# @matatbread/matbot-provider-claude-code

Run matbot inference on a **Claude subscription** (Pro / Max / Team / Enterprise) instead of a
pay-as-you-go Console API key, by driving the locally installed **Claude Code CLI** (`claude`).

matbot keeps its agentic loop and runs every tool through its own registry and hooks. Claude Code is
reduced to a **single-turn completion** and executes nothing.

## Why it works this way

A Claude subscription is only reachable *through* the Claude Code agent, and that agent always executes
any tool it decides to call — it never returns an unexecuted `tool_use`. The only interface that hands
back a raw, unexecuted `tool_use` is the raw Messages API, which needs a Console API key.

So to keep **matbot** in charge of the loop and of tool execution, this adapter constrains each `claude
-p` turn with `--json-schema` to reply with one JSON object that is *either*:

- `{"kind":"tool_use","tool":"<name>","arguments":{…}}` — a tool call matbot should make, or
- `{"kind":"final","text":"…"}` — the answer for the user.

The schema structurally prevents a native `tool_use`, so the CLI cannot execute anything. matbot parses
the object, runs the tool through its own registry + hooks, appends the result, and calls the provider
again — exactly as it does with the native Anthropic provider.

**Trade-off vs. the native Anthropic provider:** this is structured / prompt-driven tool calling, not the
model's native `tool_use` machinery. Expect slightly lower fidelity on tool selection and argument
formatting, one tool call per turn, and no token-by-token streaming of the final answer (it arrives as one
block). Everything else in matbot — hooks, tool-router, presenter, edit-session, triggers, compaction —
works unchanged.

## Prerequisites

1. Install Claude Code and sign in to your subscription:
   ```sh
   claude setup-token      # OAuth device login; stores a long-lived token, no API key
   ```
   Verify with `claude --version` and a quick `claude -p "hello"`.
2. The `claude` binary must be on `PATH` for the matbot process (or set `credentials.bin`, below).

> **Billing:** subscription usage of `claude -p` / the Agent SDK is a sanctioned, first-class path.
> As of mid-2026 it draws from your normal plan usage limits (the separate "Agent SDK credit" pool
> announced for June 15 2026 was paused). No Console API key or per-token billing is involved.

## Configuration

Add a provider profile to `matbot.yaml`:

```yaml
providers:
  claude-max:
    module: '@matatbread/matbot-provider-claude-code'
    model: opus            # opus | sonnet | haiku | fable, or a full id e.g. claude-opus-4-8
    parameters:
      effort: high         # optional: low | medium | high | xhigh | max
```

No `credentials` block is needed when the CLI is already logged in.

### Options

| Field                  | Meaning                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `model`                | Passed to `claude --model`. Accepts an alias (`opus`/`sonnet`/`haiku`/`fable`) or a full model id. |
| `parameters.effort`    | Passed to `claude --effort` when set (`low`…`max`).                                 |
| `endpoint`             | Optional path/name of the `claude` binary (default `claude`).                      |
| `credentials.bin`      | Same as `endpoint`; takes precedence if both are set.                              |

## Notes & limitations

- **Node only** (`matbotRuntime: ["node"]`) — it spawns the `claude` child process; it cannot run in the
  browser bundle.
- **One tool call per provider turn.** If the model wants several tools, matbot's loop makes them across
  successive turns.
- **Thinking / signed thinking blocks are not round-tripped** (the CLI does not expose them through this
  path); matbot elides them, as it does for cross-provider replay.
- Each turn re-sends the conversation as a rendered transcript; prompt caching on Anthropic's side still
  applies to the stable prefix, but this is not as cache-efficient as a persistent Claude Code session.

## How it maps to matbot

`complete(messages, config, tools, signal)`:

1. `convert.ts` composes one prompt — matbot's system context, a catalogue of the advertised tools, the
   JSON protocol, and the conversation transcript — and builds the union `--json-schema`.
2. `adapter.ts` spawns `claude --print --input-format stream-json --output-format stream-json --tools ""
   --json-schema <schema> --model <model>`, feeds the prompt, and reads the terminal `result` event.
3. The structured reply becomes matbot completion events: a `tool-call` event (matbot's runner executes
   the tool) or a `text-delta` (the final answer), plus a `usage` event for cost accounting.

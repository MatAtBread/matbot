# matbot

A TypeScript AI harness — a thin, composable runtime that connects language models to tools,
memory, and frontends. Not a product; infrastructure.

---

## Requirements

- Node 24+
- pnpm 9+

```sh
corepack enable
pnpm install
```

---

## Example 1 — A basic bot (no tools, just the CLI)

This is the minimum configuration: one provider, no plugins, purely conversational.

### `matbot.yaml`

```yaml
providers:
  claude:
    type: anthropic
    endpoint: https://api.anthropic.com
    model: claude-sonnet-4-6
    credentials:
      apiKey: ${env:ANTHROPIC_API_KEY}
    parameters:
      maxTokens: 4096
```

### `.env` (same directory as `matbot.yaml`)

```sh
ANTHROPIC_API_KEY=sk-ant-...
```

### Run

```sh
# Interactive REPL — pick a session or start a new one
pnpm --filter @matatbread/matbot-cli start

# Single turn
pnpm --filter @matatbread/matbot-cli start "What is the capital of France?"

# Pick a specific provider
pnpm --filter @matatbread/matbot-cli start --provider claude "Summarise the last 10 git commits"
```

The REPL shows an arrow-key session picker on startup when previous sessions exist. Press
Ctrl+D or Ctrl+C to exit; the bot prints a `--session <id>` resume command.

---

## Example 2 — A bot with tools and the web UI

This wires in the first-party tool plugins and a web frontend plugin, giving the model the
ability to run shell commands, make HTTP requests, and wait on timers, while serving a
browser-accessible chat interface.

### `matbot.yaml`

In the monorepo, reference the packages by relative path (no install step needed):

```yaml
plugins:
  - ./packages/tools/bash/src/index.ts
  - ./packages/tools/http/src/index.ts
  - ./packages/frontend/web/src/index.ts
```

When consuming the packages from npm, use their package names instead:

```yaml
plugins:
  - @matatbread/matbot-tool-bash
  - @matatbread/matbot-tool-http
  - @matatbread/matbot-frontend-web
```

Full config:

```yaml
plugins:
  - ./packages/tools/bash/src/index.ts
  - ./packages/tools/http/src/index.ts

providers:
  claude:
    type: anthropic
    endpoint: https://api.anthropic.com
    model: claude-sonnet-4-6
    credentials:
      apiKey: ${env:ANTHROPIC_API_KEY}
    parameters:
      maxTokens: 8192
```

### Run

```sh
pnpm --filter @matatbread/matbot-cli start
```

The model now has three tools available:

| Tool       | Example prompt                                         |
|------------|--------------------------------------------------------|
| `exec`     | "Run `git log --oneline -10` and summarise the changes" |
| `http`     | "Fetch https://httpbin.org/get and show me the headers" |
| `schedule` | "Remind me in 30 seconds that the build is done"       |

Plugins are loaded from the `plugins` list at startup. You can also add and remove them at
runtime via the model:

```
you: add the http tool
```

The built-in `plugin` tool handles the install, updates `matbot.yaml`, and hot-loads the
plugin immediately — no restart needed.

---

## Configuration reference

### Provider entry

```yaml
providers:
  <name>:
    type:       anthropic | openai-compat   # selects the HTTP adapter
    endpoint:   https://...                 # overrides the default base URL
    model:      <model-id>
    credentials:
      apiKey:   ${env:VAR} | ${secret:name} | literal
    parameters:                             # optional; passed to the API
      maxTokens:      4096
      temperature:    0.7
      thinking:                             # Anthropic extended thinking
        type:         enabled
        budgetTokens: 2000
    fallback:   <other-provider-name>       # used on 429 / 5xx
```

### Secret resolution

| Syntax          | Resolves to                              |
|-----------------|------------------------------------------|
| `${env:VAR}`    | `process.env.VAR`                        |
| `${secret:name}`| Entry from the Vault (runtime secret store) |
| literal string  | Used as-is (avoid for real credentials)  |

Credential values are resolved once at startup; they are never written to session storage.

### Data directory

All runtime state lives in `.data/` next to `matbot.yaml` and is gitignored:

```
.data/
  sessions/    — one JSON file per conversation
  workspace/   — default working directory for the exec tool
  files/       — uploaded and generated files (when the files plugin is active)
  settings/    — per-plugin key-value settings
```

Plugins may add further subdirectories as needed.

---

## Writing your own plugin

See [PLUGINS.md](PLUGINS.md) for the full plugin API reference.

Quick start:

```ts
// my-plugin/src/index.ts
import type { MatbotPlugin, Tool, ToolEvent, ToolContext } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

const myTool: Tool = {
  name:        'hello',
  description: 'Greet someone.',
  inputSchema: {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
  },
  executor: {
    async *execute(input, _ctx): AsyncIterable<ToolEvent> {
      const { name } = input as { name: string };
      yield { type: 'result', value: `Hello, ${name}!` };
    },
  },
};

export const plugin: MatbotPlugin = {
  name:       'hello',
  apiVersion: PLUGIN_API_VERSION,
  tools:      [myTool],
};
```

Add it to your config:

```yaml
plugins:
  - ./my-plugin/src/index.ts
```

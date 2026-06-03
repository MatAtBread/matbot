# matbot

A TypeScript AI harness — a thin, composable runtime that connects language models to tools,
memory, and frontends. Not a product; infrastructure.

---

## Core features

- **LLM-independent** — works with Anthropic Claude, any OpenAI-compatible API (GPT-4o,
  DeepSeek, Ollama, Mistral, …), or your own provider adapter; switch models mid-session
- **Minimal core** — built-in agentic loop, plugin management, and interactive CLI; no
  extras required for basic conversational use
- **Hot-loaded plugins** — extend at runtime without restart:
  - **Tools** — bash, HTTP, workspace files, sandboxed Docker bash, MCP server bridge, background jobs
  - **Memory** — persistent facts automatically extracted from conversations and injected as context
  - **Skills** — reusable system-context fragments injected on demand via a classifier
  - **Knowledge** — semantic knowledge index for domain-specific context (Rumsfeld + optional BGE reranker)
  - **Session editing** — cut, fork, and compact sessions to control context window size
  - **Frontends** — web UI with session management, Telegram bot
  - **Storage backends** — filesystem (default) or SQLite
  - **Providers** — add and remove LLM profiles live via the built-in `provider` tool

---

## Requirements

- Node 24+
- pnpm 9+

---

## Quick start

```sh
git clone https://github.com/MatAtBread/matbot
cd matbot
pnpm install
pnpm repl   # ephemeral REPL — session discarded on exit
```

The REPL starts with no config file needed. Use the built-in `plugin` tool to discover and
install providers and plugins interactively, or drop a `matbot.yaml` next to your working
directory (see examples below).

---

## Example 1 — A basic bot (no tools, just the CLI)

Minimum configuration: one provider, no plugins, purely conversational.

### `matbot.yaml`

```yaml
providers:
  deepseek-v4-flash:
    module: ./packages/plugins/providers/anthropic
    endpoint: https://api.deepseek.com/anthropic
    model: deepseek-v4-flash
    credentials:
      apiKey: ${env:DEEPSEEK_API_KEY}
    parameters:
      maxTokens: 16384
```

### `.env` (same directory as `matbot.yaml`, .gitignored)

```sh
DEEPSEEK_API_KEY=sk-...
```

### Run

```sh
# Interactive REPL (ephemeral — session discarded on exit)
pnpm --filter @matatbread/matbot-cli repl

# Single turn
pnpm --filter @matatbread/matbot-cli repl "What is the capital of France?"

# New persistent session (prints a resume command on exit)
pnpm --filter @matatbread/matbot-cli repl --session create

# Resume an existing session
pnpm --filter @matatbread/matbot-cli repl --session <id>

# Server mode — headless, waits for a frontend plugin to handle requests
pnpm --filter @matatbread/matbot-cli start
```

Sessions are **ephemeral by default**. Nothing is written to disk unless you pass
`--session create` (or `--session <id>` to resume). On exit a persistent session prints
a `--session <id>` resume command.

---

## Example 2 — A bot with tools and a web UI

Adds bash execution, HTTP requests, workspace file tools, and a browser-accessible chat
interface.

### `matbot.yaml`

In the monorepo, reference packages by relative path (no install step needed):

```yaml
plugins:
  - ./packages/plugins/bash
  - ./packages/plugins/http
  - ./packages/plugins/workspace
  - ./packages/plugins/frontend/web
```

When consuming from npm:

```yaml
plugins:
  - @matatbread/matbot-tool-bash
  - @matatbread/matbot-tool-http
  - @matatbread/matbot-tool-workspace
  - @matatbread/matbot-frontend-web
```

Full example with provider:

```yaml
plugins:
  - ./packages/plugins/bash
  - ./packages/plugins/http
  - ./packages/plugins/workspace
  - ./packages/plugins/frontend/web

providers:
  claude:
    module: ./packages/plugins/providers/anthropic
    endpoint: https://api.anthropic.com
    model: claude-sonnet-4-6
    credentials:
      apiKey: ${env:ANTHROPIC_API_KEY}
    parameters:
      maxTokens: 8192
```

### Run

```sh
pnpm repl
```

## Auto-configuration

**_You don't actually need to worry about configuration files. Matbot comes with a `plugin` tool that can discover and install plugins that provide new tools, LLM providers, front-ends and more_**

```text
~/git/matbot$ pnpm repl
provider: deepseek-v4-flash  (ephemeral)

you: install the local plugin for the web frontend
```
```
[thinking… ×24]
Let me first discover what local plugins are available.
⚙  plugin {"action":"discover_local"}

[thinking… ×45]
I found a local web frontend plugin: `@matatbread/matbot-frontend-web` located at `./packages/plugins/frontend/web`. Let me install it.
⚙  plugin {"action":"add","specifier":"./packages/plugins/frontend/web"}
Install plugin "./packages/plugins/frontend/web"? [y/N] [N] y
Activating "./packages/plugins/frontend/web"...
[frontend-web] http://localhost:19778

[thinking… ×19]
The web frontend plugin has been successfully installed and is now active. Let me verify by listing the configured plugins.
⚙  plugin {"action":"list"}

[thinking… ×24]
The web frontend plugin (`@matatbread/matbot-frontend-web`) has been successfully installed and is now active. You can see it listed under both configured and loaded plugins:

- **Configured**: `./packages/plugins/frontend/web`
- **Loaded**: `frontend-web` (type: `frontend`, API version: `0.1`)

The plugin is ready to use!
[↑1021 ↓424 tokens]
```

The built-in `plugin` tool installs the package, updates `matbot.yaml`, and hot-loads it
immediately — no restart needed.

Ask it what other plugins there are:

```
you: what other local plugins do you have?
```
> Of course, you could have opened your browser and done this from the web UI if you wanted

```
[thinking… ×32]
Here are all the local plugins available for installation:

| # | Specifier (Path) | Package Name | Notes |
|---|-----------------|--------------|-------|
| 1 | `./packages/plugins/background` | `@matatbread/matbot-tool-background` | |
| 2 | `./packages/plugins/bash` | `@matatbread/matbot-tool-bash` | |
| 3 | `./packages/plugins/docker-bash` | `@matatbread/matbot-tool-docker-bash` | |
| 4 | `./packages/plugins/edit-session` | `@matatbread/matbot-edit-session` | |
| 5 | `./packages/plugins/frontend/telegram` | `@matatbread/matbot-frontend-telegram` | |
| 6 | `./packages/plugins/frontend/web` | `@matatbread/matbot-frontend-web` | ✅ Already installed |
| 7 | `./packages/plugins/http` | `@matatbread/matbot-tool-http` | |
| 8 | `./packages/plugins/mcp` | `@matatbread/matbot-tool-mcp` | |
| 9 | `./packages/plugins/memory` | `@matatbread/matbot-memory-node` | |
| 10 | `./packages/plugins/persist-ki-bge` | `@matatbread/matbot-persist-ki-bge-node` | |
| 11 | `./packages/plugins/providers/anthropic` | `@matatbread/matbot-provider-anthropic` | ✅ Already installed |
| 12 | `./packages/plugins/providers/openai-compat` | `@matatbread/matbot-provider-openai-compat` | |
| 13 | `./packages/plugins/rumsfeld` | `@matatbread/matbot-rumsfeld-node` | |
| 14 | `./packages/plugins/sessions` | `@matatbread/matbot-sessions` | |
| 15 | `./packages/plugins/skills` | `@matatbread/matbot-skills-node` | |
| 16 | `./packages/plugins/storage/sqlite` | `@matatbread/matbot-storage-sqlite` | |
| 17 | `./packages/plugins/workspace` | `@matatbread/matbot-tool-workspace` | |

Would you like to install any of these?
[↑1622 ↓550 tokens]
```
---

## Configuration reference

### Provider entry

```yaml
providers:
  <name>:
    module:     <npm-package | ./relative/path>   # adapter module
    endpoint:   https://...                       # overrides the default base URL
    model:      <model-id>
    credentials:
      apiKey:   ${env:VAR} | ${secret:name} | literal
    parameters:                                   # optional; passed to the API
      maxTokens:      4096
      temperature:    0.7
      thinking:                                   # Anthropic extended thinking
        type:         enabled
        budgetTokens: 2000
    fallback:   <other-provider-name>             # used on 429 / 5xx
```

### Session behaviour

| CLI option           | Behaviour                                         |
|----------------------|---------------------------------------------------|
| *(none)*             | Ephemeral — session discarded on exit             |
| `--session create`   | New persistent session; saved to the store        |
| `--session <id>`     | Resume an existing session                        |
| `--ephemeral`        | Force ephemeral even when `--session` is given    |

Setting `ephemeral: true` in `matbot.yaml` is a hard override — it takes effect even if
`--session` is passed. Background sub-agents set this to avoid leaving session traces.

### Secret resolution

Both placeholder forms are resolved at runtime by the Vault:

| Syntax           | Resolves to                              |
|------------------|------------------------------------------|
| `${env:VAR}`     | `process.env.VAR` (snapshotted at startup) |
| `${secret:name}` | Entry from the Vault (runtime secret store) |
| literal string   | Used as-is (avoid for real credentials)  |

Credentials are resolved at startup and never written to session storage.

### Data directory

All runtime state lives in `.data/` next to `matbot.yaml` and is .gitignored:

```
.data/
  sessions/    — session store (only created when persistence is active)
  settings/    — per-plugin key-value settings
  schedules/   — recurring background job definitions (background plugin)
  knowledge/   — KnowledgeIndex entries (persist-ki-bge plugin)
  bash-cwd/    — default working directory for bash tool execution
  files/       — file store blobs; the workspace namespace holds workspace_write output
```

The SQLite storage plugin (`@matatbread/matbot-storage-sqlite`) replaces the per-directory
filesystem stores with a single `.data/matbot.db` file. Plugins may create additional
subdirectories as needed.

---

## Writing your own plugin

See [PLUGINS.md](PLUGINS.md) for the full plugin API reference.

Plugins can provide tools, frontends, LLM providers (try the 'customer-services' "LLM" - my personal
favourite - it's free and runs without GPU support or an API key!)

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
  - ./my-plugin
```

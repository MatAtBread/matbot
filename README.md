# matbot

A TypeScript AI harness — a thin, composable runtime that connects language models to tools
and frontends. Not a product; infrastructure.

---

## Core features

- **LLM-independent** — works with Anthropic Claude, any OpenAI-compatible API (GPT-4o,
  DeepSeek, Ollama, Mistral, …), or your own provider adapter; switch models mid-session
- **Minimal core** — built-in agentic loop, plugin management, and interactive CLI; no
  extras required for basic conversational use
- **Hot-loaded plugins** — extend at runtime without restart:
  - **Tools** — bash, HTTP, workspace files, sandboxed Docker bash, MCP server bridge, background jobs
  - **Skills** — reusable system-context fragments injected on demand via a classifier
  - **Knowledge** — semantic knowledge index for domain-specific context (Rumsfeld + optional BGE reranker)
  - **Session editing** — cut, fork, and compact sessions to control context window size
  - **Frontends** — web UI with session management, Telegram bot
  - **Storage backends** — filesystem (default) or SQLite
  - **Providers** — add and remove LLM profiles live via the built-in `provider` tool

A clean, TypeScript API encourages you to write your own plugins to get the bot you want. Your own UI, your own memory system, your own persistent storage, your own tools or new concepts like imagination, dreaming, LLM routing - all are supported via hot-loaded npm modules.

To find out more about what makes MatBot special, take a look at the [Design ethos and developer notes](CLAUDE.md)

---

## Run it entirely in the browser

matbot also ships as a **single self-contained `matbot.html`** that runs the whole runtime
client-side — no server, calling the LLM directly from your browser. It's the same platform-neutral
core and the browser-safe plugins, type-stripped and wired together in-page, loadable from a
`file://` URL or any static host.

- **Try it live:** [open the web build](https://raw.githack.com/MatAtBread/matbot/main/apps/web-bundle/dist/matbot.html)
  — on first launch it asks for any OpenAI- or Anthropic-compatible provider (endpoint, model, key;
  e.g. DeepSeek), then you're chatting.
- **How it works and how to build it:** [apps/web-bundle/README.md](apps/web-bundle/README.md).

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

## Auto-configuration

**_You don't actually need to worry about configuration files. Matbot comes with a `plugin` tool that can discover and install plugins that provide new tools, LLM providers, front-ends and more_**. If it has nothing to go on, it will just ask you the basics to get your favourite
LLM up and running.


```text
$ pnpm repl

No providers configured. Let's set one up.

Available provider types:
  1. anthropic  (@matatbread/matbot-provider-anthropic)
  2. customer-services  (@matatbread/matbot-provider-customer-services)
  3. openai-compat  (@matatbread/matbot-provider-openai-compat)

Choose a type [1-3]: 1
Provider name (how this LLM key is named in ~/git/matbot/matbot.yaml and presented to you): deepseek
Model name: deepseek-v4-flash
Endpoint URL: https://api.deepseek.com/anthropic
API key: ************************************

Configuration written to ~/git/matbot/matbot.yaml

[2026-06-05T17:34:49.488Z 1153628] provider: deepseek  (ephemeral)

you: got any cool plugins?
[thinking… ×23]
Let me check what we've got!
⚙  plugin {"action":"list"}


⚙  plugin {"action":"discover_local"}
[2026-06-05T17:35:13.813Z 1153628] (node:1153628) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)

[thinking… ×22]
Oh yeah, there's a ton of cool stuff available! Here's the lineup of discoverable plugins you can add:

---

### 🔧 **Tool Plugins** (give me new abilities)
| Plugin | What it does |
|--------|-------------|
| **`bash`** | Run bash scripts right in the workspace — I can execute code, install packages, etc. |
| **`docker-bash`** | Same but inside a persistent Docker container — sandboxed! Project root is read-only, `.data` is read-write. |
| **`workspace`** | Read, write, and list files in the workspace. With the web UI, files are downloadable too. |
| **`http`** | Make HTTP requests to any web API or remote resource. |
| **`mcp`** | Connect MCP (Model Context Protocol) servers and expose their tools — huge for extending capabilities! |
| **`json-validation`** | Auto-validates my tool call inputs against schemas so I self-correct on mismatches. |
| **`edit-session`** | Cut messages, fork sessions into branches, compact history — power editing for convos. |

### 🧠 **Knowledge & Skills**
| Plugin | What it does |
|--------|-------------|
| **`persist-ki-bge`** | Persistent KnowledgeIndex with entity/heading search + optional BGE reranker. |
| **`rumsfeld`** | "Unknowns unknown" handler — looks up knowledge index when I hit a term I don't know. |
| **`skills`** | Inject skill documents into sessions on demand. |

### 🖥️ **Frontends** (ways to interact)
| Plugin | What it does |
|--------|-------------|
| **`frontend/web`** | HTTP + SSE web UI with session management — serves a chat UI on a local port. |
| **`frontend/telegram`** | Run this whole setup as a Telegram bot! |

### 🗄️ **Storage & Sessions**
| Plugin | What it does |
|--------|-------------|
| **`storage/sqlite`** | Persistent SQLite backend (WAL mode) for all runtime state. |
| **`sessions`** | List, get, rename, hide conversations. |

### ⏰ **Background Automation**
| Plugin | What it does |
|--------|-------------|
| **`background`** | Run prompts in detached background processes + schedule recurring prompts (cron-style). |

---

Wanna **add** any of these? Some highlights I'd personally recommend:
- **`bash`** + **`workspace`** → I can actually code, write files, and execute things
- **`http`** → I can hit APIs, fetch data, etc.
- **`mcp`** → Opens up the whole MCP ecosystem
- **`frontend/web`** → Gives you a slick web UI
- **`docker-bash`** → If you want a sandboxed execution environment

Just say the word and I'll install whichever ones sound fun! 🚀
[↑2130 ↓779 tokens]
```
```
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
> Of course, now the web front-end is loaded, you could have opened your browser
and done this from the web UI if you wanted

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
      apiKey: ${DEEPSEEK_API_KEY}
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
pnpm repl

# Single turn
pnpm repl "What is the capital of France?"

# New persistent session (prints a resume command on exit)
pnpm repl --session create

# Resume an existing session
pnpm repl --session <id>

# Server mode — headless, waits for a frontend plugin to handle requests
pnpm start
```

Sessions are **ephemeral by default**. Nothing is written to disk unless you pass
`--session create` (or `--session <id>` to resume). On exit a persistent session prints
a `--session <id>` resume command. You can change the storage via plugins. The default is local files under `.data` (`.gitignored`)

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
      apiKey: ${ANTHROPIC_API_KEY}
    parameters:
      maxTokens: 8192
```

### Run

```sh
pnpm repl
```

---

## Configuration reference

**Everything below is pluggable.** Each facility is exposed through a named `MatbotServices`
interface, and what's described in each section is only the **default implementation** — it can be
replaced or augmented by a plugin (`services.register(...)`) without touching the core. The
interface name is called out at the top of each section so you know what to implement.

### Provider entry

> **Facility:** `services.complete` (`CompletionRequest → CompletionResponse`). Providers are
> *adapter plugins* — the `module` below names one. The two shipped adapters (Anthropic-compatible,
> OpenAI-compatible) are the defaults; a plugin can add any other by implementing the adapter
> contract. Live add/remove is via the built-in `provider` tool.

```yaml
providers:
  <name>:
    module:     <npm-package | ./relative/path>   # adapter module
    endpoint:   https://...                       # overrides the default base URL
    model:      <model-id>
    credentials:
      apiKey:   ${SECRET_NAME} | literal          # ${NAME} resolved by the Vault (see below)
    parameters:                                   # optional; passed to the API
      maxTokens:      4096
      temperature:    0.7
      thinking:                                   # Anthropic extended thinking
        type:         enabled
        budgetTokens: 2000
    fallback:   <other-provider-name>             # used on 429 / 5xx
```

### CLI options

> **Facility:** session persistence is `services.sessions` (`Store<Session>`); the per-session turn
> loop is `services.run` (`SessionRunner`). Both are pluggable — the default `Store<Session>` lives
> in whatever `StorageBackend` is active (see *Data directory*).

| Option                  | Behaviour                                                           |
|-------------------------|---------------------------------------------------------------------|
| `[prompt]` (positional) | Single-turn prompt; runs one turn and exits. Omit for an interactive REPL |
| `--provider <name>`     | Provider key from `matbot.yaml` (default: first in file)            |
| `--session create`      | New persistent session; saved to the store                          |
| `--session <id>`        | Resume an existing session                                          |
| `--ephemeral`           | Force ephemeral even when `--session` is given                      |
| `--system <text>`       | System prompt injected at session start                             |
| `--config <path>`       | Config file path (default: `./matbot.yaml`; `-` reads YAML from stdin) |
| `--prompt-file <path>`  | Read the prompt from a file; runs a single turn and exits           |
| `--principal <id\|json>` | Boot identity: a bare id (type `user`) or JSON `{"id","type"}`. Overrides `MATBOT_PRINCIPAL` and the config `principal:` |
| `--help`                | Show help and exit                                                  |

Sessions are **ephemeral by default** (discarded on exit). Setting `ephemeral: true` in
`matbot.yaml` is a hard override — it takes effect even if `--session` is passed. Background
sub-agents set this to avoid leaving session traces.

### Secret resolution

> **Facility:** `services.vault` (the `Vault` interface). The default node implementation is
> `EnvFileVault` (over `VaultImpl`), which reads/writes a `.env` file next to `matbot.yaml`. The
> browser build swaps in a WebCrypto + browser-storage vault, and any plugin can register its own
> (e.g. a cloud secret manager) — there is no `.env` requirement in the contract.

There is **one** placeholder form and **one** flat namespace — no `env:` / `secret:` distinction:

| Syntax         | Resolves to                                                    |
|----------------|----------------------------------------------------------------|
| `${NAME}`      | The entry stored under `NAME` in the active Vault              |
| literal string | Used as-is (avoid for real credentials)                        |

The YAML loader leaves `${NAME}` intact; the Vault substitutes it at runtime (regex `\$\{([^}]+)\}`).
A missing name throws `MissingSecretError`. Credentials are resolved on use and never written to
session storage. With the default node vault, `${DEEPSEEK_API_KEY}` resolves against the `.env`
file — but that's just the default backend, not part of the syntax.

### Data directory

> **Facility:** `services.StorageBackend` (the `StorageBackend` interface — `createStore<T>()` plus a
> `fileStore`) and the `Store<T>` it hands out, with `services.KnowledgeIndex` (the `KnowledgeIndex`
> interface) for the knowledge store. The default `StorageBackend` is the filesystem one below;
> `services.register('StorageBackend', …)` swaps it live and re-wires every `Store` proxy. The
> default `KnowledgeIndex` is the in-memory `LookupKnowledgeIndex`.

With the default filesystem backend, all runtime state lives in `.data/` next to `matbot.yaml` and
is .gitignored:

```
.data/
  sessions/    — session store (only created when persistence is active)
  settings/    — per-plugin key-value settings
  schedules/   — recurring background job definitions (background plugin)
  knowledge/   — KnowledgeIndex entries (persist-ki-bge plugin)
  bash-cwd/    — default working directory for bash tool execution
  files/       — file store blobs; the workspace namespace holds workspace_action (write) output
```

The SQLite storage plugin (`@matatbread/matbot-storage-sqlite`) is a drop-in replacement
`StorageBackend` that collapses the per-directory filesystem stores into a single `.data/matbot.db`
file. Plugins may create additional subdirectories as needed.

---

## Writing your own plugin

See [PLUGINS.md](PLUGINS.md) for the full plugin API reference. I recommend checking the [design ethos and developer notes](CLAUDE.md) too.

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
...or ask MatBot to do it in the repl or web-frontend
```
Add the local plugin called my-plugin
```
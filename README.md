# matbot

> *A thin, composable runtime that connects language models to tools and frontends.*

Most LLM frameworks make choices for you. matbot doesn't. It's infrastructure: a minimal
agentic loop, a plugin system, and the conviction that everything else — tools, storage,
frontends, memory, identity — should be composable, hot-loadable, and replaceable without
touching the core.

**[Try it live in your browser →](https://matatbread.github.io/matbot/apps/web-bundle/dist/matbot.html)**
*(No install. Just bring an API key.)*

---

## Why matbot?

**It's a TypeScript-first node v24 service**, with no build-step, no config setup.
All you need is an LLM (OpenAI, Anthropic, DeepSeek, your own local LLM) with an API key.

**It also runs entirely in the browser.** matbot ships as a single self-contained HTML file —
no server, no build step, no backend. The full runtime runs client-side, calling your LLM
directly. Same core, same plugins, same UI as the Node build. This isn't a demo mode:
it's a deliberate design choice that makes the browser a first-class, sandboxed deployment
target.

**Everything is a plugin.** Tools, frontends, storage backends, LLM providers, knowledge
indexes, session editors — all plugins. None of them are hardcoded. The core is genuinely
minimal: an agentic loop, plugin management, and a principal carrier. Everything else is
optional. A basic set of plugins for file access is bundled so you can get started
immediately, but every one can be replaced with your preferred setup.

**Plugins are hot-loaded.** Add, remove, or reload a plugin at runtime without
restarting. The built-in `plugin` tool lets the LLM manage its own capabilities
mid-session. You can go from a bare conversational bot to one with bash execution, a web
UI, and a Telegram frontend without ever touching a config file.

**Security is a first-class concern.** The principal carrier threads identity through
every layer — tools, storage, knowledge index — without it needing to be in every
signature. Credentials are resolved at runtime and never written to session storage. In
the browser, the sandbox means even an overenthusiastic LLM can't touch your filesystem.

---

## Quick start (Node)

matbot is a small CLI plus a set of **optional plugins you install alongside it** — so install
it **into a project**, not globally. That way the CLI and its plugins share one `node_modules`
and resolve to a single core (a `-g` or bare `npx` install runs fine but can't load
project-local plugins, which are the whole point):

```sh
mkdir my-matbot && cd my-matbot
npm init -y
npm i @matatbread/matbot-cli
npx matbot                 # runs the locally-installed `matbot` bin
```

> Just kicking the tyres, no plugins? `npx @matatbread/matbot-cli` runs it standalone.
>
> From source, which includes **all** the optional plugins and the web-bundler, or for development: 
> ```
> git clone https://github.com/MatAtBread/matbot.git  # ...or fork your own
> pnpm install 
> pnpm repl
> ```
> `pnpm repl` is the from-source alias for `matbot`.

No config file needed — on first run matbot walks you through setting up a provider. After
that, capabilities are added with the built-in `plugin` tool; each is its own npm package
(see [What's in the box](#whats-in-the-box) for the catalogue):

```
you: I'd like a browser UI — add the web frontend

⚙  plugin { "action": "add", "specifier": "@matatbread/matbot-frontend-web" }
Install plugin "@matatbread/matbot-frontend-web"? [y/N] y
Installing with npm…

[frontend-web] http://localhost:19778

The web frontend is live — open http://localhost:19778 in your browser.
Your current session continues there; no restart needed.
```

That last bit is the point: the plugin hot-loads, prints a URL, and you move seamlessly
from the terminal into the web UI — same session, no interruption. (`plugin add` installs the
package into your project alongside the CLI, so it resolves to the same core.)

> **No API key?** The `customer-services` provider is free, needs no key, and runs
> without GPU support. It's not a real LLM, but it's useful for testing your setup

---

## Quick start (Browser)

Open [matbot.html](https://matatbread.github.io/matbot/apps/web-bundle/dist/matbot.html)
in any modern browser. On first launch it asks for a provider (endpoint, model, API key —
DeepSeek, Anthropic, OpenAI, or anything compatible). Then you're chatting. Sessions,
skills, workspace files, and provider config all persist in browser storage across reloads.

---

## What's in the box

### Core

- Agentic loop with tool-call / tool-result handling
- Plugin lifecycle: add, remove, reload, discover local plugins
- Provider management: add and switch LLM profiles live
- Principal carrier: ambient identity threaded through every layer
- Vault: secret resolution with `${NAME}` placeholders
- Basic implementations for storage (files) and UI (CLI) are created by "apps" like the CLI.

### Plugins (all optional - install and try out as you please)

| Category | Plugin | What it does |
|---|---|---|
| **Tools** | `bash` | Run shell commands on the host |
| | `docker-bash` | Run commands in a sandboxed Docker container |
| | `http` | Make HTTP requests to any web API |
| | `workspace` | Read/write files; browser build serves them as downloads |
| | `mcp` | Connect stdio (local) MCP servers; `mcp-http` adds HTTP/SSE servers (browser + Node) |
| | `edit-session` | Cut, fork, and compact sessions to manage context window size |
| | `ask-user` | Ask the user a question mid-turn (`ask_user`) |
| **Hooks** | `json-validation` | Validate tool inputs against schema (a `toolcall` hook); LLM self-corrects on mismatch |
| **Knowledge** | `rumsfeld` | Look up the knowledge index when the LLM encounters an unknown term |
| | `persist-ki-bge` | Persistent knowledge index with optional BGE reranker |
| | `skills` | Named markdown playbooks, injected on demand by a classifier |
| | `cognition` | Seeds skills (Inner Voice critique, Remember This, Dream Time) and a remembered-facts store |
| **Frontends** | `frontend/web` | HTTP + SSE web UI with session management |
| | `frontend/telegram` | Telegram bot frontend |
| **Storage** | `storage/sqlite` | SQLite backend (Node); browser uses IndexedDB |
| **Background** | `background` | Detached background jobs and cron-style scheduling |

Note: plugins are scoped to a run-time. Not all plugins (eg bash) are available in all run-times (eg the browser).

---

## The browser build

The browser build deserves its own section because it's not a cut-down version — it's a
deliberate deployment target.

matbot's platform-neutral core and browser-safe plugins are type-stripped and bundled
into a single `matbot.html`. It runs entirely in-page: no server, no CORS proxy, no
service worker. The same web UI used by the Node web frontend is reused here, with an
in-process transport instead of HTTP+SSE.

**What the browser build gives you:**
- **Zero install** — open a URL, bring an API key, start working
- **Sandboxed by default** — browser security restrictions limit blast radius if your LLM goes rogue
- **Persistent** — sessions, skills, provider config, and workspace files survive page reloads
- **Portable** — loadable from a `file://` URL or any static host

**What it doesn't have (since they require Node specific interfaces):**
- Bash / Docker execution
- Stdio MCP servers
- SQLite storage
- Telegram frontend
- Filesystem-backed skills with file watching

For evaluating or just basic personal use, the browser build is the right starting point.

---

## Writing a plugin

The plugin API is a TypeScript interface. A minimal tool plugin:

```ts
import type { MatbotPluginSpec, Tool } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

const myTool: Tool = {
  name: 'hello',
  description: 'Greet someone.',
  inputSchema: {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
  },
  executor: {
    async *execute(input) {
      const { name } = input as { name: string };
      yield { type: 'result', value: `Hello, ${name}!` };
    },
  },
};

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools: [myTool],
};
```

Add it to your config — or just tell the LLM:

```
Add the local plugin called my-plugin
```

Plugins can provide tools, frontends, LLM adapters, storage backends, knowledge indexes,
hooks, or entirely new concepts (memory systems, LLM routing, background cognition — all
shipped as first-party plugins in this repo).

---

## More about matbot

| Document | What's in it |
|---|---|
| [GETTING-STARTED.md](docs/GETTING-STARTED.md) | Installation, full CLI reference, config reference, worked examples |
| [DEVELOPING.md](docs/DEVELOPING.md) | Full plugin API — tools, providers, storage, frontends, hooks, the browser bundle |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Visual tour of the core, plugin seams, and turn flow |
| [CLAUDE.md](CLAUDE.md) | Design ethos, hard rules, and architectural intent — written for AI assistants working on the codebase, but essential reading for any contributor |

---

## Requirements

- Node 24+
- pnpm 9+
- An LLM API key (Anthropic, OpenAI-compatible, DeepSeek, Ollama, …)

---

## Licence

Apache 2.0
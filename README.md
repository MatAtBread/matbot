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
All you need is an LLM (OpenAI, Anthropic, DeepSeek, Google Gemini, your own local LLM) with an API key.

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
UI, memory, skills and a Telegram frontend without ever touching a config file.

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
npm i @matatbread/matbot-cli   # creates a minimal package.json + node_modules
npx matbot                     # runs the locally-installed `matbot` bin
```

> Just kicking the tyres, no plugins? `npx @matatbread/matbot-cli` runs it standalone.
>

### From source, which includes **all** the optional plugins and the web-bundler, or for development:
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

### Plugins

All the plugins are optional - install and try out as you please. You can use them as is, or as templates for your own, bespoke implementations. Note that some, like `providers` are loaded indirectly when needed, and so you don't actually need to add them.

| Category | Plugin | What it does |
|---|---|---|
| **Tools** | `bash` | Run shell commands on the host |
| | `docker-bash` | Run commands in a sandboxed Docker container |
| | `http` | Make HTTP requests to any web API |
| | `workspace` | Read/write files; browser build serves them as downloads |
| | `mcp` | Connect stdio (local) MCP servers; `mcp-http` adds HTTP/SSE servers (browser + Node) |
| | `sessions` | List, rename, and hide saved sessions (`session_action`) |
| | `edit-session` | Cut, fork, split, and compact sessions to manage context window size |
| | `ask-user` | Ask the user a question mid-turn (`ask_user`) |
| | `whoami` | Report the current principal (`whoami`) |
| | `function-tools` | Author & run TypeScript functions that compose other tools in one pass (`tool_function`) |
| | `tool-store` | Define named persistent stores with generated CRUD tools (`store_action`) |
| | `tool-router` | Serve the model a bounded per-turn window from a large tool library, with a `tool_search` entry point |
| | `tool-types` | Node service: derives a typed `.d.ts` of tool results so tool-composing codegen (`function-tools`, `skill-compiler`) is type-checked |
| **Hooks** | `json-validation` | Validate tool inputs against schema (a `toolcall` hook); LLM self-corrects on mismatch |
| | `triggers` | Data-driven hooks: fire a tool or skill when an LLM classifier judges a stored condition matched |
| | `hook-logger` | Diagnostic: log every hook-channel firing |
| | `provenance` | Trace a claim back to the tool result or message it came from (`determine_provenance`) |
| **Knowledge** | `rumsfeld` | Look up the knowledge index when the LLM encounters an unknown term |
| | `persist-ki-bge` | Persistent knowledge index with optional BGE reranker |
| | `skills` | Named markdown playbooks, injected on demand by a classifier |
| | `skills-node` | Node specialization of `skills`: import & watch local `.md` skill files |
| | `skill-compiler` | Compile a procedural skill into a hot-loadable TypeScript tool plugin (`skill_compiler`) |
| | `cognition` | Inner-voice critique, persistent fact memory, and background Dream Time consolidation |
| **Frontends** | `frontend/web` | HTTP + SSE web UI with session management |
| | `frontend/dom` | Minimal in-process browser chat (the `matbot-demo.html` demonstrator) |
| | `frontend/telegram` | Telegram bot frontend |
| | `web-principal-user` | Set the web frontend's request principal to the host OS user — a template for multi-user auth |
| **Providers** | `anthropic` | Anthropic Messages API (+ DeepSeek `/anthropic` compat) |
| | `openai-compat` | OpenAI-compatible chat completions |
| | `google` | Google Gemini (native `generateContent`) |
| | `customer-services` | Free built-in demo LLM — no API key needed |
| | `chatjimmy` | Hosted llama endpoint — non-streaming, text-only, keyless; a very low-latency comparison point |
| **Storage** | `storage/filesystem` | Filesystem backend (Node; the CLI's default store) |
| | `storage/sqlite` | SQLite backend (Node) |
| | `storage/google-drive` | Google Drive backend (browser) |
| | `storage/profiles` | Per-principal partitioning over the filesystem backend — a profile per user (`profile_action`, `share`) |
| | `browser` | Browser-native storage: IndexedDB store, OPFS files, WebCrypto vault (+ the browser `plugin`/`provider` tools) |
| | `files` | Node filesystem `FileStore` for MIME-typed blobs served by the web frontend |
| **Background** | `background` | Detached background jobs and cron-style scheduling |

The built-in `plugin` and `provider` tools (add/remove/reload plugins, manage LLM profiles) are always
loaded — see [Core](#core) above. Note: plugins are scoped to a run-time; not all (eg `bash`) are
available in all run-times (eg the browser).

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

## Composing tools in code

> **LLMs are better at writing code than running it.**

A long chain of one-at-a-time tool calls is where models drift: every round-trip is a chance to lose
the thread, and the orchestration gets re-derived from scratch each turn. Writing a *single function*
that calls those same tools is something models do far more reliably — so matbot lets them do exactly
that, and leans hard on dynamically-generated TypeScript types to keep them honest.

**The type surface is live.** The [`tool-types`](docs/DEVELOPING.md#first-party-plugins-reference)
plugin derives a `.d.ts` of every *currently-loaded* tool from its declared contract — inputs **and**
results. Multi-action tools become overload sets, so `await tool.workspace_action({ action: 'read', path })`
narrows to the exact result type for that action. The model isn't guessing what a call returns; it's
reading it off the types.

**The model writes functions that compose tools.** With `function-tools`, the model authors a
TypeScript function that calls several tools in one pass — `tool_function` with `define` persists it as
a new named tool (reusable next turn), `lambda` runs it once. There's no build step: the TypeScript is
erased at runtime by the host's stripper, exactly as matbot's own plugins are.

**Procedures compile to code.** `skill-compiler` turns a written-out markdown procedure (a *skill*)
into an executable TypeScript tool plugin — a fuzzy prose playbook becomes a deterministic,
re-runnable tool.

**Hallucinated shapes can't reach runtime.** Every piece of generated code is graded by a real
TypeScript compiler running in a worker thread — including a *cast gate* that rejects `as any` /
`as unknown as T` escape hatches exactly like type errors, because a cast is the one hole a made-up
shape could slip through. Diagnostics are annotated and handed back to the model to repair. A tool
that type-checks is a tool whose calls resolve to the shapes the model expected.

> **Bonus feature: much lower cost**
Tools created by `tool_function` and `skill_compiler` are MUCH more efficient in terms of tokens because
- The cost of generating the code is done once, up-front, and re-used for free. Even if a tool uses a
`single_turn` tool for LLM classification or summarization, it does so in a low-context, low cost environment.
Your compiled skills and functional tools don't have to be dumb!
- Tools which render large volumes of data and aggregate it for presentation to another tool
_doesn't require that the LLM tokenises all your data_. This is huge win when your tools are
orchestrating work based on external data sources, especially repeatedly.

The payoff: fewer round-trips, deterministic re-runs, and the model's discretion over things it can't
actually know — a tool's return shape, a required parameter — compiled away instead of re-guessed every
turn.

---

## Writing a plugin

The plugin API is a TypeScript interface. A minimal tool plugin — declaring its **typed call
contract** so the tool is type-safe end to end:

```ts
import type { MatbotPluginSpec, Tool, ToolContract, ToolResultOf } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

// The single source of truth for what `hello` accepts and returns. Augment ToolContracts
// exactly as you would MarkerData / MatbotServices — keyed by the tool's name.
declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    hello: ToolContract<string, { name: string }>;   // ToolContract<Result, Params>
  }
}

// Binding `Tool<ToolResultOf<'hello'>>` ties the executor to that contract: the compiler now
// checks every `result` you yield against it, so the tool and its declared type can't drift.
const myTool: Tool<ToolResultOf<'hello'>> = {
  name: 'hello',
  description: 'Greet someone.',
  inputSchema: {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
  },
  executor: {
    async *execute(input) {
      const { name } = input as { name: string };          // inputSchema stays loose; validate at the boundary
      yield { type: 'result', value: `Hello, ${name}!` };  // ← must be a string, or this won't compile
    },
  },
};

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools: [myTool],
};
```

That one augmentation pays off everywhere: callers recover the concrete result from `invokeTool` +
`toolResult` instead of `unknown`, and the typed `tool` proxy that [code-composed tools](#composing-tools-in-code)
call knows exactly what `hello` returns. Multi-action tools register a **union of arms** — one
`ToolContract<Result, Params>` per action — so the result narrows by the params passed; see
[DEVELOPING.md](docs/DEVELOPING.md#typed-results-toolcontracts) for that pattern.

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
- pnpm 9+ (only to run from source; a project install uses npm)
- An LLM API key (Anthropic, OpenAI-compatible, Google Gemini, DeepSeek, Ollama, …)

---

## Licence

Apache 2.0

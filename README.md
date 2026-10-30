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
signature. Credentials are resolved at runtime and never written to session storage.
Privileged operations pass through permission gates that ask a human, and refuse when nobody
can be asked. In the browser, the sandbox means even an overenthusiastic LLM can't touch your
filesystem. [SECURITY.md](docs/SECURITY.md) sets out the threat model, what is protected, what
remains open, and how to deploy.

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

All the plugins are optional - install and try out as you please. Note that some, like `providers` are loaded indirectly when needed, and so you don't actually need to add them.

Each plugin has a **Type**, the same classification the `plugin` tool's `list` action reports (`types`): what it contributes — `tools`, a `provider`, a `frontend`, a `storage` backend, `hooks`, or a **service** registered by name (`KnowledgeIndex`, `ToolTypeIndex`, `ToolPresenter`, …).

And a **Status**:

- **Functional** — intended for real use as shipped.
- **Example** — a demonstration of how a feature *might* be implemented, typically with an obvious security hole or incomplete functionality. Use it as a template for your own, not as-is where the gap matters. For instance `storage/profiles` shows how to partition a `Store` by `Principal`, but has no login or auth, so any user can impersonate any other (by design — the web UI has a selector for it).
- **Deprecated** — kept for existing installs; use its replacement.

| Type | Plugin | Status | What it does |
|---|---|---|---|
| **tools** | `bash` | Functional | Run shell commands on the host |
| | `docker-bash` | Functional | Run commands in a sandboxed Docker container (replaces `bash`; `bash_config`) |
| | `http` | Functional | Make HTTP requests to any web API |
| | `workspace` | Functional | Read/write files; browser build serves them as downloads |
| | `mcp` | Functional | Connect stdio (local) MCP servers; delegates HTTP/SSE servers to `mcp-http` (Node) |
| | `mcp-http` | Functional | Connect HTTP/SSE MCP servers (`mcp_action`; Node + browser) |
| | `sessions` | Functional | List, get, rename, and hide saved sessions (`session_action`) |
| | `edit-session` | Functional | Cut, fork, split, and compact sessions to manage context window size |
| | `ask-user` | Functional | Ask the user a question mid-turn (`ask_user`) |
| | `whoami` | Functional | Report the current principal (`whoami`) |
| | `tool-store` | Functional | Define named persistent stores with generated CRUD tools (`store_action`) |
| | `provenance` | Functional | Trace a claim back to the tool result or message it came from (`determine_provenance`) |
| | `rumsfeld` | Functional | Look up the knowledge index when the LLM encounters an unknown term (`contextual_search`, `find_fact`) |
| | `cognition` | Functional | Inner-voice critique, persistent fact memory, and background Dream Time consolidation |
| | `skills` | Functional | Named markdown playbooks, injected on demand by a classifier (`skill_action`; provides `SkillManager`) |
| | `skills-node` | Functional | Node specialization of `skills`: import & watch local `.md` skill files |
| | `skill-compiler` | Functional | Compile a procedural skill into a hot-loadable TypeScript tool plugin (`skill_compiler`; Node) |
| | `background-jobs` | Functional | Run prompts as background jobs — now, at a time, or on an interval — that report by appending to a conversation; jobs run in-process |
| | `background-jobs-node` | Functional | The same, each job in its own process (Node) |
| **tools + hooks** | `function-tools` | Functional | Author & run TypeScript functions that compose other tools in one pass (`tool_function`) |
| | `triggers` | Functional | Data-driven hooks: fire a tool or skill when an LLM classifier judges a stored condition matched |
| **hooks** | `hook-logger` | Example | Diagnostic: log every hook-channel firing |
| | `json-validation` | Functional | `validate` hook: validate tool inputs against their JSON Schema; the LLM self-corrects on mismatch |
| | `ts-validation` | Functional | `validate` hook: validate tool inputs against the `ToolContract` params type (Node; needs `tool-types`). Loads beside `json-validation`; a call either refuses is refused |
| **services** | `tool-types` | Functional | `ToolTypeIndex` (Node): derives a typed `.d.ts` of tool results so tool-composing codegen (`function-tools`, `skill-compiler`) is type-checked |
| | `caching-tool-types` | Functional | `ToolTypeIndex` (Node): `tool-types` with its build kept in settings across restarts; load it instead of `tool-types` |
| | `function-runner-node` | Functional | `FunctionRunner` (Node, optional): bounds a `tool_function` body's run time, withholds host globals, gates its `import(...)`. Without it a body runs unbounded and ungated |
| | `tool-router` | Functional | `ToolPresenter`: serve the model a bounded per-turn window from a large tool library, with a `tool_search` entry point |
| | `persist-ki-bge` | Functional | `KnowledgeIndex`: persistent, with optional BGE reranker |
| | `web-principal-user` | Example | `WebPrincipalResolver`: the web frontend's fallback principal becomes the host OS user (`$USER`) — a template for a real resolver |
| **frontend** | `frontend/web` | Functional | HTTP + SSE web UI with session management (Node); in-process in the browser |
| | `frontend/dom` | Functional | Minimal in-process browser chat (the `matbot-demo.html` demonstrator) |
| | `frontend/telegram` | Functional | Telegram bot frontend |
| **provider** | `anthropic` | Functional | Anthropic Messages API (+ DeepSeek `/anthropic` compat) |
| | `openai-compat` | Functional | OpenAI-compatible chat completions |
| | `google` | Functional | Google Gemini (native `generateContent`) |
| | `chatjimmy` | Example | Hosted llama endpoint — non-streaming, text-only, keyless; a very low-latency comparison point |
| | `customer-services` | Example | Mock LLM: always helpful, never useful. No API key needed |
| | `webllm` | Example | Open-weight models (Qwen3 by default) on the GPU in the page via WebLLM, loaded from a CDN on first use — browser only, keyless. `webllm_models` lists and removes models |
| | `provider-store-test` | Example | Test/reference: contributes provider profiles from its own store and reverts them on unload. In the repo only; not published |
| **storage** | `storage/filesystem` | Functional | Filesystem backend (Node; the CLI's default store) |
| | `storage/sqlite` | Functional | SQLite backend (Node) |
| | `storage/google-drive` | Functional | Google Drive backend (browser) |
| | `storage/profiles` | Example | Per-principal partitioning over the filesystem backend — a profile per user (`profile_action`, `share`). No login or auth: any user can impersonate any profile |
| | `browser` | Functional | Browser-native storage: IndexedDB store, OPFS files, WebCrypto vault (+ the browser `plugin`/`provider` tools) |

`files` (`@matatbread/matbot-files-node`) is not a plugin but a library: the Node filesystem `FileStore` the CLI and `storage/*` backends use for MIME-typed blobs served by the web frontend.

The built-in `plugin` and `provider` tools (add/remove/reload plugins, manage LLM profiles) are always
loaded — see [Core](#core) above. Note: plugins are scoped to a run-time; not all (eg `bash`) are
available in all run-times (eg the browser).

### Recommended for more secure operation

None of these is loaded by default, because none is needed to run matbot. Each one narrows what a
model can get wrong, or get away with:

| Plugin | Why |
|---|---|
| `json-validation` | Refuses a tool call whose params do not match the tool's schema — a wrong type, a missing field, a value outside its set — before the tool runs, and tells the model what to fix. Node and browser |
| `ts-validation` | The same check against the tool's TypeScript contract, which is stricter than its schema: it also refuses a property the contract does not declare, so `session_id` mis-sent for `sessionId` is a reported mistake rather than a call the tool reads as "no session given". Loads beside `json-validation`; a call either refuses is refused. Node only, and installs `tool-types` itself |
| `tool-types` (or `caching-tool-types`) | Types the code `function-tools` and `skill-compiler` generate, and refuses what it must not do before it runs: casts that hide a wrong shape, globals and modules the runner withholds, and reaching past the runner (`ESCAPE-GATE`) |
| `function-runner-node` | Runs `tool_function` bodies: bounds their run time, withholds `process` and friends, puts every `import(…)`, `fetch` and `WebSocket` to a permission gate, and refuses code built from a string. Without it a body runs unbounded and ungated. One implementation of the `FunctionRunner` seam: a runner that runs each body in a child process is a more secure one, not currently part of this repo |

`tool-types` and `function-runner-node` matter only where model-written code runs — in practice, with
`function-tools` loaded, which is the route by which model-written text runs as code without a plugin
install. Without `function-tools` there is no body to run, and `tool-types` is then only what
`ts-validation` checks against.

```yaml
plugins:
  - '@matatbread/matbot-tool-json-validation'
  - '@matatbread/matbot-tool-ts-validation'     # Node; brings tool-types with it
  - '@matatbread/matbot-function-tools'
  - '@matatbread/matbot-function-runner-node'   # Node; only meaningful with function-tools
```

**Shells deserve a decision of their own.** `bash` is inherently insecure: it runs as matbot's user,
with nothing gated about what a command does, including rewriting the stored gate answers.
`docker-bash` is safer but not safe. It keeps the project read-only and the gate answers out of reach,
but what it protects depends on the Docker installation underneath it (rootful Docker makes matbot's
user root-equivalent on the host). As shipped, its container also reaches the network and the host,
runs as root inside, and has no resource limits. See [SECURITY.md](docs/SECURITY.md#shells).

**Permission gates start closed, and the user decides what opens them.** A privileged act (installing
a plugin, reaching an origin, a function importing a module) asks a human, and is refused when nobody can
be asked. What model-written code may do beyond that is what a user has permitted: each "Always allow…"
answer widens it from then on, for every route including background jobs and the HTTP tool endpoint, and
"Always deny" refuses that exact act from then on without asking. To forbid something more broadly,
don't load the plugin that does it, or see
[SECURITY.md](docs/SECURITY.md#what-an-answer-can-change) for the other ways.

**These are one strategy, not the only one.** Everything is a plugin, so each of these is a choice
an installation can replace — by hand, or by asking the model to write the replacement. The node
runner, for instance, runs bodies in matbot's own process and stops a body reaching past the gates,
but cannot stop code written to interfere with matbot; a `FunctionRunner` that runs each body in a
child process, or a context of its own, is a different strategy behind the same seam, and needs no
change anywhere else. [SECURITY.md](docs/SECURITY.md) says what each of these does and does not
cover, which is what a replacement would be measured against.

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
results. Multi-action tools become overload sets, so `await tool.workspace_action({ action: 'read', name })`
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
| [MEDIA.md](docs/MEDIA.md) | How images, PDFs and audio reach a model — submission, storage and delivery, with the first-party plugins as templates |
| [SECURITY.md](docs/SECURITY.md) | The threat model: what the permission gates protect, against whom, what remains open, and how to deploy |
| [SSE-CLIENTS.md](docs/SSE-CLIENTS.md) | Writing a UI client (or reimplementing the server half): what the streams guarantee, and the failures that are invisible in testing |
| [CLAUDE.md](CLAUDE.md) | Design ethos, hard rules, and architectural intent — written for AI assistants working on the codebase, but essential reading for any contributor |

---

## Requirements

- Node 24.12+
- pnpm 9+ (only to run from source; a project install uses npm)
- An LLM API key (Anthropic, OpenAI-compatible, Google Gemini, DeepSeek, Ollama, …)

---

## Upgrading to 0.5.0

0.5.0 removes code that migrated old data in place. Two kinds of stored data written by much older
versions are no longer read:

- **A SQLite database created before 0.4.4.** Before 0.4.4 a namespace's table name was derived by
  replacing every character outside `[A-Za-z0-9]` with `_` (so `profile-registry` was stored as
  `profile_registry_store`); only a namespace whose name has such a character is affected. Any 0.4.x from
  0.4.4 renames the table the first time its namespace is opened, so start the install once with matbot
  **>=0.4.4 <0.5.0** and the same plugins before upgrading. Opened directly by 0.5.0, an affected
  namespace looks empty, and the old table is left untouched in the file.
- **A file stored before 0.2.4 without a name** (a UUID id). Its `<id>.meta.json` has an `id` field and no
  `dataFile`, and its data is at `<id>.data`. No version of matbot rewrites these: to keep one, add
  `"dataFile": "<id>.data"` to its sidecar — a task any model with `bash` or Node file access can do.

The full list of removals is in [CHANGELOG.md](CHANGELOG.md).

---

## Licence

Apache 2.0

# Developing for matbot

This document covers everything you need to write plugins for matbot — tools, providers,
storage backends, frontends, hooks, and the browser bundle. For the design principles and
hard rules behind these APIs, see [CLAUDE.md](../CLAUDE.md) — it's written for AI
assistants working on the codebase, but it's also the best single source of ethos and
architectural intent for any contributor.

For the project overview see [README.md](../README.md); for installation and configuration
see [GETTING-STARTED.md](GETTING-STARTED.md).

---

## The plugin contract

Every plugin module must export a named `plugin` constant satisfying `MatbotPlugin`
from `@matatbread/matbot-plugin-api`:

```ts
import type { MatbotPlugin } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

export const plugin: MatbotPlugin = {
  name:       'my-plugin',
  apiVersion: PLUGIN_API_VERSION,
  tools:      [myTool],
};
```

The loader also accepts a default export with a `plugin` key, but the named export is
preferred. Keep `@matatbread/matbot-plugin-api` in `dependencies` (not `devDependencies`).

### `MatbotPlugin` fields

| Field | Type | Purpose |
|---|---|---|
| `name` | `string` | Unique identifier |
| `apiVersion` | `string` | Must equal `PLUGIN_API_VERSION` |
| `manifest` | `PluginManifest` | Human-readable metadata, required env vars |
| `tools` | `readonly Tool[]` | Tool implementations to register |
| `providers` | `Record<string, ProviderAdapterFactory>` | LLM adapter factories keyed by `type` string |
| `storageBackend` | `{ open(dotData: string): Promise<StorageBackend> }` | Storage backend |
| `setup` | `(services: MatbotServices) => Promise<void>` | Called once after all plugins are registered |
| `teardown` | `() => Promise<void>` | Called on graceful shutdown |

### Package layout

```
my-plugin/
  package.json       # "type": "module", exports "." → "./src/index.ts"
  tsconfig.json      # extends tsconfig.base.json; add "types": ["node"] only if needed
  src/
    index.ts         # export const plugin: MatbotPlugin
```

---

## Loading plugins

> **Security note:** plugins won't install unless the user explicitly confirms via the
> current UI. This prevents remote actors from adding plugins without the user's consent.

### Via the LLM

```
Add the local plugin called background
Add the plugin from npm called @somecooldude/superbot
Add the plugin from the github repo SomeCoolDude/MyLatestMatbotPlugin
```

### Via `matbot.yaml`

```yaml
plugins:
  - @matatbread/matbot-tool-bash          # npm package
  - ./my-plugin                           # local package directory
  - ./my-plugin/src/index.ts              # explicit entry point
```

### Via the `plugin` tool at runtime

```
plugin({ action: 'add',    specifier: '@matatbread/matbot-tool-bash' })
plugin({ action: 'remove', specifier: '@matatbread/matbot-tool-bash' })
plugin({ action: 'list' })
```

Plugins are hot-loaded immediately — no restart needed.

---

## Services available in `setup()`

`MatbotServices` is the runtime environment handed to every plugin:

```ts
interface MatbotServices {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  settings(pluginName: string): PluginSettings;
  createStore<T extends { id: string; version: string }>(namespace: string): Store<T>;
  loadPlugin(specifier: string): Promise<void>;
  unloadPlugin(specifier: string): Promise<void>;
  register<K extends keyof MatbotServices>(key: K, value: NonNullable<MatbotServices[K]>): Promise<void>;
  get<K extends keyof MatbotServices>(key: K): MatbotServices[K] | undefined;

  readonly providers:       ReadonlyMap<string, ProviderConfig>;
  readonly storageBackend?: StorageBackend | undefined;
  readonly sessions?:       Store<Session>;
  readonly files?:          FileStore;
  readonly knowledge:       KnowledgeIndex;
  readonly vault:           Vault;
  readonly hooks:           HookRegistry;
  readonly tools:           ToolRegistry;
  readonly systemContext:   SystemContextRegistry;
  readonly workdir?:        string;
  readonly configPath?:     string;
}
```

### Plugin-to-plugin services

Plugins advertise services to each other by augmenting `MatbotServices`:

```ts
// In a types package, e.g. @matatbread/matbot-analytics-types:
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    analytics?: AnalyticsService;   // optional: present only when loaded
  }
}
```

```ts
// Advertising (providing plugin's setup()):
await services.register('analytics', new AnalyticsServiceImpl(store));

// Consuming (any plugin's setup()):
const analytics = services.get('analytics'); // AnalyticsService | undefined
```

### Plugin settings

```ts
interface PluginSettings {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Keys are scoped per plugin — two plugins can use the same key without collision.

### Calling LLMs directly

`services.complete()` lets plugins call LLMs for classification, summarisation, or
inner-voice critique:

```ts
interface CompletionRequest {
  provider:    string;
  messages:    Message[];
  system?:     string;
  parameters?: Partial<ModelParameters>;
  signal?:     AbortSignal;
}
```

---

## Writing a tool

```ts
import type { Tool, ToolEvent, ToolContext } from '@matatbread/matbot-plugin-api';

const myTool: Tool = {
  name:        'search',
  description: 'Search the index and return matching hits.',
  requires:    ['network'],
  inputSchema: {
    type:       'object',
    required:   ['query'],
    properties: {
      query: { type: 'string', description: 'Search terms.' },
    },
  },
  executor: {
    async *execute(input, ctx): AsyncIterable<ToolEvent> {
      const { query } = input as { query: string };
      yield { type: 'stdout', chunk: `Searching for "${query}"...\n` };
      yield { type: 'result', value: { hits: [] } };
    },
  },
};
```

### Multi-action tools (preferred convention)

When a plugin would otherwise expose several `noun_verb` tools for one noun, the
preferred style is a single `noun_action` tool with an `action` discriminator. The
description teaches the domain once and carries the per-action contract as a TypeScript
discriminated union (LLMs read TS unions more reliably than JSON-Schema `oneOf`).
`inputSchema` stays loose (`required: ['action']`); the executor enforces per-action
requirements. See `CLAUDE.md` for the full rationale.

```ts
const mcpAction: Tool = {
  name: 'mcp_action',
  description: `Manage MCP server connections.

  type McpAction =
    | { action: 'add';    name: string; endpoint: string }
    | { action: 'list' }
    | { action: 'remove'; name: string };`,
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['add', 'list', 'remove'] },
      name:   { type: 'string' },
      endpoint: { type: 'string' },
    },
  },
  executor: {
    async *execute(input, ctx) {
      const act = input as McpAction;
      switch (act.action) {
        case 'add':    /* … */ break;
        case 'list':   /* … */ break;
        case 'remove': /* … */ break;
        default: yield { type: 'error', message: `Unknown action.` };
      }
    },
  },
};
```

### `ToolEvent` variants

| Event | Fields | Meaning |
|---|---|---|
| `stdout` | `chunk: string` | Streaming output |
| `stderr` | `chunk: string` | Streaming error output |
| `progress` | `pct: number`, `message?: string` | Progress (0–100) |
| `result` | `value: unknown` | Final result (JSON-serialisable) |
| `file` | `handle: FileHandle` | Output file reference |
| `error` | `message: string`, `code?: number`, `stdout?: string`, `stderr?: string` | Expected tool error |

Throw only for unexpected failures; yield `{ type: 'error' }` for expected ones.

### `ToolContext`

```ts
interface ToolContext {
  callId:      string;
  session:     Session;
  principal:   Principal;
  signal:      AbortSignal;
  workdir?:    string;
  configPath?: string;
  files?:      FileStore;
  prompt(question: string, defaultValue?: string): Promise<string>;
  loadPlugin(specifier: string):   Promise<void>;
  unloadPlugin(specifier: string): Promise<void>;
}
```

`ctx.signal` is aborted on Ctrl+C or session cancellation — propagate it to
sub-processes, fetch calls, and timers. `ctx.prompt()` asks the user a question via the
host's readline/form system; use sparingly, only for irreversible actions.

### Capability requirements

| Capability | Meaning |
|---|---|
| `network` | Makes outbound HTTP requests |
| `filesystem` | Reads or writes local files |
| `spawn` | Forks child processes |
| `container` | Runs containers |
| `audit:read` | Reads audit logs |

---

## Writing a provider plugin

```ts
import type { MatbotPlugin, ProviderAdapter, CompletionEvent } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

const myAdapter: ProviderAdapter = {
  name: 'my-provider',
  async *complete(messages, config, tools, signal): AsyncIterable<CompletionEvent> {
    yield { type: 'text-delta', delta: 'Hello' };
    yield { type: 'usage', inputTokens: 10, outputTokens: 1 };
    yield { type: 'done' };
  },
  async health() { return { status: 'ok', latencyMs: 42 }; },
};

export const plugin: MatbotPlugin = {
  name:      '@matatbread/matbot-provider-my-provider',
  apiVersion: PLUGIN_API_VERSION,
  providers: { 'my-provider': (_config) => myAdapter },
};
```

### `CompletionEvent` variants

| Event | Key fields |
|---|---|
| `text-delta` | `delta: string` |
| `tool-call` | `id, name, input` |
| `tool-result` | `id, result` |
| `thinking` | `delta: string` |
| `thinking-block` | `thinking, signature` |
| `reasoning-block` | `reasoning: string` |
| `usage` | `inputTokens, outputTokens, costUsd?, cacheReadTokens?, cacheCreationTokens?` |
| `done` | — |

---

## Writing a storage backend plugin

```ts
import type { MatbotPlugin, StorageBackend, Store, FileStore } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

class MyBackend implements StorageBackend {
  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> { /* … */ }
  get fileStore(): FileStore { /* … */ }
  async close(): Promise<void> { /* … */ }
  static async open(dotData: string): Promise<MyBackend> { return new MyBackend(); }
}

export const plugin: MatbotPlugin = {
  name:           '@matatbread/matbot-storage-my-backend',
  apiVersion:     PLUGIN_API_VERSION,
  storageBackend: { open: (dotData) => MyBackend.open(dotData) },
  async setup(services) {
    if (services.storageBackend instanceof MyBackend) return;
    if (!services.configPath) return;
    const { join, dirname } = await import('node:path');
    const dotData = join(dirname(services.configPath), '.data');
    await services.register('storageBackend', await MyBackend.open(dotData));
  },
};
```

When listed in `matbot.yaml`, `open()` is called before any `setup()` runs. When
hot-loaded at runtime, `setup()` calls `register('storageBackend', backend)`, which
transparently re-targets all existing `Store` and `FileStore` proxy references.

### `Store<T>` interface

```ts
interface Store<T extends { id: string; version: string }> {
  get(id: string): Promise<T | null>;
  set(id: string, value: T): Promise<void>;
  cas(id: string, expected: string, next: T): Promise<CASResult<T>>;
  delete(id: string, expectedVersion?: string): Promise<boolean>;
  query(q: StoreQuery<T>): Promise<QueryResult<T>>;
}
```

`StoreQuery` supports filters, full-text search, vector search, sorting, pagination, and
field projection. See `FilterExpr`, `SortSpec`, and `VectorQuery` in the API types.

---

## Writing a frontend plugin

A frontend owns its own I/O — HTTP server, bot connection, REPL — and declares itself
by calling `services.registerFrontend({ name: '…' })` in `setup()`. It drives the
runtime itself: reading and writing sessions through `services.sessions` and running
turns through the runner.

```ts
export const plugin: MatbotPlugin = {
  name:       'frontend-example',
  apiVersion: PLUGIN_API_VERSION,
  async setup(services: MatbotServices) {
    services.registerFrontend({ name: 'frontend-example' });
    // start your own I/O loop: HTTP server, bot client, readline, …
  },
};
```

Multiple frontends may run simultaneously. A frontend is auto-unregistered when its
plugin unloads.

---

## Pipeline hooks

Hooks intercept the turn pipeline. A handler that returns nothing is a pure observer.
`priority` orders within a channel (lower first, default 50).

```ts
type Hook =
  | { on: 'screen';     priority?: number; handler(ctx: ScreenContext):     ScreenResult | void | Promise<…> }
  | { on: 'contribute'; priority?: number; handler(ctx: ContributeContext): Message[] | void | Promise<…> }
  | { on: 'toolcall';   priority?: number; handler(ctx: ToolCallContext):   ToolCallResult | void | Promise<…> }
  | { on: 'toolresult'; priority?: number; handler(ctx: ToolResultContext): { result: unknown } | void | Promise<…> }
  | { on: 'followup';   priority?: number; handler(ctx: FollowupContext):   FollowupResult | void | Promise<…> };
```

| Hook | When it fires | What it can do |
|---|---|---|
| `screen` | Once per turn, before the first provider call | Mutate the session durably, inject ephemeral context, abort the turn |
| `contribute` | Before every provider call | Transform the outgoing messages (ephemeral, never persisted) |
| `toolcall` | Before each tool runs | Reject or abort the tool call |
| `toolresult` | After each tool runs | Redact or transform the result; observe for audit |
| `followup` | After the turn commits | Resubmit a robo turn (head-enqueued, runs next) |

Example — redact secrets from tool results:

```ts
services.hooks.register({
  on: 'toolresult',
  handler(ctx) {
    const redacted = scrubKeys(ctx.result);
    return redacted !== ctx.result ? { result: redacted } : undefined;
  },
});
```

**Authorship vs role.** A `followup` resubmission is machine-authored but carried as
`role: 'user'` so the model responds to it. The per-block `origin?: 'robo'` on
`MessageContent` records authorship for *presentation only* — it is never sent to the
model.

---

## Markers

A marker is an opaque annotation attached to a session — a cross-reference, a status, a
link — that a frontend can render but the LLM never sees. Markers are persisted with the
session, elided from provider submission, and preserved by compaction.

```ts
declare module '@matatbread/matbot-plugin-api' {
  interface MarkerData {
    'my-plugin': { peerSessionId: string; relation: 'parent' | 'fork' };
  }
}

function markerMessage(data: MarkerData['my-plugin']): Message {
  const marker: Marker<'my-plugin'> = { type: 'marker', creator: 'my-plugin', data };
  return {
    id:        crypto.randomUUID(),
    role:      'marker',
    content:   [marker],
    createdAt: new Date().toISOString(),
    traceId:   crypto.randomUUID(),
  };
}
```

---

## Knowledge index

The knowledge index is always present at `services.knowledge`. The default is
`LookupKnowledgeIndex`, an in-memory implementation that scores by term-occurrence
frequency. Replace it at any time with `services.register('knowledge', impl)`.

```ts
interface KnowledgeIndex {
  index(entry: KnowledgeEntry): Promise<void>;
  search(terms: Array<{ term: string; context?: string }>, signal: AbortSignal): Promise<KnowledgeEntry[]>;
  entries?(): Iterable<KnowledgeEntry>;
}
```

The `@matatbread/matbot-rumsfeld` plugin registers a `contextual_search` tool that
queries the knowledge index when the model encounters an unknown term.
`@matatbread/matbot-persist-ki-bge` replaces the default with a persistent,
Store-backed index with optional Cloudflare BGE reranker.

---

## First-party plugins reference

| Package | Tools / Kind | Description |
|---|---|---|
| `@matatbread/matbot-tool-plugin` | `plugin` · always loaded | Manage plugins: list, add, remove, discover |
| *(built-in)* | `provider` · always loaded | Manage LLM provider profiles |
| `@matatbread/matbot-tool-bash` | `bash` | Run bash scripts; stream stdout/stderr |
| `@matatbread/matbot-tool-docker-bash` | `bash` (sandboxed) | Drop-in for bash; runs inside Docker |
| `@matatbread/matbot-tool-http` | `http` | Make HTTP requests |
| `@matatbread/matbot-tool-workspace` | `workspace_action` | Read/write/list/delete workspace files |
| `@matatbread/matbot-tool-background` | `background`, `every_action` | Detached background jobs and recurring schedules |
| `@matatbread/matbot-tool-mcp` | `mcp_action` | Connect to stdio MCP servers (Node only) |
| `@matatbread/matbot-mcp-http` | `mcp_action` | Connect to HTTP/SSE MCP servers (Node + browser) |
| `@matatbread/matbot-sessions` | `session_action` | Session lifecycle: list, get, rename, hide |
| `@matatbread/matbot-edit-session` | `session_edit` | Trim, branch, split, and compact sessions |
| `@matatbread/matbot-skills` | `skill_action`, `skill_triggers` | Cross-runtime skill CRUD |
| `@matatbread/matbot-skills-node` | `skill_action` + file watch | Node skills: adds local `.md` import/watch |
| `@matatbread/matbot-rumsfeld` | `contextual_search` | Resolves unknown terms via the knowledge index |
| `@matatbread/matbot-persist-ki-bge` | knowledge backend | Persistent KnowledgeIndex with optional BGE reranker |
| `@matatbread/matbot-cognition` | skills | Inner Voice, Remember This, Dream Time |
| `@matatbread/matbot-hook-logger` | diagnostic hooks | Logs each hook channel firing |
| `@matatbread/matbot-frontend-web` | frontend | Web UI with session management |
| `@matatbread/matbot-frontend-telegram` | frontend + tools | Telegram bot |
| `@matatbread/matbot-provider-anthropic` | provider | Anthropic Messages API (+ DeepSeek compat) |
| `@matatbread/matbot-provider-openai-compat` | provider | OpenAI-compatible chat completions |
| `@matatbread/matbot-provider-customer-services` | provider | Free built-in demo LLM — no API key needed |
| `@matatbread/matbot-storage-sqlite` | storage backend | SQLite-backed Store + FileStore |
| `@matatbread/matbot-tool-store` | `store_action` | Define and expose named persistent stores |
| `@matatbread/matbot-tool-whoami` | `whoami` | Reports the current Principal |

---

## The browser bundle

The browser build is a single self-contained `matbot.html` — the same platform-neutral
core and browser-safe plugins, type-stripped and wired together in-page. No server, no
build step, no backend required. This section covers the architecture; for usage see
the [README](../README.md).

### One UI, two transports

The same `app.js` + `index.html` client runs unchanged whether served from Node over
HTTP+SSE or running entirely in-browser in-process. The only difference is the object
behind `window.matbotTransport`:

| Transport | Where | How |
|---|---|---|
| `http-transport.js` | Node-served | `fetch` + SSE to `server.ts` |
| `browser.js` | Baked into the bundle | Drives `services.run` / `services.tools` in-process — no wire |

`frontend/web` is one package with a `browser` export condition:

```jsonc
"exports": { ".": { "browser": "./src/browser.js", "import": "./src/index.ts" } }
```

Node resolves to `index.ts` (the HTTP server); the assembler prefers `browser.js` (the
in-process mount). One package, two runtimes, no duplicated UI.

### Two bundles

| Output | Frontend | Purpose |
|---|---|---|
| `dist/matbot.html` | `frontend/web` (browser entry) | Full-featured UI — sessions, files, plugin manager |
| `dist/matbot-demo.html` | `frontend/dom` | Minimal ~450-line demonstrator |

```sh
pnpm web-build    # builds both
```

### The plugin model

The browser has no `matbot.yaml`. Its `matbot.web.json` is the analogue. Plugins fall
into three layers:

1. **Auto-load (`plugins[]`)** — loaded at boot. Kept minimal: just `browser` (IndexedDB/OPFS
   storage + the `plugin` tool) and `frontend/web` (the UI).

2. **Baked-but-idle (`bundledPlugins[]`)** — bundled into the artifact but not auto-loaded.
   These are the browser analogue of Node's on-disk `packages/plugins`. `discover_local`
   lists them; enabling one is a single `plugin add`. Persisted by package name — resolves
   through the import map on every reload without network access.

3. **Remote (a URL)** — `plugin add https://…` fetches raw `.ts`, type-strips it in-page
   (sucrase from CDN), and loads it. Requires HTTP (not `file://`).

### How it's assembled

`assemble.mjs` walks the static import graph from `bootstrap.ts` + configured plugins,
type-strips each `.ts` with sucrase, and inlines the resulting JS modules + a loader into
one HTML file. It prefers each package's `browser` export condition, bakes
`bundledPlugins` as graph roots (without auto-loading them), and adds their package names
to the import map. The loader runs first in the browser: it rewrites relative imports to
`mbmod:` ids, blob-ifies each module, and publishes one import map. Everything is
in-memory — no service worker, no `fetch` at boot, no in-page stripping for the baseline.

### Browser caveats

- **CORS** — the browser calls the LLM endpoint directly. Pick a provider that allows
  browser-origin requests (DeepSeek, Azure, a local/proxied endpoint), or front it with
  a CORS-enabled gateway.
- **`file://`** — IndexedDB works; OPFS (workspace files) and runtime remote plugin
  loading require HTTP.
- **Secrets** — stored in browser storage (WebCrypto vault). Single-user local use only.
- **Interactive `plugin add`** — requires a human click; cannot be driven
  non-interactively.
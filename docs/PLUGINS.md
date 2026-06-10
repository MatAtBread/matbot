# matbot Plugin System

Plugins are the extension point for everything beyond the built-in `plugin` management
tool. They register tools, LLM providers, storage backends, frontends, and hooks, and
can call LLMs programmatically, persist scoped settings, and access shared services.

I recommend checking the [design ethos and developer notes](../CLAUDE.md) before writing plugins.

---

## The contract

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
preferred.

---

## Loading plugins

> Note: for security, plugins won't install unless you specifically agree via the current UI. This prevents people remotely adding plugins to your bot without your agreement.

### Via the LLM chatbot

```
Add the local plugin called background
```
```
Add the plugin from npm called @somecooldude/superbot
```
```
Add the plugin from the github repo SomeCoolDude/MyLatestMatbotPlugin
```

### Via `matbot.yaml`

```yaml
plugins:
  - @matatbread/matbot-tool-bash          # npm package (must be installed)
  - ./my-plugin                           # local package directory
  - ./my-plugin/src/index.ts              # explicit entry point
```

Plugins are imported in parallel and registered in order. A failed import logs a warning
and is skipped; it does not abort startup.

### Via the `plugin` tool at runtime

The built-in `plugin` tool lets the model manage plugins without editing the config:

```
plugin({ action: 'list' })
plugin({ action: 'add',    specifier: '@matatbread/matbot-tool-bash' })
plugin({ action: 'remove', specifier: '@matatbread/matbot-tool-bash' })
```

Plugins are hot-loaded immediately after install — no restart needed.

---

## `MatbotPlugin` fields

| Field            | Type                                           | Purpose |
|------------------|------------------------------------------------|---------|
| `name`           | `string`                                       | Unique identifier |
| `apiVersion`     | `string`                                       | Must equal `PLUGIN_API_VERSION` |
| `manifest`       | `PluginManifest`                               | Human-readable metadata, required env vars |
| `tools`          | `readonly Tool[]`                              | Tool implementations to register |
| `providers`      | `Record<string, ProviderAdapterFactory>`       | LLM adapter factories keyed by `type` string |
| `storageBackend` | `{ open(dotData: string): Promise<StorageBackend> }` | Storage backend (see below) |
| `setup`          | `(services: MatbotServices) => Promise<void>`  | Called once after all plugins are registered |
| `teardown`       | `() => Promise<void>`                          | Called on graceful shutdown |

### `PluginManifest`

```ts
interface PluginManifest {
  description?: string;            // shown by `plugin list`
  credentials?: readonly string[]; // env var names this plugin needs
  config?: readonly string[];      // keys under extensions.<pluginName>
}
```

---

## Services available in `setup()`

`MatbotServices` is the runtime environment handed to every plugin:

```ts
interface MatbotServices {
  /** Call an LLM directly (see sub-runner section below). */
  complete(req: CompletionRequest): Promise<CompletionResponse>;

  /** Scoped key-value settings store isolated per plugin name. */
  settings(pluginName: string): PluginSettings;

  /** Create (or retrieve a cached) typed document store for a namespace. */
  createStore<T extends { id: string; version: string }>(namespace: string): Store<T>;

  /** Hot-load a plugin by specifier. */
  loadPlugin(specifier: string): Promise<void>;

  /** Hot-unload a plugin, removing its tools, hooks, and system context contributions. */
  unloadPlugin(specifier: string): Promise<void>;

  /**
   * Register a service under a MatbotServices key.
   * Well-known keys: 'storageBackend' (re-wires all Store proxies), 'knowledge' (drains entries).
   * All other keys are stored in a per-plugin registry, retrievable via get().
   */
  register<K extends keyof MatbotServices>(key: K, value: NonNullable<MatbotServices[K]>): Promise<void>;

  /** Look up a service previously registered under a MatbotServices key. */
  get<K extends keyof MatbotServices>(key: K): MatbotServices[K] | undefined;

  /** @internal Remove a service entry — called by the runtime on plugin unload. */
  unregister(key: string): void;

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

Plugins advertise novel services to each other by augmenting `MatbotServices` in
`@matatbread/matbot-plugin-api`. The key is a property name that must not collide with any
existing property — use a short, unambiguous name unique to your domain.

**Declaring the contract** (in a types package, e.g. `@matatbread/matbot-analytics-types`):

```ts
// analytics-types.ts — augment MatbotServices to declare the property
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    analytics?: AnalyticsService;   // optional: present only when the analytics plugin is loaded
  }
}
```

**Advertising a service** (in the providing plugin's `setup()`):

```ts
await services.register('analytics', new AnalyticsServiceImpl(store));
```

**Consuming a service** (in any plugin's `setup()`):

```ts
const analytics = services.get('analytics'); // AnalyticsService | undefined
if (analytics) { /* use it */ }
```

Both `register` and `get` are typed through `MatbotServices`, so the compiler enforces that
`'analytics'` is a valid key and that the value is an `AnalyticsService`. No separate types
package or import-side-effect trick is needed — the augmentation alone is sufficient.

### Sub-runner: `services.complete()`

Plugins can call LLMs directly — for classification, summarisation, or inner-voice
critique:

```ts
interface CompletionRequest {
  provider:    string;
  messages:    Message[];
  system?:     string;
  parameters?: Partial<ModelParameters>;
  signal?:     AbortSignal;
}

interface CompletionResponse {
  text:  string;
  usage: { inputTokens: number; outputTokens: number };
}
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

---

## Writing a tool

A `Tool` has a name, description, JSON Schema input, optional `requires` capability
list, and an async generator executor:

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

When a plugin would otherwise expose several `noun_verb` tools for one noun (e.g.
`mcp_add` / `mcp_list` / `mcp_remove`), the preferred style is a single `noun_action`
tool with an `action` discriminator. This is a convention, not enforced by the runtime —
separate tools still work, and standalone single-purpose tools (`http`, `bash`, `ask_user`)
stay separate. See **Tool design — multi-action tools** in `CLAUDE.md` for the full rationale.

The shape:

- The **description teaches the domain once** and carries the per-action contract as a
  **TypeScript discriminated union** (LLMs read TS unions more reliably than JSON-Schema `oneOf`).
- `inputSchema` stays **loose**: `required: ['action']` plus the union of every action's optional
  fields.
- The **executor enforces** per-action requirements and errors on a missing field or unknown action.

```ts
const mcpAction: Tool = {
  name: 'mcp_action',
  description: `Manage MCP server connections. … (teach the domain here)

  type McpAction =
    | { action: 'add'; name: string; type: 'local' | 'remote'; … }
    | { action: 'list' }
    | { action: 'remove'; name: string };`,
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['add', 'list', 'remove'] },
      name:   { type: 'string', description: 'add/remove only.' },
      // … union of all optional per-action fields …
    },
  },
  executor: {
    async *execute(input, ctx) {
      const act = input as McpAction;
      switch (act.action) {
        case 'add':    /* validate add fields, then … */ return;
        case 'list':   /* … */ return;
        case 'remove': /* … */ return;
        default: yield { type: 'error', message: `Unknown action "${(act as { action: string }).action}".` };
      }
    },
  },
};
```

### `ToolEvent` variants

| Event      | Fields                                                                      | Meaning |
|------------|-----------------------------------------------------------------------------|---------|
| `stdout`   | `chunk: string`                                                             | Streaming output |
| `stderr`   | `chunk: string`                                                             | Streaming error output |
| `progress` | `pct: number`, `message?: string`                                           | Progress (0–100) |
| `result`   | `value: unknown`                                                            | Final result (JSON-serialisable) |
| `file`     | `handle: FileHandle`                                                        | Output file reference |
| `error`    | `message: string`, `code?: number`, `stdout?: string`, `stderr?: string`    | Expected tool error |

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
sub-processes, fetch calls, and timers.

`ctx.prompt()` asks the user a question via the host's readline/form system. Use
sparingly — only for irreversible actions.

### Capability requirements

| Capability   | Meaning |
|--------------|---------|
| `network`    | Makes outbound HTTP requests |
| `filesystem` | Reads or writes local files |
| `spawn`      | Forks child processes |
| `container`  | Runs containers |
| `audit:read` | Reads audit logs |

---

## Writing a provider plugin

Provider plugins register LLM adapter factories keyed by `type`:

```ts
import type { MatbotPlugin, ProviderAdapter, ProviderConfig, CompletionEvent } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

const myAdapter: ProviderAdapter = {
  name: 'my-provider',
  async *complete(messages, config, tools, signal): AsyncIterable<CompletionEvent> {
    yield { type: 'text-delta', delta: 'Hello' };
    yield { type: 'usage', inputTokens: 10, outputTokens: 1 };
    yield { type: 'done' };
  },
  async health() {
    return { status: 'ok', latencyMs: 42 };
  },
};

export const plugin: MatbotPlugin = {
  name:       '@matatbread/matbot-provider-my-provider',
  apiVersion: PLUGIN_API_VERSION,
  providers: {
    'my-provider': (_config: ProviderConfig) => myAdapter,
  },
};
```

The `type` field in `matbot.yaml` selects the adapter. The built-in adapters
(`@matatbread/matbot-provider-anthropic`, `@matatbread/matbot-provider-openai-compat`)
are loaded automatically when their `type` is referenced.

### `CompletionEvent` variants

| Event                | Key fields |
|----------------------|------------|
| `text-delta`         | `delta: string` |
| `tool-call`          | `id, name, input` |
| `tool-result`        | `id, result` |
| `thinking`           | `delta: string` |
| `thinking-block`     | `thinking, signature` |
| `redacted-thinking`  | `data: string` |
| `reasoning-block`    | `reasoning: string` |
| `refusal`            | `text: string` |
| `unknown-block`      | `blockType, raw` |
| `usage`              | `inputTokens, outputTokens, costUsd?, cacheReadTokens?, cacheCreationTokens?` |
| `done`               | — |

---

## Writing a storage backend plugin

A storage backend replaces both the document store factory and the file store for the
entire runtime. Implement `StorageBackend` and expose it via `storageBackend.open()`:

```ts
import type { MatbotPlugin, StorageBackend, Store, FileStore } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

class MyBackend implements StorageBackend {
  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    // return a Store<T> backed by your database
  }
  get fileStore(): FileStore {
    // return a FileStore backed by your database
  }
  async close(): Promise<void> { /* flush and disconnect */ }

  static async open(dotData: string): Promise<MyBackend> {
    // dotData is the .data directory path next to matbot.yaml
    return new MyBackend(dotData);
  }
}

export const plugin: MatbotPlugin = {
  name:       '@matatbread/matbot-storage-my-backend',
  apiVersion: PLUGIN_API_VERSION,
  storageBackend: {
    open: (dotData) => MyBackend.open(dotData),
  },
  async setup(services) {
    // If already activated via startup pre-scan, skip.
    if (services.storageBackend instanceof MyBackend) return;
    // Hot-loaded at runtime: activate now.
    if (!services.configPath) return;
    const { join, dirname } = await import('node:path');
    const dotData = join(dirname(services.configPath), '.data');
    await services.register('storageBackend', await MyBackend.open(dotData));
  },
};
```

When the plugin is listed in `matbot.yaml`, `open()` is called before any `setup()`
runs and the backend is used for all stores from startup. When hot-loaded at runtime,
`setup()` calls `register('storageBackend', backend)`, which transparently re-targets all
existing `Store` and `FileStore` proxy references — callers do not need to be updated.

### `Store<T>` interface

All writes use compare-and-swap for safety under concurrent access:

```ts
interface Store<T extends { id: string; version: string }> {
  get(id: string): Promise<T | null>;
  set(id: string, value: T): Promise<void>;
  cas(id: string, expected: string, next: T): Promise<CASResult<T>>;
  delete(id: string, expectedVersion?: string): Promise<boolean>;
  query(q: StoreQuery<T>): Promise<QueryResult<T>>;
}

type CASResult<T> =
  | { ok: true;  doc: T }
  | { ok: false; current: T | null };
```

`StoreQuery` supports filters, full-text search, vector search, sorting, pagination, and
field projection. See `FilterExpr`, `SortSpec`, and `VectorQuery` in the API types for
the full query DSL.

### `FileStore` interface

```ts
interface FileStore {
  /** Upserts by (name + namespace) when name is provided; always creates otherwise. */
  put(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    meta?:    { sessionId?: string; messageId?: string; namespace?: string },
  ): Promise<FileHandle>;
  get(id: string): Promise<FileHandle | null>;
  getByName(name: string, namespace?: string): Promise<FileHandle | null>;
  delete(id: string): Promise<void>;
  list(filter?: FileFilter): AsyncIterable<FileHandle>;
  putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle>;
  watch(signal?: AbortSignal): AsyncIterable<FileEvent>;
}
```

`watch()` emits a `FileEvent` (metadata + `changed` field listing which keys changed)
after each `put`. Implementations that cannot watch their backing store should yield
nothing and return when the signal fires.

---

## Writing a frontend plugin

A frontend owns its own I/O — an HTTP server, a bot connection, a REPL — and declares itself at
runtime by calling `services.registerFrontend({ name: 'my-plugin-name' })` inside `setup()`. There is no adapter interface
for the runtime to drive: matbot only records that the plugin is a frontend (so tools like
`plugin list` can label it). Declaring is an action, symmetric with `services.register()` —
multiple frontends may run at once, and a frontend is auto-unregistered when its plugin unloads.

```ts
interface FrontendInfo {
  name: string;
}

// on MatbotServices:
registerFrontend(info: FrontendInfo): void;
```

A frontend drives the runtime itself: it reads and writes sessions through `services.sessions`
and runs turns through the runner, rendering pipeline events however it likes.

```ts
export const plugin: MatbotPlugin = {
  name:       'frontend-example',
  apiVersion: PLUGIN_API_VERSION,

  async setup(services: MatbotServices) {
    services.registerFrontend({ name: 'frontend-example' });
    // start your own I/O loop here: HTTP server, bot client, readline, …
  },
};
```

---

## Pipeline hooks

Plugins register hooks in `setup()` to intercept the pipeline. Hooks are named by the **job** they
do, not by lifecycle position — `Hook` is a discriminated union on `on`, so each channel's context
and return type expose only the effects it honours (a write that goes nowhere won't type-check). A
handler that returns nothing is a pure observer. `priority?` orders within a channel (lower first,
default 50).

```ts
type Hook =
  // screen — once per turn, before the 1st provider call. The only durable-mutate point.
  | { on: 'screen';     priority?: number; handler(ctx: ScreenContext):     ScreenResult | void | Promise<ScreenResult | void> }
  // contribute — before every provider call. Transform the outgoing array; ephemeral, never persisted.
  | { on: 'contribute'; priority?: number; handler(ctx: ContributeContext): Message[] | void | Promise<Message[] | void> }
  // toolcall — before each tool runs. Reject the call or abort.
  | { on: 'toolcall';   priority?: number; handler(ctx: ToolCallContext):   ToolCallResult | void | Promise<ToolCallResult | void> }
  // toolresult — after each tool runs. Transform the result (redaction) or observe it (audit).
  | { on: 'toolresult'; priority?: number; handler(ctx: ToolResultContext): { result: unknown } | void | Promise<{ result: unknown } | void> }
  // followup — after the turn commits. Resubmit a robo turn (head-enqueued, runs next).
  | { on: 'followup';   priority?: number; handler(ctx: FollowupContext):   FollowupResult | void | Promise<FollowupResult | void> };

interface ScreenResult     { session?: Session; ephemeral?: MessageContent[]; abort?: string }
interface ToolCallResult   { rejectTool?: { message: string }; abort?: string }
interface FollowupResult   { resubmit?: { content: MessageContent[] } }
```

Each context carries `session`, `config`, `signal`, plus channel specifics — `ToolCallContext`/
`ToolResultContext` add `toolCall` + `tool` (and `toolresult` also `result`, `isError`, `durationMs`);
`ContributeContext` adds the read-only `outgoing` array; `FollowupContext` adds `resubmitDepth`. See
`@matatbread/matbot-hook-logger` for one hook on every channel.

Example — redact key-shaped material from every tool result before the model or storage sees it:

```ts
export const plugin: MatbotPlugin = {
  name:       'redactor',
  apiVersion: PLUGIN_API_VERSION,
  async setup(services) {
    services.hooks.register({
      on: 'toolresult',
      handler(ctx) {
        const redacted = scrubKeys(ctx.result);   // your redaction
        return redacted !== ctx.result ? { result: redacted } : undefined;
      },
    });
  },
};
```

**Authorship vs role.** A `followup` resubmission (and a `screen`-injected fragment) is machine-authored
but carried as `role: 'user'` so the model responds to it. The per-block `origin?: 'robo'` on
`MessageContent` records authorship for *presentation only* — it is OOB, never sent to the model.
Frontends present by author (robo content renders agent-side, 🤖); the LLM operates by role.

---

## Markers

A marker is an opaque annotation a plugin attaches to a session — a cross-reference, a status, a
link — that a frontend can render but the LLM never sees. Markers are persisted with the session,
elided from provider submission, and preserved by compaction (they survive
`session_edit`'s compact). Any plugin with session access can create one.

A marker is a `MessageContent` block, usually emitted as its own message with the `marker` role:

```ts
import type { Marker, Message } from '@matatbread/matbot-plugin-api';

// Make the payload type-safe by augmenting the shared MarkerData registry, keyed by your plugin's
// reference. Readers that narrow on `creator` then get a typed `data`.
declare module '@matatbread/matbot-plugin-api' {
  interface MarkerData {
    'my-plugin': { peerSessionId: string; relation: 'parent' | 'fork' };
  }
}

function markerMessage(data: MarkerData['my-plugin']): Message {
  const marker: Marker<'my-plugin'> = { type: 'marker', creator: 'my-plugin', data };
  return {
    id:        crypto.randomUUID(),
    role:      'marker',          // skipped by every provider adapter
    content:   [marker],
    createdAt: new Date().toISOString(),
    traceId:   crypto.randomUUID(),
  };
}
```

Append the message to a session and persist it through `services.sessions` like any other edit.
The base `marker` content type stays loose (`creator: string; data: unknown`), so unregistered
creators still work — augmenting `MarkerData` only adds compile-time safety for your own.
Interpreting and rendering markers is entirely up to the creating plugin and the frontend; the
runtime treats them as inert.

---

## Knowledge index

The knowledge index is a **core** service — always present at `services.knowledge`. By
default it uses `LookupKnowledgeIndex`, an in-memory implementation that scores entries by
term-occurrence frequency. Plugins can replace it with a richer backend at any time by
calling `services.register('knowledge', impl)`.

```ts
interface KnowledgeIndex {
  /** Add or update an entry. */
  index(entry: KnowledgeEntry): Promise<void>;

  /** Find the most relevant entries for a list of query terms. */
  search(
    terms:  Array<{ term: string; context?: string }>,
    signal: AbortSignal,
  ): Promise<KnowledgeEntry[]>;

  /** Iterate all indexed entries (optional — used by loaders). */
  entries?(): Iterable<KnowledgeEntry>;
}

interface KnowledgeEntry {
  id:       string;
  version:  string;
  entities: string[];   // canonical names / aliases for this entry
  content:  string;     // the knowledge text shown to the model
}
```

### Rumsfeld: contextual knowledge fault handling

The `@matatbread/matbot-rumsfeld` plugin registers a `contextual_search` tool. When
the model encounters an unknown term it calls this tool, which queries `services.knowledge`
and returns the best-matching entry. This lets the model resolve domain-specific references
(personal nouns, proprietary systems, user preferences) without hallucinating.

### Persistent BGE knowledge index

`@matatbread/matbot-persist-ki-bge` replaces the default in-memory index with one
backed by a `Store<KnowledgeEntry>`, with entity/heading search and an optional Cloudflare
BGE reranker for semantic scoring. Credentials: `SKILL_RANK_API_KEY`,
`CLOUDFLARE_ACCOUNT_ID`.

### Custom knowledge backend

Implement `KnowledgeIndex` and call `services.register('knowledge', impl)` in your
plugin's `setup()`. The replacement takes effect immediately for all subsequent
`contextual_search` calls.

---

## First-party plugins

| Package | Tools / Kind | Description |
|---------|--------------|-------------|
| `@matatbread/matbot-tool-plugin` | `plugin` · **always loaded** | Manage plugins: list, add, remove, discover |
| *(built-in)* | `provider` · **always loaded** | Manage LLM provider profiles: list, add, remove |
| `@matatbread/matbot-tool-bash` | `bash` | Run bash scripts; stream stdout/stderr |
| `@matatbread/matbot-tool-docker-bash` | `bash` (sandboxed) | Drop-in for bash; runs scripts inside Docker |
| `@matatbread/matbot-tool-http` | `http` | Make HTTP requests |
| `@matatbread/matbot-tool-workspace` | `workspace_action` | Read/write/list/delete files in the workspace namespace (one tool, `action` parameter) |
| `@matatbread/matbot-tool-background` | `background`, `every_action` | Run prompts in detached processes once or on a recurring interval; manage schedules (list/suspend/resume/cancel via `action`, `id: "*"` = all for suspend/resume) |
| `@matatbread/matbot-tool-mcp` | `mcp_action` | Connect to Model Context Protocol servers (add/list/remove via `action`) |
| `@matatbread/matbot-sessions` | `session_action` | Session lifecycle (list/get/rename/hide via `action` parameter) |
| `@matatbread/matbot-edit-session` | `session_edit` | Trim, branch, split, and compact sessions to manage context window (cut/fork/split/compact via `action`) |
| `@matatbread/matbot-skills-node` | `skill_action` + file watch | Node skills: embeds the cross-runtime skill CRUD, adds local `.md` import/watch |
| `@matatbread/matbot-rumsfeld` | `contextual_search` | Contextual knowledge fault handler — resolves unknown terms via the knowledge index |
| `@matatbread/matbot-persist-ki-bge` | knowledge backend | Persistent KnowledgeIndex with entity search and optional BGE reranker |
| `@matatbread/matbot-hook-logger` | diagnostic (all hook channels) | Logs each hook firing; demos durable injection (`screen`), redaction/audit (`toolresult`), resubmit (`followup`) |
| `@matatbread/matbot-frontend-web` | frontend | Web UI with session management |
| `@matatbread/matbot-frontend-telegram` | frontend + tools | Telegram bot with `telegram_send`, `telegram_open_door`, `telegram_provider` (get/set) tools |
| `@matatbread/matbot-provider-anthropic` | provider | Anthropic Messages API (also DeepSeek Anthropic-compat) |
| `@matatbread/matbot-provider-openai-compat` | provider | OpenAI-compatible chat completions |
| `@matatbread/matbot-storage-sqlite` | storage backend | SQLite-backed Store + FileStore |
| `@matatbread/matbot-tool-whoami` | `whoami` · *test/example* | Reports the current `Principal` (`{ id, type }`) via `currentPrincipal()`. A minimal demo of ambient-principal access — little real purpose beyond confirming who a turn is running as. |
| `@matatbread/matbot-web-principal-user` | service override · *test/example* | Registers a `WebPrincipalResolver` deriving the web request principal from `$USER`. Demonstrates overriding the default web identity; not useful in itself, but the natural skeleton for a *proper* auth/identity plugin (swap `$USER` for header/cookie/token derivation). |

Provider plugins are loaded automatically when their `module` is referenced in a provider
config entry — they don't need an explicit `plugins:` entry.

---

## Package layout for a plugin

```
my-plugin/
  package.json       # "type": "module", exports "." → "./src/index.ts"
  tsconfig.json      # extends tsconfig.base.json; add "types": ["node"] only if needed
  src/
    index.ts         # export const plugin: MatbotPlugin
```

Keep `@matatbread/matbot-plugin-api` in `dependencies` (not `devDependencies`).

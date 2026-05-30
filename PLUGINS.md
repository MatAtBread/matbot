# matbot Plugin System

Plugins are the extension point for everything beyond the built-in `plugin` management
tool. They register tools, LLM providers, storage backends, frontends, and hooks, and
can call LLMs programmatically, persist scoped settings, and access shared services.

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
| `frontend`       | `FrontendFactory`                              | Frontend adapter factory |
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

  /** Look up a service registered by another plugin. */
  get<K extends keyof ServiceMap>(key: K): ServiceMap[K] | undefined;

  /** Advertise a service implementation to other plugins. */
  register<K extends keyof ServiceMap>(key: K, service: ServiceMap[K]): void;

  /** Replace the active storage backend at runtime. All Store and FileStore references
   *  captured before the call remain valid — they are forwarding proxies. */
  replaceStorageBackend?(next: StorageBackend): Promise<void>;

  readonly providers:        ReadonlyMap<string, ProviderConfig>;
  readonly storageBackend?:  StorageBackend | undefined;
  readonly sessions?:        Store<Session>;
  readonly files?:           FileStore;
  readonly vault:            Vault;
  readonly hooks:            HookRegistry;
  readonly tools:            ToolRegistry;
  readonly systemContext:    SystemContextRegistry;
  readonly workdir?:         string;
  readonly configPath?:      string;
}
```

### Plugin-to-plugin services: `ServiceMap`

Optional services use an open registry keyed by the npm package name of the interface
package. This keeps core minimal and allows any plugin to advertise novel services without
modifying the harness.

**Advertising a service** (in the providing plugin's `setup()`):

```ts
import type { MemoryManager } from '@matatbread/matbot-memory-types';
// importing the types package also loads the ServiceMap augmentation

services.register('@matatbread/matbot-memory-types', new MemoryManagerImpl(store));
```

**Consuming a service** (in any plugin's `setup()`):

```ts
import type { MemoryManager } from '@matatbread/matbot-memory-types';

const memory = services.get('@matatbread/matbot-memory-types'); // MemoryManager | undefined
```

Type safety comes from module augmentation in the types package:

```ts
// In @matatbread/matbot-memory-types:
declare module '@matatbread/matbot-plugin-api' {
  interface ServiceMap {
    '@matatbread/matbot-memory-types': MemoryManager;
  }
}
```

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
    if (!services.replaceStorageBackend || !services.configPath) return;
    const { join, dirname } = await import('node:path');
    const dotData = join(dirname(services.configPath), '.data');
    await services.replaceStorageBackend(await MyBackend.open(dotData));
  },
};
```

When the plugin is listed in `matbot.yaml`, `open()` is called before any `setup()`
runs and the backend is used for all stores from startup. When hot-loaded at runtime,
`setup()` calls `replaceStorageBackend()`, which transparently re-targets all existing
`Store` and `FileStore` proxy references — callers do not need to be updated.

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

Frontends consume `InboundMessage`s and emit `OutboundMessage`s:

```ts
type FrontendFactory = (services: MatbotServices) => FrontendAdapter;

interface FrontendAdapter {
  readonly name: string;
  subscribe:     MessageKind[];
  files?: {
    accept?:   MimeType[];
    produce?:  MimeType[];
    maxBytes?: number;
  };
  receive(): AsyncIterable<InboundMessage>;
  send(message: OutboundMessage): Promise<void>;
  health(): Promise<HealthStatus>;
}

type MessageKind =
  | 'thinking' | 'tool-call' | 'tool-result'
  | 'tool-stdout' | 'tool-stderr' | 'file'
  | 'usage' | 'error' | 'form';
```

---

## Pipeline hooks

Plugins register hooks in `setup()` to intercept the processing pipeline:

```ts
type HookPoint =
  | 'before:submit'    // can mutate session or abort
  | 'after:submit'     // observe final session; trigger memory extraction
  | 'before:response'  // runs between tool results and next LLM call
  | 'after:response'   // (reserved)
  | 'before:tool'      // capability check, rate limiting
  | 'after:tool';      // audit logging

interface Hook {
  point:     HookPoint;
  priority?: number;        // lower runs first (default 50)
  handler(ctx: HookContext): Promise<HookContext | void>;
}

interface HookContext {
  session:   Session;
  principal: Principal;
  config:    RunConfig;
  signal:    AbortSignal;
  abort?:    string;           // set to cancel the turn
  inject?:   MessageContent[]; // emit as a synthetic user message
  [key: string]: unknown;
}
```

Example — audit logging after every tool call:

```ts
export const plugin: MatbotPlugin = {
  name:       'audit',
  apiVersion: PLUGIN_API_VERSION,
  async setup(services) {
    services.hooks.register({
      point:   'after:tool',
      handler: async (ctx) => {
        console.warn('[audit]', ctx.session.id);
        return ctx;
      },
    });
  },
};
```

---

## Memory manager

Memory is a plugin-provided service, not a core concern. The interface lives in
`@matatbread/matbot-memory-types`; the implementation in `@matatbread/matbot-memory-node`.

The LLM does **not** have direct memory tools — memory is managed entirely by plugins
via hooks and the service registry.

```ts
interface MemoryManager {
  recall(query: RecallQuery): Promise<MemoryEntry[]>;
  remember(entry: Omit<MemoryEntry, 'id' | 'version' | 'createdAt'>): Promise<MemoryEntry>;
  reinforce(id: string, delta?: number): Promise<void>;
  forget(id: string): Promise<void>;
  purge(ownerPrincipalId: string): Promise<number>;
  buildContext(session: Session, signal: AbortSignal): Promise<ContextBlock[]>;
}
```

The implementation depends only on `Store<MemoryEntry>`, so the storage backend is
independently swappable.

---

## First-party plugins

| Package | Tools / Kind | Description |
|---------|--------------|-------------|
| `@matatbread/matbot-tool-plugin` | `plugin` · **always loaded** | Manage plugins: list, add, remove |
| `@matatbread/matbot-tool-bash` | `bash` | Run bash scripts; stream stdout/stderr |
| `@matatbread/matbot-tool-docker-bash` | `bash` (sandboxed) | Drop-in for bash; runs scripts inside Docker |
| `@matatbread/matbot-tool-http` | `http` | Make HTTP requests |
| `@matatbread/matbot-tool-workspace` | `workspace_read/write/list/delete` | Read and write files in the workspace namespace |
| `@matatbread/matbot-tool-background` | `background`, `every`, `every_list`, `every_cancel` | Run prompts in detached processes; recurring schedules |
| `@matatbread/matbot-tool-mcp` | MCP client | Connect to Model Context Protocol servers |
| `@matatbread/matbot-sessions` | `session_list/get/rename/hide` | Session management tools |
| `@matatbread/matbot-skills-node` | hooks + classifier | File-backed skill injection |
| `@matatbread/matbot-frontend-web` | frontend + hooks | Web UI with session management |
| `@matatbread/matbot-provider-anthropic` | provider | Anthropic Messages API (also DeepSeek compat) |
| `@matatbread/matbot-provider-openai-compat` | provider | OpenAI-compatible chat completions |
| `@matatbread/matbot-storage-sqlite` | storage backend | SQLite-backed Store + FileStore |

Provider plugins are loaded automatically when their `type` is referenced in a provider
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

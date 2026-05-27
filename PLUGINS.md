# matbot Plugin System

Plugins are the extension point for everything beyond the built-in `plugin` management
tool. They can register tools, LLM providers, storage backends, frontends, and skills —
and can run async setup/teardown logic, register pipeline hooks, call LLMs
sub-programmatically, and persist scoped settings.

---

## The contract

Every plugin module must export a named `plugin` constant satisfying `MatbotPlugin`
(from `@matbot/plugin-api`):

```ts
import type { MatbotPlugin } from '@matbot/plugin-api';
import { PLUGIN_API_VERSION } from '@matbot/plugin-api';

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

### Via `matbot.yaml`

```yaml
plugins:
  - @matbot/tool-bash          # npm package (must be installed)
  - ./my-plugin/src/index.ts   # local file path
```

Plugins are imported in parallel and registered in order. A failed import logs a warning
and is skipped; it does not abort startup.

### Via the `plugin` tool at runtime

The built-in `plugin` tool lets the model manage plugins without editing the config:

```
plugin({ action: 'list' })
plugin({ action: 'add', specifier: '@matbot/tool-bash' })
plugin({ action: 'remove', specifier: '@matbot/tool-bash' })
```

Plugins are hot-loaded immediately after install — no restart needed.

---

## `MatbotPlugin` fields

| Field        | Type                                           | Purpose |
|--------------|------------------------------------------------|---------|
| `name`       | `string`                                       | Unique identifier |
| `apiVersion` | `string`                                       | Must equal `PLUGIN_API_VERSION` from `@matbot/plugin-api` |
| `manifest`   | `PluginManifest`                               | Human-readable metadata, required env vars, config keys |
| `tools`      | `readonly Tool[]`                              | Tool implementations to register |
| `providers`  | `Record<string, ProviderAdapterFactory>`       | LLM adapter factories keyed by `type` string |
| `storage`    | `Record<string, StoreFactory>`                 | Storage backend factories |
| `frontend`   | `FrontendFactory`                              | Frontend adapter factory (web UI, terminal, etc.) |
| `setup`      | `(services: MatbotServices) => Promise<void>`  | Called once after all plugins are registered |
| `teardown`   | `() => Promise<void>`                          | Called on graceful shutdown |

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

`MatbotServices` is the runtime environment handed to every plugin on startup:

```ts
interface MatbotServices {
  complete(req: CompletionRequest): Promise<CompletionResponse>;

  /** Scoped key-value store isolated per plugin name. */
  settings(pluginName: string): PluginSettings;

  /** Hot-load another plugin by specifier. */
  loadPlugin(specifier: string): Promise<void>;

  readonly providers:   ReadonlyMap<string, ProviderConfig>;
  readonly stores?:     { readonly sessions?: Store<Session> };
  readonly extensions?: Record<string, unknown>;
  readonly memory?:     MemoryManager;
  readonly files?:      FileStore;
  readonly vault:       Vault;
  readonly hooks:       HookRegistry;
  readonly tools:       ToolRegistry;
  readonly workdir?:    string;
}
```

### Sub-runner: `services.complete()`

Plugins can call LLMs themselves — for classification, summarisation, or inner-voice
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

Keys are scoped per plugin — two plugins can use the same key without collision. Use
this for persisting runtime state (e.g. cache of previously seen items, rate-limit
counters) without requiring a full storage backend.

### Hot-loading: `services.loadPlugin()`

Dynamically imports and registers another plugin at runtime, updating `matbot.yaml`.
Available both in `setup()` and on `ToolContext`.

---

## Writing a tool

A `Tool` has a name, description, JSON Schema input, optional `requires` capability
list, and an async generator executor:

```ts
import type { Tool, ToolEvent, ToolContext } from '@matbot/plugin-api';

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

| Event      | Fields                                | Meaning |
|------------|---------------------------------------|---------|
| `stdout`   | `chunk: string`                       | Streaming output line |
| `stderr`   | `chunk: string`                       | Streaming error line |
| `progress` | `pct: number`, `message?: string`     | Progress percentage (0–100) |
| `result`   | `value: unknown`                      | Final result (JSON-serialisable) |
| `file`     | `handle: FileHandle`                  | Output file reference |
| `error`    | `message: string`, `code?: number`, `stdout?: string`, `stderr?: string` | Expected tool error |

Throw only for unexpected failures; yield `{ type: 'error' }` for expected ones.

### `ToolContext`

```ts
interface ToolContext {
  callId:    string;
  session:   Session;
  principal: Principal;
  signal:    AbortSignal;
  workdir?:  string;
  prompt(question: string, defaultValue?: string): Promise<string>;
  loadPlugin(specifier: string): Promise<void>;
}
```

`ctx.signal` is aborted on Ctrl+C or session cancellation — always propagate it to
sub-processes, fetch calls, or timers.

`ctx.prompt()` asks the user a question via the host's readline/form system. Use
sparingly — only for irreversible actions.

`ctx.loadPlugin()` hot-loads another plugin from within tool execution.

### Capability requirements

| Capability      | Meaning |
|-----------------|---------|
| `network`       | Makes outbound HTTP requests |
| `filesystem`    | Reads or writes local files |
| `spawn`         | Forks child processes |
| `container`     | Runs containers |
| `memory:read`   | Reads from the memory subsystem |
| `memory:write`  | Writes to the memory subsystem |
| `audit:read`    | Reads audit logs |

---

## Writing a provider plugin

Provider plugins register LLM adapter factories keyed by `type`:

```ts
import type { MatbotPlugin, ProviderAdapter, ProviderConfig, CompletionEvent } from '@matbot/plugin-api';

const myAdapter: ProviderAdapter = {
  name: 'my-provider',
  async *complete(messages, config, tools, signal): AsyncIterable<CompletionEvent> {
    // Make HTTP request to your LLM endpoint, parse SSE, yield events
    yield { type: 'text-delta', delta: 'Hello' };
    yield { type: 'usage', inputTokens: 10, outputTokens: 1 };
    yield { type: 'done' };
  },
  async health() {
    return { status: 'ok', latencyMs: 42 };
  },
};

export const plugin: MatbotPlugin = {
  name:       '@matbot/provider-my-provider',
  apiVersion: PLUGIN_API_VERSION,
  providers: {
    'my-provider': (_config: ProviderConfig) => myAdapter,
  },
};
```

The `type` field in `matbot.yaml` selects the adapter: `type: my-provider` routes to
this factory. The existing adapters (`@matbot/provider-anthropic` and
`@matbot/provider-openai-compat`) are themselves plugins loaded implicitly when their
`type` is referenced.

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

## Writing a storage plugin

Storage plugins provide backends for sessions, memory, or job queues:

```ts
type StorageKind = 'sessions' | 'memory' | 'jobs';

type StoreFactory = (
  kind: StorageKind,
  options: Record<string, unknown>,
) => Store<{ id: string; version: string }>;
```

### `Store<T>` interface

All writes use compare-and-swap for thread safety:

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

interface QueryResult<T> {
  items: Array<{ doc: T; score?: number; explanation?: string }>;
  total: number;
  cursor?: string;
}
```

`StoreQuery` supports filters, full-text search, vector search, sorting, pagination,
and field projection. See `FilterExpr`, `SortSpec`, and `VectorQuery` in the API types
for the full query DSL.

---

## Writing a frontend plugin

Frontends consume `InboundMessage`s and emit `OutboundMessage`s:

```ts
type FrontendFactory = (services: MatbotServices) => FrontendAdapter;

interface FrontendAdapter {
  readonly name: string;
  subscribe:     MessageKind[];   // event types this frontend wants
  files?: {
    accept?:   MimeType[];        // MIME types accepted for upload
    produce?:  MimeType[];        // MIME types this frontend can render
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
  | 'before:submit'   // can mutate session or abort
  | 'after:submit'    // observe final session; trigger memory extraction
  | 'before:response' // runs between tool results and next LLM call
  | 'after:response'  // (reserved)
  | 'before:tool'     // capability check, rate limiting
  | 'after:tool';     // audit logging

interface Hook<C extends HookContext = HookContext> {
  point:     HookPoint;
  priority?: number;        // lower runs first (default 50)
  handler(ctx: C): Promise<C | void>;
}

interface HookContext {
  session:   Session;
  principal: Principal;
  config:    RunConfig;
  signal:    AbortSignal;
  abort?:    string;              // set to cancel the turn
  inject?:   MessageContent[];    // emit as a synthetic user event
  [key: string]: unknown;
}
```

Example — audit logging:

```ts
export const plugin: MatbotPlugin = {
  name:       'audit',
  apiVersion: PLUGIN_API_VERSION,
  async setup(services) {
    services.hooks.register({
      point:   'after:tool',
      handler: async (ctx) => {
        console.log('[audit]', ctx.session.id);
        return ctx;
      },
    });
  },
};
```

---

## File store

Available as `services.files`:

```ts
interface FileStore {
  put(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>,
      meta?: { sessionId?: string; messageId?: string }): Promise<FileHandle>;
  get(id: string): Promise<FileHandle | null>;
  delete(id: string): Promise<void>;
  list(filter?: FileFilter): AsyncIterable<FileHandle>;
  putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle>;
}

interface FileHandle {
  id: string;  version: string;
  name: string;  mimeType: MimeType;  size: number;
  createdAt: ISODate;
  sessionId?: string;  messageId?: string;
  stream(signal?: AbortSignal): AsyncIterable<Uint8Array>;
}
```

---

## Memory manager

Available as `services.memory`. The LLM does **not** have direct memory tools — memory
is a subsystem concern managed by plugins:

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

---

## Session status

```ts
type SessionStatus = 'active' | 'archived' | 'pinned';
```

`pinned` sessions are active sessions that appear first in listings and are excluded
from auto-cleanup.

---

## First-party plugins

| Package | Name | Kind | Description |
|---------|------|------|-------------|
| `@matbot/tool-plugin` | `plugin` | tool | Manage plugins: list, add, remove. **Always loaded.** |
| `@matbot/tool-bash` | `bash` | tool | Run bash scripts, stream stdout/stderr |
| `@matbot/tool-docker-bash` | `docker-bash` | tool | Drop-in replacement for bash that runs scripts inside a Docker container |
| `@matbot/tool-http` | `http` | tool | Make HTTP requests |
| `@matbot/tool-schedule` | `schedule` | tool | Wait a specified duration |
| `@matbot/skills-node` | `skills` | tool+hooks | File-backed skill injection via skill router classifier |
| `@matbot/frontend-web` | `frontend-web` | frontend+hooks | Web UI with session management |
| `@matbot/provider-anthropic` | — | provider | Anthropic Messages API adapter (also used for DeepSeek Anthropic-compat) |
| `@matbot/provider-openai-compat` | — | provider | OpenAI-compatible chat completions adapter |

The provider plugins are loaded automatically when a `type` references them — they don't
need to be listed in `plugins:` unless you want to pin a version.

---

## Package layout for a plugin

```
my-plugin/
  package.json       # "type": "module", exports "." → "./src/index.ts"
  tsconfig.json      # extends tsconfig.base.json; add "types": ["node"] only if needed
  src/
    index.ts         # export const plugin: MatbotPlugin
```

Keep `@matbot/plugin-api` as a `dependencies` entry (not `devDependencies`).

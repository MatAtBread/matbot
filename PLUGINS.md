# matbot Plugin System

Plugins are the extension point for everything beyond the built-in `plugin` management tool.
They can register tools, providers, storage backends, and frontends, and can run async setup
and teardown logic at bot startup and shutdown.

---

## The contract

Every plugin module must export a named `plugin` constant that satisfies `MatbotPlugin`
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

The loader also accepts a default export with a `plugin` key, but the named export is preferred.

---

## Loading plugins

### Via `matbot.yaml`

Add the package name or a file path to the `plugins` list in your config file:

```yaml
plugins:
  - @matbot/tool-bash          # npm package (must be installed)
  - ./my-plugin/src/index.ts   # local file path
```

Plugins are imported in parallel and registered in order. A failed import logs a warning and
is skipped; it does not abort startup.

### Via the `plugin` tool at runtime

The built-in `plugin` tool lets the model manage plugins without editing the config file:

```
# List what's loaded
plugin({ action: 'list' })

# Install and add to matbot.yaml
plugin({ action: 'add', specifier: '@matbot/tool-bash' })

# Or add a local sub-project
plugin({ action: 'add', specifier: './packages/tools/bash' })

# Remove
plugin({ action: 'remove', specifier: '@matbot/tool-bash' })
```

Plugins are hot-loaded immediately after install without restarting the bot.

---

## `MatbotPlugin` fields

| Field        | Type                                           | Required | Purpose                                         |
|--------------|------------------------------------------------|----------|-------------------------------------------------|
| `name`       | `string`                                       | yes      | Unique identifier                               |
| `apiVersion` | `string`                                       | yes      | Must equal `PLUGIN_API_VERSION` from the API package |
| `manifest`   | `PluginManifest`                               | no       | Human-readable metadata, required env vars      |
| `tools`      | `readonly Tool[]`                              | no       | Tool implementations to register                |
| `providers`  | `Record<string, ProviderAdapterFactory>`       | no       | LLM adapter factories keyed by `type` string    |
| `storage`    | `Record<string, StoreFactory>`                 | no       | Storage backend factories                       |
| `frontend`   | `FrontendFactory`                              | no       | Frontend adapter factory (web UI, etc.)         |
| `setup`      | `(services: MatbotServices) => Promise<void>`  | no       | Called once after all plugins are registered    |
| `teardown`   | `() => Promise<void>`                          | no       | Called on graceful shutdown                     |

---

## Writing a tool

A `Tool` has a name, description, JSON Schema for the input, an optional `requires` list of
capability kinds, and an executor:

```ts
import type { Tool, ToolEvent, ToolContext } from '@matbot/plugin-api';

const executor = {
  async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const { query } = input as { query: string };

    // Stream progress to the caller
    yield { type: 'stdout', chunk: `Searching for "${query}"...\n` };

    // Return the final result
    yield { type: 'result', value: { hits: [] } };
  },
};

export const searchTool: Tool = {
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
  executor,
};
```

### `ToolEvent` variants

| Event       | Fields                                               | Meaning                          |
|-------------|------------------------------------------------------|----------------------------------|
| `stdout`    | `chunk: string`                                      | Streaming output line            |
| `stderr`    | `chunk: string`                                      | Streaming error line             |
| `progress`  | `pct: number`, `message?: string`                    | Progress percentage (0–100)      |
| `result`    | `value: unknown`                                     | Final result (JSON-serialisable) |
| `file`      | `handle: FileHandle`                                 | Output file                      |
| `error`     | `message: string`, `code?: number`, ...              | Tool-level error (non-throw)     |

Throw only for unexpected failures; yield `{ type: 'error' }` for expected ones.

### `ToolContext`

```ts
interface ToolContext {
  callId:    string;       // unique per invocation
  session:   Session;      // current session snapshot
  principal: Principal;    // caller identity and capability grants
  signal:    AbortSignal;  // honour this to support cancellation
  workdir?:  string;       // default cwd for file/exec operations
  prompt(question: string, defaultValue?: string): Promise<string>;
}
```

`ctx.signal` is aborted when the user presses Ctrl+C or the session is cancelled. Always
propagate it to any sub-process, fetch call, or timer.

`ctx.prompt()` asks the user a question via the host's readline or form system. Use it
sparingly — only for irreversible or destructive actions.

### Capability requirements

Declare which capabilities your tool needs in `requires`. The runtime checks these against the
caller's grants before invoking the executor:

| Capability      | Meaning                                      |
|-----------------|----------------------------------------------|
| `network`       | Makes outbound HTTP requests                 |
| `filesystem`    | Reads or writes local files                  |
| `spawn`         | Forks child processes                        |
| `container`     | Runs containers                              |
| `memory:read`   | Reads from the memory subsystem              |
| `memory:write`  | Writes to the memory subsystem               |
| `audit:read`    | Reads audit logs                             |

---

## `MatbotServices` — what plugins receive in `setup()`

```ts
interface MatbotServices {
  complete(req: CompletionRequest): Promise<CompletionResponse>;

  readonly providers:   ReadonlyMap<string, ProviderConfig>;
  readonly stores?:     { readonly sessions?: Store<Session> };
  readonly extensions?: Record<string, unknown>;
  readonly memory?:     MemoryManager;
  readonly files?:      FileStore;
  readonly vault:       Vault;
  readonly hooks:       HookRegistry;
  readonly tools:       ToolRegistry;
}
```

Use `setup()` to register hooks, validate config, or start background workers:

```ts
export const plugin: MatbotPlugin = {
  name:       'audit',
  apiVersion: PLUGIN_API_VERSION,

  async setup(services) {
    services.hooks.register({
      point:   'after:tool',
      handler: async (ctx) => {
        console.log('[audit]', ctx.session.id, ctx.config);
        return ctx;
      },
    });
  },
};
```

---

## Built-in plugins (included with every matbot install)

| Package               | Name     | Description                                          |
|-----------------------|----------|------------------------------------------------------|
| `@matbot/tool-plugin` | `plugin` | Manage plugins: list, add, remove. Always loaded.    |

---

## First-party optional plugins

These are in the monorepo under `packages/tools/` and must be added explicitly:

| Package                | Name       | Requires     | Description                                   |
|------------------------|------------|--------------|-----------------------------------------------|
| `@matbot/tool-bash`    | `bash`     | `spawn`      | Run a bash script and stream stdout/stderr. Set `extensions.bash.dockerImage` to run inside a container. |
| `@matbot/tool-http`    | `http`     | `network`    | Make an HTTP request and return the body.     |
| `@matbot/tool-schedule`| `schedule` | —            | Wait a specified number of milliseconds.      |

---

## Package layout for a plugin

```
my-plugin/
  package.json       # "type": "module", exports "." → "./src/index.ts"
  tsconfig.json      # extends tsconfig.base.json; add "types": ["node"] only if needed
  src/
    index.ts         # export const plugin: MatbotPlugin
```

Keep `@matbot/plugin-api` as a `dependencies` entry (not `devDependencies`) so the API types
are available at runtime as well as during authorship.

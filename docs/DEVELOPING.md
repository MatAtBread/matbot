# Developing for matbot

This document covers everything you need to write plugins for matbot — tools, providers,
storage backends, frontends, hooks, and the browser bundle. For the design principles and
hard rules behind these APIs, see [CLAUDE.md](../CLAUDE.md) — it's written for AI
assistants working on the codebase, but it's also the best single source of ethos and
architectural intent for any contributor.

For the project overview see [README.md](../README.md); for installation and configuration
see [GETTING-STARTED.md](GETTING-STARTED.md). For building multi-user deployments — per-user
gating, the bootstrap-plugin pattern, and the global tool-visibility ceiling — see
[PER-USER-PLUGINS.md](PER-USER-PLUGINS.md). For writing a **UI of your own** against the web
frontend's HTTP+SSE API — prompt delivery, stream liveness, and reconnect reconciliation — see
[SSE-CLIENTS.md](SSE-CLIENTS.md).

---

## The plugin contract

Every plugin module must export a named `plugin` constant satisfying `MatbotPluginSpec`
from `@matatbread/matbot-plugin-api`:

```ts
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools:      [myTool],
};
```

A spec carries **no `name`** — identity is loader-established, not the author's to assign.
The loader stamps `name`/`specifier`/`source` onto the spec (deriving the name from
`package.json` on Node, or a CDN URL in the browser) to produce the `MatbotPlugin` that
every consumer sees. So write a `MatbotPluginSpec`; read a `MatbotPlugin`.

The loader also accepts a default export with a `plugin` key, but the named export is
preferred. Declare `@matatbread/matbot-plugin-api` as a **`peerDependency`** (with a
`devDependencies` mirror) — never bundle your own copy. See *Dependencies* below for the
full rule.

### `MatbotPluginSpec` fields

| Field | Type | Purpose |
|---|---|---|
| `apiVersion` | `string` | The contract version this plugin targets, as `major.minor`. Set it to `PLUGIN_API_VERSION` and it stays right for free. The major must match the runtime's exactly (a mismatch is a hard load failure); a *newer* minor than the runtime warns and loads. |
| `manifest` | `PluginManifest` | Optional metadata: `description?` and the `config?` keys this plugin reads |
| `tools` | `readonly Tool[]` | Tool implementations to register |
| `provider` | `ProviderAdapterFactory` | A single LLM adapter factory (`(config) => ProviderAdapter`) |
| `storage` | `Record<string, StoreFactory>` | Named store factories |
| `storageBackend` | `{ open(dotData: string): Promise<StorageBackend> }` | Storage backend; `open()` runs before any `setup()` |
| `setup` | `(services: MatbotMachine) => Promise<void>` | Called once after all plugins are registered. The argument is the whole machine — registry services *and* the fixed runtime; see *Services available in `setup()`* |
| `teardown` | `() => Promise<void>` | Called on graceful shutdown |
| `installationMessage` | `() => Promise<string>` | Optional message shown to the user on install |

### Package layout

```jsonc
// package.json
{
  "name": "@you/matbot-my-plugin",   // canonical identity — the loader stamps this onto the plugin
  "type": "module",
  "matbotRuntime": ["node", "browser"], // runtimes this plugin supports (see below)
  "exports": { ".": "./src/index.ts" },
  // host-provided singleton — a peer (never bundle your own copy), mirrored in devDependencies so it
  // typechecks and runs standalone. See "Dependencies" below.
  "peerDependencies": { "@matatbread/matbot-plugin-api": "^0.4.0" },
  "devDependencies":  { "@matatbread/matbot-plugin-api": "^0.4.0" }
}
```

```
my-plugin/
  package.json       # as above
  tsconfig.json      # extends tsconfig.base.json; add "types": ["node"] only if needed
  src/
    index.ts         # export const plugin: MatbotPluginSpec
```

The plugin's **identity is its `package.json` `name`** — the loader derives it and stamps it onto
the spec (the author never sets `name`). That name is the canonical handle for `remove`/`reload`.

### Dependencies: `peerDependencies` vs `dependencies` vs `devDependencies`

In matbot, dependency placement is **load-bearing, not cosmetic**. Get it wrong and you either
duplicate a host singleton (subtle, dangerous) or make a package manager try to install a package
your code never imports (a hard install failure when that package isn't published). Place every
dependency by this rule:

**`peerDependencies` — the host-provided singletons.** `@matatbread/matbot-plugin-api` and
`@matatbread/matbot-core` are supplied by the host (the CLI, the browser bundle) as **exactly one
shared instance**. A plugin must bind to *that* instance — never bundle its own copy. A second copy
breaks `instanceof`, the ambient principal carrier, shared registry state, and `declare module`
augmentation — all of which depend on object/type identity being shared across the whole process.
Declaring them as peers says "I need this; the host provides it," so the package manager won't
install a duplicate into your plugin's tree. **Always mirror each peer in `devDependencies`** too —
peers are not installed for you, so the mirror is what lets the plugin typecheck, test, and run
standalone during development.

**`dependencies` — real runtime libraries you import.** Third-party npm packages whose *values* you
import and call at runtime (a parser, a client library), plus any first-party matbot package you
depend on **by construction** — the *specialization* relationship from CLAUDE.md, where your plugin
imports another plugin's runtime code and constructs it (e.g. `skills-node` → `skills`, `tool-mcp` →
`mcp-http`). These are installed into your tree and shipped.

**`devDependencies` — build/dev/type-only, erased at runtime.** `typescript` and `@types/node`; the
peer mirrors above; and — the subtle one — **any matbot package you import only as a type.** Under
`verbatimModuleSyntax` + Node type-stripping, an `import type { SkillManager } from
'@matatbread/matbot-skills'` is *erased entirely* — the package is never loaded at runtime.
Cross-plugin coupling in matbot is usually exactly this shape: you read a peer service through the
registry (`services.SkillManager?.…`, see *Plugin-to-plugin services*) and import its *type* only for
the annotation. So the provider package is a **devDependency, not a runtime dependency.** Listing it
under `dependencies` makes a packed/published tarball try to install it from the registry — and 404
if it isn't published — for a package your code never imports.

**Litmus test for a first-party (`@matatbread/*`) dependency:**

| Question | Bucket |
|---|---|
| Is it `plugin-api` or `core`? | `peerDependencies` **+** `devDependencies` mirror |
| Do you `import` a **value** from it and use it at runtime (construct/call)? | `dependencies` |
| Do you `import type` from it only (runtime coupling is via `services.X`)? | `devDependencies` |
| You don't reference it at all? | remove it |

The first-party packages in this repo follow exactly this: `plugin-api`/`core` are peers everywhere;
`skills-node` keeps `skills` in `dependencies`; `frontend-web`, `cognition`, and `web-principal-user`
keep their type-only `@matatbread/*` imports in `devDependencies`.

### Declaring supported runtimes (`matbotRuntime`)

`matbotRuntime` in `package.json` declares which environments a plugin runs in — `["node"]`,
`["browser"]`, or `["node","browser"]`. The loader reads it **before importing**: a plugin whose
declared runtimes exclude the host is skipped without ever evaluating its top-level code — the only
safe path for, e.g., a Node-only plugin reached from the browser. An **absent** field means "don't
know": the loader imports it and falls back to a try-load/rollback path. Declare it honestly — a
plugin that touches `node:*` must not claim `browser`. (This is also why a `*-node` package and its
cross-runtime base differ only by this field plus their imports.)

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
plugin({ action: 'add',            specifier: '@matatbread/matbot-tool-bash' })
plugin({ action: 'remove',         specifier: '@matatbread/matbot-tool-bash' })  // address by package name
plugin({ action: 'reload',         specifier: '@matatbread/matbot-tool-bash' })  // re-import from disk
plugin({ action: 'list' })                                                       // configured + loaded, with matbotRuntime
plugin({ action: 'discover_local' })                                             // scan plugins + the .plugins cache
plugin({ action: 'store-key',      name: 'SOME_API_KEY' })                       // supply a missing secret (value entered out-of-band)
```

Plugins are hot-loaded immediately — no restart needed. **Address an installed plugin by its
canonical `package.json` name** (preferred) or its exact `matbot.yaml`/config entry — never the
resolved `file://` path or per-load `blob:` URL. `reload` re-imports a plugin (and, with the Node
resolve hook installed, the first-party modules it imports) from disk to pick up code changes; see
CLAUDE.md's *Plugin hot-reload* for the freshness mechanism and its caveats.

### Three routes in

A plugin specifier takes one of three routes, and each hands resolution to whoever already owns it —
matbot writes none of the three resolvers. Which one runs is decided by what the specifier *is*:

| Route | What it is | Resolved by |
|---|---|---|
| **local** | a path, or a bare name the disk already answers | the **filesystem** — already an answer |
| **npm** | a name nothing local claims, a version-suffixed name, an explicit `npm:…`, a `.tgz`/`.tar.gz`, or a git URL | the **package manager** — `^1.2.3` is a *question*: constraint solving, a registry, a lockfile |
| **http** | an `http(s)://` URL, or `github:owner/repo[/sub][#ref]` | the **URL itself** — nothing to resolve but a fetch |

**A bare name is local if anything here declares it.** Not if a *path* of that shape exists — that is a
coincidence, and in a checkout it never happens: `@matatbread/matbot-edit-session` is
`plugins/edit-session`. So the disk is asked what it can answer — "does a package under `plugins/` call
itself this?" — over the same two-deep root `discover_local` scans, and only an unclaimed name is a
registry question. Otherwise `plugin add @matatbread/matbot-edit-session` in a full checkout would install
a *published copy of code already on disk*: a second package, free to skew in version, shadowing the source
being worked on. A `@<range>` suffix is always the registry, local package or not — a constraint is exactly
what a filesystem cannot solve.

The same fact runs the other way when a plugin is **recorded**: `plugin add` writes the canonical package
name, not the path it was given, whenever that name resolves back to the directory just approved. The name
works in a checkout and in an installed deployment; a path works in one working copy. A plugin the name
cannot reach — under `compiled-plugins/`, in a sibling checkout via `../` — keeps its path.

Two rules close the model. **A plugin is always a package**: never raw source without a manifest, because
matbot's own fields (`matbotRuntime`) live there. And **a bare specifier means host-provided** — the
singletons `plugin-api` and `core` always resolve to the host's own copy, never to a second one fetched
or installed alongside. matbot's version routinely exists on no registry, so a package manager could
never be asked to supply it.

That guarantee is a **link**, not a resolver rule: the two singletons are symlinked into
`.plugins/node_modules` pointing at the host's own directories, which is the disk's version of the browser
bundle's import map. It has to be something on disk, because everything that resolves from inside the cache
must agree — the ESM resolver, `createRequire`, tsc — and because there is no anchor a module hook could use
instead: `apps/cli` depends on `core`, not on `plugin-api`. Walking up is not enough either. An installed
deployment happens to work (`.plugins/` sits under a project whose flat `node_modules/@matatbread/…` is
above it); a pnpm workspace keeps its links inside each package, so a source checkout's root has no
`@matatbread` for the walk to find.

`npm:` is the one override, for when the shape does not give the answer away — a bare name that happens
to collide with a directory, or a URL serving a tarball without a `.tgz` in its path. A tarball or git URL
is a URL and still takes the npm route: nothing is importable at the far end until something unpacks or
clones it.

### Local plugins and their dependencies

Adding a local plugin (`./my-plugin`, or any path resolving to a package) installs the **`dependencies`
its own package.json declares**, so a plugin may wrap a third-party module. `plugin add` resolves them
first and lists the resolved set — transitives included — in the same approval it asks for the install,
then installs exactly that with npm (`--ignore-scripts`, and `--omit=peer` so the host's
`plugin-api`/`core` are *linked* to the host's own copies rather than fetched from a registry as a second
version). Declining installs nothing and leaves no lockfile.

Only registry ranges are handed to npm. A manifest carrying `workspace:`, `catalog:`, `link:`, `file:` or
a URL range is left **entirely** alone — those say "something already resolves me", which is what every
plugin inside this repo looks like — and `plugin add` says so rather than half-installing it.

### The http route

`add` accepts an `https://` URL or a `github:owner/repo[/sub][#ref]` shorthand for one. The install
**must resolve a `package.json` with a `name`** — the URL itself, a directory containing one, or a code
entry whose `package.json` is its *direct* sibling; absence is a hard error (no munged "index" names).
Fetched code is mirrored under a matbot-writes / LLM-reads-only `.plugins/` cache next to `matbot.yaml`
(kept separate from the read-write `.data/` tree).

**Node drives the module graph, fetching as it resolves.** Only the manifest and the entry are fetched up
front; each further import is fetched when Node actually resolves it, by a module hook that maps the
importing file back to where it came from. So a **dynamic `import(variable)`**, a **root-relative**
`/ms@2.1.3/…` specifier and an **absolute URL import** all work — none of which a scan of the source ahead
of time can see. `import.meta.url` is still a `file:` URL, so `createRequire`, `fileURLToPath` and reading
a sibling file behave normally, and the tree stays a real package the model can read.

**That tree is the cache.** A file already mirrored is read from disk and never re-fetched, so a restart
makes no requests at all and works with no network. The trade is deliberate: a restart never picks up
changed upstream source. `reload` with `refresh` (the default here) is the one path that does — it evicts
the plugin's subtree, so the manifest and every file come from upstream, which is also how a moved entry
or a renamed package is noticed.

**This route fetches one package; it installs no dependency graph.** A bare import means host-provided, so:

- a third-party dependency must already be present, or be written as a **URL import** — which is now
  fetched and cached like anything else;
- a dependency on **another matbot plugin** is met by adding that plugin to `plugins:` too, and one
  declared in the manifest but present nowhere is reported at boot;
- an import that resolves nowhere fails naming the specifier *and* the importer, because the resolution
  genuinely happened rather than being predicted.

#### Boundaries worth knowing before you hit them

- **Any source CDN, including the rewriting ones.** jsdelivr and unpkg serve source with bare imports
  intact; esm.sh rewrites them to root-relative paths. Both work — the second used to be silently dropped.
- **ESM only.** A CommonJS dependency reached by URL will not load. jsdelivr's default paths serve CJS for
  many packages; `/+esm` and esm.sh are the ESM forms.
- **A tarball or git URL is not this route** — it takes npm, because something has to unpack it.
- **Hot reload does not cross a hard-dependency edge.** To pick up a dependency's code changes, reload the
  *dependent*, not the dependency. Unchanged by any of this, and documented in CLAUDE.md.

---

## Open-registry augmentation

matbot's most distinctive API idea, and the one thing worth learning before anything else: **five
different extension points are the same technique.** Learn it once and you can read all five.

Each is an empty (or near-empty) interface in `plugin-api` that your package *adds a key to* via
`declare module`. TypeScript merges declarations across the whole program, so the interface ends up
holding every loaded plugin's contribution — while `plugin-api` itself never changes, and never needs to
know your package exists. Helper types then derive the real shapes from the merged registry.

| Registry | Key is | You add | So that |
|---|---|---|---|
| `MatbotServices` | an **interface name** | `Foo?: Foo` | your service is reachable as `services.Foo`, `?` marking that it may be absent |
| `ToolContracts` | a **tool name** | `ToolContract<Result, Params>` arms | `await tool.your_tool(params)` narrows its result, and the wire description is derived |
| `Notifications` | `<package-name>#<InterfaceName>` | your notification shape | `notify`/`consume` are typed and your `kind` cannot collide |
| `MarkerData` | a **marker creator** | your `data` shape | `Marker<'your-creator'>` reads/writes typed |
| `ProviderMeta` | your **package's namespace** | e.g. `google?: { … }` | core carries provider round-trip state opaquely and never changes when you add some |

```ts
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices { Analytics?: Analytics }
}
```

Four properties follow from the technique, and explain most of the per-registry rules:

- **The key is the identity.** There is no runtime type information at the boundary, so the string
  key *is* the type's erasure-time stand-in. Name it after the thing, never after a role — hence
  "the key is the interface name", and `Notifications` qualifying its keys with a package name (a
  `kind` is globally scoped, and an importer cannot rename it out of a collision).
- **It is open at runtime.** A plugin this build never compiled against — or a bridged remote server —
  can contribute a key. So a `switch` over `Notification['kind']` must always `default`, and
  exhaustiveness checking over these registries is unsound, unlike a closed union.
- **Absence is a type, not an error.** `?:` is the entire mechanism by which "this may not be loaded"
  reaches a call site. Degrade (`if (!services.Analytics) return;`); never fall back to loading it.
- **Unregistered means loose, not broken.** An unknown tool name yields `unknown`, an unregistered
  marker creator yields `data: unknown`. The base types stay permissive so the unions still work.

Each of the five declarations carries its own specifics. This is the shared shape underneath.

### The same technique, one level down: result shapes

A registry key is registered by *merging*, so it can only ever be declared once. That has a
consequence worth knowing before you try to override a builtin tool: you **cannot** replace an
existing `ToolContracts` arm. Declaring your own is `TS2717: Subsequent property declarations must
have the same type`, and declaring nothing leaves you advertising a shape you do not return — worse
than saying nothing, because an unregistered tool at least resolves to `unknown` and forces the caller
to narrow.

So a builtin tool's result is a **named, exported interface**, and you extend the shape rather than
the registry:

```ts
declare module '@matatbread/matbot-plugin-api' {
  interface LoadedPluginSummary { managedBy?: 'personal' | 'shipped' }
}
```

`ToolContracts['plugin']` now carries your field everywhere it is read — `toolResult`, the `tool`
proxy a generator calls, and the wire description the model sees — while an *undeclared* field is
still rejected. It is an extension point, not a widening hole. `@matatbread/matbot-storage-google-drive`
does exactly this to mark each plugin as Drive-synced or local.

The same constraint is why a tool with **two implementations** (`plugin` and `provider` each have a
node and a browser one) declares a single shared arm-union from `plugin-api` rather than one
declaration apiece: two declarations of one key differ the moment the implementations do, and the
surviving one is whichever the compiler happened to see first. `buildMatbotToolsDts` reports any such
clash it finds rather than silently picking a winner.

The generated dts declares the **live tool registry**, not the source tree it scanned. The scan roots
at each loaded plugin and then unions a glob of the monorepo `plugins/` tree onto it — the only way to
reach host-constructed builtins like `plugin` and `provider`, which have no `resolvedUrl` — so its
roots are a *superset* of what is actually loaded. A scanned root may supply a tool's **contract**;
only the registry says the tool **exists**. Without that filter a generator composes
`await tool.telegram_send({ text })` against a telegram frontend nobody loaded, typechecks clean, and
throws `Tool "telegram_send" is not registered` at runtime — which no repair pass can fix, because the
code is correct against the types it was shown. If you write your own generator, type it off
`ToolTypeIndex`, which passes the live names for you.

---

## Services available in `setup()`

`setup(services)` receives a `MatbotMachine` — the intersection of two interfaces. **`MatbotRuntime`**
is the fixed plumbing that is always present and never registerable (`complete`, `createStore`, the
`hooks`/`tools`/`systemContext`/`providers` registries, plugin lifecycle, the registry API itself).
**`MatbotServices`** is the swappable, registerable bucket keyed by interface name — the `keyof` domain
of `register`/`get` and the surface third-party plugins augment (`StorageBackend?`, `KnowledgeIndex`,
`Vault`, plus what plugins add). Both are read through one member surface:

```ts
type MatbotMachine = MatbotServices & MatbotRuntime;

// MatbotRuntime — the fixed runtime plumbing (never registerable):
interface MatbotRuntime {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  singleTurn(req: SingleTurnRequest): Promise<CompletionResponse>;   // one-shot prompt convenience over complete()
  settings(): PluginSettings;                       // the calling plugin's own scoped settings
  createStore<T extends { id: string; version: string }>(namespace: string): Store<T>;
  loadPlugin(specifier: string, prompt?: PromptFn, refresh?: boolean): Promise<MatbotPlugin>;
  unloadPlugin(specifier: string): Promise<boolean>;
  register<K extends keyof MatbotServices>(key: K, value: NonNullable<MatbotServices[K]>): Promise<void>;
  get<K extends keyof MatbotServices>(key: K): MatbotServices[K] | undefined;
  registerFrontend(info: FrontendInfo): void;
  isSubAgent(): boolean;

  readonly TypeScriptStripper: TypeScriptStripper;   // host-provided, per-platform TS type-stripper
  readonly mounted:         Mounted;                 // react to a registry service (re)mounting / unloading
  readonly providers:       ProviderRegistry;        // named provider profiles (a writable ReadonlyMap)
  readonly sessions?:       Store<Session>;
  readonly run?:            SessionRunner;            // per-session turn serialiser
  readonly self?:           PluginSelf;               // the calling plugin's loader-stamped identity
  readonly files?:          FileStore;
  readonly hooks:           HookRegistrar;       // register / removeByPlugin — not the host's dispatch surface
  readonly tools:           ToolRegistry;
  readonly systemContext:   SystemContextRegistry;
  readonly workdir?:        string;
  readonly configPath?:     string;
}

// MatbotServices — the registry bucket (registerable / swappable keys):
interface MatbotServices {
  readonly StorageBackend?:  StorageBackend | undefined;
  readonly KnowledgeIndex:   KnowledgeIndex;
  readonly Vault:            Vault;
  readonly Notifier:         Notifier;                    // the one change-notification bus; always present
  readonly ToolTypeIndex?:   ToolTypeIndex | undefined;    // node-only; provided by the tool-types plugin
  readonly ToolPresenter?:   ToolPresenter | undefined;    // per-turn tool-visibility policy (tool-router)
  readonly WatchVisibility?: WatchVisibility | undefined;  // per-connection notification visibility (a partitioning backend)
  readonly FilePartition?:   FilePartition | undefined;    // addresses the file area out of band, e.g. in a URL (same backend)
  readonly SteeringPolicy?:  SteeringPolicy | undefined;   // how a mid-turn submission is disposed (queue vs interrupt)
}
```

Registered services and built-in members share one access surface: read them all as
`services.InterfaceName`. `get(key)` still works, but a member read is the idiom — a member
read of a key the object doesn't carry transparently falls back to the registry. Assignment
(`services.X = …`) throws; `register()` is the only write path.

A few members worth calling out:

- **`run`** (`SessionRunner`) — the per-session turn serialiser. A frontend submits and observes
  turns through this rather than calling `runSession` directly, so concurrent submits queue instead
  of clobbering the session.
- **`self`** (`PluginSelf`) — the calling plugin's loader-stamped identity (`name`, `specifier`,
  `source`), bound per-plugin inside `setup()`.
- **`isSubAgent()`** — `true` when this process is a background sub-agent (spawned by another
  matbot), not a top-level interactive run. Use it to suppress work that must be singular per bot
  identity — e.g. a frontend's long-poll loop, which would otherwise contend with the foreground
  process on the same upstream connection. The signal is platform-sourced (the Node entry reads it
  from the environment; the browser realm has no sub-agent notion and returns `false`).
- **`mounted`** (`Mounted`) — subscribe to a registry service (re)mounting or being unloaded. Only
  needed if your `setup()` reads another service's *current state* to build cached/derived state (e.g.
  skills/triggers caching the `StorageBackend`'s documents, cognition seeding from the `SkillManager`);
  a pure map that resolves its dependency per-invocation through the member/proxy subscribes to
  nothing. See CLAUDE.md's *mount table* for the full contract.
- **`Notifier`** — the one fan-out for every "something changed" fact. Always present; see
  [Notifications](#notifications) below.

### Plugin-to-plugin services

Plugins advertise services to each other by augmenting `MatbotServices`. **The key is the
interface name** — name it exactly after the type it carries (`Analytics` holds an `Analytics`),
never a role-noun. The `?` makes absence the type-level signal that you must null-check it.

```ts
// In a types package, e.g. @matatbread/matbot-analytics-types:
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    Analytics?: Analytics;   // optional: present only when the providing plugin is loaded
  }
}
```

```ts
// Advertising (providing plugin's setup()):
await services.register('Analytics', new AnalyticsImpl(store));

// Consuming (any plugin's setup()) — member access, `?.` is the null-check:
services.Analytics?.track(event);
```

The registry is for **loose negotiation between independent parties** — the consumer neither
knows nor cares who (if anyone) provides the capability, and degrades gracefully when it is
absent. When one plugin is a *specialization* of another (it depends on it by construction),
import and construct it directly with a hard `package.json` dependency instead. See CLAUDE.md
for the full distinction and for the four swap-aware keys (`StorageBackend`, `KnowledgeIndex`,
`Vault`, `Notifier`) — each carries a host boot default and reverts to it when the plugin that
registered one is unloaded.

### Plugin settings

```ts
interface PluginSettings {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Keys are scoped per plugin — two plugins can use the same key without collision.

The install can supply a **default** for any key, via `default_settings:` in `matbot.yaml`
(`BrowserConfig.defaultSettings` in the browser), keyed by your package name. It is read-through, so
you write nothing to support it:

- `get` returns the stored value if there is one, else the install's default, else `undefined` — so
  the familiar `(await settings.get(k)) ?? MY_DEFAULT` already prefers the install's value over your
  code's, which is the intended precedence;
- `set` persists only the key you set, and never materialises a default;
- `delete` means "revert to the default", which is what a `clear`/`reset` action should say it does. A
  caller wanting to override a configured default rather than revert to it stores a value (`null` is a
  value, and reads back as `null`);
- a default is not partitioned per principal — it is config, not data.

Nothing distinguishes a defaulted read from a stored one at this interface. If a `get`/`status` action
of yours reports settings back to the model, say "in effect" rather than "pinned".

### Calling LLMs directly

`services.complete()` lets plugins call LLMs for classification, summarisation, or
inner-voice critique:

```ts
interface CompletionRequest {
  provider:    string;
  messages:    Message[];
  system?:     string;
  parameters?: Partial<ModelParameters>;   // shallow-merged over the profile's own; request wins
  signal?:     AbortSignal;
}
```

`parameters` is for **transient** model behaviour — a lower `temperature` to classify, `thinking` off
for a cheap sub-call, a tighter `maxTokens` on output you parse rather than show. The host merges it
over the named profile's own `parameters` before the adapter sees the config, so you override only the
keys you name.

Durable properties of a model still belong in the provider profile, where they stay user-editable. The
line is *whose concern it is*: a profile describes the model, `parameters` describes one call. If the
same override appears at every call site of a provider, it was a profile all along — and if a provider
profile would differ from its sibling in exactly one field for one caller, it was `parameters` all along.

`singleTurn({ provider, prompt, system?, parameters?, signal? })` is the same call for a one-shot
prompt, without the `Message` fields (`id`/`traceId`/`createdAt`) an out-of-band call has no use for;
it forwards `parameters` verbatim.

---

## Writing a tool

```ts
import type { Tool, ToolEvent, ToolContext } from '@matatbread/matbot-plugin-api';

const myTool: Tool = {
  name:        'search',
  description: 'Search the index and return matching hits.',
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
| `model-content` | `content: ModelContent[]` | Media for the *model* to read — see [Media](#media) |
| `marker` | `creator: string`, `data: unknown` | Emit a durable marker (see [Markers](#markers)) |
| `error` | `message: string`, `code?: number`, `stdout?: string`, `stderr?: string` | Expected tool error |

Throw only for unexpected failures; yield `{ type: 'error' }` for expected ones.

`result`, `model-content` and `marker` are independent: a tool may yield a result and no markers, a
marker and no result (a silent side-effect), or show the model an image whose `result` is a one-line
summary. The durable record of what a tool did is its `result`.

### Typed results (`ToolContracts`)

`ToolEvent` is generic — `ToolExecutor<R>` yields `ToolEvent<R>` — so a tool declares its call contract
by augmenting the `ToolContracts` interface (the same pattern as `MarkerData` / `MatbotServices`), keyed
by the tool's `name`. Each entry is a `ToolContract<Result, Params>` arm pairing the result with the
params that produce it — a single-action tool declares **one** arm (never a bare `name: Result`, which
yields no callable `tool` proxy signature). That augmentation is the **single source of truth**: bind the
executor to it with `ToolExecutor<ToolResultOf<'name'>>` (or `Tool<…>`), and the compiler checks every
`result` yield against it — so the executor and the registry can't drift.

```ts
import type { Tool, ToolContract, ToolResultOf, ToolContext } from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts { search: ToolContract<{ hits: string[] }, { query: string }> }
}

const myTool: Tool<ToolResultOf<'search'>> = {
  name: 'search', /* … */
  executor: {
    async *execute(input, ctx) {            // return type inferred: ToolEvent<{ hits: string[] }>
      yield { type: 'result', value: { hits: [] } };
    },
  },
};
```

A caller then recovers the concrete type without narrowing: `invokeTool(machine, 'search', …)` is typed
`AsyncIterable<ToolEvent<{ hits: string[] }>>`, and `toolResult(events)` resolves to `{ hits: string[] }`
(the structured counterpart to `toolText`, which collapses the result to a string). An unregistered name
resolves to `unknown`. This is purely type-level — no runtime validation. A genuinely-`unknown` result
(e.g. `http`'s parsed JSON) still declares an arm, just with `unknown` as its result:
`ToolContract<unknown, { url: string; … }>`.

**Per-action narrowing.** A multi-action tool is a weird overloaded function — its result depends on its
params. Register it as a union of `ToolContract<Result, Args>` *arms*, each pairing a result with the
discriminating params *pattern* that selects it; `invokeTool` matches the call's params and narrows to
the matching arm. The discriminant is any field(s), not just `action` (`background` keys on `interval`'s
presence). Key on the discriminant only, not the full input, so a call carrying just that field matches;
when no arm matches (a non-literal or absence discriminant), the result soundly falls back to the union of
all arms. `ToolResultOf<'name'>` unwraps the arms to that union, so the executor binding is unchanged.

```ts
declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    mcp_action:
      | ToolContract<{ message: string; tools: string[] }, { action: 'add'    }>
      | ToolContract<{ servers: string[] },                { action: 'list'   }>
      | ToolContract<{ message: string },                  { action: 'remove' }>;
  }
}
// invokeTool(machine, 'mcp_action', { action: 'list' }) → result is { servers: string[] }
```

### `ToolContext`

```ts
interface ToolContext {
  callId:      string;
  session:     Session;
  signal:      AbortSignal;
  vault:       Vault;
  provider?:   string;       // the provider key driving the current turn
  workdir?:    string;
  configPath?: string;
  files?:      FileStore;
  prompt:      PromptFn;     // (question, default?) | (field: FormField) => Promise<string>
  loadPlugin(specifier: string, refresh?: boolean): Promise<MatbotPlugin>;  // refresh: re-download a remote
  unloadPlugin(specifier: string): Promise<boolean>;
}
```

`ctx.signal` is aborted on Ctrl+C or session cancellation — propagate it to
sub-processes, fetch calls, and timers. `ctx.prompt()` asks the user a question via the
host's readline/form system; use sparingly, only for irreversible actions. There is no
`principal` field — the security principal is carried **ambiently**; read it with
`currentPrincipal()` from `@matatbread/matbot-core` (or the re-export in plugin-api).

---

## Writing a provider plugin

A plugin contributes a **single** provider adapter via the `provider` factory
(`(config: ProviderConfig) => ProviderAdapter`):

```ts
import type { MatbotPluginSpec, ProviderAdapter, CompletionEvent } from '@matatbread/matbot-plugin-api';
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

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  provider:   (_config) => myAdapter,
};
```

A provider is selected by name in `matbot.yaml` (each named block sets `module`, `endpoint`,
`model`, and `credentials`); the `module` resolves to the package exporting this spec.

### `CompletionEvent` variants

| Event | Key fields |
|---|---|
| `text-delta` | `delta: string` |
| `tool-call` | `id, name, input`, `meta?: ProviderMeta`, `truncated?: { bytes, stopReason? }` |
| `tool-result` | `id, result` |
| `thinking` | `delta: string` |
| `thinking-block` | `thinking, signature` |
| `redacted-thinking` | `data: string` |
| `reasoning-block` | `reasoning: string` |
| `refusal` | `text: string` |
| `unknown-block` | `blockType: string, raw: unknown` |
| `truncated` | `reason: 'max-tokens' \| 'stream-end'`, `raw?: string` |
| `usage` | `inputTokens, outputTokens, costUsd?, cacheReadTokens?, cacheCreationTokens?` |
| `done` | — |

**`truncated` — the response was cut short, and the model did not choose to stop.** `max-tokens` is
the provider saying so outright (`stop_reason: "max_tokens"` / `finish_reason: "length"` /
`finishReason: "MAX_TOKENS"`); `stream-end` is the stream ending with no finish reason at all, e.g.
a dropped connection. Emit it whether or not a tool call was caught in the cut — the commoner case
is prose stopping mid-sentence. The runner records it as a durable `matbot-truncation` marker
(LLM-invisible, so the reader and the audit see it without the model narrating its own cut-off);
acting on it is a `followup` hook's business, not the harness's.

The `truncated` field on a **`tool-call`** is the narrower case: the call's arguments were severed
mid-stream and never parsed, so `input` is `{}` and the runner does *not* execute the call — it
pairs it with an error result and the model self-corrects next round. Only adapters that accumulate
arguments as a streamed JSON string can detect this (Anthropic's `input_json_delta`, OpenAI's
`function.arguments` fragments); Gemini delivers each `functionCall` complete, so there is nothing
to sever.

### Provider round-trip metadata (`ProviderMeta`)

Some providers hand back an opaque token that must be echoed **verbatim** when a tool call is
replayed in history — Gemini 3 "thought signatures" are mandatory on every historical
`functionCall` or the request 400s. That rides on a tool call's `meta?: ProviderMeta`, on both
`CompletionEvent` and `MessageContent`, so core stores and replays it without understanding it.

`ProviderMeta` is one of the five open-registry augmentation points: declare your own namespaced
slice from your own module and `plugin-api` never changes when you add round-trip state.

```ts
declare module '@matatbread/matbot-plugin-api' {
  interface ProviderMeta { myprovider?: { thoughtSignature?: string } }
}
```

Replay a token **only when the message that produced it came from your provider** — one session
interleaves tool calls from several. A foreign token is elided or degraded, never posted into a
slot it doesn't belong in.

---

## Writing a storage backend plugin

```ts
import type { MatbotPluginSpec, StorageBackend, Store, FileStore } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

class MyBackend implements StorageBackend {
  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> { /* … */ }
  get fileStore(): FileStore { /* … */ }
  async close(): Promise<void> { /* … */ }
  static async open(dotData: string): Promise<MyBackend> { return new MyBackend(); }
}

export const plugin: MatbotPluginSpec = {
  apiVersion:     PLUGIN_API_VERSION,
  storageBackend: { open: (dotData) => MyBackend.open(dotData) },
  async setup(services) {
    if (services.StorageBackend instanceof MyBackend) return;
    if (!services.configPath) return;
    const { join, dirname } = await import('node:path');
    const dotData = join(dirname(services.configPath), '.data');
    await services.register('StorageBackend', await MyBackend.open(dotData));
  },
};
```

When listed in `matbot.yaml`, `open()` is called before any `setup()` runs. When
hot-loaded at runtime, `setup()` calls `register('StorageBackend', backend)`, which
transparently re-targets all existing `Store` and `FileStore` proxy references.

**Your `FileStore` is already a media store.** `MediaStore` is an alias of `FileStore`, so there is no
second interface: persist the `opts` you are handed (`sessionId`, `messageId`, `namespace`, `allowed`)
and honour `FileFilter.sessionId` in `list()`, and a host or plugin can `register('MediaStore', …)`
against you unchanged. The one thing to get right is that `put(name, …)` and `put(undefined, …)` are
different operations — a named put is addressable and upserts, an anonymous one mints a fresh id — and
media always takes the anonymous path. See [MEDIA.md](MEDIA.md).

### `Store<T>` interface

```ts
interface Store<T extends { id: string; version: string }> {
  get(id: string): Promise<T | null>;
  set(id: string, value: T): Promise<void>;
  cas(id: string, expected: string, next: T): Promise<CASResult<T>>;
  delete(id: string, expectedVersion?: string): Promise<boolean>;
  query(q: StoreQuery): Promise<QueryResult<T>>;
}
```

All writes are compare-and-swap where concurrent updates are possible — `cas(id, expectedVersion,
next)`, never a bare `set`. The **one place CAS is not sufficient** is a session with a turn in
flight: the runner commits its own in-memory copy with an unconditional `set`, so it clobbers a
correct CAS without ever comparing versions. A live session's document belongs to the runner; write
it from a hook, a UI route or a background job only at the quiescent edge (see [Persisting work
computed after a turn](#persisting-work-computed-after-a-turn)).

`StoreQuery` is a deliberately minimal grammar designed to translate to a real backend (SQL
`WHERE`, Elasticsearch `bool`, Mongo `find`, IndexedDB cursor) rather than be interpreted by an
embedded engine: a closed `Filter` AST (a union discriminated by `op` — `eq/neq/lt/lte/gt/gte`,
`in/nin`, `exists`, `stringContains`, `arrayContains`, composed with `and/or/not`), `sort`,
`limit`, and an opaque `cursor`. The cursor is **self-contained** — it carries the query, sort,
page size, and position, so a caller pages by sending only a previous result's `cursor` back; this
is what makes consecutive pages a disjoint cover (each page re-applies the same sort, so the total
order never shifts under you). A present `cursor` means more pages follow; an absent one means done.
**`limit: 0` is the count form** and every backend must honour it: run the filter, report `total`,
materialise no document and issue no cursor (a zero-length page never advances the offset, so a
cursor would page forever on the same empty slice). It is a page size of zero rather than a separate
`count` flag because that is already what the word means in a native query too — fetch no rows,
report how many there were — so a pushdown backend compiles it to `SELECT COUNT(*)` and an
in-memory one gets it for free from `executeQuery`. Comparisons are type-strict; null and absent are a single
"missing" state queried only via `exists`. The in-memory reference evaluator (`executeQuery` in
`@matatbread/matbot-core/storage-base`) compiles the AST to a composed-closure predicate; a backend may
instead compile the same AST to its native query. **`@matatbread/matbot-storage-sqlite` is the worked
example** (`plugins/storage/sqlite/src/query-sql.ts`): one `WHERE` fragment per `op`, `json_extract`
for the field and `json_type` for its type, the field path *bound* rather than interpolated, and
`limit: 0` compiled to `SELECT COUNT(*)`. Write that compiler against a conformance corpus — the same
queries run through both backends, asserting the same documents in the same order
(`apps/cli/test/query-sql-conformance.test.ts`) — because a native query language will disagree with
the grammar by default at four points, each of which silently returns plausible rows: SQL's
three-valued logic (`NOT NULL` is NULL, so a row *missing* the field is dropped from a negated
predicate the grammar says it matches), the erasure of a JSON boolean to 0/1 by a value accessor
(defeating type-strictness), NULL ordering being a property of the sort *direction* where the
grammar's missing-last is a property of the *value*, and the `id` tiebreaker that makes the order
total. Full-text and vector search are **not** part of
`Store` — they live on `KnowledgeIndex`. See `Filter`, `StoreQuery`, and `StoreQueryError` in the
API types (`plugin-api/src/store-query.ts`).

---

## Writing a frontend plugin

A frontend owns its own I/O — HTTP server, bot connection, REPL — and declares itself
by calling `services.registerFrontend({ name: '…' })` in `setup()`. It drives the
runtime itself: reading and writing sessions through `services.sessions` and running
turns through the runner.

```ts
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  async setup(services: MatbotMachine) {   // the machine, not just MatbotServices
    services.registerFrontend({ name: 'frontend-example' });
    // start your own I/O loop: HTTP server, bot client, readline, …
  },
};
```

Multiple frontends may run simultaneously. A frontend is auto-unregistered when its
plugin unloads.

A frontend that lets a person **attach** an image, PDF or audio clip submits `UserContent[]` with the
bytes inline; the rewrite to a stored `file-ref` happens inside `open()`, so you inherit it rather than
implement it. What you do own is validating what you accept (a whitelist of arms, never a blacklist —
the boundary is a trust boundary), relaying a `MediaRejectedError` as something the user can act on, and
serving the bytes back if you draw them. See [MEDIA.md](MEDIA.md); `frontend/web` and
`frontend/telegram` are the two templates, and they differ in the way that matters — one could upload in
advance and chooses not to, the other cannot.

> **Security note:** the `toolcall` hook gates only the *runner* path (model-driven turns).
> A frontend that executes tools directly — e.g. a `POST /tools` endpoint — bypasses it and
> **must re-enforce any per-user gating itself** (`currentPrincipal()` is available on that
> path). See [PER-USER-PLUGINS.md](PER-USER-PLUGINS.md) for the full multi-user model.

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
| `screen` | Once per turn, before the first provider call | Replace the `session`; inject `ephemeral` context (this turn only) or `durable` context (folded onto the user turn, persisted + visible, carried live as `robo-user`); append durable `markers`; `abort` the turn; or hand back a `deferred` verdict (below) |
| `contribute` | Before every provider call | Transform the outgoing messages (ephemeral, never persisted) |
| `toolcall` | Before each tool runs | Reject or abort the tool call |
| `toolresult` | After each tool runs | Redact or transform the result; observe for audit |
| `followup` | After the turn commits | `resubmit` a robo turn (head-enqueued, runs next), `retractAndRerun` the turn just committed, and/or append durable `markers` |

**`screen`'s `deferred` verdict** lets a hook race expensive work — a classifier — against
generation instead of gating on it: return immediately, hand back a `DeferredScreen`, and the runner
restarts the turn in-situ if the verdict fires before commit. A hook that would rather block until
the verdict just returns `ephemeral` as usual.

**`followup`'s `retractAndRerun`** is the inverse of `resubmit`: rather than appending a robo turn
after the response, it *supersedes* it. The pump pops the committed turn back to (and excluding) the
last user message, stashes the popped content in a durable retraction marker (LLM-elided, so a
frontend can render it struck-through and a post-mortem can audit it), then re-runs that same user
turn with `context` folded in ephemerally — or `durable` blocks folded onto the re-run's user
message, for a correction that should outlive the redo. It is self-terminating by design: a
well-formed trigger fires on a *curable* defect that the injected context dissolves on the redo, and
`resubmitDepth` caps an ill-formed one.

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

### Persisting work computed after a turn

The runner holds **one in-memory copy** of the session for the extent of a turn and commits it at
every exit with an unconditional `store.set` (`end()`, `core/src/runner.ts`). So while a turn is in
flight the runner *owns* the document, and any other writer of that session is clobberable —
including one that compare-and-swaps, because the clobberer does not compare versions. Post-commit
the pump is likewise the sole writer, which is what makes its own unconditional appends safe.

That leaves a real question with two wrong answers. Say a plugin summarises a long conversation and
wants the summary to live on the session as a marker; the summarisation is an LLM call, so it cannot
be done inline without the user paying for it.

- **Await it inside `followup`** and the pump blocks. The hold spans the *whole queue*
  (`machineBusy` in `session-runner.ts`), so the user's next message waits on your summarisation.
  Correct, and silently slow.
- **Fire and forget from `followup`** and the write races the next turn's `end()` and loses.
  Silently.

The answer is neither: compute detached, then land the *write* at the **quiescent edge** — the next
moment nothing holds the machine.

```ts
import { onContextQuiesce } from '@matatbread/matbot-plugin-api';

services.hooks.register({
  on: 'followup',
  handler(ctx) {
    const { id } = ctx.session;
    void summarise(ctx.session).then(marker => {
      // One-shot: unregisters as it fires. The closure holds the work, so there is no pending flag.
      onContextQuiesce(un => { un(); return applyMarker(id, marker); });
    });
    // Returns immediately — the pump moves on and the next turn starts.
  },
});
```

Registering is all a stager does: it **announces** the work, so the barrier engages and an edge is
guaranteed to arrive rather than depending on the machine happening to go idle. And `machineBusy`
waits for staged work before taking its hold, so the next pump run will not read its copy of the
session until your flusher has settled — the window a detached write races is closed, not narrowed.

The latency objection does not transfer, because what is registered is the *write*, not the work:
the next turn waits for a store round-trip, not for an LLM call. Keep it that way. A flusher may
return a promise and the edge will wait for it, which is the point — and also the trap, since a slow
flusher is the blocking `followup` again by another route.

Three practical notes:

- **Re-read at the edge.** It is the first moment the committed document is readable; take it from
  the store rather than closing over the copy your hook was handed.
- **Serialise your own deferred writes.** Two landing at once compare-and-swap the same document
  concurrently. `plugins/edit-session/src/defer.ts` is the worked example: a promise tail plus a
  one-shot quiescer.
- **A quiescer is not bound to your plugin's load extent**, unlike `services.mounted.observe`. A
  one-shot is self-limiting; a standing registration survives `unloadPlugin` and will fire into a
  torn-down closure, so unregister it yourself.

**Or keep the state out of the session entirely.** If what you compute can live in your own
document, write it there and fold it in at `screen` — which may replace the session outright, so one
pass can inject the new summary and elide the previous one. Eliding on entry is also what stops
`followup`'s append-only `markers` from accumulating one summary per summarisation. That path never
writes the session and so has no clobber window at all; reach for the edge when the thing genuinely
belongs *on* the session.

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

A tool emits one inline with `yield { type: 'marker', creator, data }` rather than building the
message itself.

---

## Media

There are two ways bytes reach a model, and they are told apart by **who owns them**. *Tool media* — the
model pulled it, by calling your tool — is the subject of this section. *Session media* — a person
attached it to a message — is a different path with a storage half, and is covered in
[MEDIA.md](MEDIA.md) along with everything a frontend or a storage backend has to provide.

**For tool media, the model pulls; nothing pushes.** A tool yields `model-content` — the inline arms of
`MessageContent` (`image` / `document` / `audio`), bytes plus a mime type — and the runner pins them
directly after the tool message they answer, splicing them into the **outgoing copy** for the rest of
the turn.

```ts
executor: {
  async *execute(input, ctx) {
    const png = await renderChart(input);
    yield { type: 'model-content', content: [{ type: 'image', mimeType: 'image/png', data: png }] };
    yield { type: 'result', value: { rendered: true, points: 240 } };
  },
}
```

Media is the exact mirror of a marker: a marker is persisted and invisible to the model; media is
visible to the model and **never persisted**. The transcript records what a tool *returned*, not the
bytes it *showed* — so a session cannot accumulate base64 and no exit path has to remember to strip
it. A later turn that needs the bytes calls the tool again, which is the same pull the model already
performed.

Two consequences worth designing around:

- **Rest-of-turn, not next-call-only.** Withdrawing content the model has already seen breaks the
  prompt cache from that point and leaves it referring to something no longer there. The cost
  corollary is real: a large document is re-sent on every subsequent round of the turn, so hand over
  the smallest thing that answers the question (a page range, a thumbnail) — and the provider's
  `maxRounds` bounds how often it is paid for.
- **No `FileStore` dependency.** `files` is optional on both `RunSessionOpts` and `ToolContext`, so
  routing media through it would make multimodal impossible without one. Core never asks where you
  got the bytes — a `FileStore`, an HTTP fetch, a chart rendered in memory. Storage reads are your
  concern; the loop's concern is the wire.

A tool that also wants the *user* to see something has `file` and `marker`. Media is deliberately not
a `PipelineEvent`: nothing durable backs it, so a frontend drawing it live would show something that
vanishes on reload.

**A result cannot substitute for the event.** A result is a value in the transcript, so base64 there is
4/3 of the file persisted *and* re-sent on every later round, for something the model still cannot see.
The two are not interchangeable and no description makes them so.

`workspace_action show` (`plugins/workspace/src/index.ts`) is the reference producer, and shows the two
decisions such a tool has to make: which mime types it will hand over at all (it refuses SVG and text
toward `read`, which gives the source and is the better answer anyway), and a size ceiling checked
against the handle's declared size *before* the read, because shown media is paid for once per round
rather than once.

---

## Notifications

`services.Notifier` is the one fan-out for every "something changed" fact — always present, and the
sanctioned way a plugin publishes an event. Do not build a private `watch()` stream over your own
broadcaster; matbot owns the envelope and the registration surface, and a registered distributed
`Notifier` can then forward everything off-box at once.

```ts
services.Notifier.notify({
  kind: ItemChangeKind, source: 'skill', operation: 'saved',
  namespace: 'skills', id, principal: currentPrincipal(),
});

services.Notifier.consume(n => { /* re-read through the store */ }, signal,
                          n => n.kind === ItemChangeKind);
```

`consume(handler, signal?, filter?)` is the fire-and-forget loop: it awaits each handler before
pulling the next, isolates a throwing one, and ends when `signal` aborts. `subscribe(signal?,
filter?)` is the same stream as a plain `AsyncIterable<Notification>` when you want to drive the
`for await` yourself. Both discriminants are filterable — `kind` selects the payload shape,
`instance`/`plugin`/`source` are attribution.

**Which kind do I publish?** `ItemChange` whenever the fact is "the thing addressed by
`(namespace, id)` is stale — re-read it", *whatever holds it*: a `Store` (wrap it in `notifyingStore`
and it is automatic), a `FileStore`, a directory you watch. It is deliberately not named
`StoreChange` — the medium is an implementation concern. Define a kind of your own only when you
carry something a consumer **cannot** get by re-reading: progress, a measurement, an external event.
That is a new shape, not a new source; `detail` is not the place to smuggle one.

```ts
export interface JobProgress extends NotificationBase { done: number; total: number }
export const JobProgressKind = '@fnarr/jobs#JobProgress' satisfies keyof Notifications;

declare module '@matatbread/matbot-plugin-api' {
  interface Notifications { '@fnarr/jobs#JobProgress': JobProgress }
}
```

**`kind` is `<package-name>#<InterfaceName>`, and nothing declares it twice** — the `Notifications`
key *is* the tag, so an arm never declares a `kind` field. It is qualified because, unlike a type
name, a `kind` is globally scoped and an importer *cannot* rename it out of a collision: two plugins
picking the same bare word is an unfixable declaration-merge conflict in a file neither owns. The
prefix names the package that **defines** the shape, never the one emitting it — `plugin` is the
emitter, and it is stamped for you from your plugin's scope. Don't use the emitter/kind pair as a
compound discriminant: relaying rewrites `plugin`.

Four rules follow from how the bus is built:

- **Identity, never value.** Events are queued per subscriber and are stale the moment a concurrent
  writer lands, so a consumer re-reads through the store. `detail` is advisory at most.
- **Re-query on attach.** A sink attaching mid-flight has missed what preceded it; the bus refuses to
  replay, so never put current state on it.
- **Emit where the change happens**, not where a tool call happens — a detached child's completion
  and an HTTP-created session are both real changes with no tool executor in scope.
- **Always `default` a `switch` over `kind`.** A foreign plugin or a bridged remote can publish one
  this build has never seen (see *Open-registry augmentation*).

`namespace` is an **address space, not a plugin** — `files` is emitted by workspace, by background,
and by the profiles backend; `sessions` has no plugin at all. `principal` is **ownership** (whose
data changed), not attribution — never conflate it with `plugin`/`source`.

---

## Knowledge index

The knowledge index is always present at `services.KnowledgeIndex`. The default is
`LookupKnowledgeIndex`, an in-memory implementation that scores by term-occurrence
frequency. Replace it at any time with `services.register('KnowledgeIndex', impl)` — the
swap drains the old index's entries into the new one.

```ts
interface KnowledgeIndex {
  index(entry: KnowledgeEntry): Promise<void>;
  remove(id: string): Promise<void>;                 // idempotent; id is the sole primary key
  search(terms: Array<{ term: string; context?: string }>, signal: AbortSignal): Promise<KnowledgeEntry[]>;
  entries?(): Iterable<KnowledgeEntry>;               // when present, a swap drains these into the new index
}
```

`index` replaces by `id`, so retraction is by `id` alone — the index never inspects an entry's
opaque `source`. Whoever indexed an entry owns retracting it (the skill manager retracts a hidden or
deleted skill), rather than the index policing its tenants.

The `@matatbread/matbot-rumsfeld` plugin registers a `contextual_search` tool that
queries the knowledge index when the model encounters an unknown term.
`@matatbread/matbot-persist-ki-bge` replaces the default with a persistent,
Store-backed index with optional Cloudflare BGE reranker.

---

## First-party plugins reference

| Package | Tools / Kind | Description |
|---|---|---|
| `@matatbread/matbot-tool-plugin` | `plugin`, `provider` · always loaded | Built-in: manage plugins (list/add/remove/reload/discover_local/store-key) and LLM provider profiles |
| `@matatbread/matbot-tool-bash` | `bash` | Run bash scripts; stream stdout/stderr |
| `@matatbread/matbot-tool-docker-bash` | `bash` (sandboxed), `bash_config` | Drop-in for bash, runs inside Docker; `bash_config` tunes the container at runtime |
| `@matatbread/matbot-tool-http` | `http` | Make HTTP requests |
| `@matatbread/matbot-tool-workspace` | `workspace_action` | Read/show/write/list/delete workspace files; `show` hands an image, PDF or audio clip to the model to look at |
| `@matatbread/matbot-tool-ask-user` | `ask_user` | Ask the user a question mid-turn (one-shot prompt) |
| `@matatbread/matbot-tool-background` | `background`, `every_action` | Detached background jobs — now, at a stated time, or on a recurring schedule |
| `@matatbread/matbot-tool-mcp` | `mcp_action` | Connect to MCP servers — stdio (local) and remote (delegates to mcp-http); Node only |
| `@matatbread/matbot-mcp-http` | `mcp_action` | Connect to HTTP/SSE MCP servers (Node + browser) |
| `@matatbread/matbot-sessions` | `session_action` | Session lifecycle: list, get, rename, hide |
| `@matatbread/matbot-edit-session` | `session_edit`, `compact_sessions` | Trim, branch, split, compact and LLM-summarise sessions |
| `@matatbread/matbot-triggers` | `trigger_action`, `triggers_config` (`screen`/`followup` hooks) | Data-driven hooks: stored conditions that invoke a tool when an LLM classifier judges them matched |
| `@matatbread/matbot-tool-json-validation` | `toolcall` hook | Validate tool inputs against their schema; the model self-corrects on mismatch |
| `@matatbread/matbot-skills` | `skill_action`, `skills_config` | Cross-runtime skill CRUD (named markdown playbooks) |
| `@matatbread/matbot-skills-node` | `skill_action` + file watch | Node specialization of `skills`: adds local `.md` import/watch |
| `@matatbread/matbot-tool-skill-compiler` | `skill_compiler` | Compile procedural markdown skills into executable TypeScript tool plugins |
| `@matatbread/matbot-function-tools` | `tool_function` | Author/run TypeScript functions that compose registered tools in one pass (define persists a named tool; lambda runs once) |
| `@matatbread/matbot-tool-router` | `ToolPresenter` (`tool_search`) | Serves a bounded per-turn tool window from a large library — pins + BM25-ranked tools + a `tool_search` entry point |
| `@matatbread/matbot-tool-store` | `store_action` (+ `defineStore`) | Define and expose named persistent stores with generated CRUD tools |
| `@matatbread/matbot-rumsfeld` | `contextual_search`, `find_fact` | Resolve unknown terms via the knowledge index (`contextual_search` returns a document; `find_fact` returns a precise answer) |
| `@matatbread/matbot-provenance` | `determine_provenance`, `provenance_config` | Trace a claim back to the tool result or user message it came from — or establish that nothing in the session accounts for it |
| `@matatbread/matbot-persist-ki-bge` | knowledge backend | Persistent KnowledgeIndex with optional BGE reranker |
| `@matatbread/matbot-cognition` | `ask_inner_voice`, `remember_fact`, `dream_time`, `cognition_config` + `remembered_facts_action` | Seeds the Inner Voice skill and a remembered-facts store; inner-voice critique, fact memory, background Dream Time consolidation |
| `@matatbread/matbot-tool-whoami` | `whoami` | Reports the current Principal |
| `@matatbread/matbot-tool-types` | `ToolTypeIndex` service · Node only | Derives a `.d.ts` of the loaded tools' result/service types so code generators can type what `tool` calls resolve to |
| `@matatbread/matbot-hook-logger` | diagnostic hooks | Logs each hook channel firing |
| `@matatbread/matbot-frontend-web` | frontend | Web UI with session management (HTTP+SSE on Node, in-process in the browser) |
| `@matatbread/matbot-frontend-dom` | frontend | Minimal in-process browser chat (the `matbot-demo.html` demonstrator) |
| `@matatbread/matbot-frontend-telegram` | frontend + tools | Telegram bot (`telegram_send`, `telegram_provider`, `telegram_open_door`) |
| `@matatbread/matbot-web-principal-user` | `WebPrincipalResolver` | Override the web frontend's request principal with the host OS user (`$USER`) |
| `@matatbread/matbot-provider-anthropic` | provider | Anthropic Messages API (+ DeepSeek `/anthropic` compat) |
| `@matatbread/matbot-provider-openai-compat` | provider | OpenAI-compatible chat completions |
| `@matatbread/matbot-provider-google` | provider | Google Gemini (native `generateContent`; OpenAI-compat fallback by endpoint path) |
| `@matatbread/matbot-provider-customer-services` | provider | Free built-in demo LLM — no API key needed |
| `@matatbread/matbot-provider-chatjimmy` | provider | Hosted llama endpoint — non-streaming, text-only, keyless; a very low-latency comparison point |
| `@matatbread/matbot-storage-filesystem` | storage backend | Filesystem-backed Store + FileStore (Node; content-addressed, CAS-safe; the CLI's default) |
| `@matatbread/matbot-storage-sqlite` | storage backend | SQLite-backed Store + FileStore (Node) |
| `@matatbread/matbot-storage-google-drive` | storage backend | Google Drive-backed Store + FileStore (browser; Google Identity Services auth) |
| `@matatbread/matbot-storage-profiles` | storage backend + `profile_action`, `share` | Partitions selected namespaces per web principal over the filesystem backend, so each profile gets its own slice (Node; list it first in `matbot.yaml`) |
| `@matatbread/matbot-browser` | storage + `plugin`/`provider` tools | Browser-native backends: IndexedDB Store, OPFS FileStore, WebCrypto vault, and browser plugin/provider management tools |
| `@matatbread/matbot-files-node` | `FileStore` | Node filesystem-backed FileStore for MIME-typed blobs, served by the frontend |

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
"exports": { ".": { "browser": "./src/browser.js", "import": "./src/index.ts", "default": "./src/index.ts" } }
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
   These are the browser analogue of Node's on-disk `plugins`. `discover_local`
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
- **Secrets** — held by `LocalStorageVault` (a `localStorage`-backed `WebCryptoVault`), persisted
  in plaintext. Single-user local use only.
- **Interactive `plugin add`** — requires a human click; cannot be driven
  non-interactively.
## Releasing

```
pnpm changeset          # describe the change (one file per change, committed with it)
pnpm version-packages   # consume changesets: bump versions, fold into CHANGELOGs
pnpm publish-check      # dry audit: what would publish, and what would stop it
pnpm publish-all        # preflight → publish → reconcile → verify
```

Every `@matatbread/*` package is in one **`linked`** group: a release versions only the packages that
actually changed, and those that do move together to one number. Everything else keeps the version it
last shipped at, so a release is no longer 45 identical bumps to say four things.

It was a `fixed` group, which released every package whether or not it had changed. Two measurements
retired it: a patch drags in no dependents at all (peer ranges are `workspace:^`, rewritten at pack time
from the dependency's own version, so there is nothing to update), and a *minor* on `plugin-api` escalates
every peer-dependent to `1.0.0` **whether the group is fixed or not** — at `0.x`, `^0.4.7` does not admit
`0.5.0`, so changesets treats each peer range as broken. `fixed` was only unifying the numbers; it never
prevented that, and the escalation stops for good at `>=1.0.0`.

`pnpm publish-all` (`scripts/publish.mjs`) treats **the registry, not a command's exit code, as the
source of truth**: preflight → canary → settle → reconcile → verify. It reads what npm actually
has, publishes only the difference, waits for those writes to become readable, retries anything the
batch left behind, and ends with a **Result block that states plainly how many packages are on npm
and names any that are not**. That sentence is the point of the script — a release should never
leave you reading scrollback to work out what shipped.

Two things it deliberately does *not* trust:

- **A subprocess's exit code.** `You cannot publish over the previously published versions` is a
  failure to *re*-publish something that already succeeded. Every publish result is confirmed by
  asking the registry for that exact version, never by matching the error text — which is also why
  it stays correct when the child inherits the terminal and prints nothing we can capture.
- **A read taken the instant a write returns.** npm's read path is a CDN that lags its write path;
  a brand-new package's first version has been measured taking over two minutes to appear. Acting
  on that read is what turns a *successful* release into a screen of E403s.

The practical consequence: **a failed release is fixed by running it again.** It resumes from live
registry state rather than replaying a transcript, so re-running skips what landed and finishes
what didn't. There is no manual clean-up path and no need to work out which of ~45 packages made it.

Preflight blocks on the things that kill a whole run — an expired npm token (checked against the
registry, because an expired token looks identical to a good one on disk), a dirty tree, an entry point
missing from disk or excluded by `files`, a `workspace:` range naming something unpublishable. A spread of
versions is no longer among them: under `linked` it is the expected state, so it is reported and got out
of the way. Anything that merely *ships
imperfectly* — a missing `files` field, changesets accumulated since this version was cut — warns
and gets out of the way.

`--check` audits without publishing, `--dry-run` runs everything but the publish calls, and
`--no-git` drops the clean-tree/tag gates for CI.

### The credential must be a granular access token

`npm login` writes a **browser-session** token. npm accepts it for reads — `npm whoami` is happy —
but demands a 2FA one-time code when you actually publish, whatever the account's 2FA mode says.
A batch publish has nowhere to prompt, so every package fails with `ERR_PNPM_OTP_NON_INTERACTIVE`.

Use a **Granular Access Token** instead (npmjs.com → Access Tokens → Generate New Token → Granular),
with Read/Write on the `@matatbread` scope, in `~/.npmrc`:

```
//registry.npmjs.org/:_authToken=npm_xxxxxxxx
```

Granular tokens publish without an OTP — that is what they are for. For a one-off release on a
session token, `pnpm publish-all --otp <code>` passes one code to the whole batch.

Note there is deliberately **no preflight check for this**. Reads and even a dist-tag write both
succeed on a credential that publishing will reject, so any such check would hand you a confident ✓
and then fail anyway. Instead the script publishes **one canary package first** and stops if it
fails — same cost, but you find out after one package rather than forty-five.

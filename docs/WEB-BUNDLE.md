# matbot in the browser — the web bundle

matbot ships as a **single self-contained `matbot.html`** that runs the entire runtime client-side:
the platform-neutral core plus the browser-safe plugins, type-stripped and wired together in-page.
Open it from a `file://` URL or any static host — once loaded, the page *is* matbot. It calls the
LLM directly over `fetch`; there is no Node server in the loop.

This document covers the **architecture and usage** of the web build. For the package-level build
mechanics (the assembler, the in-page loader, try-it-live link, CORS/storage caveats) see
[apps/web-bundle/README.md](../apps/web-bundle/README.md). For the project-wide design principles see
[CLAUDE.md](../CLAUDE.md).

---

## One UI, two transports

The headline: **the same client UI runs unchanged whether it's served from Node over HTTP+SSE or
hosted entirely in the browser in-process.** There is one `index.html` + one `app.js`
([plugins/frontend/web/src/](../plugins/frontend/web/src/)) — byte-identical in both
modes — and every server touch-point is routed through a single runtime global:

```js
const T = window.matbotTransport;   // set up before app.js runs
```

`app.js` is a classic script with **no imports**: Node serves it verbatim, and the bundle bakes it
in as a raw asset. Only the object behind `window.matbotTransport` differs. Two implementations
satisfy one contract:

| Provider | Where | How it talks to the runner |
|---|---|---|
| **`http-transport.js`** | Node-served (`frontend/web` server entry) | `fetch` + SSE to `server.ts` |
| **`browser.js`** | baked into the bundle (`frontend/web` browser entry) | drives `services.run` / `services.tools` **in-process**, no wire |

The contract (read it in [http-transport.js](../plugins/frontend/web/static/http-transport.js)):
`hostRuntime`, `callTool`, `createSession`, `sessionBusy`, `submit`, `sessionEvents`,
`answerPrompt`, `abort`, `statusEvents`, `fileEvents`, `toolEvents`, `pluginEvents`, `openFile`.
`statusEvents`/`fileEvents`/`toolEvents`/`pluginEvents` are read-only `AsyncIterable` observation
streams (session busy/idle, file changes, tool-registry CRUD, plugin load/unload); over HTTP each is
one SSE endpoint under the `/events/…` prefix, in-process each is the matching backend iterable
(e.g. `services.tools.watch()` / `watchPlugins()`) yielded directly. They let panels keyed off
tool/plugin presence (skills, plugins) refresh live when something loads out of band. (`sessionEvents`
is the per-session turn demux — one persistent stream per session, not a global observer.) The in-process side
([browser.js](../plugins/frontend/web/static/browser.js)) is essentially `server.ts`'s
coordination — the busy tracker, prompt parking, per-session subscribe, the buffered tool-call
context — re-expressed without HTTP. Streaming is the same `AsyncIterable<PipelineEvent>` the runner
emits natively; in-process is simply that iterable, HTTP demuxes it back out of one SSE stream.

All SSE streams live under a dedicated `/events/` prefix — `GET /events/sessions` (busy/idle),
`/events/sessions/:id` (per-session turns) and `/events` (one multiplexed global stream carrying
`session-busy` plus every `notification`, which replaced the per-kind `/events/files`,
`/events/files/:ns/:name`, `/events/tools` and `/events/plugins` streams) — so no author-controlled
path segment can shadow a route (a tool named `events` no longer collides with `POST /tools/:name`).

### The `browser` export condition

`frontend/web` is one package that answers to both runtimes via a standard export condition
([package.json](../plugins/frontend/web/package.json)):

```jsonc
"exports": { ".": { "browser": "./src/browser.js", "import": "./src/index.ts", "default": "./src/index.ts" } }
```

- **Node** resolves `["node","import"]` → `index.ts` → `server.ts` (the HTTP server). Unchanged.
- **The assembler** prefers the `browser` condition → `browser.js` (the in-process mount). So
  `server.ts` and `node:http` never enter the browser graph.

No separate package, no duplicated UI — the same `app.js` + `index.html` are shared, and `browser.js`
is just the thin frontend plugin that, on `setup(services)`, sets `window.matbotTransport`, injects
the baked scaffold + `app.js`, and mounts.

---

## Two bundles

`pnpm web-build` produces both artifacts (each from its own config in
[apps/web-bundle/](../apps/web-bundle/)):

| Output | Config | Frontend | Purpose |
|---|---|---|---|
| **`dist/matbot.html`** | `matbot.web.json` | `frontend/web` (browser entry) | The default, full-featured UI — sessions sidebar, files, plugin manager, markdown, the works. |
| **`dist/matbot-demo.html`** | `matbot.web-demo.json` | `frontend/dom` | A minimal ~450-line in-process demonstrator, kept deliberately simple. |

```bash
pnpm web-build          # both bundles
# under the hood:
#   assemble.mjs                       → dist/matbot.html
#   assemble.mjs matbot.web-demo.json  → dist/matbot-demo.html
```

A given bundle hosts exactly one frontend; the two never coexist.

---

## The plugin model (mirrors Node)

The browser has no `matbot.yaml`. Its `matbot.web.json` is the analogue, and plugins fall into
**three layers** — the same shape as Node, just sourced differently:

1. **Auto-load core — `plugins[]`.** Loaded at boot, like `matbot.yaml`'s `plugins`. Kept minimal:
   just **`browser`** (IndexedDB/OPFS storage + the `plugin` tool) and **`frontend/web`** (the UI).
   Nothing else auto-loads.

2. **Baked-but-idle — `bundledPlugins[]`.** Baked into the artifact *and* the import map but **not**
   auto-loaded. They're the browser analogue of Node's on-disk `plugins` — present, ready,
   and offered for on-demand activation. The `browser` plugin tool's **`discover_local`** action
   lists them (with `specifier` = their package name); the UI's plugin panel and "enable" banners
   surface them. Loading one is a single `plugin add`.

3. **Remote — a URL.** `plugin add https://…` fetches raw `.ts`, type-strips it in-page (sucrase from
   a CDN), and loads it. Requires http (not `file://`) and the network.

### Why baked-but-idle matters: persistence

User-added plugins are persisted (in IndexedDB by the `browser` plugin) and **replayed on reload**.
The specifier you persist therefore has to re-resolve on the next boot — and this is where the
layers differ sharply:

- A **baked** plugin loaded by its **package name** re-resolves every boot through the import map to
  a fresh blob — **no network, works on `file://`, survives refresh.** This is the good path.
- A `mbmod:` synthetic id or a `/plugins/…` HTTP path does *not* survive cleanly (ephemeral blob, or
  http-only re-fetch).

So the `browser` plugin tool **canonicalizes what it persists**: after a successful load, if the
plugin is baked (its name is a key in the bundle's `packageEntries`), it persists the **package
name**; only genuinely remote plugins keep their URL
([plugin-tool.ts](../plugins/browser/src/plugin-tool.ts)). The package name is also the one
specifier common to Node and the browser. Net effect: enable a bundled plugin once, and it sticks
across reloads.

### Immutable baked config

The auto-load `plugins[]` are baked into the artifact, so they can't be removed at runtime — the
`plugin remove` action only manages the persisted user-added set (the mutable layer). To drop a
core plugin, remove it from `matbot.web.json` and rebuild. (See the "disabled set" note below if you
ever want runtime opt-out.)

### Adding / trimming plugins

Edit [matbot.web.json](../apps/web-bundle/matbot.web.json) and re-run `pnpm web-build`:

- Move a plugin between `plugins` (auto-load) and `bundledPlugins` (baked-but-idle).
- Drop it from both to shrink the bundle — it can still be added at runtime from a URL.
- `providerModules` are the adapter *types* the first-run wizard offers (not pre-configured providers).

---

## How it's assembled

A single Node step, no bundler — every module stays a module, wired by an import map at runtime
(the browser mirror of Node's `apps/cli/ts-hooks.js`):

1. **[assemble.mjs](../apps/web-bundle/assemble.mjs)** walks the static import graph from
   `bootstrap.ts` + the configured plugins, type-strips each `.ts` with **sucrase**, and inlines the
   resulting JS modules + the loader into one HTML. It also:
   - prefers each package's **`browser`** export condition (so `frontend/web` → `browser.js`);
   - bakes `bundledPlugins` as graph roots and adds their **package names to `packageEntries`** (so
     the import map carries them) without auto-loading them, emitting them as `config.availablePlugins`;
   - bakes raw **`assets`** (the `index.html` scaffold + `app.js`) verbatim for `browser.js` to inject.
2. **[loader.js](../apps/web-bundle/src/loader.js)** runs first in the browser: rewrites relative
   imports to `mbmod:` ids, blob-ifies each module, and publishes one import map mapping **every
   package name and every synthetic id** to its blob. Bare `@matatbread/*` imports are left untouched
   so host and plugins share one module instance (the `instanceof` singleton boundary).
3. **[bootstrap.ts](../apps/web-bundle/src/bootstrap.ts)** is just another inlined module: it builds
   `MatbotServices`, installs the constant principal carrier, and runs the real `loadPlugins` /
   resolver / `SessionRunner` unchanged.

Everything is in-memory (blobs + import map, no service worker, no `fetch`, no in-page stripping),
so the baseline boots instantly and runs identically from `file://` or any static host. Sucrase is
lazy-loaded from a CDN only for *runtime remote* `.ts` plugin loading — never for the baseline boot.

---

## Caveats

A demonstrator, not a hardened product. The key ones (full list in
[apps/web-bundle/README.md](../apps/web-bundle/README.md)):

- **CORS** — the browser calls the LLM endpoint directly; pick a provider that allows browser
  access (DeepSeek, Azure, a local/proxied endpoint) or front it with a CORS-enabled gateway.
- **`file://`** — IndexedDB works; OPFS (workspace files) and runtime remote plugin loading need http.
- **Secrets** persist in `localStorage`/the browser vault in plaintext — single-user local use only.
- **Interactive `plugin add`** confirms out-of-band (the same security break as Node), so it needs a
  human click — it can't be driven non-interactively.

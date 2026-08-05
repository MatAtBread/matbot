# @matatbread/matbot-web-bundle

A **browser-only matbot**: the platform-neutral core and the browser-safe plugins, assembled into a
single self-contained `matbot.html` that runs entirely client-side. Open it from a `file://` URL or
serve it from any static host — once loaded, the page *is* matbot. It talks to the LLM directly over
`fetch`; there is no node server in the loop.

This exists to stress-test the core architecture, not to be a product. It is an MVP someone could
build on.

> For the architecture — the unified UI/transport model, the two bundles, and the baked-but-idle
> plugin model — see **[WEB-BUNDLE.md](../../docs/WEB-BUNDLE.md)**. This README covers the package-level
> build mechanics and caveats.

**Try it live (no checkout needed):** [open the latest build](https://matatbread.github.io/matbot/apps/web-bundle/dist/matbot.html)
— served from the committed `dist/matbot.html`

## Build & run

```bash
pnpm web-build    # → dist/matbot.html (rich UI) + dist/matbot-demo.html (minimal dom demonstrator)
open apps/web-bundle/dist/matbot.html # file:// — just works

# or, to also exercise runtime *remote* plugin loading (which fetches .ts over http):
pnpm web-server    # → http://localhost:9778/
```

On first launch a setup form asks for the **full provider config** — a name, the adapter type
(Anthropic-compatible, OpenAI-compatible, or Google Gemini), the endpoint URL, the model, and the API key — and persists it
(config in `localStorage`, key in the vault). No OpenAI/Anthropic account needed: point it at
DeepSeek, Azure, a local server, or anything compatible. The header's provider dropdown has a
**＋ Add provider…** entry to configure more later.

## How it works — one assemble step, no bundler

There is a single node assemble step and no bundler: every module stays a separate module, wired
together by an import map at runtime. The mechanism is the browser mirror of the node app's
`apps/cli/ts-hooks.js`:

1. **`assemble.mjs`** (the only node step) walks the static import graph from `src/bootstrap.ts` and
   every configured plugin, type-strips each `.ts` file with **sucrase** (a pure-JS stripper — no
   native binary, no postinstall; it transforms `.ts`→`.js` per-module and rewrites nothing else),
   and inlines the resulting JS modules — plus the in-page loader — into one HTML file. The
   TypeScript compiler is **not** inlined.
2. **`src/loader.js`** runs first in the browser. The modules arrive already type-stripped, so it
   does **no** compiling at boot: it rewrites each module's **relative** imports to synthetic
   `mbmod:<id>` specifiers, turns each into a `blob:` URL, and publishes one **import map** mapping
   every package name and synthetic id to its blob. Bare `@matatbread/*` imports are left untouched
   so the host and every plugin resolve to the **same module instance** — the singleton boundary that
   the ambient principal carrier, the shared registry state and `declare module` augmentation all
   depend on, exactly as `ts-hooks.js` protects in node. (Error identity deliberately does *not*
   depend on it: plugin-api's errors are branded, not classes, so they survive a split tree — see
   [duplicate-singletons.md](../../docs/duplicate-singletons.md).) (Sucrase is lazy-loaded from a CDN
   only for *runtime* remote `.ts` plugin loading — see the caveat below — never for the baseline
   boot.)
3. **`src/bootstrap.ts`** is just another inlined module. It builds `MatbotServices` (the browser
   analogue of `apps/cli/src/index.ts`), installs the constant principal carrier, and runs the real
   `loadPlugins` / resolver / `SessionRunner` unchanged. The whole architecture runs as-is.

Because everything is in-memory (blobs + an injected import map, no service worker, no `fetch`, no
in-page stripping), the baseline boots instantly and runs identically from `file://` or any static
host.

## What's a plugin here (not core)

The web defaults are plugins, never core packages. The **auto-load core** (`matbot.web.json` →
`plugins`) is kept minimal — just two:

- **`@matatbread/matbot-browser`** — the storage backend (IndexedDB `Store`s + OPFS `FileStore`),
  the `LocalStorageVault`, and the browser `plugin` management tool. It also persists user-added
  plugins and replays them on reload.
- **`@matatbread/matbot-frontend-web`** (browser entry) — the full-featured in-process UI: the same
  `index.html` + `app.js` the Node server serves, mounted with no wire. (The `matbot-demo.html`
  bundle swaps this for **`@matatbread/matbot-frontend-dom`**, a minimal ~450-line demonstrator.)

Everything else browser-safe — `http`, `ask-user`, `sessions`, `edit-session`, `workspace`,
`rumsfeld`, `triggers`, `skills`, `mcp-http`, `whoami`, `hook-logger`, `persist-ki-bge`,
`json-validation`, `tool-store`, `function-tools`, `tool-router`, `cognition`, and the
`storage/google-drive` backend — is **baked-but-idle** (`bundledPlugins`): in the artifact and the
import map but not auto-loaded, offered via the `plugin` tool's `discover_local` and loaded on demand
by package name (which persists across reloads). The provider adapters (anthropic / openai-compat /
google Gemini — pure `fetch`) are inlined as wizard-selectable *types* rather than pre-configured
providers — including **customer-services**, a free self-contained demo LLM the wizard offers with no
endpoint or API key required (zero-config first run). Node-only plugins (`bash`, `docker-bash`, the stdio `mcp`
plugin, `skills-node`, the node web frontend's server entry) are omitted — they need Node primitives.
Note the MCP split: the stdio `@matatbread/matbot-tool-mcp` is Node-only, but the cross-runtime
`@matatbread/matbot-mcp-http` (HTTP/SSE servers) *is* bundled. Likewise the base `skills` plugin is
cross-runtime and bundled; only its `skills-node` filesystem specialization is Node-only. See
[WEB-BUNDLE.md](../../docs/WEB-BUNDLE.md) for the three-layer plugin model.

Built-in tools `plugin` (list/add/remove/reload/discover_local/store-key) and `provider` (list/add/remove) are present too,
so the model can manage plugins and provider profiles at runtime. These are browser-native
reimplementations: the node versions edit `matbot.yaml` via `node:fs`, so they couldn't be reused —
the browser ones drive the same store/vault/localStorage persistence instead (the *capability* is
portable; the node tools' file I/O was the only thing that wasn't).

Edit `matbot.web.json` to change the plugin set or the adapter types the wizard offers
(`providerModules`), then re-assemble. You can also pre-bake providers there (the `providers` map) if
you don't want the wizard.

## Caveats (it's a demonstrator)

- **CORS**: the browser calls the LLM endpoint directly. Providers that don't send permissive CORS
  headers (e.g. `api.anthropic.com` by default) will block the request. Point a provider at a
  CORS-enabled gateway/proxy, or use one that allows direct browser access.
- **`file://` storage**: IndexedDB works; OPFS (used only by `workspace_action`) may be unavailable
  on `file://` in some browsers — serve over http if you need it.
- **Runtime remote plugin loading** (`plugin add <url>`) requires http (not `file://`) and a recent
  browser; it fetches raw `.ts` and type-strips it in-page, lazy-loading sucrase from a CDN on first
  use (so that one path needs network). The inlined baseline has neither requirement.
- **Size**: ~530 KB for the full UI (`matbot.html`), ~270 KB for the minimal `matbot-demo.html` —
  the build-time-stripped JS modules and the loader, nothing else. No compiler is inlined.
- Secrets persist in `localStorage` in plaintext — single-user local use only.

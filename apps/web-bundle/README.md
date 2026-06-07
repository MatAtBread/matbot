# @matatbread/matbot-web-bundle

A **browser-only matbot**: the platform-neutral core and the browser-safe plugins, assembled into a
single self-contained `matbot.html` that runs entirely client-side. Open it from a `file://` URL or
serve it from any static host — once loaded, the page *is* matbot. It talks to the LLM directly over
`fetch`; there is no node server in the loop.

This exists to stress-test the core architecture, not to be a product. It is an MVP someone could
build on.

**Try it live (no checkout needed):** [open the latest build](https://raw.githack.com/MatAtBread/matbot/main/apps/web-bundle/dist/matbot.html)
— served from the committed `dist/matbot.html` via githack. (Points at `main`; until `feat/web-bundle`
merges, use the [branch link](https://raw.githack.com/MatAtBread/matbot/feat/web-bundle/apps/web-bundle/dist/matbot.html).)

## Build & run

```bash
pnpm --filter @matatbread/matbot-web-bundle assemble   # → dist/matbot.html
open apps/web-bundle/dist/matbot.html                  # file:// — just works

# or, to also exercise runtime *remote* plugin loading (which fetches .ts over http):
pnpm --filter @matatbread/matbot-web-bundle serve      # → http://localhost:8787/
```

On first launch a setup form asks for the **full provider config** — a name, the adapter type
(Anthropic- or OpenAI-compatible), the endpoint URL, the model, and the API key — and persists it
(config in `localStorage`, key in the vault). No OpenAI/Anthropic account needed: point it at
DeepSeek, Azure, a local server, or anything compatible. The header's provider dropdown has a
**＋ Add provider…** entry to configure more later.

## How it works — no build step, no bundler

The novel part is loading `.ts` plugins in the browser with no compile/bundle pipeline. The mechanism
is the browser mirror of the node app's `apps/cli/ts-hooks.js`:

1. **`assemble.mjs`** (the only node step) walks the static import graph from `src/bootstrap.ts` and
   every configured plugin, slurps each `.ts` file **verbatim** (it transforms nothing), and inlines
   the sources — plus the TypeScript compiler and the in-page loader — into one HTML file.
2. **`src/loader.js`** runs first in the browser. It type-strips every module with the inlined
   `typescript` compiler (`ts.transpileModule`), rewrites each module's **relative** imports to
   synthetic `mbmod:<id>` specifiers, turns each into a `blob:` URL, and publishes one **import map**
   mapping every package name and synthetic id to its blob. Bare `@matatbread/*` imports are left
   untouched so the host and every plugin resolve to the **same module instance** — the singleton
   boundary that `instanceof` (e.g. `MissingSecretError`) depends on, exactly as `ts-hooks.js`
   protects in node.
3. **`src/bootstrap.ts`** is just another inlined module. It builds `MatbotServices` (the browser
   analogue of `apps/cli/src/index.ts`), installs the constant principal carrier, and runs the real
   `loadPlugins` / resolver / `SessionRunner` unchanged. The whole architecture runs as-is.

Because everything is in-memory (blobs + an injected import map, no service worker, no `fetch`), the
baseline runs identically from `file://` or any static host.

## What's a plugin here (not core)

The web defaults are plugins, never core packages:

- **`@matatbread/matbot-browser`** — the storage backend (IndexedDB `Store`s + OPFS `FileStore`),
  the `LocalStorageVault`, and the browser `plugin` management tool. It also persists user-added
  plugins and replays them on reload.
- **`@matatbread/matbot-frontend-dom`** — an in-process chat UI that drives `services.run` directly
  (the same contract a remote frontend uses over SSE, minus the wire).

Configured (browser-safe) plugins: `http`, `ask_user`, `session_action`, `session_edit`,
`workspace_action`, `contextual_search`, and json-validation. The provider adapters (anthropic /
openai-compat — pure `fetch`) are inlined as wizard-selectable *types* rather than pre-configured
providers. Node-only plugins (`bash`, `docker-bash`, `mcp`, `skills`, the node web frontend) are
omitted — they need Node primitives.

Built-in tools `plugin` (list/add/remove/store-key) and `provider` (list/add/remove) are present too,
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
  browser; the inlined baseline has no such requirement.
- **Size**: ~9 MB, almost entirely the inlined TypeScript compiler. Fine for a local demonstrator;
  pre-stripping the host at assemble time is the obvious diet if it ever matters.
- Secrets persist in `localStorage` in plaintext — single-user local use only.

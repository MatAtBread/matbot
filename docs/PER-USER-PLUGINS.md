# Per-user plugins and multi-user matbot

matbot plugins are **process-global**: a plugin's `setup()` runs once, at boot, and registers tools,
hooks, providers, system-context and stores into a single shared registry. There is no per-user
plugin set inside one process. But the *surfaces* a plugin installs are consulted **inside the turn's
`runAs(principal)` scope**, so each can read `currentPrincipal()` and behave per user.

That split is the whole story, and it yields two deployment models plus one recipe. The models and
recipe lead; the rationale that justifies each step is annotated at the end.

For project-wide design principles see [CLAUDE.md](../CLAUDE.md) (especially *Service registry*,
*Security principal*, and *Hooks*).

---

## Viable multi-user models

| Model | Per-user plugin *sets* | Per-user *gating* / data | Cost |
|---|---|---|---|
| **Process-per-user** — one matbot per user, each booted with its own config | **Yes** — separate registry, code, and state per process | Yes | Needs a fronting reverse proxy to route HTTP by user (one process can't rebind the listen port); full process/memory cost per user |
| **Standalone multi-user server** — one matbot, many users *(the recipe below)* | **No** — one global registry; everyone shares the installed set | Yes — identity, install rights, invocation, data and prompt all branch per user | Cheap; capabilities are a common set, *gated* not *partitioned* |
| **Single-tenant / browser realm** | N/A — one principal per realm | N/A | Trivial; per-tenant = per-bundle/per-config at build or boot |

**Process-per-user** is the only path to genuinely isolated per-user plugin sets — it sidesteps the
global registry by giving each user their own process. Its cost is orchestration: a reverse proxy in
front, because the processes cannot share a listening port.

The **standalone multi-user server** is the common case and the subject of the recipe: one process,
one global plugin set, every *behaviour* made per-user on top. The one thing it cannot do is vary
which tools a user can *see* (see *the tool-visibility ceiling* below).

---

## Recipe — a user-aware multi-user web frontend (single process)

> **Mental model:** you do not make plugins user-aware; you make their **surfaces** user-aware.
> `setup()` is global and runs once at the boot principal, but tools, hooks, system-context
> contributors and stores all run inside the per-turn `runAs(principal)` scope
> ([session-runner.ts:204](../core/src/session-runner.ts#L204)), so each reads
> `currentPrincipal()` and branches per user.

### Step 0 (foundational) — establish per-user identity

Nothing else works without this. Register a `WebPrincipalResolver`
([frontend/web/src/server.ts](../plugins/frontend/web/src/server.ts)) that derives the user
from each HTTP request (cookie, auth header, token, mTLS):

```ts
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices { WebPrincipalResolver?: WebPrincipalResolver; }
}

await services.register('WebPrincipalResolver', (req) => ({
  id:   userIdFromRequest(req),   // your auth
  type: 'user',
}));
```

The web server reads this **per request** and wraps the request in `runAs(principal, …)`, freezing
the identity into the queued submission. **The default resolver returns one constant identity for
every request** — so skip this and `currentPrincipal()` is identical for all users, making every gate
below a silent no-op. (`plugins/web-principal-user` is a working template.) Register it
**before** the submit it should affect — a resolver hot-loaded mid-turn won't retro-stamp that turn.

### Step 1 — close the install seam (bootstrap plugin)

Boot with a **minimal config listing exactly one plugin**. Its `setup()`:

1. reads a manifest from a store/file/DB,
2. calls `services.loadPlugin(...)` for each entry, and
3. registers a tool named `plugin` that **shadows the built-in one**, branching on
   `currentPrincipal()`: ordinary users → reject `add`/`remove`; admins → CAS the manifest, then
   `loadPlugin`/`unloadPlugin`.

This makes *installation* a per-user decision. Mechanics and gotchas (boot re-entrancy, shadow-not-
omit, the collision default, fail-closed on unload) are in *Bootstrap mechanics* below. Note the
residual: a plugin an admin installs is visible to **all** users (visibility is global — see the
ceiling below); install-gating decides who can *change* the set, not who *sees* it.

### Step 2 — gate tool invocation at **every** entry point

Tool execution has more than one entry point, and **each is its own enforcement point.** There is no
single hook that covers them all — by design (see *Why gating is per-entry-point* below).

**Runner path (model-driven turns) — a central `toolcall` hook.** It fires for *every* tool call
regardless of which plugin owns the tool, including plugins an admin loads later
([hooks.ts](../plugin-api/src/hooks.ts) `runToolCall`;
[runner.ts:201](../core/src/runner.ts#L201)), so one hook in the bootstrap plugin is
the whole-system chokepoint *for this path*:

```ts
services.hooks.register({
  on: 'toolcall',
  handler: ({ toolCall }) => {
    const user = currentPrincipal();
    if (!policyAllows(user, toolCall.name)) {
      return { rejectTool: `${toolCall.name} is not available to ${user.id}` };
    }
  },
});
```

Make `policyAllows` **default-deny / allowlist** for sensitive tools — because visibility is global,
the model *sees* and can *attempt* every tool, including admin-added ones.

**Direct-call paths bypass the hook — the frontend must re-enforce.** The web server's
`POST /tools/:name` and `POST /stream/tools/:name` call `tool.executor.execute(...)` **directly**
([server.ts](../plugins/frontend/web/src/server.ts)); the in-process `browser.js` `callTool`
does the same. **Neither invokes `runToolCall`** — the `toolcall` hook fires *only* inside the runner
loop. So **a plugin that exposes tool execution outside the runner (any frontend, web service, RPC
surface) must re-implement the same gating in its own handler.** `currentPrincipal()` *is* available
on those paths (the web server wraps each request in `runAs`), so the check is straightforward — it is
just *yours* to perform, not the runner's.

**Factor the policy, not the logic.** Put the decision in one place — a shared `policyAllows`
function or a small registered authorization service — and *enforce* it at each entry point (the
`toolcall` hook **and** the `/tools` handler). One decision point, several enforcement points.

### Step 3 — per-user data

The default `Store`/`FileStore` do **not** partition by principal — sessions carry `ownerPrincipalId`
but nothing enforces it ([storage/filesystem/src/store.ts](../plugins/storage/filesystem/src/store.ts)).
Two in-model options:

- **Principal-aware `StorageBackend`** (`register()`-swappable core service): a backend whose
  `createStore` partitions keys by `currentPrincipal()`, isolating *all* plugins' stores at once —
  the clean system-wide option.
- **Per-plugin key namespacing**: a plugin prefixes its own keys with `currentPrincipal().id`.
  Localised; each plugin must remember to do it.

Either is correct because `currentPrincipal()` is live at every store call inside a turn.

### Step 4 (optional) — per-user system prompt

System-context contributors are rebuilt **every turn** inside the principal scope
([system-context.ts](../core/src/system-context.ts);
[runner.ts:80-88](../core/src/runner.ts#L80-L88)), not captured at registration. A
contributor may call `currentPrincipal()` and emit per-user instructions (role, tenant rules,
persona).

### What you get, and the one thing you don't

| Concern | Per-user? | Mechanism |
|---|---|---|
| Identity | ✅ | `WebPrincipalResolver` (Step 0) |
| Who may install plugins | ✅ | shadowed `plugin` tool (Step 1) |
| Who may *invoke* a tool | ✅ | `toolcall` hook **+** frontend re-enforcement (Step 2) |
| Data isolation | ✅ | principal-aware `StorageBackend` or key namespacing (Step 3) |
| System prompt | ✅ | per-turn system-context contributor (Step 4) |
| **Which tools a user can *see*** | ❌ | **global** — the model's tool list is built outside the principal scope; gating is reject-at-invocation, never hide-from-menu |

A fully user-aware multi-user web frontend **is** buildable in one process. The single irreducible
limitation is **tool visibility**: every user's model sees the same menu, and admin-added plugins
enlarge it for everyone. If a deployment cannot tolerate that exposure (a tenant must not even *know*
another tenant's tools exist), that is the line at which you move to **process-per-user**.

---

## Rationale and constraints

### The loader is not the security seam

`loadPlugin`/`unloadPlugin` are hardcoded **core members** of `MatbotServices`, not
`register()`-swappable — `unifyServices` throws on `services.loadPlugin = …`, and `register` won't
accept them ([plugin-api/src/plugin.ts](../plugin-api/src/plugin.ts)). A plugin cannot
override them. Their *implementation* lives in the app entry, not core
([apps/cli/src/index.ts](../apps/cli/src/index.ts);
[apps/web-bundle/src/bootstrap.ts](../apps/web-bundle/src/bootstrap.ts)).

But that openness is not a hole, because **`services.loadPlugin` is not reachable by the model** — it
is plugin-code-facing. The model reaches it only *through a registered tool*
([runner.ts](../core/src/runner.ts) wraps it onto `ToolContext`; the built-in `plugin`
tool calls `ctx.loadPlugin` in [tool-plugin/src/tools/plugin.ts](../plugins/tool-plugin/src/tools/plugin.ts)).
So the real question is not "is the seam open?" but **"which registered tools reach it?"** In a stock
config that is the always-present built-in `plugin` tool — which is exactly why Step 1 shadows it. The
closure rests on one auditable assumption you now control: no manifest-listed plugin re-exposes
`loadPlugin` through an ungated tool of its own.

### The global registry and the tool-visibility ceiling

The registry — `state.plugins`, the tool map, providers, hooks
([registry.ts](../core/src/registry.ts)) — is one module-scoped object shared by every
concurrent session. `loadPlugin` mutates it globally; a bootstrap `setup()` runs once, at the boot
principal.

The toolset the model sees is built by `deps.tools.list()` at
[session-runner.ts:194](../core/src/session-runner.ts#L194) — **one line before**
`runAs(head.principal, …)` opens the principal scope at line 204. So `currentPrincipal()` is **not even
established** when the menu is assembled. This is why re-implementing `ToolRegistry` the way you'd
re-implement `Store` cannot rescue per-user *visibility*: `list()` has no principal to branch on.

*Invocation*, by contrast, runs inside the scope — `resolve()` at
[runner.ts:193](../core/src/runner.ts#L193) and the `toolcall` hook both see the
principal — which is why per-user *gating* works while per-user *visibility* does not.

**Why `Store` escapes this and plugins don't.** `Store`/`FileStore`/`Vault`/`KnowledgeIndex` can be
made principal-transparent because every operation is a per-call lookup *inside* the turn, so the
ambient principal is always in scope. Plugins fail on two counts `Store` does not: loading is global,
once, at the boot principal (no per-user load to specialise), **and** the read surface that feeds the
model (`list()`) is consulted outside any principal scope. The `Store` ceiling is liftable; the
plugin-visibility ceiling is structural.

### Bootstrap mechanics and gotchas

- **Boot re-entrancy works.** `services.loadPlugin` is wired before any plugin's `setup()` runs, so a
  nested load from inside `setup()` goes through `loadPlugins → registerPlugin → setupPlugin`
  sequentially; `registerPlugin` throws on duplicate names and the global `state` mutations don't
  interleave.
- **Shadow, not omit.** The built-in `plugin` tool is hardcoded into `createBuiltinTools()`
  ([tool-plugin/src/index.ts](../plugins/tool-plugin/src/index.ts)) and seeded before any config
  plugin loads — you cannot exclude it, only register a same-named tool over it. That triggers
  `resolveToolCollision` ([registry.ts](../core/src/registry.ts)): **non-interactive**
  (boot / HTTP installs, no `prompt`) → overwrites by default, your tool wins; **interactive** →
  prompts Keep / Overwrite / Always. The registry `Map` is keyed by name, so the later `register()`
  replaces the earlier entry.
- **Shadow, not stack.** Because the `Map` overwrites, the built-in is *gone*, not suspended — if your
  bootstrap plugin is ever unloaded, `removeByPlugin` deletes the `plugin` entry and the built-in is
  **not** restored. This fails **closed** (no plugin tool at all), which is safe but deliberate.
  Self-reload is fine (collision where `existing.pluginName === plugin.name` is skipped).
- **The non-interactive overwrite default is load-bearing.** It is what lets the override win at boot
  with no human present. If that ever changed to fail-closed, your override would silently lose and
  the built-in would stay live — re-opening the seam. Defend with an assertion after load:
  `services.tools.resolve('plugin')?.pluginName === <your plugin>`.

### Why tool gating is per-entry-point, not a single hook

The `toolcall` hook covers the runner path only. It deliberately does **not** extend to the web
frontend's direct `/tools` endpoints, and that is the correct design, for three reasons:

1. **Hooks are the runner's lifecycle mechanism.** They fire at the runner's turn lifecycle points;
   the runner owns their context. The direct `/tools` path is a *different entry point* that bypasses
   the runner on purpose (a "run this tool now" affordance, not a model turn).
2. **The contexts don't match.** A `toolcall` handler's ctx carries `session`, `config`, `tool`,
   `toolCall` — turn-shaped. The direct path has no turn: it fabricates a stub session, no provider
   config, no history, no trace lineage. Firing the hook there would hand handlers a context that
   misrepresents itself (a handler inspecting `session` history would misbehave).
3. **A generic or frontend-specific hook would be worse.** `Hook` is a closed discriminated union
   keyed by `on`, each channel typed to the effects it honours — a generic "register any hook"
   facility discards that. A frontend-specific channel would couple every gating plugin to one
   particular frontend.

Because **there is no base frontend** — every frontend is itself a plugin, i.e. userland code with
`currentPrincipal()` in scope — the obligation falls naturally on it: **a plugin that exposes tool
execution outside the runner must re-implement the same gating in its own handler.** Share the
*policy* (one decision function / service); enforce it at each *entry point*.

*Integrator footnote:* the one true cross-path chokepoint is a principal-aware `ToolRegistry.resolve()`
— both paths call `resolve()` inside `runAs`. But `services.tools` is a core member (substitutable
only at the app entry, not via a plugin), and `resolve()` cannot feed a rejection message back to the
model (it would read as "tool not found"), so it is a weaker fit than per-entry-point enforcement.

### Platform note — the web bundle

In the browser the question is largely moot: a realm is single-principal by construction
(`createConstantPrincipalCarrier`), so there is one user per tab and the global registry *is* that
user's. `loadPlugin` fetches + type-strips into an ephemeral `blob:` URL with `bustCache: false`, and
a true reload is a realm reload ([apps/web-bundle/src/bootstrap.ts](../apps/web-bundle/src/bootstrap.ts)).
Per-tenant differentiation is per-bundle/per-`BrowserConfig` at build time, not a runtime bootstrap.
The in-process `browser.js` `callTool` shares the same direct-execution / hook-bypass shape as the
HTTP `/tools` path, so the Step 2 re-enforcement rule applies there too.

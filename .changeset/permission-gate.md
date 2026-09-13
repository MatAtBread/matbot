---
'@matatbread/matbot-plugin-api': patch
'@matatbread/matbot-core': patch
'@matatbread/matbot-cli': patch
'@matatbread/matbot-web-bundle': patch
'@matatbread/matbot-default-gate': patch
'@matatbread/matbot-tool-plugin': patch
'@matatbread/matbot-mcp-http': patch
'@matatbread/matbot-tool-mcp': patch
'@matatbread/matbot-browser': patch
'@matatbread/matbot-frontend-web': patch
---

PermissionGate: privileged operations declare, a replaceable policy decides

**Breaking: `default_settings.__matbot_core__.overwriteToolsOnCollision` is gone**, in both forms —
the stored answer and the configured floor — and is deliberately not migrated. The standing answer is
re-offered the first time that collision comes round again, so restoring it is one click at the next
prompt; it now lives under the default policy's own namespace and spelling:

```yaml
default_settings:
  '@matatbread/matbot-default-gate':
    'tools.overwrite': [bash, plugin]
```

(The `string[]` form added earlier in this cycle moved with it; the same list, keyed by gate id.) An
install that still authors the old key is warned at boot, naming where it went — the value is not
adopted, only the silence is fixed.

A privileged operation — installing a plugin, adding a provider profile, connecting an MCP server,
overwriting a tool another plugin owns — used to do two jobs at the call site: decide *that*
acceptance was needed, and implement *how* it was obtained. The second job had already grown past a
prompt (core held a settings key, a cached memo, a per-tool allowlist and two "always" options;
`confirmAction` was implemented three times over), and the consequence is what this fixes: an
alternative installation could not **supply** a policy, only defeat one.

The call site now declares — `ctx.gate({ gate, subject, label, fallback })` — and a swap-member
`PermissionGate` decides. `decide(req, ask)` receives the prompt channel in scope for that call, and
`ask === undefined` **is** "no human is reachable", which is when the request's own `fallback` (the
site's stated non-interactive behaviour) applies. `gate` is a suffix the host qualifies with the
tool's *registered* name, so one policy answer covers both runtimes' implementations of a tool, and a
plugin cannot address a gate it does not own. 20 call sites, 13 gate ids.

**New package `@matatbread/matbot-default-gate`** — a library each host seeds, in the `tool-plugin`
mould rather than a configured plugin: `createDefaultGate` becomes the boot `PermissionGate` and
`gate_action` is registered beside `plugin`/`provider`. A minimal install's first act is adding a
plugin or a provider, which is gated, so neither the policy nor the means to inspect it may depend on
a `plugins:` line. It reproduces today's behaviour (ask, offer standing answers, remember them) keyed
`(gate, subject)` in its own settings namespace; `gate_action` (`get` / `clear`) reports the standing
answers in effect and forgets them — there is deliberately no `set`, because the write path for a
runtime actor is answering a prompt that names the specific act, and no listing of gates that have no
answer, because an absent key says nothing about what a gate will do. Registering a `PermissionGate` of your own
replaces the policy, and unregistering reverts to the seeded one, which asks.

**API:** `PermissionRequest` / `PermissionGate` and the `MatbotServices.PermissionGate` key (not
optional — the behaviour must always exist), `ToolContext.gate`, `bindGate`, and the bare asking gate
`askPermissionGate` (`plugin-api/host`, re-exported by core).

`ToolContext.gate` is **required**, so code that hand-builds a `ToolContext` — an embedder standing up
its own invocation door, a test fixture — must supply it: `bindGate(machine.PermissionGate, toolName,
ask)`, the same one-liner the runner, `invokeTool` and frontend-web use. Optional was rejected because
it would make "this tool cannot ask permission" a silent state rather than a compile error. `confirmAction` is gone from
`@matatbread/matbot-mcp-http` and `@matatbread/matbot-tool-plugin`.

The 19 converted call sites are a **different implementation with the same functionality**: each still
asks a human when there is one, and still declines when there is not (`fallback: false` everywhere but
`tools.overwrite`, which is what the old `CONFIRM_NO` default already resolved to). What changes is who
answers, and that an installation can now decide without editing a plugin — including for the callers
that have no prompt channel at all:

```yaml
default_settings:
  '@matatbread/matbot-default-gate':
    'mcp_action.add': true          # lets invokeTool / a trigger / POST /tools connect a server
```

Be clear-eyed about what this buys. A privileged operation is now *decided somewhere replaceable*,
and by default that means a human is asked — it is **not** out of the model's reach: the default
policy keeps its answers in `.data/settings/`, which any shell tool can write. A standing answer is
also a decision rather than a channel, so it applies at doors with no human behind them
(`POST /tools/:name`, `invokeTool`, a trigger). And a gate that auto-approves `plugin.add` has granted
everything, a loaded plugin having full Node capability with no in-process sandbox. A deployment that
needs a real boundary ships a gate with its rules compiled in — which is what the seam is for.

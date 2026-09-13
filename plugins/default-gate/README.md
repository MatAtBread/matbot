# @matatbread/matbot-default-gate

matbot's default permission policy.

A privileged operation — installing a plugin, adding a provider profile, removing an MCP server,
overwriting a tool another plugin owns — **declares** that acceptance is needed, by calling
`ctx.gate({ gate, subject, label, fallback })`. What *happens* then is this package's business, and
it is replaceable: an installation that wants different rules registers its own `PermissionGate`
instead of undoing this one.

**This is a library, not a plugin** — do not list it in `plugins:`. Each host seeds it at boot
(`createDefaultGate` as the `PermissionGate`, `createGateTools()` beside the `plugin` and `provider`
builtins), because a minimal install's first act is a gated one: making the policy, or the means to
inspect and undo an answer, conditional on a config line answers the question at the wrong moment.

This one reproduces matbot's historical behaviour:

- ask the user, through whatever channel the turn has;
- offer two standing answers — *Always allow "<subject>"* and *Always allow every `<gate>`*;
- honour what was remembered, silently, next time;
- with nobody to ask, answer the request's own `fallback` (which is what the *call site* says its
  non-interactive behaviour is — `true` for a tool-name collision at boot, `false` everywhere else).

## Configuring it

Standing answers live in this package's own settings namespace, one key per gate id, so an
installation authors them the ordinary way (the hosts exempt this one key from the "names no loaded
plugin" warning, since nothing loads it):

```yaml
default_settings:
  '@matatbread/matbot-default-gate':
    'tools.overwrite': [bash, plugin]    # subjects allowed without asking
    'plugin.add': true                   # every subject allowed — see the warning below
```

A value is `true` (allow every subject), or a list of subjects to allow. Anything else asks.

**`subject` is the identifier the call site has, not a canonical identity.** At `plugin.add` the
plugin is not loaded yet, so the subject is the specifier *as typed*: an allow for `@x/foo` does not
match `https://…/foo.ts`. That is correct — different trust root, different decision — but it means a
policy keys on the spelling.

**A gate that auto-approves `plugin.add` has granted everything.** A loaded plugin has full Node
capability and there is no in-process sandbox. And a standing answer is a *decision, not a channel*:
it applies at every door, including `POST /tools/:name`, `invokeTool` and a trigger — so *Always allow
every `plugin.add`* lets anything that can reach the HTTP endpoint install anything, with nobody asked.
Prefer the per-subject form.

**These answers are not out of the model's reach.** They live in `.data/settings/`, which `bash` can
write and `docker-bash` mounts read-write, so on an install with a shell tool the model can author its
own standing answer and every later prompt is skipped. This policy is therefore a *record of decisions*,
not a security boundary; a deployment that needs one ships a gate with its rules compiled in — which is
what the replaceable seam is for.

## `gate_action`

- `{ action: 'get' }` — the standing answers in effect (optionally one `gate`). A stored answer and a
  configured default read identically, because the question is whether the prompt appears. A gate with
  **no** answer is not reported: on a fresh install this returns nothing, and every gate simply behaves
  as configured. There is no list of "all the gates" — ids are open, and an absent key says only that
  nobody answered, not what will happen. Name a `gate` to ask about one, which is also the only way to
  see one an installation configured but nobody has answered (settings cannot enumerate their keys).
- `{ action: 'clear' }` — forget standing answers so the operation asks again: everything, one
  `gate`, or one `subject` within a gate. Clearing means *revert to the configured default*, so an
  installation's own `default_settings:` floor survives it.

There is deliberately no `set`: the write path for a runtime actor is answering a prompt that names
the specific act.

## Gate ids

`tools.overwrite` (subject: tool name) · `plugin.add` / `plugin.provision-deps` / `plugin.remove` /
`plugin.npm-uninstall` / `plugin.load` · `provider.add` / `provider.add-unverified` /
`provider.update` / `provider.update-unverified` / `provider.remove` · `mcp_action.add` /
`mcp_action.remove`.

A tool's ids are qualified with the name it is **registered** under, so one answer covers both
runtimes' implementations of a tool. The list is open — a plugin this build never compiled against
contributes ids, and an id this policy does not recognise is asked about, never allowed.

Two gates chain on the provider path (`add-unverified` → `add`, `update-unverified` → `update`): one
user-visible operation can cost two decisions, the first carrying information the second does not.

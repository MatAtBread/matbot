# The default permission gate

matbot's default permission policy, in `core` (`core/src/default-gate/`).

A privileged operation — installing a plugin, adding a provider profile, removing an MCP server,
overwriting a tool another plugin owns — **declares** that acceptance is needed, by calling
`ctx.gate({ gate, subject, label, fallback })`. What *happens* then is the `PermissionGate`'s business,
and it is replaceable: an installation that wants different rules registers its own `PermissionGate`
instead of undoing this one, and an embedder can pass its own `gate` to `assembleMachine`.

**It is not a plugin** — there is nothing to list in `plugins:`. `assembleMachine` seeds it at boot
(`createDefaultGate` as the `PermissionGate`, `gate_action` beside the other built-in tools) unless the
host passes another `gate`, because a minimal install's first act is a gated one: making the policy, or
the means to inspect and undo an answer, conditional on a config line answers the question at the wrong
moment.

This one reproduces matbot's historical behaviour, with lifetimes:

- ask the user, through whatever channel the turn has, as three choices: **allow or deny**, **for how
  long** (*this time*, *for this session*, *always*) and **what** (each subject the call site offers,
  narrowest first, then every subject of the gate). A frontend that can draw them side by side (the web
  UI) shows what and how long as dropdowns, then *Allow* and *Deny* as the buttons that answer; one that draws buttons (Telegram, the terminal) is offered the common
  combinations — *Deny*, *Deny for this session*, *Always deny*, *Allow*, then *Allow … for this
  session* and *Always allow …* per subject, and *Always allow every `<gate>`*;
- honour what was remembered, silently, next time — the most specific answer first;
- with nobody to ask, answer the request's own `fallback` (which is what the *call site* says its
  non-interactive behaviour is — `true` for a tool-name collision at boot, `false` everywhere else).

*For this session* exists for the work in hand: "this task needs my photos directory" should neither
grant it for ever nor ask about every file. It is offered only where there is a session someone works in
— not when a plugin registers, and not at the HTTP tool door — and only where the call site permits it
(`PermissionRequest.lifetimes`: keeping a function's grants across its edits is *session* only).

Each answer carries the `source` that produced it, which is what the caller's refusal message names:
`user` for anything a human answered at the prompt (a refusal included — the source is which test
decided, not what it decided), `session` for an answer held for this session, `configuration` for one
held everywhere (or at a door), and `fallback` when it deferred with nobody to ask. A standing answer is one source whether it came from `default_settings:`
or from an *Always allow* a human gave earlier: settings reads are layered, so nothing here can tell
the two apart, and reporting `user` for a configured floor would be wrong half the time. A gate this
one displaces keeps its own source when it is delegated to.

## Configuring it

Standing answers live in the policy's own settings namespace, `@matatbread/matbot-default-gate` (the
name of the package it was published as before 0.5.0, kept because existing answers and installations
are keyed by it), one key per gate id, so an installation authors them the ordinary way (this one key is
exempt from the "names no loaded plugin" warning, since nothing loads it):

```yaml
default_settings:
  '@matatbread/matbot-default-gate':
    'tools.overwrite': { '*': [bash, plugin] }   # subjects allowed without asking, everywhere
    'plugin.add':      { '*': true }             # every subject allowed — see the warning below
```

A gate's value maps a **scope** to its answer. `'*'` is everywhere — every session and every door; a
session's id holds only in that session; `#http` holds at the HTTP tool door (`POST /tools/:name`),
which has no session of its own. An answer is `true` (every subject) or a list of subjects. Anything
else asks. The map is required even for `'*'` alone: a bare list or `true` under the gate id is the
format before 0.5.0, which is migrated once where it was **stored**, and anywhere else — a
`default_settings:` entry — is ignored with a warning naming the key, so a configured denial in the old
format does not silently stop denying.

Denials live beside them, under `deny:<gate>`, in the same shape:

```yaml
default_settings:
  '@matatbread/matbot-default-gate':
    'deny:plugin.add': { '*': true }              # never install a plugin, and never ask
    'http.request':    { '#http': ['https://api.example'] }   # what the HTTP door may reach unattended
```

**The most specific answer wins.** A call site lists an act's subjects narrowest first (this file, its
directory, that directory for every function), so where stored answers disagree the one covering the
earliest of them decides; then the longer of two prefixes, where the subjects nest; then an answer for
this session before one held everywhere; then a denial, should two answers tie. So an allow of
`* node:fs` beside a denial of `* node:` admits `node:fs` and no other builtin, and a denial of
`* /home/me/.ssh/` carves a subtree out of an allow of `* /home/me/` — and an allow of one function's
directory reopens it inside a denial for every function. A session's broad allow does not lift a
standing denial of something narrower.

**Where a session answer is kept** is the policy's one option, `'#session-store'` in the same namespace
(a `#` key is never a gate id): `memory`, the default — kept until matbot restarts, and out of reach of
every tool, being in no file — or `settings`, beside the `'*'` answers under the session's id, kept until
forgotten. Sessions are never deleted, so persisted session answers accumulate until `gate_action`
clears them.

This is also the supported way to make a gated operation work for callers that have **no prompt
channel** — `invokeTool`, a trigger, a compiled skill, `POST /tools/:name` — which otherwise get the
call site's `fallback` (a refusal, for everything but `tools.overwrite`). Connecting an MCP server
from a script is the usual case:

```yaml
default_settings:
  '@matatbread/matbot-default-gate':
    'mcp_action.add': true
```

Naming the gate is the whole point of the seam: the alternative is editing the plugin that declares
it, and an installation should not have to fork a tool to decide its own policy.

**`subject` is the identifier the call site has, not a canonical identity.** At `plugin.add` the
plugin is not loaded yet, so the subject is the specifier *as typed*: an allow for `@x/foo` does not
match `https://…/foo.ts`. That is correct — different trust root, different decision — but it means a
policy keys on the spelling.

**A gate that auto-approves `plugin.add` has granted everything.** A loaded plugin has full Node
capability and there is no in-process sandbox. And a standing answer is a *decision, not a channel*:
it applies at every door, including `POST /tools/:name`, `invokeTool` and a trigger — so *Always allow
every `plugin.add`* lets anything that can reach the HTTP endpoint install anything, with nobody asked.
An answer means what it says; the per-subject form is offered first.

**A policy can refuse where nobody is watching.** `decide(req, ask, context)` gets `ask === undefined` when no
human is reachable, so a policy that wants standing answers to apply only to interactive callers is
four lines — `if (ask === undefined) return req.fallback;` before consulting them. It also runs under
the ambient security principal, so `tryCurrentPrincipal()` says *who* is asking with no extra plumbing.
Neither is what the shipped policy does: an installation that configures `'mcp_action.add': true`
precisely wants the non-interactive caller to succeed, so the default honours an answer wherever the
operation happens. Write the stricter one if your deployment wants it.

**These answers are not out of the model's reach.** They live in `.data/settings/` (or the SQLite
database), which `bash` can write — `docker-bash` mounts both read-only — so on an install with `bash`
the model can author its own standing answer and every later prompt is skipped. (A session answer kept in
memory is the exception: no tool can write it.) This policy is therefore a *record of decisions*,
not a security boundary; a deployment that needs one ships a gate with its rules compiled in — which is
what the replaceable seam is for.

## `gate_action`

- `{ action: 'get' }` — the standing answers in effect (optionally one `gate`), as `answers`, and any
  denials as `denials` (present only when there is one, so the result is unchanged where there are
  none). A stored answer and a
  configured default read identically, because the question is whether the prompt appears. A gate with
  **no** answer is not reported: on a fresh install this returns nothing, and every gate simply behaves
  as configured. There is no list of "all the gates" — ids are open, and an absent key says only that
  nobody answered, not what will happen.
- `{ action: 'list', gate?, match? }` — the same answers one **entry** at a time, each with an `id`:
  `{ id, gate, effect: 'allow' | 'deny', session?, inMemory?, subject? }`, where an absent `subject` means
  every subject of the gate, an absent `session` means everywhere, and `inMemory` marks a session answer
  that a restart forgets. `match` keeps entries whose gate, subject or session contains the text — a
  host, a URL, a function or plugin name, a session id. It is a substring because a subject's format belongs to the call site that raised the
  gate, and this policy never parses one; so it can find "every entry mentioning this host", not
  "every entry for it", and it lists rather than clears. The id is a digest of the entry itself, so it
  is the same on every listing and needs nothing remembered between the two calls.
- `{ action: 'clear', ids }` — forget exactly the entries named. An id that matches nothing (already
  cleared) is reported, never applied to something else.
- `{ action: 'clear' }` — forget everything, one `gate`, or one `subject` within a gate, in every scope. Forgetting a
  whole gate means *revert to the configured default*, so an installation's own `default_settings:`
  floor survives it; forgetting entries of a configured list stores the rest of the list.

Forgetting a **denial**, by any form of `clear`, is itself gated — `gate_action.forget-denial`, subject
`deny:<gate> <subject>` (or `deny:<gate>` for a denial of every subject), `fallback: false`. A denial is a
refusal the user chose, and without this a model asking for a refused act could clear the denial and ask
again; at a door with nobody to ask the act would fall to its site's fallback, which for
`tools.overwrite` is to proceed. Forgetting an allow is not gated, since it only makes a gate ask again.
Writes re-read inside the same queue as the policy's own, so two clears at once cannot restore what the
other removed.

There is deliberately no `set`: the write path for a runtime actor is answering a prompt that names
the specific act.

## Gate ids

`tools.overwrite` (subject: tool name) · `plugin.add` / `plugin.provision-deps` / `plugin.remove` /
`plugin.npm-uninstall` / `plugin.remove-provisioned` / `plugin.load` · `provider.add` / `provider.add-unverified` /
`provider.add-unlisted` / `provider.update` / `provider.update-unverified` / `provider.update-unlisted` /
`provider.remove` · `mcp_action.add` /
`mcp_action.remove` · `gate_action.forget-denial` · `tool_function.import` / `tool_function.connect` /
`tool_function.edit` (session only) / `tool_function.fs-read` / `tool_function.fs-write` · `http.request` /
`http.secret`.

A tool's ids are qualified with the name it is **registered** under, so one answer covers both
runtimes' implementations of a tool. The list is open — a plugin this build never compiled against
contributes ids, and an id this policy does not recognise is asked about, never allowed.

Gates chain on the provider path (`add-unverified` → `add` → `add-unlisted`, `update-unverified` →
`update-unlisted` → `update`): one user-visible operation can cost up to three decisions, each carrying
information the others do not. `*-unlisted` is asked when the endpoint lists its models and the profile's
model is not among them; `add-unlisted` comes after `add` because listing sends the credential.

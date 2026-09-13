---
'@matatbread/matbot-plugin-api': patch
'@matatbread/matbot-core': patch
'@matatbread/matbot-cli': patch
'@matatbread/matbot-web-bundle': patch
'@matatbread/matbot-default-gate': patch
'@matatbread/matbot-frontend-telegram': patch
---

Gate review: delegation, a lost update, a missing warning, and an honest boundary

**A policy that displaces another can delegate to it.** `PermissionGate` was behind the same
capture-safe `forwardingProxy` as the other swap-members, which made the documented composition —
capture `services.PermissionGate`, register your own, defer to what you displaced — capture a
reference that resolves to whatever is *current*: the capturing gate itself, calling itself until the
stack overflowed. The pattern the docs recommend was the pattern that broke. The hosts expose this one
member as a getter, so a read yields the concrete impl; every consumer already resolves it per call.
(`ToolCallValidator` composes identically and was never proxied, which is why that idiom worked.)

**Two "Always allow" answers at once no longer drop one.** Appending a subject is a read-modify-write
and `PluginSettings` has no CAS on a value, so two collisions answered concurrently both read the same
list and the second write dropped the first's subject. The policy serialises its writes and re-reads
inside the queue; two processes over one medium remain last-write-wins, which is the store's contract.

**A collision resolved with nobody to ask says so again.** The pre-gate code warned when it overwrote
non-interactively and the gate dropped the line, leaving the one decision that proceeds with no human
and no record of itself.

**The telegram frontend supplies no `PromptFn`** instead of a stub that answered with each field's
default. The stub was the worse lie: to a tool it resolved silently, and to a gate it looked like a
reachable human — "no PromptFn at all" being the one signal for *nobody is here*.

**And the docs stop overclaiming.** A gate makes a privileged operation *decided somewhere
replaceable*, which by default means a human is asked; it does not put that decision out of the
model's reach, since the default policy stores answers in `.data/settings/` and a shell tool can write
them. A standing answer is also a decision rather than a channel: it applies at `POST /tools/:name`,
`invokeTool` and triggers, so *Always allow every `plugin.add`* is a blanket grant to anything that can
reach the endpoint. Both are now stated where a user and a policy author will meet them.

**A plugin's `services.PermissionGate` is live, not a load-time copy.** `setupPlugin` builds the
per-plugin machine with `{ ...services }`, which evaluates the host's getters exactly once. For the
other swap-members that is harmless — they hand back capture-safe proxies — but `PermissionGate` is
deliberately un-proxied, so a plugin held whatever policy was active when *it* loaded: a policy
registered afterwards was never consulted through that machine (frontend-web's `POST /tools/:name`
route reads exactly this way), and unloading one left the copy on the gone impl instead of reverting.
The scoped block re-declares it as a getter, as it already did for `Notifier`.

**`gate_action clear` no longer claims to have cleared a configured default.** `delete` reverts to what
the installation configured, so for a gate answered only in `default_settings:` it is a no-op — and
listing it under `cleared` was a success report for nothing. The result is read back and the answer
compared: what *changed* is reported as forgotten, and what is still in force is named separately as
coming from config, which this tool cannot change.

**The write queue is module-scoped**, not per gate instance, since instances multiply by design: a
policy that displaces the seeded one composes by building another over the same settings, and a
per-instance queue would serialise each against itself and neither against the other.

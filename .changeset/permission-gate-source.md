---
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-core": patch
"@matatbread/matbot-default-gate": patch
"@matatbread/matbot-tool-plugin": patch
"@matatbread/matbot-tool-mcp": patch
"@matatbread/matbot-mcp-http": patch
"@matatbread/matbot-browser": patch
"@matatbread/matbot-function-tools": patch
"@matatbread/matbot-function-runner-node": patch
"@matatbread/matbot-cli": patch
"@matatbread/matbot-web-bundle": patch
---

A permission decision says which test produced it. `PermissionGate.decide` and `ctx.gate` resolve `{ allowed, source }` rather than a bare boolean, where `source` names the layer of the cascade that answered — `user` (a human was asked, a refusal included: the source is which test decided, not what it decided), `configuration` (a standing answer in force), `fallback` (nobody reachable, so the call site's own default stood), or a name a replacement policy invented. `PermissionSource` is deliberately open (`… | (string & {})`): a policy has layers of its own, and a closed union would mean it could not report truthfully without a plugin-api change.

It exists for the REPORT, not the control flow. A refusal that says only `Cancelled.` is indistinguishable from a malfunction, and a model that reads a decision as a malfunction goes looking for the malfunction: it retries under another spelling, probes for a bug, or reaches for a route around the gate. So every call site now renders `refusalMessage(decision)` — which names the layer and, for the two sources nothing in the turn can change, says there is nothing here to work around. `fallback` says the opposite, because that one CAN change: it needs a human present, or a standing answer in the installation's policy.

Nothing branches on `source`, and a gate must not be given one to branch on — a call site that treated `fallback` differently from a human's "no" would be reintroducing the policy the gate exists to hold. A gate that delegates passes the displaced gate's source back out unrewritten, since rewriting it erases the one fact it carries. `default-gate` reports one `configuration` for both an installation's configured floor and a remembered *Always allow*: settings reads are layered, so nothing there can tell the two apart, and claiming `user` for a configured floor would be wrong half the time.

Migrating a call site or a gate of your own: test `.allowed`. The decision is an object, so `if (!await ctx.gate(…))` is always false, which the compiler cannot tell you — it is the one hazard of the shape, and it is stated on `ToolContext.gate`. A gate returns `permitted(source)` / `refused(source)`, both exported from `plugin-api` and re-exported from `core` beside `refusalMessage`.

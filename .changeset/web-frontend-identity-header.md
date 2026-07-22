---
"@matatbread/matbot-frontend-web": patch
---

The web frontend now honours an `x-matbot-principal` request header as a generic per-request identity
override, taking precedence over any registered `WebPrincipalResolver` (`headerPrincipal(req) ?? resolver
?? default`). This lets a browser act as a chosen identity even when a resolver (e.g. web-principal-user
or auth) pins a default. The `headerPrincipal` helper is exported. The shared UI also shows a profile
selector (left of the title) when a `profile` tool is registered, sending the selected profile as that
header; it stays hidden otherwise, so default deployments are unchanged. Each profile row gains a gear that
edits which namespaces the profile isolates — a checklist populated from the tool's `available_namespaces`
action, applied via `set_isolated` — and the new-profile row gains a matching (collapsed) chooser so a
profile's isolated set can be picked at creation.

The URL fragment now accepts an optional leading profile: `#<profile>:<session>~<params>`, every part
optional so existing `#<session>` / `#<session>~<params>` links are untouched. At load — before any
session loads — a `#<profile>:…` prefix (or a lone `#<profile>` that names an existing profile) adopts
that profile, then strips itself from the hash. Each profile row in the selector gains a link icon that
copies its shareable `#<profile>` URL to the clipboard.

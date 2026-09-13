---
'@matatbread/matbot-plugin-api': patch
'@matatbread/matbot-core': patch
'@matatbread/matbot-cli': patch
'@matatbread/matbot-web-bundle': patch
'@matatbread/matbot-frontend-web': patch
'@matatbread/matbot-frontend-dom': patch
'@matatbread/matbot-default-gate': patch
---

A `select` option can carry a value distinct from its label

`FormField.options` now takes `string | { value, label }`. A bare string keeps meaning "the value is
the label", so every existing caller, every frontend and `ask_user` are untouched; the pair form
separates what the user *reads* from what the caller gets *back*. Frontends render `optionLabel(o)`
and answer with `optionValue(o)`; `default` names a value.

The reason is a footgun with a proven bite. A rendered label is cosmetic, rewordable and potentially
localised, and using it as an identity invites a comparison against prose: the permission gate
offered *Allow* and *Always allow "…"*, and matching by prefix read the first as the second —
granting standing permission nobody gave. `confirm` avoided this from the start (`CONFIRM_YES` /
`CONFIRM_NO` are tokens, not labels); this is the same medicine for `select`. The gate now offers
`deny` / `allow` / `always-subject` / `always-gate` and compares tokens, so its wording can change
freely without touching the decision.

Deliberately not an index: `allowOther` free text has to arrive on the same channel as a pick, an
answer is persisted in a `form-response` where `"2"` is unreadable and silently changes meaning if
the options are reordered, and cancellation already has `PromptCancelledError` rather than a
sentinel.

Two CLI fixes come with it, neither frontend-dependent: the select resolver matches a typed prefix
against labels and returns the option's value, and an answer matching no option now falls back to the
default rather than being returned verbatim. The abort-time form path passed a *synthesised* string
to `prompt()`, which took the free-text branch — so a form's select answer came back unresolved,
never as the option's value. It passes the field, so one resolver serves every path.

---
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-core": patch
"@matatbread/matbot-tool-http": patch
"@matatbread/matbot-gate-fs-node": patch
"@matatbread/matbot-frontend-telegram": patch
"@matatbread/matbot-frontend-web": patch
"@matatbread/matbot-function-runner-node": patch
"@matatbread/matbot-function-tools": patch
"@matatbread/matbot-cli": patch
---

Permission answers have lifetimes: *this time*, *for this session* or *always*, for allow and deny alike. `PermissionGate.decide` and `snapshot` take a host-stated `PermissionContext` (the session), and `bindGate` requires one; `POST /tools/:name` runs in the fixed session `#http`. The default gate stores answers by scope (`{ '*': [...] }`, a session id, `#http`), migrates the unscoped format once from what was stored, and ignores (with a warning) an unscoped `default_settings:` entry. The most specific answer now wins, so an allow beneath a broader denial applies. The prompt is three choices, drawn as dropdowns where a field carries `FormField.axes`. Standing labels name what is allowed, not for how long.

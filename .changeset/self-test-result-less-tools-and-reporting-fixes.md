---
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-tool-plugin": patch
"@matatbread/matbot-provenance": patch
"@matatbread/matbot-frontend-web": patch
"@matatbread/matbot-tool-workspace": patch
"@matatbread/matbot-triggers": patch
---

Fix six defects found by a self-test of the running harness.

`await tool.x(…)` no longer throws `Tool produced no result` for a tool that yields none: a side-effect
tool yields nothing by design, so the one calling surface meant to be silent was the one that failed.
The case that throw existed to catch — a body declaring a data result and not producing one — is already
caught where the types are: the snippet checker compiles a body against its declared return type, and
`strict` rejects one that can fall through.

Reporting fixes: `provider update` errors on a missing profile instead of returning prose; `trigger_action`
reports `enabled` on every trigger; `workspace_action list` accepts a complete file name as a `prefix`;
`url_for_resource` and `determine_provenance` describe what they actually return and search.

---
"@matatbread/matbot-tool-plugin": patch
---

fix(tool-plugin): discover_local resolves conditional `exports`

`resolveExportsMain` only handled a string `exports["."]`; a plugin using the
conditional form (`{ browser, import, default }`, e.g. frontend-web) resolved to
`undefined` and was silently skipped during discovery — so a cached/source plugin
with a browser bundle never appeared in `discover_local`. Now resolves the node
ESM conditions (node/import/default), skipping browser/require.

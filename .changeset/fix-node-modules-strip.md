---
"@matatbread/matbot-cli": patch
---

Strip TypeScript types in the CLI loader so published packages run. Node's native
type stripper refuses `.ts` files under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), which broke `npx matbot` from an
npm install. `ts-hooks.js` now strips types itself in a `load` hook (via
`module.stripTypeScriptTypes`), so installed raw-`.ts` packages load the same as
workspace ones.

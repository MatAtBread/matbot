---
"@matatbread/matbot-tool-types": patch
"@matatbread/matbot-cli": patch
---

A `tool_function` body's imports are type-checked, against the modules that are actually reachable. `ToolTypeIndex.check` resolves `node:` specifiers through `paths` — the builtins a body may ask for — so a hallucinated `os.hstname()` is caught instead of the whole specifier merely failing to resolve. This needed `@types/node` as a dependency of `matbot-tool-types`: the check program is rooted at the `matbot.yaml` directory, which under pnpm and in any published install has no `node_modules/@types` in its lookup chain, so nothing resolved from there.

Loading node's declarations also declares `require`, `module`, `exports`, `__dirname` and `__filename`, none of which a body has — it is compiled as a bare async function, not a module. A new structural rule, **ENV-GATE**, rejects those and `import.meta` with the working form named, rather than letting `require('node:fs')` typecheck clean and fail at the first call: correct against the types it was shown, which is the one failure the check gate exists to prevent and the repair loop cannot repair. `ToolCheckDiagnostic.label` now carries a per-rule name for a structural finding instead of always `CAST-GATE`.

A path or a URL gets no declarations, being unimportable from a body; IMPORT-GATE refuses it at the check.

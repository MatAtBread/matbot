---
"@matatbread/matbot-tool-types": patch
"@matatbread/matbot-cli": patch
---

A `tool_function` body can `await import('node:…')`, and is type-checked when it does. The vm runner compiles the body with `importModuleDynamically: USE_MAIN_CONTEXT_DEFAULT_LOADER`, so dynamic import routes through the main context's own ESM loader and the CLI's registered hooks apply unchanged (the .js→.ts remap, type stripping, `?mbfresh=` propagation, `.plugins/` fetching). This grants no capability: running in this context, a body already reached every builtin through `process.getBuiltinModule` — `vm` was never a boundary here. The synchronous-work bound is unaffected.

`ToolTypeIndex.check` now loads node's types for a snippet that names a builtin, so `os.hstname()` is caught rather than the whole specifier failing to resolve. `@types/node` moved to a dependency of `matbot-tool-types` because the program is rooted at the `matbot.yaml` directory, which in a pnpm workspace or a published install has no `node_modules/@types` in its lookup chain. They are loaded only when the snippet mentions `node:` — they roughly double a check.

Loading them declares `require`, `module`, `exports`, `__dirname` and `__filename` as globals, none of which the runner defines, so the commonest wrong guess (`require('node:fs')`) would typecheck clean and fail at the first call — correct against the types it was shown, which the repair loop cannot repair. A new structural rule (ENV-GATE, beside the cast gate) rejects all five and `import.meta`, naming the working form, and does not fire on an author's own binding of the same name. `ToolCheckDiagnostic.label` now carries a per-rule name for structural findings rather than always `CAST-GATE`.

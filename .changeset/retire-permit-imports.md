---
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-function-runner-node": patch
"@matatbread/matbot-function-tools": patch
"@matatbread/matbot-tool-types": patch
"@matatbread/matbot-browser": patch
"@matatbread/matbot-cli": patch
---

`permit_imports` is retired: what a `tool_function` body may import is the permission gate's alone, refused outright by a standing denial (`deny:tool_function.import`). The type-check derives the modules it declares, and the literal imports it refuses, from the gate in force via `ToolCheckOptions.importRefused`, which `function-tools` supplies. `FunctionRunSettings.permittedImports` and `importPermitted` are removed from `plugin-api`.

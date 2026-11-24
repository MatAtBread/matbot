---
"@matatbread/matbot-tool-types": patch
---

`tool_function` `define` type-checks when `tool-types` is installed from npm (#118). The checker's worker `require`d `src/parameters.cts` by path, and node refuses to strip types from a file under `node_modules`, so every checked `define` failed unless `noTypeCheck` was passed. The checker now strips the file itself and hands the worker the text.

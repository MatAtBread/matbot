---
"@matatbread/matbot-function-tools": patch
---

function-tools: `tool_function { action: 'package' }` defines a package — one TypeScript module whose exported functions become tools named `<package>__<function>`, while its helpers, types and constants stay private and are never registered. Defined, replaced and removed as a group (`remove { package }`); type-checked as a whole; stateless, admitting only `function`, `const`, `interface` and `type` at the top level; listed under `packages` and checked with `check { package }`. (#63)

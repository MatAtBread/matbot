---
"@matatbread/matbot-cli": patch
---

Fix first-run setup on an npm install. The CLI now bundles the provider adapters
(anthropic, openai-compat, customer-services) as dependencies, discovers them via
module resolution instead of a monorepo-only directory scan, and writes the
provider's package name as `module:` in matbot.yaml (resolves in both an install
and the workspace). Previously `matbot` aborted with "No provider packages found".

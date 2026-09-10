---
'@matatbread/matbot-plugin-api': patch
'@matatbread/matbot-tool-plugin': patch
'@matatbread/matbot-browser': patch
'@matatbread/matbot-storage-google-drive': patch
---

`provider update`: change `model`, `endpoint`, `parameters` or `maxRounds` on an existing profile
without touching its credentials. Adds `ProviderPatch` to the `provider` tool contract and the
`applyProviderPatch`/`patchedFields` policy to plugin-api (re-exported by core). Also fixes the block
remover swallowing the top-level section that follows the last provider — a pre-existing
`provider remove` bug.

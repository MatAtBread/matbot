---
"@matatbread/matbot-cli": patch
---

At boot, a plugin that failed to load is probed for a second copy of `core` or `plugin-api` as well as the ones that loaded, so a skewed copy it nests is named beside its failure.

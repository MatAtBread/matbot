---
"@matatbread/matbot-cli": patch
---

Suppress the experimental `stripTypeScriptTypes` warning that the loader otherwise
prints on every plugin load. Only that one warning is filtered; all others pass through.

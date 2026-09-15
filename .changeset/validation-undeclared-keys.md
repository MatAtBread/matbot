---
"@matatbread/matbot-tool-types": patch
"@matatbread/matbot-tool-json-validation": patch
---

Tool-call validation names an undeclared key instead of reporting what else is missing: the typed validator reports `unexpected property` for a key no union arm declares, and the schema validator lists undeclared keys first when it is already refusing a call.

---
"@matatbread/matbot-cli": patch
---

Two fetches of an http plugin at once into an empty `.plugins/` no longer fail. Both linked matbot's own packages into `.plugins/node_modules`, and the second failed on finding the first's link. Where that fetch was a fingerprint, the failure was swallowed, and the next `plugin reload` asked about code that had not changed.

---
"@matatbread/matbot-tool-store": patch
---

A store a plugin exposes with `defineStore` records its `owner`. tool-store's boot no longer registers it — the owner does, from its own setup — so the owner's registration is no longer a tool collision ("cannot remove the tool …", "Overwrite it?") at every boot, and the store is not exposed while its owner is unloaded. `store_action remove` refuses a store its owner is exposing.

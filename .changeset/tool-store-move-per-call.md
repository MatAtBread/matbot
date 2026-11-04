---
"@matatbread/matbot-tool-store": patch
---

Moving a store defined before 0.5.0 out of its old namespace is decided per call and per principal, and nothing about the outcome is remembered. Each principal's definition now moves with that principal's documents, a failed move is tried again by the next call rather than at the next restart, and a definition another process has moved or handed to its owner is honoured, so writes no longer diverge into the old namespace. `defineStore` takes over any definition of its name that has no owner, including one already moved and one a model created, instead of colliding with the tool tool-store registered for it.

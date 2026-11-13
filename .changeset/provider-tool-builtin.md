---
"@matatbread/matbot-cli": patch
---

The built-in `provider` tool is in the registry before any plugin loads, as `plugin` is, so a plugin can shadow it: it finds the built-in in `setup()` to delegate to, and keeps its name. The CLI used to register `provider` after every plugin's setup, directly into the registry, which silently replaced any plugin's `provider` at every boot. Its description, which lists the loaded adapters, is still refreshed once they have loaded, unless a plugin has shadowed it.

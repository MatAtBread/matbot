---
"@matatbread/matbot-cli": patch
---

The built-in `provider` tool is in the registry before any plugin loads, as `plugin` is, so a plugin can shadow it: it finds the built-in in `setup()` to delegate to, and keeps its name. The CLI used to register `provider` after every plugin's setup, directly into the registry, which silently replaced any plugin's `provider` at every boot. Its description, which lists the loaded adapters and the configured profiles, is built when it is read, so it includes an adapter `plugin add` loaded after boot, and a shadow that captured the built-in reads the current list too.

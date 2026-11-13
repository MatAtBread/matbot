---
"@matatbread/matbot-core": patch
---

The `tools.overwrite` question offers a standing answer for any tool from the incoming plugin (`<plugin> *`), beside the one for the tool. A plugin that replaces a built-in collides with it again on every reload, since its unload reinstates the built-in; that answer, given once or configured under `default_settings:`, lets the reload proceed unasked.

---
"@matatbread/matbot-core": patch
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-tool-store": patch
---

Unloading a plugin that shadowed one of the host's own tools (`plugin`, `provider`, a core tool such as `gate_action`) reinstates the built-in, as does the plugin removing its tool; the name used to be left empty until a restart. A plugin's tool that displaced another plugin's is still replaced, not suspended. The host's copies of a registered tool (the owner stamp, the validating wrapper) keep its accessors, so a `description` getter stays live; `copyTool` is that copy. tool-store re-registers a store's tool without removing it first, which would now reinstate a built-in it had displaced and ask about the collision again.

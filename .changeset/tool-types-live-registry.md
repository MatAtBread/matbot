---
"@matatbread/matbot-tool-types": patch
"@matatbread/matbot-tool-skill-compiler": patch
---

The generated tool dts declares the live tool registry, not every plugin on disk.

`buildMatbotToolsDts` roots its scan at each loaded plugin's `resolvedUrl` and then UNIONs a glob of the monorepo `plugins/` tree onto it, to catch host-constructed builtins (`plugin`, `provider`, `single_turn`, `about_matbot`) that have no `resolvedUrl`. Every `ToolContracts` key on the merged symbol was then emitted, so the dts declared tools from plugins nobody had loaded — in this repo, six of them (`telegram_send`, `telegram_provider`, `telegram_open_door` from the telegram frontend, `profile_action`/`share` from the profiles backend, `bash_config` from docker-bash), fully typed and indistinguishable from the real ones.

That reached the model twice over: `tool_function { action: 'types' }` and every skills_compiler codegen prompt (which asserts "a tool not declared here does not exist"), and `ToolTypeIndex.check()` graded the generated code against the same text. So `await tool.telegram_send({ text })` typechecked clean and threw `Tool "telegram_send" is not registered` at runtime — the one failure the check gate exists to prevent, and one the repair loop cannot repair, because the code is correct against the types it was shown.

`buildMatbotToolsDts` now takes the live tool names and emits only those keys (also filtering the wire contracts and the clash census); `ToolTypeIndex` and `skills_compiler` pass `tools.list()`. A scanned root may supply a tool's *contract*; only the registry says a tool *exists*. The glob is unchanged and host-constructed builtins keep their scanned types. Omitting the argument keeps the whole-tree behaviour, which is what the clash-census test wants. This brings node to the browser `ToolTypeIndex`'s behaviour, which already derived its dts from the live registry.

Unchanged: the per-turn wire descriptions, which were always keyed by the live registry.

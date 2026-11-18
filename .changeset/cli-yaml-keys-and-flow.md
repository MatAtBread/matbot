---
"@matatbread/matbot-cli": patch
---

`matbot.yaml` reads a key containing a colon, and flow collections. A key ended at the first colon in its line, quoted or not, so `'deny:tool_function.import':` became the key `'deny` and no configured permission denial could be written; and `[a, b]` and `{ k: v }` were read as strings, so the documented form of every configured permission answer (`'tools.overwrite': { '*': [bash, plugin] }`) was silently no answer. A key now ends at a colon followed by a space or the end of the line, as YAML has it, a quoted one at its closing quote; a flow collection may be nested and span lines until its brackets close, and a malformed one fails naming its line, as does a file that is not a mapping of keys. `plugin add` and `plugin remove` rewrite a flow `plugins:` list in block form.

---
"@matatbread/matbot-function-tools": patch
---

A `define` or `package` the store refuses no longer changes the tool registry: the source is compiled first, then written, then registered, so a refused write (e.g. to a function shared in from someone else) no longer leaves the caller's unsaved code running under the name. A read-only refusal says to choose another name, and a `check` sweep survives a re-stamp the store refuses. (#106) A stored function no longer replaces a tool `function-tools` did not register: `reload` skips it with a warning, `list` reports it as `shadowedBy` (a package as `shadowed`) and `check` as `SHADOWED`, and a name another plugin has since taken over is not taken back by a reload, `define` or `remove`. (#107)

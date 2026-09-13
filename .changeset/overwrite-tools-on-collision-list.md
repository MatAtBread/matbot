---
'@matatbread/matbot-core': patch
---

`overwriteToolsOnCollision` accepts a list of tool names

The core setting behind tool-name collisions (`default_settings.__matbot_core__.overwriteToolsOnCollision`)
was a boolean: ask about every collision, or silently overwrite every one. An install that deliberately
shadows one built-in therefore had to choose between answering an identical prompt every start and
giving up the prompt for the collisions it would actually want to hear about.

It now also takes a `string[]` of tool names: those overwrite silently, everything else still asks. A
listed name resolves the way not being asked already does — to the prompt's own default, which is the
incoming tool — so the list is a granular form of the existing answer rather than a new outcome.
`true` and `false` are unchanged, and a value that is neither warns and asks, rather than reading as
truthy: a malformed setting that silently overwrote every collision would leave no trace of why.

The collision prompt writes the same setting it reads. Its single `Always overwrite` option is now
two — `Always overwrite "<tool>"`, which appends that name to the list in effect, and `Always
overwrite all tools`, which stores `true` as the old option did. The per-tool one is offered first,
so a typed prefix resolves to the narrower answer. It persists the list in effect plus the new name
rather than the name alone: a stored key wins over a `default_settings:` one wholesale, so writing
just the one name would silently un-exempt everything the install had already configured.

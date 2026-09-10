---
'@matatbread/matbot-tool-plugin': patch
---

`plugin add` over http: offer to install the dependencies a source-fetch cannot bring. A URL-fetched
plugin copies one package's own files, not a dependency graph, so one with registry dependencies failed
to activate on its first unresolved import. It now names every dependency the project cannot already
resolve, asks once, installs them with the project's own package manager, and retries activation.

Also fixes the missing-package remedy being unreachable for that route: it was matched off Node's
`Cannot find package 'x'`, but a bare import from inside `.plugins/` is answered by ts-hooks' own
`Cannot resolve "x"`, so the generic activation error was surfaced instead.

---
"@matatbread/matbot-cli": patch
---

tool-plugin: github/http-fetched plugins now resolve each other by canonical package name. A remote
plugin is registered in the `.plugins/` symlink farm under its own `package.json` name when fetched,
so a sibling that imports it (`@matatbread/matbot-skills` from skills-node, `@matatbread/matbot-tool-store`
from cognition) resolves to the fetched copy — the package name is the canonical identity, independent
of the source it came from. Previously only host-installed packages were bridged, so inter-dependent
plugins installed from github failed with `ERR_MODULE_NOT_FOUND`. The host singletons (plugin-api/core)
are never self-registered, so the singleton boundary is preserved.

Also: the `plugin` tool now refuses to "install" a host runtime package (`@matatbread/matbot-plugin-api`,
`@matatbread/matbot-core`, with or without a version suffix) as a plugin, instead of letting it land in
the config as a bogus, unloadable entry.

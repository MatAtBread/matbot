---
"@matatbread/matbot-cli": patch
---

tool-plugin: give a readable error when a github/URL-fetched plugin has an unresolved dependency, and
document which sources resolve dependency graphs. A raw source-fetch installs one plugin's own files,
not its dependency graph, so a plugin with a runtime dependency on another package (cognition →
@matatbread/matbot-tool-store) fails to activate with an opaque ERR_MODULE_NOT_FOUND — which sent the
model hunting for npm name variations. The `plugin` add flow now names the missing package and states
the remedy (install the dependency too; from npm for first-party packages, where its own deps resolve),
explicitly telling the model not to retry name variations; the entry is left in config so it activates
once the dependency is present. The `plugin` tool description and the `Classified` source type now spell
out dependency resolution per source: npm/.tgz/git resolve the full tree; local inherits the surrounding
node_modules; raw github/HTTP fetches only the plugin's own files (deps must be provided separately).

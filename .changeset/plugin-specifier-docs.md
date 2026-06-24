---
"@matatbread/matbot-tool-plugin": patch
---

Clarify the `plugin` tool's specifier docs: show the raw `github:owner/repo/subdir#ref`
form for source plugins (a repo subdir), state that the `#path:`/git forms are only for
fully-packaged published packages, and instruct the model to pass a user-supplied
specifier verbatim. Prevents the model rewriting a working github specifier into a
package-manager form that fails on workspace/raw source.

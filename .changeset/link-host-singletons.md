---
'@matatbread/matbot-tool-plugin': patch
---

Link a local plugin's host singletons whether or not it has registry dependencies to install. The link
loop was behind an early return in `applyProvision`, so a plugin whose only dependency is the
`@matatbread/matbot-plugin-api` peer got no `node_modules` and no link at all.

Also asks the right question for the link target (`hostOwnPackageDir`, not `hostPackageDirFrom(name,
pluginDir)`, which answers with the author's own devDependency copy when one is installed), and replaces
a path that does not lead to the host's copy rather than accepting any path that exists.

---
"@matatbread/matbot-gate-fs-node": patch
"@matatbread/matbot-function-runner-node": patch
---

gate-fs-node closes the holes left in a body's `node:fs`. Changing a file's permissions, owner or timestamps is its own gate, `tool_function.fs-access`, independent of reading and writing, so a write grant no longer covers `chmod`, and a handle opened for reading cannot change metadata. A body may use only the descriptors it opened through the gate, until it closes them. Node's own stream and watcher classes, reached by walking a prototype, and a file handle's own `chmod`, `chown` and `utimes`, refuse a body. A directory holding a path under a standing denial cannot be renamed, and the error says which path and why. The `ImportedModuleWrapper` service is now an object: `wrapModule(specifier, wrap)` registers a wrapper, and an optional `hideFromBody(owner, key, standIn)` makes a property read as a stand-in to a body and as itself to host code. The node runner offers both. gate-fs-node uses whichever runner registered the service, and hides nothing under one that does not offer `hideFromBody`.

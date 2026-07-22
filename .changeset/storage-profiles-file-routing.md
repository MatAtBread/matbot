---
"@matatbread/matbot-storage-profiles": patch
---

Profile-aware file storage. The backend's `fileStore` is no longer the unprofiled passthrough — it now
routes every file op (`put`/`get`/`getByName`/`list`/`delete`/`putTemp`/`watch`) to the current
principal's partition, mirroring how `createStore` routes. Files are a single isolation axis (the
pseudo-namespace `files`), not per-file-namespace: `get(id)`/`delete(id)` carry no namespace, and a
file's namespace is a metadata filter rather than a directory, so the whole file area moves together. A
profile that isolates `files` keeps its area under `profiles/<id>/files`; the default/unknown principal
and any profile that doesn't isolate it read the base area — byte-identical to before, so existing files
are untouched. The `files` axis is offered as a toggle in the profile's isolated-namespace editor.

Cross-partition file watching (a server watching every partition, filtered per connection) is still to
come — until then a profile that isolates files gets no live file events, and base watching is unchanged.

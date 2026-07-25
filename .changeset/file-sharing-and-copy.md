---
"@matatbread/matbot-storage-profiles": patch
"@matatbread/matbot-frontend-web": patch
---

File-item sharing and a `copy` action for the `share` tool — item-grain sharing now spans files, not just
documents, and gains a duplicate-with-ownership mode.

- **File sharing.** `share`/`unshare`/`ownerOf` now handle the `files` axis (`id` = the file id): a file
  is a data + `<id>.meta.json` PAIR on disk, so sharing links both into the target's file area (named files
  may be nested → the target subdir is created), reads flow through the symlinks to the owner's live file,
  and `unshare` unlinks the pair. `ownerOf('files', id)` reports the owning profile (the read-only badge
  signal). A shared-in file is **read-only**: a `put`/`putTemp` under the shared name throws `ReadOnlyError`
  (it would fork the data and write through the meta symlink to the owner); anonymous puts and delete pass.
  The shared-in file set is seeded at open() (scanning each partition's file area for `.meta.json` symlinks)
  and feeds both the write-guard and Task B's live-watch OR-clause, so an owner's edit to a shared file
  reaches every sharee's firehose connection.
- **`copy` action.** A new `action: 'copy'` on the `share` tool writes an independent duplicate the target
  fully owns and can edit (unlike `share`'s read-only link). Item ids are preserved (a fresh isolated
  partition keeps intra-set references valid); a shared-in source is dereferenced to its live content.
  Documents copy through the target partition's store; files copy the data + meta pair (a copied file goes
  live via the target's watch pump); skills route through the `SkillManager` (discovered loosely) under
  `runAs(target)` so the copy is indexed into the KnowledgeIndex and evented, falling back to a structural
  doc copy when skills isn't loaded.
- **`id: '*'`.** `share`, `unshare`, and `copy` accept `*` to mean the whole namespace — every item in the
  source namespace (share skips items that are themselves shared in; unshare drops all target-side links).
- **Bulk ownership.** The `owner` action with `id: '*'` returns an `owners` map of every shared-in item in
  the namespace to its owner profile (read from the in-memory shared-in set), so a UI can gate a whole
  file/session list's share affordance in one round-trip instead of one `owner` call per item.
- **Clearer share/copy failures.** When a target profile doesn't isolate the namespace, the error no longer
  claims it "already reads the shared base data" (which read as "the target already has this item" — false
  for an item in your own isolated partition). It now names the intersection of the two profiles' isolated
  sets (the only namespaces shareable between them) and, when the namespace isn't an isolatable axis at all,
  redirects a mis-typed file share to `namespace: "files"` (the common `workspace` ≠ `files` slip). The tool
  description makes the same isolation-axis-vs-content-namespace distinction explicit.
- **Web frontend (showcase).** File items in the sidebar gain a share affordance mirroring the session one:
  a share button (targets = profiles that isolate `files`) calling `share` with `namespace: 'files'`, and a
  read-only badge naming the owner on a file shared in from another profile (share button withheld). The
  file list stays profile-agnostic — ownership comes from a single `owner`/`*` call, not the workspace tool.

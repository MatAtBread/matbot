---
'@matatbread/matbot-cli': patch
---

Warn once when a configured storage backend is discarded by another plugin's.

Exactly one `StorageBackend` is ever active: the boot pre-scan opens the first configured plugin that
offers one and stops, and a plugin registering one later displaces it at the quiescent edge. Both are
supported operations, and neither said anything — but the loser has usually already created its file,
so configuring two storage plugins left an orphaned database and every write going somewhere else,
presenting as "my backend is configured and does nothing".

The concrete case is `storage-profiles` alongside `storage-sqlite`. Profiles composes the filesystem
primitive directly rather than wrapping the active backend (partitioning is medium-specific — nested
directories here, a partition column or row-level policies elsewhere — so there is no general wrapper),
which means it cannot layer over SQLite and instead replaces it, whichever order they are listed in.
The host now says so once, naming the displaced plugin, at the moment it stops being true.

The rationale is written down in `CLAUDE.md` and the profiles README, including why the shared
`ProfileDirectory` surface does not need hoisting into `plugin-api`: consumers duck-type the *active*
backend on method presence, so any backend exposing that shape is already picked up by the existing
tools with no import and no API change.

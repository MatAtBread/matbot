---
"@matatbread/matbot-storage-profiles": patch
---

The profiles backend can now be **hot-added at runtime — no restart**. Previously, loading the plugin after
boot did nothing: it installed its backend only via the boot pre-scan `open()` hook (which a hot load never
runs) and bailed. It now mirrors the sqlite backend — on hot-load, `setup()` opens the backend and
`register('StorageBackend', …)`s it (dotData derived from `configPath`), then registers the
`profile_action`/`share` tools and the `WatchVisibility` watch layer, which resolve the backend live per call
so they work the moment the swap lands. The swap is applied immediately when the machine is idle and at the
turn's end when loaded mid-turn; `unloadPlugin` reverts to the host base via the recorded service key.
Existing data is untouched (the base layout is byte-identical to the plain filesystem backend).

Things I think we're missing, esp in an enterprise env. No specific order

* Media input & output (esp pdf, html, etc) - maybe pdfmake?

## Considered and parked

* **A storage drain/migrate tool** (copy one `StorageBackend` into another). `StorageBackend.namespaces?()`
  was added to make a backend traversable, which is the prerequisite — but the copy itself is **parked, and
  deliberately not modelled in the API.**

  The obstacle is not implementing the copy; a document-level copy through `Store.get`/`set` is
  straightforward and even survives encryption at rest (the source decrypts on read, the target encrypts on
  write). The obstacle is that **enumerating what to copy is undefined for a whole class of backends.** A
  generic drain assumes one caller can observe the entire store, and that assumption breaks the moment
  partitioning is defined by an external authority: a backend doing real auth cannot enumerate its
  principals, and one holding per-principal keys cannot be read in full by any single session. So the
  operation is undefined rather than merely difficult — the better reason to stop.

  `storage/profiles` makes this look easier than it is. It exists to prove partitioning threads through the
  system correctly, and its filesystem partitioning happens to be fully enumerable; a genuinely useful
  implementation (auth-backed, or encrypted per principal) would not be. Encoding a profile-aware drain — a
  `--ignore-profiles` flag, say — would have been the CLI learning that "profiles" is a general concept on
  the strength of the one implementation where it is easy, which it is not (see CLAUDE.md, *Storage*:
  partitioning is a backend capability, not a layer over backends).

  If it is ever revisited: it belongs as a `matbot` subcommand rather than a `scripts/` helper (`scripts/`
  is not in the CLI's published `files`, so it reaches only source checkouts), it should open both backends
  by spec via `plugin.storageBackend.open()` without ever calling `setup()` — loading a module is not
  loading a plugin, so nothing needs to take over the registry — and it must report what it did **not**
  traverse rather than returning a clean success over a partial copy.

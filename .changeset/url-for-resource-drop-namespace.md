---
"@matatbread/matbot-frontend-web": patch
"@matatbread/matbot-frontend-dom": patch
---

`url_for_resource` no longer takes a `namespace` — the word now means exactly one thing on the wire.

The parameter was asking the model for a file's *content* namespace (`"workspace"`), while the `share`
tool's identically-named parameter takes a storage *isolation axis* (`"files"`). Same name, two different
levels, contradictory values for the same file — so a model that had correctly learned one binding
generalised it to the other and produced calls that could not resolve. The frontend tools are the
exposure half of stored files and have no business asking which sub-namespace a file was written under.

`url_for_resource({ name })` now looks the file up by the path it was stored under and sources the route's
namespace segment from the stored handle, so the minted URL is unchanged. A file with no stored namespace
has no addressable path under the `/files/<namespace>/<name>` route and reports as not viewable rather
than minting a URL that would 404. Both frontends (served + in-process DOM) change identically, as they
share one merged `ToolContracts` entry.

`workspace` survives only as the name of the tool and the UI panel; `files` only as the storage namespace
and isolation axis. Neither word now appears at both levels, so `share`'s `namespace: "files"` is the only
namespace the model is ever asked to supply for a file.

---
"@matatbread/matbot-cli": patch
"@matatbread/matbot-tool-plugin": patch
---

A fetched plugin can import a bare CDN URL (issue #89). A module imported by absolute URL keeps that URL as its identity, as it does in the browser, instead of being mirrored into `.plugins/<host>/…`: a CDN's URL space is not a file tree — `https://esm.sh/ms@2.1.3` is a module and the parent of `/ms@2.1.3/es2022/ms.mjs`, which crashed the mirror with `ENOTDIR` — so its imports resolve against the URL that answered (redirects included), the query is part of its name, its `import.meta.url` is the URL, and it is stored under `.plugins/.urls/` by hash. A module the old mirror held is copied in on first use, so an upgrade needs no network. A plugin's own files are mirrored as before; the mirror now refuses a dot-segment host or an encoded separator, which would put a file outside `.plugins/`, and its rules are stated once in `@matatbread/matbot-tool-plugin/cache-layout`.

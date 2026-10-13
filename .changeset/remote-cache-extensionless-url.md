---
"@matatbread/matbot-cli": patch
"@matatbread/matbot-tool-plugin": patch
---

A fetched plugin can import a bare CDN URL (issue #89). A URL may be a module and the parent of others — `https://esm.sh/ms@2.1.3` re-exports `/ms@2.1.3/es2022/ms.mjs`, which is how esm.sh, jsdelivr and unpkg all serve a bare package — and the `.plugins/` cache mirrored each under its own path, so the first became a file and the second's `mkdir` failed with `ENOTDIR`. A path with no module extension is now cached with `.mjs` appended, beside the directory its children need (`ms@2.1.3.mjs` next to `ms@2.1.3/`), by the module hook and `materializeRemote` alike; a path that has one, and a plugin's declared `files`, stay where they were. The file a failed attempt left behind is cleared when it stands where a directory belongs. The one collision no rule over the URL can avoid — a module-named path also used as a directory, `https://esm.sh/chart.js` with `…/chart.js/auto` — now fails saying so in either order; a pinned `chart.js@4.5.1` is unaffected.

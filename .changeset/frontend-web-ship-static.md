---
"@matatbread/matbot-frontend-web": patch
---

Ship the `static/` UI assets (index.html, app.js, http-transport.js, favicon) in the
npm package. `files` was `["src"]`, so the published package omitted the web UI it
serves at runtime.

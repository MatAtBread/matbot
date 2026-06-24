---
"@matatbread/matbot-frontend-web": patch
---

Ship the static UI assets (index.html, app.js, browser.js, http-transport.js,
favicon) by listing them concretely in `files`. Previously `files` was `["src"]`, so
the published package omitted the web UI it serves at runtime; concrete entries also
let a github/http install mirror them (a raw host can't be directory-listed).

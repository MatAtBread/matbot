---
'@matatbread/matbot-frontend-web': patch
---

Serve the running harness version as `x-matbot-version` on every response, and reload a page that
loaded against a different one. The version comes from `about_matbot` — the same value app.js already
shows in `#matbot-version`, which is what the HTTP transport compares each response's header against —
so a server restarted on a new build no longer leaves a long-lived tab running stale UI code against a
newer API. Static assets are now served `cache-control: no-cache` so the reload re-fetches them.

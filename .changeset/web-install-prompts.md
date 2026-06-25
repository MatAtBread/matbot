---
"@matatbread/matbot-frontend-web": patch
---

fix(frontend-web): click-to-install banners name the exact package and discover locally first

The "Enable workspace", "Install edit-session", and "Enable sessions" banners sent the
LLM a partial plugin name, which led it to guess registry name variations. They now name
the exact package (`@matatbread/matbot-tool-workspace`, `@matatbread/matbot-edit-session`,
`@matatbread/matbot-sessions`), instruct it to run `discover_local` first and add from the
local cache if present, and only then fall back to npm/github by that exact name — with an
explicit "do not guess other name variations".

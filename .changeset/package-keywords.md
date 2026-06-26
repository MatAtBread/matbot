---
"@matatbread/matbot-cli": patch
---

Add npm `keywords` to every published package. A shared `matbot` anchor on all of
them plus a role tag by location (`matbot-plugin-api`, `matbot-core`, `matbot-app`,
`matbot-plugin`, and `matbot-provider`/`matbot-frontend`/`matbot-storage`). This makes
the family discoverable via npmjs keyword search (`keywords:matbot`,
`keywords:matbot,matbot-provider`) rather than relying on the lagging text/org index.

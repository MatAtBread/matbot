---
'@matatbread/matbot-plugin-api': patch
'@matatbread/matbot-core': patch
'@matatbread/matbot-cli': patch
'@matatbread/matbot-web-bundle': patch
'@matatbread/matbot-frontend-web': patch
---

`about_matbot` reports the system prompt in force, broken down by the plugin that contributed each part.

**The model could not see its own system prompt.** It is assembled once per submit from every registered
`SystemContextContributor` and never persisted, so there was nothing on the session to read back and no
tool that reported it — asked "what are your instructions?" or "why do you keep doing that?", the model
could only guess, while the answer sat in a registry it had no route to. `about_matbot` already answered
the adjacent questions (which model, which provider, which harness version), so it answers this one too:
`systemPrompt` is the joined text exactly as the turn received it, and `systemContext` is the same
content kept apart, each part carrying the name of the plugin that registered it. Attribution is the
half that makes it actionable — "the skills catalogue put that there" names the thing to change.

**`SystemContextRegistry` gains `parts(ctx)`**, and `build()` now derives from it: one traversal and one
filter, so the text sent and the breakdown reported cannot drift into disagreeing about what is in the
prompt. Breaking for a host that hand-rolls the registry rather than constructing core's
`SystemContextRegistryImpl` (nothing in this repo does); `build()`'s own signature and behaviour are
unchanged, empty contributions dropped and `null` for none at all.

**`createAboutMatbotTool(version)` is now `createAboutMatbotTool(version, services)`** — it needs the
live machine to rebuild the prompt, the same second argument `createSingleTurnTool` already takes.
Rebuilt rather than recorded: against the turn's own session it is the same text, and where a
contributor's source moved mid-turn (a skill added, a plugin loaded) it correctly reports what the next
call will carry rather than what the last one did.

**The web UI puts it behind the version in the header.** Clicking `matbot vX.Y.Z` runs `about_matbot`
over HTTP and shows the harness line, the provider, and the system prompt broken down per contributing
plugin with a character count each — the one thing the UI had no window onto at all. Re-run on each open
rather than reusing the copy taken at boot, because the interesting half changes while the page is up (a
plugin loads, a skill is flagged for the catalogue) and a stale answer to "what are you being told?" is
worse than none. It names the provider selected in the tab rather than the tool's `currentProvider`, which
is absent here by construction: the direct tool endpoint builds a session-less context, so there is no
turn to report — and the overlay says which it is showing rather than implying the tool answered.

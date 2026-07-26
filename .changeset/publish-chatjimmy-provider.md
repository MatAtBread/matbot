---
"@matatbread/matbot-provider-chatjimmy": patch
"@matatbread/matbot-cli": patch
---

**Optional (providers/chatjimmy).** The ChatJimmy adapter is no longer `private` — it publishes as
`@matatbread/matbot-provider-chatjimmy` and is a dependency of the CLI, so it appears in the first-run
setup wizard's provider list (option 5) and resolves by bare package name from an installed matbot as
well as a source checkout. A hosted llama endpoint: keyless, non-streaming (one `text-delta` per turn),
text-only and no tool-calling — useful as a low-latency comparison point rather than a
general-purpose provider.

---
"@matatbread/matbot-triggers": patch
---

An assistant message with no tool calls in its turn is summarised to the classifier as `[Tool calls in this turn: none]`, on both surfaces: as the reply being judged, and as the preceding message beside a judged user message. In 0.4.23 such a turn had no line, which the classifier could not tell from a summary it was not shown, so a condition on a reply made without tools could only be guessed at.

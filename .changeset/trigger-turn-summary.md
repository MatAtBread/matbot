---
"@matatbread/matbot-triggers": patch
---

The trigger classifier is told what each message's turn held besides its text. Each side of the pair it judges ends with a bracketed summary: a user message lists its attachments (`[Files in this turn: def.pdf (application/pdf)]`), and an assistant message lists every tool call in its turn, across rounds (`[Tool calls in this turn: http ×2, tool_function]`, or `none`). The classifier is shown text alone so that it stays small and quick, so a condition such as "no tool was called" or "the attachment is a PDF" could only be guessed at. A user message that is only an attachment is now judged; with no text, it was skipped.

---
"@matatbread/matbot-provider-webllm": patch
---

A WebLLM reply is read for the call it makes, not only for the tags it was told to write.

Measured on `Qwen3-1.7B-q4f16_1-MLC`, asked what tools it had, the whole reply was `<think>\n\n</think>\n\n{"name":
"tool_search", "arguments": {"query": "List the tools I have"}}` — a complete, well-formed call with the two
`<tool_call>` tags its prompt had just shown it missing. WebLLM's structural tag constrains only what follows
that literal, so the grammar never fired, the parser found no marker, and the call arrived as JSON in a text
bubble with the tool it meant to call never called. A call written with no wrapper is now read as a call (an
object, or a `[…]` of them, naming `arguments` so a JSON example in prose stays prose), with any prose before
it emitted first, and `parameters.lenientCalls: false` to turn that off.

Three other faults in reading a reply, all of which turned a formatting slip into something else:

- A call written inside an unclosed `<think>` block was swallowed as reasoning — invisible when `thinking` is
  off, and "reasoned, then forgot to call" when it is on. A call now ends reasoning, as vLLM's own Qwen3 parser
  treats it, for Qwen3 opens `<think>` and writes the call without closing the block.
- A `<tool_call>` whose body would not parse was executed with `{}` for its arguments, so the tool ran blind
  and its error or default dump read as the model's answer. It is now reported as `unparsed-call` and shown as
  the model wrote it, unexecuted: an unreadable call has no arguments to run with, and the model meets its own
  attempt again in history. A call the reply ended *inside* is still a `truncated` tool call, but one whose
  JSON had closed and only `</tool_call>` was cut is an ordinary call — its arguments are whole.
- `arguments` given as a JSON string (Qwen's template accepts both, and the small builds use either) is
  normalised to the object the tool declared; a trailing comma before a closing bracket is repaired for a body
  that does not otherwise parse; and the tags are recognised as a model writes them (`<tool_call >`,
  `<toolcall>`). The tools prompt repeats the tag requirement after its example, since a small model imitates
  the line it read last — the example object is what it was copying.

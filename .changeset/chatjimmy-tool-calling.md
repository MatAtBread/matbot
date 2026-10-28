---
"@matatbread/matbot-provider-chatjimmy": patch
---

Tool calling, done in the prompt because the endpoint has none. On by default; `parameters.tools: false`
turns it off. The tools are described in the system prompt in the `<tools>` / `<tool_call>` format, calls
are parsed out of the reply, and results are replayed as `<tool_response>` user turns that name the call and
restate the user's question. Without that, Llama 3.1 8B read a result as the user's own words: it called an
unrelated tool, wrote about the result, or (told only to "answer the user's question with it") advised
someone on how they might answer.

Only the first `maxCalls` calls of a reply are kept (default 1), and the rest of the reply is dropped. The
endpoint ignores `stop`, so the model writes on past a call, inventing further calls or a guess at the
result. A call whose arguments are not an object (`"arguments": "ls /tmp"`) is shown, not run. A call
written without its tags is still read (`lenientCalls: false` turns this off), and so is Llama's own
`parameters` key. A closing tag pairs with the nearest opening one, because the model also writes the tag
into its prose ("let me call it with a<tool_call> to get…"), and the code fence it wraps a call in is
stripped. A reply that ends at the token limit is reported as truncated. Sampling defaults to greedy
(`topK: 1`) when tools are offered, which made the first round reliable where top-k 4 failed about a third
of the time; a profile's `topK` still wins, and text-only requests keep the default of 8.

Every request is fitted to the endpoint's ~6k-token window (`contextWindow`, default 6144, less
`maxTokens` for the reply). Past the window the endpoint answers with an empty body, which matbot recorded
as an empty turn: every round after a `tool_search` came back empty, its finds alone being several times
the window. In order, until it fits: older tool results shortened, tool descriptions cut to their first
paragraph, the earliest turns left out, then tools left out, the ones named in the latest tool result
last. A turn that still cannot fit is refused before it is sent, and an empty response is reported as an
error. `debug: true` logs each exchange whole.

With `tools: false`, no tools are described and history is replayed as text only, as before. The window
fitting still applies. A profile kept for latency tests may want this, since the tools prompt lengthens
every request.

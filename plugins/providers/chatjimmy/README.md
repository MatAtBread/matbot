# @matatbread/matbot-provider-chatjimmy

This is a [matbot](https://github.com/MatAtBread/matbot) plugin.

ChatJimmy provider adapter — a very fast hosted llama endpoint, handy for odd-ball / latency tests.

Non-streaming: the endpoint returns the whole completion in one response body (with a trailing
`<|stats|>` block the adapter parses for token counts), so a turn arrives at once.

Showcases the exceptionally fast Taalas HC1 hardware inference engine. See [https://taalas.com/products/](https://taalas.com/products/)

```yaml
providers:
  jimmy:
    module: @matatbread/matbot-provider-chatjimmy
    endpoint: https://chatjimmy.ai/api/chat
    model: llama3.1-8B
```

Both `endpoint` and `model` default to the values above, and no credentials are needed.

## Tool calling

The endpoint has no tool support, so the adapter does it in the prompt: the tools are listed in the system
prompt in the `<tools>` / `<tool_call>` format, calls are parsed out of the reply, and tool results are
replayed as `<tool_response>` turns that restate the user's question and say what to do next. It is on
by default; `tools: false` turns it off, for instance on a profile kept for latency tests.

```yaml
providers:
  jimmy-tools:
    module: @matatbread/matbot-provider-chatjimmy
    parameters:
      tools: false       # don't offer the turn's tools (default true)
      maxCalls: 1        # calls kept per reply (default 1)
      lenientCalls: true # read a call written without its tags (default true)
      contextWindow: 6144 # tokens shared by the prompt and the reply (default 6144)
      maxTokens: 1024    # room kept for the reply within that window (default 1024)
      debug: false       # log every exchange whole: what the model was sent and what it wrote
      topK: 1            # default 1 when tools are offered, 8 otherwise
```

### The context window

The endpoint's window is about 6k tokens, shared by the prompt and the reply. Past it, the endpoint returns
an empty response, and close to it the reply stops part-way. matbot's tools are far bigger than that: the
registered tools come to ~100k characters, and one `tool_search` loads a dozen full specifications. So
every request is cut down to fit, least useful first, and a warning names what was given up (the session
itself is unchanged):

1. older tool results shortened to 400 characters, and the latest to 4,000;
2. tool descriptions cut to their first paragraph, and the schema's own descriptions to their first
   sentence (the keys, types, enums and required fields stay whole);
3. the earliest turns left out (the model is told);
4. tools left out, starting with the last offered, but never one named in the latest tool result, which
   keeps what `tool_search` just found. If `tool_search` itself is still listed, the model is told that
   more tools exist.

A turn that cannot fit even then is refused before it is sent. An empty response is reported as an
error naming the window, not passed on as an empty turn.

What to expect from Llama 3.1 8B:

- Simple single-tool turns work well: it calls the right tool with the right arguments, answers from the
  result, and answers plainly when no tool is needed. Through `tool_search` it reached the tool it needed
  (`about_matbot`, `workspace_action`) and answered from that tool's result. It sometimes invents a tool
  name first, then recovers from the "not registered" error.
- It does not stop after a call. Nothing ends generation there, and the endpoint ignores `stop`, so it
  writes on: more calls, mostly invented, or a guess at the result. Only the first `maxCalls` calls are
  kept, and the rest of the reply is dropped (logged as a warning). Raising `maxCalls` allows parallel
  calls, along with the invented ones.
- Nothing constrains a call's shape: an unknown tool name gets through, and a call whose arguments are
  not an object is shown as text rather than run. Loading `json-validation` catches calls with the wrong
  shape, and `tool-router` keeps the tool list short.
- Tasks needing several rounds are less reliable: it may answer after the first result.
- It sometimes adds an argument the tool doesn't declare (`about_matbot {"format": "string"}`).
- Sampling is greedy (`topK: 1`) by default when tools are offered. With `topK: 4`, about a third of first
  rounds talked about tools, invented one, or searched on a greeting. A profile's own `topK` overrides it.
- `debug: true` logs each exchange, which is the way to see why a live turn went wrong.
- The endpoint rate-limits (a 429 after about a dozen quick requests), and a turn with tool rounds makes
  several requests.

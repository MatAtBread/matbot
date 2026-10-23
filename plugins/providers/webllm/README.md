# @matatbread/matbot-provider-webllm

This is a [matbot](https://github.com/MatAtBread/matbot) plugin.

**Prototype.** A provider adapter that runs open-weight models in the page, on the GPU, through
[WebLLM](https://github.com/mlc-ai/web-llm). It needs no endpoint and no key, and makes no network calls
once the model is cached. It is browser-only and needs WebGPU.

The library is not a dependency. It is imported from a CDN (WebLLM 0.2.85, pinned) the first time this
provider is used, so an install that never picks it pays nothing. It runs in a module worker, so the page
stays responsive while the model works.

The browser bundle's setup wizard offers it as a self-contained adapter with `Qwen3-4B-q4f16_1-MLC`.
Configured by hand:

```json
"providers": {
  "qwen": { "module": "@matatbread/matbot-provider-webllm", "model": "Qwen3-4B-q4f16_1-MLC" }
}
```

`model` is any WebLLM prebuilt model id, e.g. `Qwen3-8B-q4f16_1-MLC` (~5.7 GB of GPU memory) or
`Qwen3-1.7B-q4f16_1-MLC` (~2 GB). Only one model is kept loaded. A different one replaces it once no call is
still using the old one.

The id is checked before anything downloads:
- an id WebLLM does not know is refused, naming the closest ones;
- a model not trained on this adapter's tool format is refused while tools are offered (see below);
- a `q4f16` build on a GPU without the `shader-f16` feature is refused, naming its `q4f32` build.

### Which models can call tools

WebLLM records nothing about this. Its `functionCallingModelIds` concerns its own `tools` path, which this
adapter does not use. What matters here is whether a family was trained on the Hermes
`<tool_call>{"name": …, "arguments": …}` format, as read off each family's published chat template. The
constraint can force a valid call only once a model writes `<tool_call>`, and one never trained on it rarely
does.

| Family | Tool calls here | Why |
|---|---|---|
| Qwen3, Qwen2.5, Qwen2.5-Coder | yes | Hermes-style JSON in the template |
| Hermes-2-Pro, Hermes-2-Theta, Hermes-3 | yes | the format's origin; documented on the model cards |
| Qwen3.5 | no | calls tools in XML (`<function=…><parameter=…>`); supportable later via WebLLM's `qwen_xml_parameter` tag |
| Qwen2.5-Math | no | shares Qwen2.5's template, but is a maths specialist |
| Llama 3.x, Mistral, Ministral | no | formats of their own |
| Qwen2, DeepSeek-R1 distills, Phi, Gemma, SmolLM2, others | no | no tool format |

That is 39 of WebLLM 0.2.85's models. With tools offered, any other is refused, naming the closest one that
qualifies. With `parameters.tools: false`, any chat model may be used for plain conversation.

A refused request leaves the loaded model alone.

## `webllm_models`

The plugin also registers a tool for choosing among models:

- **`list`** describes the models the library can run that can call tools (above), smallest first. Detail costs context, and a small
  model's window is the scarcest thing here: a full row for each would cost far more than the ids. So:
  - **`matched`**: full rows, only for the models a call selects. A row gives the id, the GPU memory needed
    (`vramMB`), whether this GPU has the features it needs (`runsHere`), and whether it is `downloaded` or
    `loaded`. A call selects with `query` (words that all appear in the id, e.g. `"qwen3 4b"`) and/or
    `downloaded: true`.
  - **`others`**: just the ids (about 400 tokens for all 39), given when the call selects nothing,
    or when its selection matches nothing. A model that searched for something that is not in any id
    (`"webllm"`) gets the ids it can search, not an empty list.
  - **`hint`**: says which of these happened and how to narrow.
- **`delete`** removes a downloaded model from this origin's cache to free its storage.

To switch a profile, pass a listed id to the `provider` tool's `update`.

The list is WebLLM's own (`prebuiltAppConfig`), not a directory on Hugging Face. Hugging Face's `mlc-ai`
organisation has far more converted weights (Qwen3 14B and 32B among them), but a model also needs a model
library compiled for WebLLM's version, and only the listed ones have one. The tool reads through the
library and cache the provider last used, so it sees the same models and downloads.

The tool is registered when the plugin loads. matbot loads a provider's module on its first use, so the
tool appears once a WebLLM profile has answered once, or straight away if the plugin is loaded explicitly.

## Parameters

| key | meaning |
|---|---|
| `contextWindow` | Tokens. Default 8192. WebLLM's own default for Qwen3 is 4096, which matbot's system context and tool list can fill alone. A larger window costs GPU memory. |
| `thinking` | `true` lets Qwen3 reason before answering, streamed as `thinking`. Off by default, because on a laptop GPU it is most of the wait. |
| `tools` | `false` offers no tools. |
| `cache` | Where weights are kept: `cache`, `indexeddb`, `opfs` or `cross-origin`. Defaults to `indexeddb` for a page opened from `file://`, where Cache Storage is unavailable, and to WebLLM's default otherwise. |
| `library` | Another WebLLM build to import, as an ES module URL. |
| `maxTokens`, `temperature`, `topP`, `stopSequences` | Passed through. |

## Tool calls

WebLLM's own `tools` support is not used. It is hard-wired to two 2024 Hermes models. It refuses a system
message of the caller's, so matbot's system context could not be sent. And it forces every reply to be a
JSON array of calls, so the model can never simply answer.

Instead the adapter does what the models are trained on. Tools are described in the system prompt in Qwen's
format (`<tools>…</tools>`), and the model calls one with `<tool_call>{"name": …, "arguments": …}</tool_call>`.
A WebLLM *structural tag* constrains everything after `<tool_call>`:

- each tool's opening text includes its name, so only an existing tool can be called;
- its arguments must satisfy that tool's `inputSchema`.

Text outside a call is unconstrained, so the model still writes prose. The constraint enforces shape (keys,
types, enums, required fields), not the content of a free string. It is reliable on models trained on this
format: Qwen and Hermes.

History is rendered the way Qwen's chat template renders it: calls as `<tool_call>` blocks after the
assistant's text, results as `<tool_response>` blocks in a user turn. Rendering is deterministic, so WebLLM
can reuse its prefill whenever a request extends the previous conversation exactly. A tool round or a new
turn then prefills only what is new.

## Long conversations

The model's context window (8192 tokens by default) is much smaller than a remote provider's. A session
moved here from Claude or GPT would otherwise fail with WebLLM's `ContextWindowSizeExceededError`. A single
large tool result does the same: it fills most of the window, and the next turn has room for little else.
So when a conversation does not fit, two things happen, cheapest loss first:

1. **Large tool results in earlier turns are shortened.** A result over 800 characters keeps its first 400,
   plus a note of how much was left out and that calling the tool again shows the whole of it. That is the
   bulk the model has already read and answered from. Who asked what, and what was decided, survives. The
   current turn is never shortened: its latest result may be what the model is answering from.
2. **The oldest turns are left out** only if that is not enough.

Either way:

- **The session is unchanged.** Switching back to a large-window provider sends everything again.
- **Whole turns only.** A turn is a user message and everything after it, so a tool call is never parted
  from its result. The current turn is always kept.
- **Room for the reply.** The budget is the window minus `maxTokens` (or 1024).
- **Estimated size.** WebLLM has no way to count tokens ahead of a request, so size is estimated from
  rendered length at 3 characters per token. If WebLLM still refuses at prefill, which is before any output,
  the call is re-fitted with a stricter estimate, up to twice.
- **A stable start.** Once a conversation needs shortening, that is remembered for it, and a turn's shortened
  form never changes. When turns must go, the cut leaves a quarter of the budget spare and is remembered too. That keeps the start of what is sent unchanged for several turns, which is
  what lets WebLLM reuse its prefill; a cut that moved every turn would re-read the whole window every time.
- **The model is told.** A shortened result says so itself. A line in the system prompt says how many
  earlier turns it cannot see, and to say so rather than guess. The user sees a console warning listing both.

If the system prompt, the tools and the current turn alone do not fit, the call fails with an error naming
the remedies: a larger `contextWindow`, fewer tools, or a new conversation.

### Open: shorten or summarise

Leaving turns out is the simplest strategy that avoids the error, not a settled design. The alternatives:

- **Shorten (what this does).** Shrinking old tool results, then dropping turns. Cheap and exact, and stable
  enough for prefill reuse. Everything in the
  omitted turns is gone as far as the model is concerned.
- **Summarise, recursively.** The gist of what is cut survives, but each summary is a generation pass by the
  same small model, out of the same small window. Summaries of summaries drift. And every new summary changes
  the start of the prompt, so prefill reuse is lost unless summaries are made in fixed chunks at the cut.
  It also belongs outside this adapter. A model answering from a summary that is in no session breaks
  matbot's rule that the session is the record. A `contribute` hook that stores its summary as a marker
  would be visible, durable, and usable by any small-window provider.
- **Fetch on demand.** Leave turns out, but let the model ask for them. The note already says they exist;
  a tool that reads them back (`session_action get`, or a search over the session) would keep the window
  small and fetch only what a question needs. It depends on the model knowing when to look, which is the
  weakest skill of a small one.

These can combine: shorten always, summarise or fetch for what is cut.

## Known gaps

- Not yet run against a real WebLLM engine. It was exercised only against a fake that follows WebLLM's types.
- No images or audio. They are replaced by a note. WebLLM's vision models (Phi-3.5-vision) are not wired in.
- The schema is compiled into a grammar on each request that offers tools. A large tool list may make that
  noticeable.
- First use downloads several GB from Hugging Face and GitHub. The download is cached per origin, so the
  same model is fetched again for a different host.

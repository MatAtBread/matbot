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
- a `q4f16` build on a GPU without the `shader-f16` feature is refused, naming its `q4f32` build.

A refused request leaves the loaded model alone.

## `webllm_models`

The plugin also registers a tool for choosing among models:

- **`list`** returns every LLM the library can run, smallest first. Each entry gives its id, the GPU memory
  it needs (`vramMB`), whether this GPU has the features it needs (`runsHere`), and whether it is already
  `downloaded` or `loaded`. `query` narrows by words in the id (`"qwen3 4b"`), and `downloaded: true` lists
  only what is on this device. The full list is over 150 entries, too long for a small model's context, so
  the description steers it to filter.
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

## Known gaps

- Not yet run against a real WebLLM engine. It was exercised only against a fake that follows WebLLM's types.
- No images or audio. They are replaced by a note. WebLLM's vision models (Phi-3.5-vision) are not wired in.
- The schema is compiled into a grammar on each request that offers tools. A large tool list may make that
  noticeable.
- First use downloads several GB from Hugging Face and GitHub. The download is cached per origin, so the
  same model is fetched again for a different host.

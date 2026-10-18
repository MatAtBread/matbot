# @matatbread/matbot-provider-prompt-api

This is a [matbot](https://github.com/MatAtBread/matbot) plugin.

**Prototype.** A provider adapter for the browser's built-in on-device model through the
[Prompt API](https://github.com/webmachinelearning/prompt-api) (`LanguageModel`). In Chrome, that model is Gemini Nano. It needs no
endpoint and no API key, and makes no network calls after the one-off model download. It is browser-only.

The browser bundle's setup wizard offers it as a self-contained adapter. Configured by hand:

```json
"providers": {
  "nano": { "module": "@matatbread/matbot-provider-prompt-api", "model": "on-device" }
}
```

`model` is required by the provider shape but ignored: the browser decides which model runs.

## Parameters

| key | meaning |
|---|---|
| `samplingMode` | `most-predictable` … `balanced` … `most-creative`. This is the web page's sampling control. |
| `thinkingEffort` | `none` / `low` / `medium` / `high`. Thoughts stream as `thinking` and are kept as an unsigned `reasoning` block. |
| `languages` | Expected text languages, e.g. `["en"]`. These are hints for Chrome's download and capability check. |
| `tools` | `false` runs text-only even when tools are offered. Use it when the tool declarations do not fit the context window. |
| `temperature`, `topK` | Passed through. Chrome honours them only in extension contexts and ignores them on a web page. |

## How it maps

matbot adapters receive the whole history on every call, but the Prompt API is session-based. So each call
builds a session from that history:

- **Base session.** The system prompt, tool declarations and expected modalities form a *base* session. The
  adapter creates one per distinct configuration and `clone()`s it per call, so that part of the prefill is
  paid once. A configuration change replaces the base session.
- **History.** History is `append`ed one message at a time, then the final message is prompted. When an
  append overflows the window, the API evicts the oldest turns and keeps the system prompt. Sending the
  history as one block larger than the window would fail instead.
- **Tools.** Tool use is the explainer's open-loop form. The model returns `tool-call` items, and matbot's
  runner executes them as it does for any provider. Results go back as `LanguageModelToolSuccess` or
  `LanguageModelToolError`. Ids are not provider-minted state, so tool calls made by another provider in
  the same session also replay natively.
- **Missing capabilities.** A capability the browser lacks is degraded, not sent. Only a yes is cached,
  since Chrome says no to everything while its model service is still starting:
  - With no open-loop tool use, the call runs text-only, and earlier call/result pairs become text notes.
  - An image or audio clip the model cannot take becomes a note.
- **Download.** The first-run model download and load report as `progress` events, which the web UI
  draws as a bar on the pending reply. They are live-only and never persisted.
- **Usage.** The API has no per-call token report, only the session's running `contextUsage`. `usage` is
  therefore the difference across the prompt, and the raw figures are in `reported`.

## Known gaps

- Not yet run against a real `LanguageModel`. It was exercised only against a fake that follows the
  explainer (October 2026). The API is experimental, and Chrome's shipped surface may lag the explainer,
  especially tool use and the `contextUsage` rename.
- **The context window is small** (a few thousand tokens for Gemini Nano). matbot's system prompt plus a
  full tool list will often not fit, and that fails with a message pointing at `tool-router` or
  `tools: false`.
- Every call re-prefills the conversation history. Only the base session is reused. Keeping a warm
  session that grows with the transcript is the next optimisation, but it needs a reliable check that the
  transcript has not been rewritten underneath it (retract, compact, a hook edit).
- **User gesture.** Chrome starts the model download only from a user gesture. A turn started by a trigger
  or a background job before the model is present fails with an explanation.
- No `maxTokens` or stop sequences. The API has neither.

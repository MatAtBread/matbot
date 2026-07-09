# @matatbread/matbot-provider-google

This is a [matbot](https://github.com/MatAtBread/matbot) plugin.

Google Gemini provider adapter. One `module:`, two wire formats, chosen by the endpoint **path** (not host — a proxy may rewrite the host but keeps the path):

- a bare base (`…/v1beta`) or a native method path (`…/models/{model}:generateContent`) → the native `generateContent` adapter;
- a `…/chat/completions` / `…/openai/…` path → the shared OpenAI-compatible adapter in `gemini` mode.

Both round-trip Gemini 3 thought signatures (carried on a tool-call's `meta.google.thoughtSignature`) and gracefully degrade foreign, unsignable cross-provider tool calls to text context notes rather than eliding them silently. The native adapter also maps tool results into `user`-role `functionResponse` parts, lifts the system prompt to `systemInstruction`, and sanitizes tool schemas to Gemini's strict OpenAPI subset.

```yaml
providers:
  gemini:
    module: '@matatbread/matbot-provider-google'
    endpoint: https://generativelanguage.googleapis.com/v1beta   # native
    model: gemini-3.1-flash-lite
    credentials: { apiKey: ${GOOGLE_LLM_API_KEY} }
```

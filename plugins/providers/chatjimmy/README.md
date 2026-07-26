# @matatbread/matbot-provider-chatjimmy

This is a [matbot](https://github.com/MatAtBread/matbot) plugin.

ChatJimmy provider adapter — a very fast hosted llama endpoint, handy for odd-ball / latency tests.

Non-streaming and text-only: the endpoint returns the whole completion in one response body (with a
trailing `<|stats|>` block the adapter parses for token counts), so a turn arrives as a single
`text-delta`. No tool-calling.

Showcases the exceptionally fast Taalas HC1 hardware inference engine. See [https://taalas.com/products/](https://taalas.com/products/)

```yaml
providers:
  jimmy:
    module: @matatbread/matbot-provider-chatjimmy
    endpoint: https://chatjimmy.ai/api/chat
    model: llama3.1-8B
```

Both `endpoint` and `model` default to the values above, and no credentials are needed.

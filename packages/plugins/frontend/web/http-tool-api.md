# HTTP Tool API

Tools registered with the web server can be called directly over HTTP, outside of any session.

## Endpoint

```
POST /tools/:name
```

Where `:name` is the tool's registered name (e.g. `bash`, `http`, `schedule`).

## Request

`Content-Type: application/json`

```json
{
  "input": { },
  "principal": {
    "id": "some-principal-id",
    "grants": [{ "capability": "exec" }]
  }
}
```

- `input` — tool-specific input object (matches the tool's declared input schema)
- `principal` — the caller's identity; `grants` must include any capabilities declared in `tool.requires`

## Response

Returns `text/event-stream` (SSE). Each event has the form:

```
event: <type>
data: <JSON payload>
```

Event types and payloads match the tool's `ToolEvent` shape. The stream closes when the tool finishes or errors.

## Errors

| Status | Meaning |
|--------|---------|
| 400 | Invalid JSON body |
| 403 | Missing required capability |
| 404 | Tool not registered |

## Notes

- Aborting the HTTP connection aborts the tool via `AbortController`
- The tool runs with a stub ephemeral session (not persisted)
- `prompt()` resolves to the default value; rejects if no default is provided (non-interactive context)
- The server must be started with a `ToolRegistry` passed as `deps.tools` — tools are not exposed if omitted

## Implementation

`packages/frontend/web/src/server.ts`, lines 317–379.

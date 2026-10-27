# @matatbread/matbot-frontend-web

This is a [matbot](https://github.com/MatAtBread/matbot) plugin.

Web UI with session management. Node entry serves it over HTTP+SSE; browser entry mounts the same UI in-process. Both share index.html + app.js.

## Building your own UI against it

If you are writing a **different** frontend against this server — a React app, a soft-tabbed shell, an
embedded panel — read [docs/SSE-CLIENTS.md](../../../docs/SSE-CLIENTS.md) first. It covers what the two SSE
streams guarantee and what they don't: prompt delivery (a prompt is state, not an event, and must never be
answered on the user's behalf), heartbeat-based liveness detection, reconnect reconciliation, the
~6-socket-per-host budget, and what changes for a soft-tabbed UI or the serverless in-process build.

`static/app.js` + `static/http-transport.js` are the reference implementation of all of it.

## Calling it from elsewhere

The server answers its own origin only: the UI, and any dashboard it serves from `/files/`, call it
same-origin. A page hosted on another origin is granted by naming that origin in the plugin's settings:

```yaml
default_settings:
  '@matatbread/matbot-frontend-web':
    cors_origin: http://dashboards.lan:8080
```

Every POST must be sent as `Content-Type: application/json`, with or without a body; anything else is
refused with 415. That is what stops a page on another origin from sending one without the browser asking
first.

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

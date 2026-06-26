---
"@matatbread/matbot-cli": patch
---

frontend-web: don't crash the process when an SSE write hits a dead socket. Tearing the server down
mid-stream (e.g. unloading the frontend-web plugin while a session's `/events` stream is open) makes
a pending `res.write` emit an asynchronous `'error'` on a later tick — which escapes the request
handler's try/catch and, with no listener, becomes an unhandled `'error'` event that exits the
process. The handler now attaches a no-op `'error'` listener to every request/response, so a
dead-socket write is absorbed (the SSE loop already breaks on `!res.writable`).

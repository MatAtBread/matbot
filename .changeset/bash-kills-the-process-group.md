---
'@matatbread/matbot-tool-bash': patch
'@matatbread/matbot-core': patch
---

`bash` ends when the process it waited for ends, and takes every process it spawned with it.

`bash -c` forks each pipeline stage as its own process, and the plugin got both halves of that wrong.
Its abort handler and its `timeout` signalled the **direct child** only, with no `detached` and therefore
no process group to signal — so `find / … | head -5` lost its shell to the SIGTERM and left `find`
running, reparented to init, traversing the whole filesystem with nothing in the app able to stop it. And
completion hung off `'close'`, which needs the process to have exited **and** every stdio stream to have
reached EOF — so the orphan holding the script's stdout meant the event stream never terminated. Together
they made the turn unrecoverable: the session sat at "working" for ever while every abort reported
success, because the abort worked and the tool call was simply unreachable. Measured: `'exit'` at 14ms,
`'close'` at 5021ms behind a five-second orphan.

So the script now gets its own process group (`detached`, POSIX only — Windows keeps the direct-child
kill), every stop signals the negative pid and escalates SIGTERM → SIGKILL after a grace, and `'exit'` is
authoritative for completion: `'close'` still wins when it arrives, otherwise an idle window (reset by
each chunk, so a real drain of the pipe buffer completes) ends the call and says so in `stderr` rather
than reading a pipe nothing is waiting for any more.

Two bounds come with it, because an unattended host has no operator to restart: a **default `timeout` of
ten minutes** (a caller who needs longer passes a bigger number) and a **100000-byte output cap**,
matching `docker-bash` — the two same-named tools should not behave differently, and a runaway that only
stopped accumulating would still spin to the timeout.

A third bug fell out of the same code: a signal-killed script gives `code === null`, which the success arm
read as **exit code 0** — so a timeout kill and an abort both reported a clean run. A kill is now reported
as a kill, naming the reason.

In `core`, an aborted turn no longer depends on the tool's cooperation. The runner iterated executors with
a bare `for await`, so any tool that never returns held the turn open for ever — `bash` got there through
inherited file descriptors, but a generator awaiting something that never settles or a bridged remote that
went away do too. Once the turn is aborted the read is bounded (`ABANDONED_TOOL_GRACE_MS`, 30s): the
runner stops reading, warns, and records the call as interrupted, which keeps every `tool_use` paired with
a `tool_result`. Only armed on abort, so a long-running tool on a healthy turn is never cut short, and a
tool cleaning up after a cut-off is still waited for.

# @matatbread/matbot-tool-docker-bash

## 0.4.9

### Patch Changes

- 880613b: `bash` output is bounded by a **default**, not a hard limit: `maxOutputBytes` overrides it per call.

  0.4.9 gave the local `bash` an output cap with no way past it, justified by parity with `docker-bash` —
  while omitting the half of `docker-bash` that makes a cap survivable. A bound the caller cannot lift is not
  a safety net, it is a ceiling on what the tool can be used for: the only party who knows whether 400KB of
  output is a verbose build or a `yes` loop is the one that wrote the command.

  So `maxOutputBytes?: number` joins the `bash` params — declared identically in both plugins, since they
  share one tool name and therefore one merged contract — and both honour it. In `docker-bash` it overrides
  the `bash_config` setting for that one command, leaving the persisted setting as the default for the rest;
  that setting was also the only route before, and changing a global to get one verbose build through is the
  wrong shape of answer.

  **The default rises from 100000 to 1000000 bytes in both.** The two failure directions are not symmetric:
  output that overflows is output whose process was _killed_, so too low a default kills legitimate work —
  while runaway protection barely notices, because anything genuinely runaway emits megabytes a second and
  trips either number in well under a second. Overflow now also names the remedy, which it could not before.

  A nonsensical value (zero, negative, non-finite) is refused before the script runs rather than silently
  falling back to the default.

## 0.4.8

### Patch Changes

- f6d546d: `bash` ends when the process it waited for ends, and takes every process it spawned with it.

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
  as a kill, naming the reason. `docker-bash` carried the same misreport in its own `close` handler and gets
  the same arm; there it can only be reached by the _local_ `docker exec` client being signalled, since an
  in-container signal death is propagated by `docker exec` as its own numeric exit code (137, …).

  In `core`, an aborted turn no longer depends on the tool's cooperation. The runner iterated executors with
  a bare `for await`, so any tool that never returns held the turn open for ever — `bash` got there through
  inherited file descriptors, but a generator awaiting something that never settles or a bridged remote that
  went away do too. Once the turn is aborted the read is bounded (`ABANDONED_TOOL_GRACE_MS`, 30s): the
  runner stops reading, warns, and records the call as interrupted, which keeps every `tool_use` paired with
  a `tool_result`. Only armed on abort, so a long-running tool on a healthy turn is never cut short, and a
  tool cleaning up after a cut-off is still waited for.

  - @matatbread/matbot-plugin-api@0.4.9

## 0.4.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.7

## 0.4.6

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.6

## 0.4.5

### Patch Changes

- Updated dependencies [99152f3]
- Updated dependencies [20d87fe]
  - @matatbread/matbot-plugin-api@0.4.5

## 0.4.4

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.4

## 0.4.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.3

## 0.4.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.4.2

## 0.3.10

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.10

## 0.3.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.9

## 0.3.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.8

## 0.3.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.7

## 0.3.5

### Patch Changes

- Updated dependencies [3e662d0]
- Updated dependencies

  - @matatbread/matbot-plugin-api@0.3.5

- Updated dependencies [86fd3fe]
  - @matatbread/matbot-plugin-api@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [c3a1b00]
  - @matatbread/matbot-plugin-api@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.2

## 0.2.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.8

## 0.2.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.6

## 0.2.4

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.4

## 0.2.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.3

## 0.2.2

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.2

## 0.2.1

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.1

## 0.2.0

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies [4891bf7]
  - @matatbread/matbot-plugin-api@0.1.8

## 0.1.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.7

## 0.1.6

### Patch Changes

- b40c2ec: fix: correct misplaced workspace dependencies

  Several plugins declared type-only `@matatbread/*` imports (the runtime coupling
  is via the service registry, not the import) under `dependencies`, which made a
  packed/published tarball try to install them from the registry:

  - frontend-web: `matbot-skills` → devDependencies
  - cognition: `matbot-skills`, `matbot-triggers` → devDependencies
  - web-principal-user: `matbot-frontend-web` → devDependencies
  - docker-bash: removed `matbot-tool-bash` (entirely unused; the "replaces bash"
    relationship is runtime via the registry, never imported)
  - @matatbread/matbot-plugin-api@0.1.6

## 0.1.5

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.5
- @matatbread/matbot-tool-bash@0.1.5

## 0.1.4

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.4
- @matatbread/matbot-tool-bash@0.1.4

## 0.1.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.3
- @matatbread/matbot-tool-bash@0.1.3

## 0.1.2

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.2
- @matatbread/matbot-tool-bash@0.1.2

## 0.1.1

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.1
- @matatbread/matbot-tool-bash@0.1.1

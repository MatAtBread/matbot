---
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-core": patch
"@matatbread/matbot-frontend-web": patch
---

Mid-turn steering: a submission arriving while a turn runs can now **interrupt** it.

- **API gaps filled.** `SubmitOpenOpts` gains `mode: 'queue' | 'interrupt' | 'auto'` (default `queue`,
  backward-compatible). `interrupt` stops the running turn — keeping its committed partial work (the
  agentic loop already commits coherently on abort, so no dangling tool-call) — and runs the new
  message next with a "keep going, noting the above" nudge, rather than waiting for the turn boundary.
  The decision is made inside the runner, synchronously against the running state, so an interrupt can
  never land on a later turn.
- **New optional service `SteeringPolicy`** (`MatbotServices`): under `mode: 'auto'`, its `classify`
  (regex / semantic / LLM — not assumed to be an LLM) decides queue vs interrupt; its `nudge` supplies
  the continuation nudge. Both members optional; absent ⇒ host defaults (`DEFAULT_STEERING_POLICY`,
  `interrupt`, and a built-in nudge).
- **New `PipelineEvent` variant `steer`** — announces an interrupt so a frontend places the new bubble
  and reads the imminent `aborted` (reason `'steer'`) as a yield, not a dead-end.
- **Interrupted tool results are reframed.** A tool that errors while the turn is aborted (a steer, a
  cancel) no longer leaks the raw abort reason (`"Error: steer"`) into its result — the runner records a
  neutral "interrupted before completion" message, so a steer's continuation turn reads a clear signal
  and doesn't reflexively re-run a side-effecting tool.
- **Optional (frontend/web).** `POST /sessions/:id/submit` accepts `mode`, defaulting to `auto` — the
  web frontend opts into steering (interrupt-by-default with no policy registered). Other frontends are
  unchanged (runner default `queue`). The web UI renders the `steer` event as its user bubble live, and
  no longer re-renders the session from the interrupted turn's `aborted` snapshot (which lacked the
  not-yet-persisted steer message and wiped the live bubble until a manual refresh).

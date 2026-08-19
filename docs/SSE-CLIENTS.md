# Writing a matbot UI client

For anyone building a **frontend other than the bundled one** against `@matatbread/matbot-frontend-web` —
a React app, a soft-tabbed shell, an embedded panel. It is about the *streams*: what they guarantee, what
they do not, and the four mistakes that are invisible in testing and permanent in production.

`plugins/frontend/web/static/app.js` + `http-transport.js` are the reference implementation of everything
below. Where this document states a rule, that pair obeys it and its comments say why.

---

## The one idea

**The server is the source of truth; a stream is a disposable view of it.** Every fact a stream carries is
either already persisted or explicitly marked as live-only delivery of something persisted. So the
question a client must keep answering is not "did I receive every event?" — it will not — but "if I
missed some, how do I find out and re-read?"

Two corollaries, and between them they cover most of this document:

- **Never treat the stream as the record.** Render from committed history; use the stream for the delta.
- **A stream can end without telling either end.** Assume it, detect it, recover from it.

---

## The two streams

| | `GET /events` | `GET /events/sessions/:id` |
|---|---|---|
| Carries | `session-busy`, `notification` | one session's turn events, `prompt`, `prompt-resolved`, `web-env-eval` |
| Scope | whole install | one session |
| Reference client uses | `EventSource` | `fetch` + a manual read loop |
| Reconnect | native (`EventSource` retries on error) | yours to write |

Both heartbeat with an SSE comment (`: hb`) every ~20s — see **Liveness** below.

`EventSource` is not usable for the per-session stream, because it cannot set the
`x-matbot-principal` header that routes a request to a profile. That is the whole reason the reference
client hand-rolls one and not the other.

### Frames on the session stream

Everything with a `traceId` is a `PipelineEvent` from the runner — the union in
`plugin-api/src/types/events.ts` is the authority, and it is **open**: new arms get added. Switch on
`type` and `default` to ignoring the frame; never exhaustively assume.

The ones that need behaviour beyond rendering:

- **`queued`** — a submission, possibly not yet running. Its user bubble comes from *here*, not from your
  own optimistic echo, so there is one source of truth for ordering.
- **`prompt`** — a tool is asking the user something and the turn is blocked on the answer. See
  **Prompts** — this is the frame most likely to be got wrong.
- **`prompt-resolved`** — somebody else answered; retire your dialog *without* answering.
- **`done` / `aborted` / `error` / `cancelled`** — a turn ends with exactly one of these. If you never see
  one, you must not assume the turn is still running. See **Recovery**.
- **`idle`** — session-level (no `traceId`); the runner's queue is drained.

### Socket budget

Browsers cap HTTP/1.1 at ~6 connections per host. That is why matbot has **one** stream per session and
**one** multiplexed global stream rather than a stream per panel: exceeding the cap does not fail loudly,
it starves ordinary `fetch` calls, so the sidebar stops loading and `POST /prompt` hangs — which looks
exactly like a server problem. If your UI holds several session streams open at once (see **Soft tabs**),
count them, and either keep the total under about four or serve over HTTP/2, where they multiplex.

---

## Prompts

A tool calling `ctx.prompt()` blocks its turn until a human answers. Delivery is the frontend's job, and
this is where the sharp edges are.

**A prompt is state, not an event.** It stays true until answered. The server keeps the outstanding
prompt and **re-sends it on every new session stream**, so a client that connects late, reloads, or was
looking at another conversation still gets asked. Concretely, this means:

- A `prompt` frame **can be the first thing you receive on a fresh connection**, for a turn you hold no
  render state for. Create that state lazily on any frame, not only on `queued`.
- It can arrive **before** the replayed `queued`/`tool:start` for its own turn. Since you render committed
  history before subscribing (you do — see **Recovery**), the turn's user message is already on screen, so
  attaching the dialog to a lazily-created container lands it in the right place either way.
- You may receive a prompt you have **already answered or dismissed** if you reconnect before the server
  processes the answer. Make dismissal idempotent.

**Never answer on the user's behalf.** Not on unmount, not on tab-switch, not on stream close, and above
all not with the field's `default`. The bundled server used to resolve a pending prompt with `''` when its
last viewer went away, which the prompt implementation turns into the default — an answer nobody gave to
a question nobody saw. That is merely wrong on a `confirm` (it silently declines) and destructive on
`plugin store-key`, whose default is `''` and where blank **removes the key**. Leaving the prompt pending
is always correct: it will be put to the next viewer.

If the user genuinely wants out, that is `POST /sessions/:id/abort` (abandon the turn) or
`POST /sessions/:id/prompt` with `{ cancel: true }` (give up on the prompt, keep the queue). Both cancel
rather than invent, and a tool reports a cancellation as an error.

**Do not block your event loop on the dialog.** This one is a deadlock, not a slowdown:

```js
// WRONG — parks the consumer while the dialog is up
const answer = await showDialog(ev.field);
await answerPrompt(sid, { answer });

// RIGHT — keep consuming; settle out of band
void showDialog(ev.field).then(answer => answerPrompt(sid, { answer }));
```

The frame that retires your dialog when *another* viewer answers (`prompt-resolved`) arrives on the same
stream you just stopped reading. Await the dialog and you can never receive it.

**One prompt per session at a time** — turns are serialised, so there is never a second outstanding
question to queue.

---

## Liveness

**Nothing tells you a stream died.** A socket killed by sleep, a network change, a proxy's idle timeout or
a frozen tab stays `writable` on the server and pending in the client's `read()`. No error is raised at
either end, so a client that only reconnects *on error* never reconnects at all, and a server that only
reaps *on close* keeps writing into a socket nobody is holding. A long tool call is minutes of silence —
exactly the window in which this happens, and exactly when it matters.

This is not an SSE limitation. WebSockets have the same failure mode, which is why the WS spec has
ping/pong frames — and browsers do not expose those to JS, so a WebSocket client hand-rolls
application-level pings too. Reconnect was never the hard part; **detection** is.

So both matbot SSE endpoints write `: hb` every ~20s (`WebServerDeps.heartbeatMs`), and a client must:

1. **Bound the silence.** Track the last byte received — any byte, heartbeat included. If nothing arrives
   for more than ~3 beats, treat the stream as dead, cancel it and reconnect. The reference client uses
   65s. Do not raise `heartbeatMs` above ~21s without changing this to match; they are two halves of one
   number.
2. **Recover on the way back, not on the way out.** Hidden tabs usually keep their connections, so a
   deliberate disconnect-on-hide guarantees a gap that mostly would not have happened — and recovery
   costs a re-read. Instead, on `visibilitychange → visible` **and** on `pageshow`, check the last-byte
   stamp and only reconnect if the stream has gone quiet. Both events, because they answer different
   questions: `visibilitychange` covers tab switching and app backgrounding, `pageshow` covers the
   back/forward cache, where the page is restored with its scripts un-rerun and its streams gone. Safari
   leans on bfcache heavily, and mobile Safari freezes JS while hidden — so a timer alone cannot be your
   only mechanism there.

---

## Recovery

**A reconnect is not a continuation.** On subscribing you get:

- the **running** turn's events replayed, then the pending queue;
- any outstanding **prompt**;
- and *nothing at all* about a turn that started and finished while you were away.

That last one is the trap, and it has a distinctive symptom: a turn stuck showing loading dots forever,
which appears complete the instant the user refreshes. The turn finished, committed, and the terminal
frame went to a stream nobody was reading.

There is no cursor — the server does not yet emit `id:` lines or honour `Last-Event-ID` — so the client
must reconcile:

1. Render from committed history **before** subscribing. `session_action { action: 'get' }` for the
   messages, `GET /sessions/:id` for the authoritative busy flag.
2. Tag rendered turns with their `traceId`, and make the replayed `queued` **adopt** an existing element
   rather than drawing a second one. History and the stream both carry the running turn's user message;
   whichever arrives first should win, and the other should be a no-op.
3. On every **re**connect, for any turn you still show as running, re-read committed history. The
   reference transport makes this findable by yielding a synthetic `{ type: 'stream-resumed' }` on
   reconnect (never on the first connect) so the consumer has a single place to hook. Skip the work when
   you have no turn in flight — an idle session's reconnect needs no recovery, and re-rendering for
   nothing is the cost you are trying to avoid.

If a re-render is too expensive for your UI, the fix is the cursor rather than a cleverer heuristic —
`Last-Event-ID` over a bounded per-session replay ring would let a reconnect resume incrementally and
leave the DOM alone. It is not built; if you need it, say so rather than working around its absence.

---

## Soft tabs

A shell that shows conversations with `display: none | block` keeps one page, always visible. Two
consequences:

- **`visibilitychange` never fires.** Switching soft tabs is not a page-visibility change, so the
  page-lifecycle hooks above do nothing for you. The heartbeat watchdog is your *only* liveness signal
  for a stream belonging to a hidden panel. Implement it.
- **A hidden panel's stream is as live as a visible one's** — the page is not throttled — so you have a
  genuine choice, and it is a trade rather than a right answer:

**Hold a stream per conversation, all open.** Nothing is ever missed, so recovery is rare. Costs a
connection per open conversation — mind the ~6-socket cap, which you will hit at about four
conversations plus the global stream, and which manifests as unrelated fetches hanging rather than as an
error.

**Open on switch, close on leave.** One connection, no cap risk. But every switch back is now a
reconnect, so the recovery path above stops being an edge case and becomes the main path: you *will*
return to a conversation whose turn finished while you were away, and you *will* be handed a `prompt`
frame as the first thing on a fresh stream. Both are handled correctly by the rules above and silently
wrongly without them.

**Either way, keep the session's *prompt* reachable.** A blocked turn is invisible from another panel, so
consider surfacing "this conversation is waiting for you" at the tab level — the ingredients are the
`prompt` frame plus `session-busy` from the global stream, which you already hold for every conversation
regardless of which panel is showing.

---

## The in-process build (`matbot.html`)

The single-file browser bundle has **no server**: `browser.js` is a transport over an in-process runner,
so `sessionEvents` is an async iterable and not a socket. Everything under **Liveness** and the reconnect
half of **Recovery** is therefore moot — there is no connection to lose, nothing to heartbeat, and no
reconnect to announce.

Two things do carry over, and one does not carry the way you would guess:

- **Prompt parking still applies**, and for a reason that has nothing to do with sockets: injecting a
  prompt is one pass over whatever streams are currently draining, and a session the user is not looking
  at has none. That is the same bug in a system with no network in it, which is the clearest evidence
  that the prompt rule is about *statefulness*, not transport. `browser.js` parks the prompt and injects
  it when a stream starts draining, exactly as the server does.
- **`prompt-resolved` still matters** even with one window, because `app.js` is shared with the HTTP
  build. Keep the path alive rather than special-casing it away.
- **Turn durability is the opposite way round.** With a server, the turn lives in the server and your view
  is what you might lose — so a view is worth recovering. In-process, the provider request is made *from
  the page*, so losing the network interrupts the turn itself: there is no completed work sitting
  somewhere waiting to be re-read. Recovery there is not a UI problem and cannot be solved by a UI.

---

## Checklist

- [ ] Render committed history first; the stream is the delta.
- [ ] Demux by `traceId`; `default` unknown `type`s.
- [ ] Create per-turn render state lazily — any frame, not just `queued`.
- [ ] Adopt an existing element on replayed `queued`; never draw a second bubble.
- [ ] Handle `prompt` as the first frame on a fresh stream.
- [ ] Never await a prompt dialog inside the event loop.
- [ ] Never fabricate an answer — no defaults on close, unmount or switch.
- [ ] Honour `prompt-resolved`, idempotently.
- [ ] Track last-byte time; give up after ~3 missed heartbeats and reconnect.
- [ ] Hook `visibilitychange` **and** `pageshow`; reconnect only if quiet.
- [ ] On reconnect, re-read history for any turn still shown as running.
- [ ] Count your open streams against the ~6-socket cap.

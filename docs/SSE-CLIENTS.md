# Writing a matbot UI client

For anyone building a **frontend other than the bundled one** — a React app, a soft-tabbed shell, an
embedded panel — and for anyone reimplementing the **server** side of it as well. It is about the
*streams*: what they guarantee, what they do not, and the four mistakes that are invisible in testing and
permanent in production.

Most of it is client-side. The last section is for the case where the server is yours too: some rules then
stop being ones you obey and become ones you have to provide, and a client cannot work around their
absence.

`plugins/frontend/web/static/app.js` + `http-transport.js` are the reference client, and
`plugins/frontend/web/src/server.ts` the reference server. Where this document states a rule, that code
obeys it and its comments say why — the code is the model; this is the contract it happens to implement.

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
count them (see **Holding vs. opening**), and either keep the total under about four or serve over
HTTP/2, where they multiplex.

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
2. **Recover on the way back, not on the way out.** A backgrounded view usually keeps its connections, so
   deliberately disconnecting when one is hidden guarantees a gap that mostly would not have happened —
   and recovery costs a re-read. Instead, whenever a conversation comes *back* to the foreground, check
   the last-byte stamp and reconnect only if the stream has actually gone quiet. What counts as "comes
   back to the foreground" is your UI's to define — see **Foreground is yours to define**.

   The bundled client shows one conversation at a time, so its two sources are `visibilitychange` and
   `pageshow`. Both, because they answer different questions: `visibilitychange` covers tab switching and
   app backgrounding, `pageshow` covers the back/forward cache, where the page is restored with its
   scripts un-rerun and its streams gone. Safari leans on bfcache heavily, and mobile Safari freezes JS
   while hidden — so a timer alone cannot be your only mechanism there.

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

## Foreground is yours to define

Everything above says "when a conversation comes back to the foreground" rather than naming an event,
because the event is yours. matbot shows one conversation at a time, so its only two sources are
`visibilitychange` and `pageshow`. A shell with soft tabs — panels toggled `display: none | block`, a
route change, a store mutation, a click handler — has a third that no browser API will tell it about:
**switching soft tabs is not a page-visibility change**, so a hidden panel's stream gets no lifecycle
event at all, ever.

The fix is not to find a different event. It is to name the *transition* once and route every source into
it:

```
onConversationForeground(id)   ← a tab click, a route change, a panel un-hide,
                                 visibilitychange → visible, pageshow
onConversationBackground(id)   ← the same, in reverse
```

Then the rules below attach to those two functions, and it stops mattering which source fired.

### What foreground must do

1. **If you hold no stream for it:** render committed history, *then* subscribe, and expect a `prompt`
   frame possibly before anything else (see **Prompts**).
2. **If you hold one:** check its last-byte stamp. Fresher than a beat-and-a-bit ⇒ it demonstrably
   survived, do nothing — no reconnect, no re-render. Quieter than that ⇒ tear it down and reconnect
   rather than waiting out the full watchdog.
3. **Either way**, for any turn you still show as running, reconcile against committed history — because
   you cannot distinguish "still running" from "finished while I wasn't reading". A show-after-close is a
   reconnect, not a first connect, so treat it as one.

### What background must not do

This is the shorter list and the more important one, because a cleanup hook is exactly where the wrong
thing gets written — a React `useEffect` teardown, a panel's `onHide`:

- **Do not answer a pending prompt.** Backgrounding is not a decision the user made. Not with the
  default, not with `''`, not at all.
- **Do not abort the turn.** It is doing work the user asked for; nobody is watching, which is not the
  same as nobody wanting the result.
- **Do not hold a stream you have stopped reading.** That is worse than closing it: an undrained
  `ReadableStream` applies backpressure, so the server's writes buffer up on its side with no bound, and
  you still miss `prompt-resolved`. Either keep consuming it or close it.

Closing on background is fine — just record that you did, so the next foreground knows it owes a
reconciliation.

### Holding vs. opening

A genuine trade with no right answer, and the soft-tab case is the one where it bites, since a hidden
panel's page is not throttled and its stream is as live as a visible one's.

**Hold a stream per conversation.** Nothing is ever missed, so reconciliation is rare. Costs a connection
each: watch the ~6-socket cap, which you reach at about four conversations plus the global stream, and
which shows up as unrelated `fetch` calls hanging rather than as an error.

**Open on foreground, close on background.** One connection, no cap risk. But reconciliation stops being
an edge case and becomes the main path — you *will* routinely return to a conversation whose turn finished
while you were away, and you *will* routinely be handed a `prompt` as the first frame on a fresh stream.
Both are handled by the rules above and silently wrongly without them.

**Either way, keep a blocked turn visible from outside its panel.** A conversation waiting on a prompt
looks idle from another tab. `session-busy` on the global stream is held for every conversation regardless
of which panel is showing, so a badge is cheap; without one, a parked question is invisible until someone
happens to look.

---

## Seeing it work

These paths fire in conditions that are hard to provoke, and a client on a healthy socket behaves
identically whether or not any of them exist — so "it still works" is not evidence in either direction.
Each recipe below forces one.

**Confirm the heartbeat.** Not from DevTools: Chrome's **EventStream** panel lists parsed `event:`/`data:`
frames only, so SSE *comment* lines — which is what a heartbeat is — never appear there, and their absence
means nothing. Read the raw stream instead:

```
curl -sN http://localhost:<port>/events/sessions/<id> | grep --line-buffered '^: hb'
```

Do this first; if beats are absent, nothing below is meaningful.

**Force a reconnect and reconcile.** Start a long turn (`sleep 90` through the `bash` tool is ideal — a
genuinely quiet stream), then Network → throttling → **Offline** for a few seconds, then back to Online.
Note what this does *not* prove: going offline raises an **error**, and the error path is the one case that
always worked. It exercises the reconcile, not the detection.

**Force the watchdog.** It needs silence *without* an error, which no network control produces — so remove
the heartbeat instead: start the server with `heartbeatMs` set long (10 minutes) and run a turn that stays
quiet for over 65s. Before this existed, that same 65s produced nothing at all, forever.

**Force the foreground revive.** Same long `heartbeatMs`, quiet turn, switch to another application for
~30s, come back: recovery should happen on your return rather than at the end of the watchdog's window.
With the beat *on* it should do nothing instead — a stream that survived being hidden needs no recovery,
and that no-op is the intended behaviour rather than a missed case.

**Force the prompt rescue** — worth doing first, since it needs no DevTools and is the original bug. Run a
turn that sleeps and then asks something (`sleep 60`, then any `ask_user`), and switch to a different
conversation before the question fires. Come back after it: the question is waiting. Before the fix,
switching away answered it for you with the field's default.

---

## Optional capabilities

A UI that shows features conditionally (a profiles panel, a sharing button) has to ask whether the tool
behind one exists, and the natural way — call it and read the 404 — has two traps.

**A control built from a tool call is derived state, so it has to track the registry — both ways.** A 404
means "not registered when you asked", never "absent": the `/tools` endpoints hold an unknown name briefly
during boot, because the server starts listening before the plugins configured after it, but that window is
a courtesy and cannot be made authoritative — a plugin's `setup()` may itself call `loadPlugin()`, so tools
can register long after the initial burst and no deadline the server picks can outlast a slow enough nested
load. And a plugin can be *unloaded* while your page is up, from your own plugins panel, taking its tools
with it.

So re-derive on `RegistryChange{registry:'tools'}` rather than latching an answer at boot. A one-way latch
gets both directions wrong: a capability that loads late never appears however long you wait, and one that
leaves goes on offering operations that now 404. Debounce it — a boot announces dozens of tools — separate
the one-time wiring from the part that re-runs, so an arrival doesn't stack duplicate listeners, and keep
one probe in flight at a time, since mid-boot a probe for an absent tool *waits* rather than 404ing.

**Don't serialise your bootstrap on it.** An optional capability should never gate the shell, however fast
the answer is expected to be. Render without it and wire it in when it arrives. If some part of startup
genuinely depends on the answer — the bundled client adopts a `#<profile>:…` deep-link before anything
opens a session under the old identity — make *that* the only thing that waits, not the whole page.

---

## If you own the server half too

Then some of these rules are not yours to obey but yours to *provide*. A client cannot work around a
server that does not, so if you are reimplementing the server side (against matbot's as a model), these
five are the load-bearing ones:

1. **Heartbeat every stream.** Without periodic traffic a client cannot distinguish quiet from dead, and
   *you* cannot reap a socket nobody holds — you will go on reporting successful writes into it. This is
   the one that makes the other four detectable.
2. **Park the outstanding prompt and re-send it on every new subscription.** A prompt written once to
   whoever happened to be connected is a prompt lost, and no amount of client cleverness recovers it. The
   client's job is to render one that arrives unexpectedly; getting it there is yours.
3. **Never settle a prompt because viewers went away.** Leave it pending. A default answer is worse than a
   hung turn, because it is indistinguishable from a decision.
4. **Replay the running turn on subscribe** — the in-flight delta, in order, after committed history ends.
   Without it a client that reconnects mid-turn has a gap it cannot even see.
5. **Expose committed history and an authoritative busy flag.** Reconciliation is a re-read; if there is
   nothing to re-read, the client's only recovery is a full page reload.

matbot's own answers are in `plugins/frontend/web/src/server.ts`, and the reasoning for each is in the
comments beside them.

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
- [ ] Route every foreground/background source — clicks and route changes included, not just
      `visibilitychange`/`pageshow` — into one transition, and reconnect only if the stream is quiet.
- [ ] On background: answer nothing, abort nothing, and don't hold a stream you stopped reading.
- [ ] On reconnect, re-read history for any turn still shown as running.
- [ ] Count your open streams against the ~6-socket cap.

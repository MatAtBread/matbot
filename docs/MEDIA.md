# Media: submission, storage and delivery

What **matbot core** implements when an image, PDF or audio clip has to reach a model, and what it
deliberately leaves to you. The first-party plugins are the worked examples, named throughout — none of
them is privileged, and every one of them is a template for rolling your own.

The one invariant, stated once because everything below follows from it: **no base64 ever reaches a
session document.** What persists is always a reference.

---

## Two paths, distinguished by who owns the bytes

|  | Carried as | Resolved by | Lifetime |
|---|---|---|---|
| **Tool media** — the model pulled it | nothing; wire-only | the runner, from the tool's `model-content` event | dies with the turn |
| **Session media** — a person attached it | a `file-ref` in the message | the runner, via `MediaStore` | dies with the session |

They do not overlap and the runner never guesses which one an id belongs to: it only ever resolves
session media. A model referring to a *workspace* file transfers no ownership — it calls a tool, and the
tool pulls (`workspace_action show`; see [Tool media](#tool-media-the-pull-path)).

This document is mostly about the **push** path, because that is the one with a storage half.

---

## What core implements

Everything in `core/src/media.ts` plus two hooks into the runner. In full:

| | Where | What it is |
|---|---|---|
| `UserContent` | `plugin-api/src/types/session-runner.ts` | the narrow arm-set a submission may carry |
| `ingestMedia()` | `core/src/media.ts` | the submission boundary: inline arms → `file-ref` |
| `resolveSessionMedia()` | `core/src/media.ts` | turn-side: `file-ref` → inline bytes, inside a budget |
| `armFor()` | `core/src/media.ts` | which inline arm a type may be sent as, or `null` for none |
| `MediaStore` | `plugin-api/src/types/files.ts` | a `MatbotServices` key, aliasing `FileStore` |
| `MediaRejectedError` | `plugin-api/src/errors.ts` | a refusal that names the file and the reason |
| the caps | `core/src/media.ts` | four constants, listed under [Limits](#limits) |

What core does **not** implement: accepting bytes over a wire, storing them, or serving them back. Those
are a frontend's, a storage backend's and a frontend's respectively — all three have first-party
examples.

---

## Submission

### `UserContent`, and why it is not `MessageContent`

A submission crosses a trust boundary, so `SubmitOpenOpts.content` is `UserContent[]` — a deliberately
narrow subset of `MessageContent`:

```ts
type UserContent = (
  | { type: 'text';          text: string }
  | { type: 'image';         data: string; mimeType: MimeType; name?: string }
  | { type: 'document';      data: string; mimeType: MimeType; name?: string }
  | { type: 'audio';         data: string; mimeType: MimeType; name?: string }
  | { type: 'file-ref';      fileId: string; name: string; mimeType: MimeType }
  | { type: 'form-response'; values: Record<string, string> }
) & { origin?: 'robo' };
```

Widening it to the full union would let a client post a forged `tool-result`, `thinking` block or
`marker` straight into persisted history. If you accept submissions over a network, **validate against a
whitelist of arms** rather than a blacklist, so an arm a later plugin-api adds is rejected by default
rather than admitted by omission. `validateUserContent()` in `plugins/frontend/web/src/server.ts` is the
reference.

### Bytes arrive by value

Media rides *inside* the submission, base64 in `data`. There is no upload-in-advance leg, and that is a
requirement rather than a simplification: Telegram delivers bytes **with** the message and cannot be made
to do otherwise. A frontend that *could* upload first (the web composer) posts inline anyway, for one
place instead of two — and it dodges the pre-session draft-key problem, since a client creates its
session lazily on first send.

By-value is a **boundary form, not a wire format**. It exists only at the door.

### The rewrite happens in `open()`

```ts
const content = await ingestMedia(opts.content, opts.sessionId, deps.mediaStore?.());
```

Each inline arm is written through the `MediaStore` and replaced by a `file-ref` **before anything is
enqueued**. One place, so every frontend inherits it and no frontend can forget.

The put is **anonymous** (`store.put(undefined, …)`), so two uploads of `photo.jpg` in one session are
two files rather than an upsert over each other; the display name rides on the `file-ref` block instead,
which means every `FileStore` preserves it without having to. Files are written under namespace
`session-media` with `sessionId` set and `allowed: true`.

A text-only submission never touches the store, so a deployment with no `MediaStore` registered is
completely unaffected — it hears about one only when somebody actually attaches something, and is then
told why rather than silently dropped.

### Why a reference and never the bytes

Measured, not stylistic. `store.set` runs at turn start *and* at every turn end, so a 5MB image inlined
in the document is ~6.7MB of base64 riding two whole-document writes per turn, for the rest of the
session. The rule has no exception to police because there is nowhere else the bytes could be.

### Refusals

`ingestMedia` throws `MediaRejectedError` (branded; test with `isMediaRejectedError`, never
`instanceof`), carrying `reason` and the offending `file`:

| `reason` | Meaning | Suggested HTTP |
|---|---|---|
| `no-store` | no `MediaStore` registered — a deployment fact, not a bad request | 501 |
| `unreadable` | not valid base64, or content that does not match its declared type | 400 |
| `unsupported-type` | a type no endpoint decodes — an `image/*` outside PNG/JPEG/GIF/WebP | 415 |
| `too-large` | over the per-file cap | 413 |
| `session-quota` | would take the session over its total | 413 |
| `unknown-ref` | a submitted `file-ref` does not name media attached to this session | 404 |

**Refuse at the boundary, naming the file.** The alternative is a provider 400 part-way through a turn
the user already believes was sent, with no way back. Nothing is enqueued on a refusal, so there is
nothing to unwind — and a frontend should put the attachment back in the composer rather than lose it.

`unreadable` includes a **magic-byte check** on the types where a mismatch is a guaranteed provider
rejection (PNG, JPEG, GIF, WebP, PDF). It is not a validity check — a well-formed header on a
structurally broken file still passes, because only the provider can know that. It exists because the
failure it prevents is not recoverable in-band: the `file-ref` is by then in history, where it resolves
into *every* subsequent outgoing copy and fails the session for good. Nothing else is sniffed; for
`text/*`, audio or an octet-stream we genuinely do not know, and guessing would refuse valid files.

`unsupported-type` is the same failure caught one step earlier, and it is why `armFor` returns `null`
rather than always naming an arm. **`image/*` is the one prefix that cannot be admitted by prefix
alone**: a provider *tries* to decode whatever the image arm carries and 400s on what it cannot, where an
unrecognised document or audio type degrades to a text note instead. So HEIC — what an iPhone camera roll
hands back, and what a `<input type="file">` with no `accept` will happily offer — along with SVG (XML;
`read` gives the source, which is the better answer), BMP and TIFF are refused rather than routed to an
arm that will fail. Same list and same reasoning as `workspace`'s `showArm`; they stay separate because
they answer for separate stores. A frontend should also set `accept` to the decodable types, which is what
makes iOS transcode a camera-roll photo to JPEG instead of handing over HEIC — but drag and paste bypass
`accept` entirely, so the boundary check is the gate and `accept` only saves the round trip.

`unknown-ref` covers the arm a caller may legitimately send *itself*. `UserContent` admits `file-ref`, so
a frontend that has already uploaded can skip the rewrite — which means a `fileId` arriving over the wire
is the client's word about which bytes to send, and `resolveSessionMedia` inlines what it is handed. Each
one is therefore checked against the session that owns it: the handle must exist, its `sessionId` must
match, and its namespace must be `session-media`. Ownership rather than `allowed`, because every put above
sets `allowed: true` — the flag the HTTP read route gates on cannot separate this session's media from
another's, and `sessionId` + namespace is strictly the stronger check. Phrased as *unknown* rather than
forbidden for the reason `GET /media/:id` gives: a refusal must not confirm that an id exists. The check
belongs here and nowhere else, because this is the only point that knows the session **and** has a channel
to say no — the runner could only drop the block silently, mid-turn, for something the user watched itself
attach.

The session total is **derived** by summing what the store already holds for the session, never kept as
a counter — a counter is wrong after a restart, a swap, or anything deleting a file behind it.

---

## Storage

### `MediaStore` is an alias of `FileStore`

```ts
export type MediaStore = FileStore;
```

Registered under its own `MatbotServices` key. There is no separate interface to implement, and that is
the point: `FileMetaData` already carries `sessionId` / `messageId` / `namespace` / `allowed`, and
`FileFilter` already filters on `sessionId` — so session-scoped lifetime, per-message attribution and a
servable flag are in the shape already. **Every existing `FileStore` is a candidate media store,
unchanged**, and putting media on a different medium from sessions is a *registration, not a port*.

Two implementations of one interface get an alias, never an invented role name (see CLAUDE.md § Service
registry). A bespoke `MediaResolver` was considered and rejected: it bought nothing the alias didn't, and
left something to implement.

### It works with no configuration

Both hosts seed their own file area as the boot default — `apps/cli` its `FileStore`, `apps/web-bundle`
its OPFS one. The seed goes in the **registry**, not on `baseServices`: `unifyServices` resolves an own
property first, so a member spelled there is one `register()` could never reach. Unregistering reverts to
that default rather than turning media off.

To put media somewhere else:

```ts
await services.register('MediaStore', myFileStore);
```

### Templates

| Medium | Package | File |
|---|---|---|
| filesystem | `@matatbread/matbot-files-node` | `plugins/files/src/store.ts` (`FilesystemFileStore`) |
| SQLite | `@matatbread/matbot-storage-sqlite` | `plugins/storage/sqlite/src/file-store.ts` |
| OPFS (browser) | `@matatbread/matbot-browser` | `plugins/browser/src/opfs-file-store.ts` |
| Google Drive | `@matatbread/matbot-storage-google-drive` | `plugins/storage/google-drive/src/drive-file-store.ts` |
| per-principal partitions | `@matatbread/matbot-storage-profiles` | `plugins/storage/profiles/src/file-store.ts` |

None of these was changed to support media. If yours implements `FileStore` honestly — in particular
persisting the `opts` it is handed, and honouring `FileFilter.sessionId` in `list()` — it is already a
media store.

One thing to get right that is easy to miss: `put(name, …)` with a **name** and with **`undefined`** are
different operations. A named put is addressable and upserts; an anonymous one mints a fresh id. Media
always takes the anonymous path.

### Referential integrity is yours

Whether bytes physically live inline in the session document or in a blob store is the implementation's
business and must not leak above the door. That is why a text-only `StorageBackend` implements *nothing*
here, and why `cut` / `fork` / `split` / `compact` keep working: they move whole messages.

---

## Delivery to the model

`resolveSessionMedia()` runs **once per turn**, before the round loop, and returns a
message-id → (file-id → inline arm) map the runner splices into the **outgoing copy only**. Session media
is swapped **in place**, so the model reads the image where the person actually put it; tool media is
pinned *after* the tool message it answers. Same splice, different placement, different source.

Resolution walks **newest-first** inside a byte budget (`MEDIA_RESIDENCY_BYTES`, 8MB). Beyond it the
`file-ref` is left exactly as it is and the provider adapters degrade it to `[Attached file: x]` — honest,
already written, and the file is still fetchable.

Two design points that are load-bearing:

- **A byte budget, not a turn count.** The cost is denominated in bytes: three turns is a fine window for
  a thumbnail and a ruinous one for a 40MB PDF, and a count cannot tell them apart.
- **Once per turn, not per round.** Recomputing per round would let a message fall out of the window
  *between two provider calls* — busting the prompt cache and leaving the model referring to something
  no longer there.
- **Keyed per ref, spliced per block.** The map deliberately does not hand back each message's finished
  content array, because that array is not final when resolution runs: a raced `screen` verdict folds
  durable `robo-user` blocks onto the user message *inside* the round loop, and substituting an array
  computed at turn start would drop them from every later round — persisted and on screen, but never
  sent. Handing back the substitutions instead leaves the runner mapping blocks it still owns.

What each arm becomes on the wire is the adapter's business, and they differ — a `document` your storage
holds perfectly well may still reach one model as a note saying it exists:

| | `image` | `document` | `audio` |
|---|---|---|---|
| `anthropic` | inline | PDF and `text/*` inline; anything else a note | `[Audio: …]` |
| `google` | inline | inline | inline |
| `openai-compat` | inline (data URL) | `[Document: …]` | `[Audio: …]` |

An adapter that cannot carry something **says so in the transcript** rather than dropping it silently —
the same note an unresolved `file-ref` degrades to. Writing an adapter, do the same: a model told "there
was a PDF here" can ask for another form; a model shown nothing answers confidently about a file it
never saw.

Known-benign: a semantic back-reference ("that image I uploaded") cannot survive a `split` or a `compact`
that leaves the media on the far side. "I can't see any uploaded image" is the *correct* answer there and
is visible to the user. Structural integrity — bytes travelling with their message — is separate and is
preserved.

---

## Serving bytes back to a UI

A frontend that draws a thumbnail in the message thread has to fetch the file back. matbot's own answer
is `GET /media/[~<partition>/]<fileId>`, and its one rule is worth copying:

**The route applies no gate of its own.** Whether these bytes may leave the box is `allowed` — a flag the
*store* persists and the producer opts into per put. Which file area an id resolves in is the backend's,
via the opaque `~<partition>` token (`FilePartition.enter`). Both answers belong to the layer that
*implements* storage, not the layer *exposing* it: a UI can lie about a principal, and a route that
compared `handle.sessionId` against the request principal would be inventing an access rule the store
never agreed to.

A missing file and a non-servable one both return **404**, not 403 — do not reveal that an id exists.

Its only real difference from `GET /files/<namespace>/<name>` is being **id-addressed**: a store id from
an anonymous put is not guessable, and `workspace/notes.md` is. (Note that a *named* put in several
backends uses the name as the id, so that property holds for media specifically, not for every file.)

An in-process frontend has no HTTP route at all, so the reference client puts this behind one transport
member — `mediaUrl(fileId)` — which returns a path on the server build and mints a `blob:` from the store
in the browser build. Memoise it: a blob costs a full store read. See `plugins/frontend/web/static/`
(`http-transport.js` and `browser.js`) and [SSE-CLIENTS.md](SSE-CLIENTS.md).

---

## Frontend templates

| If your frontend… | Copy | Why it is the interesting case |
|---|---|---|
| accepts uploads from a browser | `plugins/frontend/web/src/server.ts` + `static/app.js` | whitelist validation, a body cap on the submit route only, refusal → 413/501/400 with the filename, attachments restored to the composer on refusal |
| receives bytes with the message | `plugins/frontend/telegram/src/plugin.ts` (`messageContent`) | the case that *proves* by-value: two-step download, largest photo rendition, `caption` read as the prose, a failed download reported rather than dropped |
| runs in-process, no server | `plugins/frontend/web/static/browser.js` | `blob:` minting, and the reminder that a browser-only build has no `/media/` route |

Two mistakes both of those had during development, worth knowing before you repeat them:

- **The submit-body normaliser is a second site.** The HTTP handler and the in-process transport are
  mirrors; changing one means changing both. Getting it wrong turned an array into `[[…]]`, the turn ran
  fine, and the user bubble silently never drew.
- **No Web Crypto in a served client.** `crypto.randomUUID` and `crypto.subtle` need a *secure context*,
  so they are undefined over plain HTTP to anything but localhost — which is how a LAN or test deployment
  is normally reached. Need an identity for a composer attachment? Use object identity, an index, or a
  server-minted id.

---

## Tool media (the pull path)

Covered in full in [DEVELOPING.md § Media](DEVELOPING.md#media); the short version is that a tool yields

```ts
yield { type: 'model-content', content: [{ type: 'image', mimeType: 'image/png', data }] };
yield { type: 'result', value: { name, mimeType, bytes } };
```

— bytes to the model's eyes, metadata to the transcript. `workspace_action show`
(`plugins/workspace/src/index.ts`) is the reference producer, and shows the two decisions such a tool has
to make: which mime types it will hand over at all (it refuses SVG and text toward `read`, which gives
the source and is the better answer anyway), and a size ceiling checked against the handle's declared
size *before* the read.

**A result cannot substitute for the event.** A result is a value in the transcript, so bytes there are
4/3 of the file persisted **and** re-sent on every later round, for something the model still cannot see.

---

## Limits

All in `core/src/media.ts`; the fifth is the tool-side ceiling in the workspace plugin. Every one is a
first guess — one knob each, and measure before adding a second.

The per-file cap is not independent: it **is** the residency budget. A file larger than the outgoing-copy
window can never be resident (`spent + size > budget` is true on the first item, with `spent === 0`), so
admitting one would store it, charge it to the session total, and then degrade it to `[Attached file: x]`
on every turn for the rest of the session — accepted and permanently invisible, with no boundary having
said a word. Raise the window and the cap follows.

| Constant | Value | Bounds |
|---|---|---|
| `MEDIA_RESIDENCY_BYTES` | 8MB | how much resolved media may ride one turn's outgoing copy |
| `MAX_MEDIA_BYTES_PER_FILE` | = residency | one attachment, at the submission boundary |
| `MAX_MEDIA_BYTES_PER_SESSION` | 50MB | everything the store holds for a session |
| `MEDIA_NAMESPACE` | `session-media` | where ingested media is written |
| `SHOW_MAX_BYTES` (workspace) | 8MB | one file handed over by `workspace_action show` |

A frontend should mirror the first two client-side, so the common mistake is caught before the round
trip — but the server's are the ones that count. The web frontend additionally raises its body cap to
64MB **on the submit route only**; every other route keeps the 1MB default.

---

## What core deliberately does not do

- **No per-model capability table.** Whether a given model can see an image is the endpoint's to answer,
  and a table of model capabilities is stale the day a model ships. A model that cannot take an image
  says so in its own words; matbot's abstraction is the protocol, not the model.
- **No transcoding, resizing or thumbnailing.** Hand over the smallest thing that answers the question.
- **No delivery guarantees on the notification bus.** An `ItemChange` says an id is stale; re-read it.
- **No sweep on session delete.** There is no `session_action delete` to hang the contract on. Media is
  `sessionId`-scoped and therefore enumerable, so define it when a delete exists.

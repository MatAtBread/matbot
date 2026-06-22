# @matatbread/matbot-storage-google-drive

A browser `StorageBackend` that persists matbot's documents and file blobs to a folder in the
user's **Google Drive**, instead of the default IndexedDB + OPFS. Activate it and your sessions,
settings, skills, triggers, knowledge entries and uploaded files live in Drive — so they follow you
between machines and browsers.

## Layout in Drive

```
<rootFolder>/                 (default: "matbot")
  sessions/<id>.json          one file per document, per namespace
  settings/<id>.json
  skills/<id>.json
  …
  __files/<id>.data           file-store blobs
          <id>.meta.json      + metadata sidecar (mirrors the OPFS store)
```

Documents in a namespace are read into memory once on first access and served from there; every
write is flushed through to Drive. This matches the filesystem backend's "load all, query in
memory" model — fine for chat-scale data, not for enormous stores.

## Authentication

Uses **Google Identity Services** (GIS) in the browser — the OAuth *token* model for single-page
apps. There is **no server and no client secret**. The only configuration is a public **OAuth
Client ID**, and the scope is `drive.file` (matbot can only see files it created).

The first activation pops Google's consent dialog; the access token is cached (localStorage) and
silently renewed when it expires.

### One-time setup (Google Cloud console)

1. **Create credentials → OAuth client ID → Web application**
   (the connect dialog links straight here: <https://console.cloud.google.com/auth/clients/create>).
   Create or pick a project as part of this.
2. Add the origin you serve the matbot bundle from (e.g. `http://localhost:9778`) as an
   **Authorised JavaScript origin**. The connect dialog shows you the exact origin to paste.
3. Copy the **Client ID** (it looks like `…apps.googleusercontent.com`). This is not a secret.
4. **Enable the Google Drive API** for that project:
   <https://console.cloud.google.com/apis/library/drive.googleapis.com> → **Enable**. Without this,
   sign-in succeeds but every Drive call returns `403: API has not been used / is disabled` — allow
   ~1 minute after enabling for it to propagate. matbot now probes Drive on activation, so if you
   forget this step it leaves you on local storage with a clear message rather than erroring.

> **The bundle must be served over `http(s)`** — Google OAuth refuses a `file://` origin. Open
> `matbot.html` from a local web server, not by double-clicking the file.

### Getting past "Access blocked" / "unverified app" (personal use)

matbot requests **only** the `drive.file` scope — per-file access to files *it* creates, never the
rest of your Drive. That's a non-restricted scope, but Google's policy is that **any app used by the
general public in production must still pass brand verification** — which personal use does **not**
need. So don't publish to production; stay in **Testing** and add yourself as a test user:

1. Console → **APIs & Services → OAuth consent screen** (new console: **Google Auth Platform →
   Audience**). Keep **Publishing status = Testing**, **User type = External**.
2. Under **Test users → Add users**, add the Google account you'll sign in with. **Save.**
   *(Skip this and Google returns a hard `403: access_denied` — "can only be accessed by
   developer-approved testers".)*
3. Click **Connect** in matbot. On the **"Google hasn't verified this app"** screen, click
   **Advanced → Go to {app} (unsafe) → Continue**, then **Allow**.

The "unsafe" wording is a generic unverified-app warning — for your own app touching only its own
`drive.file` files in your own Drive, it's safe. Testing mode allows up to **100 test users**, which
is plenty for personal/portable use. (Publishing to production to remove the warning entirely is only
worth it if you're distributing matbot to strangers, and that's when you'd do Google's verification.)

> Don't add a *sensitive/restricted* Drive scope (e.g. full `.../auth/drive`) on the consent screen —
> matbot only ever requests `drive.file`; keep them matching.

## Use

It ships **baked but not auto-loaded** in the web bundle. Activate it from the chat:

```
plugin discover_local        # lists it
plugin add @matatbread/matbot-storage-google-drive
```

On first activation you're prompted once for the Client ID and the root folder name (both saved to
localStorage, since they're needed to *reach* Drive and so can't live in the Drive-backed settings).
The browser plugin replays the activation on every subsequent boot.

## Vault (secrets) also sync

On activation the plugin re-points matbot's **vault** at Drive too: secrets are stored as a single
doc in the Drive `vault` namespace, and any secrets already held by the localStorage vault are
migrated in. So API keys follow you across machines alongside your sessions. (Stored in plaintext,
matching the localStorage vault.) This relies on the browser realm honouring `register('Vault')` —
PR #2 added that to the CLI; this branch extends it to the web bundle's `bootstrap.ts`.

## A Drive-synced plugin set

Plugins follow you across machines too. Rather than ship a second, look-alike tool (which the model
would pick between at random), this plugin **shadows the built-in `plugin` tool** — same name, so the
model and the frontend `/tools` path see exactly one `plugin` tool and can't tell the difference. It
reuses the browser plugin tool verbatim, but backs persistence with a **Drive** manifest instead of
IndexedDB. So once Drive is connected, `plugin add X` installs `X` now **and** on every browser where
Drive is connected.

How it stays consistent with the unchanged local loader:

- The browser build's boot-time loader is **untouched** — it still replays the local `extra-plugins`
  list (IndexedDB), which is where this Google Drive plugin itself lives and how it boots.
- On load, this plugin restores its **Drive** set on top, and installs the shadow `plugin` tool. The
  ordering is deliberate: local loader loads this plugin → this plugin restores its Drive set.
- **Routing by set membership** (no stored provenance needed for two managers): `add` always syncs to
  Drive; `remove`/`reload` acts on Drive if the plugin is Drive-synced, otherwise **delegates to the
  original local tool** — covering plugins installed locally before Drive was connected *and* this
  Google Drive plugin itself (it lives in the local extras, so a Drive remove couldn't uninstall it,
  it'd reload next boot). `list` marks each plugin **Drive-synced** or **local-only**.
  *(If a third plugin-manager ever appears, promote this to a stored `installedBy` on the loaded
  plugin — see the rationale in the commit/branch notes.)*

## Scope / known gaps

- **Provider *configs* are not synced yet.** They're read from `localStorage` (`matbot.providers`) at
  boot, before any backend exists. The API *keys* they reference now sync (via the vault, above); the
  non-secret config metadata (module/model/endpoint) does not yet.
- **No data migration.** Activating this does not copy existing IndexedDB/OPFS *documents* into Drive;
  it's a fresh location. On a machine that already has Drive data, that data simply loads.
- **Single-realm concurrency only.** Like the filesystem backend across processes, two browsers
  writing the same doc concurrently can race; there's no cross-client lock.

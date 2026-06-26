# @matatbread/matbot-frontend-web

## 0.2.2

### Patch Changes

- @matatbread/matbot-core@0.2.2
- @matatbread/matbot-plugin-api@0.2.2

## 0.2.1

### Patch Changes

- @matatbread/matbot-core@0.2.1
- @matatbread/matbot-plugin-api@0.2.1

## 0.2.0

### Patch Changes

- @matatbread/matbot-core@0.2.0
- @matatbread/matbot-plugin-api@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies [4891bf7]
  - @matatbread/matbot-plugin-api@0.1.8
  - @matatbread/matbot-core@0.1.8

## 0.1.7

### Patch Changes

- 5c244c1: fix(frontend-web): click-to-install banners name the exact package and discover locally first

  The "Enable workspace", "Install edit-session", and "Enable sessions" banners sent the
  LLM a partial plugin name, which led it to guess registry name variations. They now name
  the exact package (`@matatbread/matbot-tool-workspace`, `@matatbread/matbot-edit-session`,
  `@matatbread/matbot-sessions`), instruct it to run `discover_local` first and add from the
  local cache if present, and only then fall back to npm/github by that exact name — with an
  explicit "do not guess other name variations".

  - @matatbread/matbot-core@0.1.7
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

- Updated dependencies [b40c2ec]
  - @matatbread/matbot-core@0.1.6
  - @matatbread/matbot-plugin-api@0.1.6

## 0.1.5

### Patch Changes

- @matatbread/matbot-core@0.1.5
- @matatbread/matbot-plugin-api@0.1.5
- @matatbread/matbot-skills@0.1.5

## 0.1.4

### Patch Changes

- @matatbread/matbot-core@0.1.4
- @matatbread/matbot-plugin-api@0.1.4
- @matatbread/matbot-skills@0.1.4

## 0.1.3

### Patch Changes

- 589e061: Ship the static UI assets (index.html, app.js, browser.js, http-transport.js,
  favicon) by listing them concretely in `files`. Previously `files` was `["src"]`, so
  the published package omitted the web UI it serves at runtime; concrete entries also
  let a github/http install mirror them (a raw host can't be directory-listed).
  - @matatbread/matbot-core@0.1.3
  - @matatbread/matbot-plugin-api@0.1.3
  - @matatbread/matbot-skills@0.1.3

## 0.1.2

### Patch Changes

- @matatbread/matbot-core@0.1.2
- @matatbread/matbot-plugin-api@0.1.2
- @matatbread/matbot-skills@0.1.2

## 0.1.1

### Patch Changes

- @matatbread/matbot-core@0.1.1
- @matatbread/matbot-plugin-api@0.1.1
- @matatbread/matbot-skills@0.1.1

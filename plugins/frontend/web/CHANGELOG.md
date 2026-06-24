# @matatbread/matbot-frontend-web

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

# @matatbread/matbot-background-jobs

## 0.4.19

### Patch Changes

- Bake `background-jobs` into the browser bundle. It is a cross-runtime plugin, and the cross-tab scheduling fix in 0.4.18 was specifically about the browser case, but the plugin was never added to `matbot.web.json` so it was absent from `matbot.html` entirely.
  - @matatbread/matbot-core@0.4.19
  - @matatbread/matbot-plugin-api@0.4.19

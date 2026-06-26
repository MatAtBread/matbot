---
"@matatbread/matbot-cli": minor
---

feat(cli): version banner + `--version` flag surfacing resolved singleton versions

The CLI now prints `matbot vX (core Y, plugin-api Z)` at boot and via `matbot --version`
(`-v`). The core/plugin-api versions are the ones actually *resolved* at runtime
(plugin-api through core, the instance the principal carrier lives in), so a duplicated /
version-skewed install shows up directly — and prints an explicit "version skew" warning
with the reinstall remedy instead of failing obscurely later.

---
'@matatbread/matbot-tool-plugin': patch
'@matatbread/matbot-cli': patch
---

Install a plugin into a pnpm workspace root

`plugin add npm:<pkg>` (and `matbot install`) shelled out to `pnpm add <pkg>` in the project
directory. Where that directory is a pnpm workspace root, pnpm refuses outright —
`ERR_PNPM_ADDING_TO_ROOT`, on the assumption that a member package was meant — and the install
failed with a message about a `-w` flag the user has no way to pass.

Here a member package was never meant: the project directory is the one holding `matbot.yaml`, and
a plugin is that project's dependency. So the root is now named explicitly (`-w`) when installing
with pnpm into a directory carrying a `pnpm-workspace.yaml`, rather than failing an install that had
nowhere else to go. Other package managers are unaffected, and the `.plugins/` provisioning path
already used npm unconditionally for the same reason.

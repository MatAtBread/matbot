# @matatbread/matbot-caching-tool-types

This is a [matbot](https://github.com/MatAtBread/matbot) plugin.

[`@matatbread/matbot-tool-types`](../tool-types), with its build kept in plugin settings. The build is a
TypeScript Program over every loaded plugin's source, about 2 s of blocked event loop on one CPU, paid by
each process's first tool call. With this plugin, a process whose inputs are unchanged takes the stored
build instead.

Load it **instead of** `tool-types`, not beside it: both register `ToolTypeIndex`.

A stored build is used only when all of these match the process asking:

- the Program roots, in order (the loaded plugins, and which of two clashing declarations wins);
- the `toolContract` strings of synthetic tools;
- the principal;
- the source of `tool-types` and of this plugin;
- every file the build read: size and mtime, then content where only the mtime moved.

Anything else builds, exactly as `tool-types` would, and is saved beside what is there. The build covers
every scanned tool and is narrowed to the live ones on the way out, so a tool registered or removed —
every `mcp__*` tool arriving after boot — is a filter, not a rebuild. The last four builds are kept, one per
set of inputs, since one boot can need two: types asked for before the last plugin has loaded, and after.

If reading the stored build fails, the plugin logs a warning and builds normally. The rebuilt index is
kept in memory even if the settings backend remains unavailable; errors from the build itself still fail.

**Trust.** Each validator is stored as JavaScript source and compiled with `new Function` on load, so the
settings medium must be trusted like plugin source.

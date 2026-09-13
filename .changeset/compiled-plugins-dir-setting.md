---
'@matatbread/matbot-tool-skill-compiler': minor
'@matatbread/matbot-tool-types': patch
---

The compiled-plugin build root is `.compiled-plugins/`, and an installation can site it

Two changes to one directory, for deployments that run matbot per user (separate pods, a read-only
project root, a per-user volume) rather than out of a working copy.

**Renamed `compiled-plugins/` → `.compiled-plugins/`.** Every other matbot-written, gitignored root
next to `matbot.yaml` is dot-prefixed (`.data/`, `.plugins/`, `.env`); this one was the outlier. It
stays out of `.data/` — the durability reason was already recorded (a compiled plugin has no upstream,
so a cache clear loses it), and the stronger one now is too: `docker-bash` mounts the project root
read-only and then `.data` read-write over it, so a build dir under there would be writable by the
model from inside the container, and a loaded plugin is full Node capability with no sandbox.

**The directory is settings-backed** — `compiledPluginsDir` in the plugin's own namespace, so an
installation can site it through `default_settings:`:

```yaml
default_settings:
  '@matatbread/matbot-tool-skill-compiler':
    compiledPluginsDir: .compiled-plugins
```

There is deliberately no action to change it at runtime. The name is not merely a path: `plugin add`
records `./<dir>/<tool>` in the config — or in whatever has taken over `plugins:` — so every
already-compiled tool's entry is spelled with it, and a change orphans all of them with **no
migration**. An installation answering the question once at boot is a different act from a running
machine moving the goalposts. A configured value is normalised to the spelling `plugin add` will
record (leading `./` and trailing `/` stripped), because that specifier is compared against
`plugin list`'s `configured` entries to decide add-vs-reload, and two spellings of one directory miss
each other as strings.

**No migration for existing compiled plugins.** An install carrying `./compiled-plugins/<tool>` in its
config either renames the directory and the config entry together, or pins the old name through the
setting above.

`tool-types` drops its own hardcoded copy of the name: `buildMatbotToolsDts` listed
`compiled-plugins` in the skip set for its `plugins/` walk, which was both a second spelling of a
constant this plugin owns (now relocatable, so unknowable there) and unreachable, the build dir being
that root's sibling. It skips dot-directories wholesale instead — one rule that cannot go stale.

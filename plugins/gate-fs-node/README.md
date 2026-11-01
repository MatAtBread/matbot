# @matatbread/matbot-gate-fs-node

Confines a `tool_function` body's `node:fs` access to permitted paths.

A body that is granted `node:fs` (through the `tool_function.import` gate) can otherwise read and write
every path the matbot process can — including the `.env` vault and `.data` state. This plugin wraps the
`node:fs` and `node:fs/promises` modules a body receives (through the runner's `ImportedModuleWrapper`
seam) in a Proxy that checks every path argument against a policy before the real call runs:

- the **`.env` vault** and the **`.data` / `.plugins` / `.git` / `node_modules`** trees under the project
  are always refused;
- otherwise a body is confined to the **project directory**, or to the roots in **`permit_fs_paths`**
  (this plugin's setting) when that is set — the deny set still applies within them.

Symlinks are resolved (`realpath`) before the check, so a link inside an allowed directory cannot point
out of it. Two-path operations (`rename`, `copyFile`, `cp`, `link`) are checked at both ends; fd-based
calls and non-path members pass through.

```yaml
default_settings:
  '@matatbread/matbot-gate-fs-node':
    permit_fs_paths: ['/home/matt/project/src', '/home/matt/project/build']
```

## What it is, and is not

A **guardrail** against an over-reaching body, enforced by **rule** (it cannot prompt — the wrapper runs
in the body's own, often synchronous, call stack, which has no gate channel). It is **not a sandbox**:

- a **granted package** gets the raw `node:fs` (it is trusted as itself), so IO it does is unwrapped;
- a body can reach a raw binding or another IO module (`node:net`, `node:child_process`);
- it only mediates a body's own `import('node:fs')`.

Bounding what the **process** may touch is the deployment's job — the OS user matbot runs as, a container,
or node's `--permission` model (`--allow-fs-read` / `--allow-fs-write`). See `docs/SECURITY.md`.

Needs a `FunctionRunner` that offers `ImportedModuleWrapper` (the node runner,
`@matatbread/matbot-function-runner-node`, does). Without one it does nothing.

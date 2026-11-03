# @matatbread/matbot-gate-fs-node

Puts each path a `tool_function` body's `node:fs` names to the permission gate.

Without it, a body that is granted `node:fs` (through the `tool_function.import` gate) can read and write every
path the matbot process can, including the `.env` vault and `.data` state. This plugin wraps the `node:fs`
and `node:fs/promises` modules a body receives (through the runner's `ImportedModuleWrapper` seam), so each
path the body names is asked about again:

- **`tool_function.fs-read`** or **`tool_function.fs-write`**: separate gates, so a grant to read a path
  doesn't allow changing it. Writing includes creating, renaming and deleting.
- **subject `<function> <realpath>`**, keyed like the import gate's. Symlinks, `..` and relative paths are
  resolved first, so a file has one subject however it is spelled, and a link can't lead out of a grant.
  The realpath is the name as stored on disk, so on a volume that ignores case (macOS's default) `.ENV`
  is asked about as `.env`. A subject you configure should be spelled as the path is stored; a **denial**
  written in lower case also holds for every spelling on such a volume, including a file that does not
  exist yet. Whether a volume ignores case is measured, once per device.
- **standing answers on offer:** the path itself, for this function or for **any** function (`* <path>`);
  anything in its directory, for this function or for any function (`* <dir>/`). A directory grant covers everything below it. A body that moves
  above it is asked again, and so is one that follows a symlink out of it, because the link is asked about
  at its target. A grant for a file covers that file only, not `notes.txt.bak` beside it.
- **for this session or always:** "allow anything in `~/Photos/` for this session" is how a piece of work
  reaches a directory without asking about every file, and without granting it for ever.

It uses the same `PermissionGate` and the same store of standing answers as every other gate, so there's no
separate setting. `gate_action` lists and clears these answers like any others. To pre-authorise, or to deny
outright, configure the gate:

```yaml
default_settings:
  '@matatbread/matbot-default-gate':
    'tool_function.fs-read':       { '*': ['* /home/matt/project/src/'] }
    'deny:tool_function.fs-read':  { '*': ['* /home/matt/.ssh/', '* /home/matt/project/.env'] }
    'deny:tool_function.fs-write': { '*': ['* /home/matt/project/'] }
```

`'*'` holds the answer everywhere. Where answers overlap, the most specific wins: the answer nearer the
path, then the one for this function before any function's. So a denial of a file or a directory inside a
granted one carves it out, whether the grant was for one function or for any, and a grant inside a denied
one reopens it. Nothing prompts you about a path a standing answer already allows, so a denial like that
is given with `gate_action deny`, which asks you to confirm it.

## Sync and async

- **Async calls** (`fs.promises.*`, `node:fs/promises`, and the callback form `fs.readFile(p, cb)`)
  **ask**: a prompt appears when nothing standing decides. A refusal rejects, or reaches the callback, with
  an `EACCES` error that says who refused. Questions within one invocation are asked one at a time, so a
  `Promise.all` over a directory prompts once if the first answer covers the directory. An answer is
  remembered for the rest of that invocation, so a refused path isn't asked about again on every pass of a
  loop.
- **Sync calls** (`readFileSync`, `createReadStream`, …) **can't ask**: they block the thread a prompt
  needs. They consult the answers in force when the body imported the module, plus any given since, and
  throw `EACCES` when those don't allow the call. The error tells the body to use the async form so it can
  be asked.

## What it is, and is not

A **guardrail** against an over-reaching body. It is **not a sandbox**:

- a **granted package** gets the raw `node:fs` (it is trusted as itself), so IO it does goes unasked;
- a body can reach another IO module (`node:child_process`), which this plugin doesn't touch;
- an operation that recurses (`rm`/`cp`/`readdir` with `recursive`, a `**` glob) on a directory granted
  by its exact path, rather than "anything in" it, acts below what was granted.

Bounding what the **process** may touch is the deployment's job: the OS user matbot runs as, a container,
or node's `--permission` model (`--allow-fs-read` / `--allow-fs-write`). See `docs/SECURITY.md`.

Needs a `FunctionRunner` that offers `ImportedModuleWrapper`; the node runner,
`@matatbread/matbot-function-runner-node`, does. Without one it does nothing.

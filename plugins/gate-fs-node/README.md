# @matatbread/matbot-gate-fs-node

Puts each path a `tool_function` body's `node:fs` names to the permission gate.

Without it, a body that is granted `node:fs` (through the `tool_function.import` gate) can read and write every
path the matbot process can, including the `.env` vault and `.data` state. This plugin wraps the `node:fs`
and `node:fs/promises` modules a body receives (through the runner's `ImportedModuleWrapper` seam), so each
path the body names is asked about again:

- **`tool_function.fs-read`**, **`tool_function.fs-write`** and **`tool_function.fs-access`**: three
  independent gates, so a grant to read a path doesn't allow changing it, and neither reading nor writing it
  allows changing its permissions, owner or timestamps (`chmod`, `chown`, `utimes`), which is `fs-access`.
  Writing includes creating, renaming and deleting.
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
    'deny:tool_function.fs-access': { '*': ['* /home/matt/'] }
```

`docs/SECURITY.md` (*A default setup for function bodies*) has a fuller example, including protecting
matbot's own files, which this plugin assumes nothing about.

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
  be asked. A stream's later open is asynchronous, so a stream that has been repointed does ask, and a refusal
  reaches it as an `error` event.

## What it is, and is not

A **guardrail** against an over-reaching body. It is **not a sandbox**.

**It holds against a body using the module**, which is what an over-eager model does. What is opened is what
was asked about, whatever the body then changes of its own:

- **A path is read once.** The string asked about is the one node gets, so a `Buffer` rewritten or a `URL`
  reassigned after the call, even while a human is deciding, changes nothing. The same goes for a glob's
  patterns and `cwd`, and for an options getter. A path that is not valid UTF-8 is refused, since no string
  can name it.
- **A stream asks again when it opens**, about the path and flags as they stand then. Assigning `s.path` or
  `s.flags`, or calling `Utf8Stream.reopen`, is asked about like any other call.
- **A flag is asked about as what it does.** `readFile(p, { flag: 'w' })` needs the write gate, because it
  truncates. `open(p, 'r+')` needs both.
- **A link is followed.** A link changed while a question is open is asked about again at its new target, and a
  dangling one is asked about at the file a write through it would create.
- **The module can't be read around or written through.** A property descriptor gives the guarded function, and
  an assignment is refused. A stream's `constructor` is the guarded class, on a stream from a handle too.
- **Node's own classes are refused to a body.** A stream's or a watcher's class reached by walking prototypes,
  and a file handle's own `chmod`, `chown` and `utimes`, refuse a body and say why. Host code still sees node's
  own, so identity checks elsewhere in the process hold. This needs a runner whose `ImportedModuleWrapper` offers
  `hideFromBody`, since only the runner knows which code is a body's. The node runner does; under one that does
  not, these stay reachable, and everything else here still holds. (`util.inspect` names such a stream `Readable` rather
  than `ReadStream`, being the one reader that looks past the property.)
- **A descriptor is the body's only if it opened it.** `read`, `write`, `fstat` and the other fd-based calls,
  and a descriptor where a path goes, take only descriptors this invocation opened through the gate, until it
  closes them. Any other number is a file the process has open for its own reasons. `fchmod`, `fchown` and
  `futimes` ask `fs-access` about the file the descriptor was opened on.
- **A directory holding a denied path cannot be renamed**, since an answer names a path and the rename would
  move the file out from under it. The error names the path and why. Only standing denials hold a rename up, so
  it never asks about every file, and a link inside is moved rather than followed.

**It does not hold against code written to get past it.** Nothing here stops these, and a body shares matbot's
process, so no in-process wrapper can:

- **rewriting a built-in** the gate or the policy reads (`Map.prototype.get`, say), which is the tampering
  `docs/SECURITY.md` describes;
- **a race**: a link repointed in the instant between the last look at a path and the kernel's own walk of it;
- **a hard link made outside matbot**, which is a second name for a file.

It also leaves these alone, by design:

- a **granted package** gets the raw `node:fs` (it is trusted as itself), so IO it does goes unasked;
- a body can reach another IO module (`node:child_process`), which this plugin doesn't touch;
- an operation that recurses (`rm`/`cp`/`readdir` with `recursive`, a `**` glob) on a granted directory acts on
  what is inside it, including a path denied there. Keep what must never be reached outside any granted
  directory.

Bounding what the **process** may touch, which is what holds against all of the above, is the deployment's job:
the OS user matbot runs as, a container, or node's `--permission` model (`--allow-fs-read` / `--allow-fs-write`).
See `docs/SECURITY.md`.

Needs a `FunctionRunner` that offers `ImportedModuleWrapper`; the node runner,
`@matatbread/matbot-function-runner-node`, does. Without one it does nothing. It takes the service from whichever
runner registered it, and depends on the node runner for types only.

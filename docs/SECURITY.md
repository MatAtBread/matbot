# Security model

What matbot defends, against whom, and where the edges are. It is written for whoever installs matbot,
and for anyone writing a plugin that adds a privileged operation.

## The threat model

Three principles. A behaviour that breaches none of them is not a defect, however surprising it looks.

1. **Authentication is outside matbot.** A reverse proxy, or a network that only trusted people can reach,
   decides who may use an installation. Whoever can reach the web UI can reach the tools and files the same
   server serves, and so can pages served from it (a dashboard calls tools; that is what it is for).
2. **Gates decide what matbot may do.** A privileged operation (installing a plugin, importing a module
   into a function, sending a request, admitting a Telegram chat) passes through a permission gate. No
   tool may widen what a gate permits; only a user can, by answering it.
3. **The adversary is a rogue model inside the authentication barrier.** It can call every tool it is
   given, write code, and reach the network from wherever matbot runs. That is why a gate asks through a
   channel the model is not party to (the UI, the terminal), and why a gate **refuses when nobody can be
   asked**: a trigger, a background job or `POST /tools/:name` has no human behind it.

The property this gives is: *a privileged operation is decided somewhere replaceable, and by default
that means a human is asked*. It is not "the model cannot change this". The default policy keeps its
standing answers in plugin settings, wherever the storage backend keeps them; a tool that can write
there can grant itself anything. `docker-bash` mounts them read-only for that reason. Plain `bash` can
write them, and everything else, as the user matbot runs as.

A refusal at a door with nobody to ask is logged (once an hour per gate and subject), naming the gate
and subject a standing answer would need, so an unattended job that stopped working can be found and
fixed.

A standing answer ("always allow…") is the user extending authority. It applies at every door, including
the ones with no human behind them, and it can be withdrawn with `gate_action`.

## What is gated

| Gate | Asked when |
|---|---|
| `plugin.add`, `plugin.load` | A plugin is installed, or loaded for the first time |
| `plugin.reload` | A plugin is reloaded and its code differs from what was loaded (on disk, or fetched upstream) |
| `plugin.provision-deps` | A fetched plugin now declares dependencies its cached copy lacks, which would be installed |
| `plugin.remove`, `plugin.npm-uninstall`, `plugin.remove-provisioned` | A plugin is removed, and with it what adding it installed or created |
| `provider.add`, `provider.update`, `provider.remove` | A provider profile is added, changed or removed |
| `provider.add-unverified`, `provider.update-unverified` | The endpoint check failed, and the profile would be saved anyway |
| `provider.add-unlisted`, `provider.update-unlisted` | The model is not among those the endpoint lists (asked last: listing sends the profile's credential) |
| `mcp_action.add` | An MCP server is connected or spawned; the prompt names any vault keys a local one is given |
| `mcp_action.remove` | An MCP server is disconnected |
| `http.request` | The `http` tool reaches an origin (scheme, host and port), including one a redirect leads to |
| `http.secret` | The `http` tool sends a vault key to an origin |
| `tool_function.import` | A function body imports a module |
| `tool_function.connect` | A function body's `fetch` or `WebSocket` reaches an origin, including by redirect |
| `tool_function.edit` | A function or package that uses `import(`, `fetch` or `WebSocket` is redefined: may the new version keep the grants? |
| `function_runner_config.set` | A setting of the function runner (its time bound, its import restriction) is changed |
| `telegram_open_door.open` | The Telegram door is opened to new chats |
| `tools.overwrite` | A plugin registers a tool another plugin owns |

A function's own grants name its **lineage**: the version it descends from by edits the user permitted
to keep them. An edit nobody permitted, or one made where nobody can be asked (another process, a job,
an HTTP call), starts a lineage of its own, so its grants are asked for again. Permission to keep them is
given per function and per session ("always, for edits to this function in this session"), while the
grants themselves hold wherever the function runs. "Any function" answers name no lineage at all.

A provider's credential does not follow its endpoint to another origin: `provider update` points the
profile at a fresh, unset vault key instead, for the user to supply with `plugin store-key`.

The list is the gates matbot's own plugins raise. A plugin can raise gates of its own, under its own tool's
name, and `gate_action get` reports every gate that has a standing answer, whoever raised it.

## How a gate decides

A gate is a question with a yes-or-no answer. The plugin doing the work **declares** it: a gate id
(`http.request`), a subject (the origin), a sentence naming the act, and what to do if nobody can be
asked. The registered `PermissionGate` **decides** it. The default policy
(`@matatbread/matbot-default-gate`, always present) decides in this order:

1. **A standing denial of exactly this subject** refuses it, without asking.
2. **A standing answer that covers the subject** allows it, without asking.
3. **Otherwise, if someone can be asked** (the web UI or the terminal of the turn that raised it), it
   asks, offering:
   - **Deny**, this once;
   - **Always deny** this exact act;
   - **Allow**, this once;
   - **Always allow** the subject, or one of the broader subjects the plugin offers, narrowest first
     ("any builtin", "any function");
   - **Always allow every** `<gate>`.
4. **Otherwise** it does what the plugin declared for nobody being there, which for every gate above is
   to refuse, and logs the refusal.

A refusal tells the model which of these refused, and, where nothing in the turn can change that, says
so, so that it does not go looking for a way round.

**Standing answers** are kept in the default policy's plugin settings: `true` for every subject of a
gate, or a list of exact subjects. Denials sit beside them under `deny:<gate>`, in the same shapes. An installation can configure them under `default_settings:` (see
[egress controlled outside matbot](#when-egress-is-controlled-outside-matbot) for an example). Settings
are layered per gate: answering a prompt stores the subjects in effect plus the new one, and from then on
the stored list is what applies, so a later edit to that gate's configured value has no effect until the
stored one is cleared. `gate_action get` reports the answers in effect (and any `denials`); `list`
reports them one entry at a time with an id, optionally those mentioning some text (a host, a function),
and `clear` forgets the entries named, a gate (reverting it to its configured value), or everything.
Forgetting a denial asks the user first (`gate_action.forget-denial`), since it undoes a refusal they
chose; forgetting an allow does not, since it only makes a gate ask again. There is no `set`: the one
way to give a standing answer at run time is a person answering the prompt that names the act.

### What an answer can change

Every gate starts closed: asked, or refused where nobody can be asked. The allows a person gives, and
those an installation configures, **widen** what matbot may do: the gates are how a user relaxes the
defaults. The point is that model-written code does nothing the user has not permitted, not to judge
what a user permits: an answer means what it says. "Always allow every `plugin.add`" means anything that
reaches the tool endpoint installs any plugin, with full access, unasked.

**Always deny** narrows one thing: the exact act asked about, refused from then on without asking,
which is what stops a model asking the same question again. It is never broader. A denial wins over an
allow that also covers the act, which arises only where the denial came first and a broader allow
after, or both are configured, since an allow that covers an act keeps it from being asked about.

A broader restriction is expressed somewhere else:

- **don't load the plugin**, or the tool, that does the thing;
- **a configured denial**, `deny:<gate>`, a list of subjects or `true` for all of them;
- **the function runner's `permit_imports`**, which forbids modules by rule, so nobody is asked;
- **a replacement `PermissionGate`** with its rules compiled in, which can refuse what the default would
  ask about, and whose rules are out of reach of anything that can write settings;
- **the deployment**: the OS user matbot runs as, a container, a firewall or egress proxy.

## The web UI's endpoints

The UI answers gate prompts over HTTP (`POST /sessions/:id/prompt`). Anything that can reach that
endpoint can answer a prompt, which is correct for every browser the user has open and wrong for the model.
`frontend-web` therefore:

- **refuses every request arriving on a connection matbot's own process opened.** The model reaches the
  network from inside that process (the `http` tool, a function's `fetch`, an MCP client), and node reports
  each such connection on every platform;
- **answers its own origin only**, unless `cors_origin` names another;
- **refuses a POST not sent as `application/json`**, which is what makes a browser ask before a page on
  another origin may send one;
- **sanitises model output**: HTML in a reply is kept, minus what runs script or changes the page
  (event handlers, `<script>`, `javascript:` URLs, `<style>`, `<form>` and the like), and each reply is
  drawn inside its own bubble. The libraries the page loads are pinned with integrity hashes;
- **sandboxes every embedded page**, so it never runs with the UI's access. One from this server is
  loaded through a bridge that makes tool calls and file reads for it, and nothing else: a dashboard
  embedded in a reply works, and cannot answer a prompt.

What remains open, and why:

- **A process matbot starts.** `curl` run by `bash`, or an MCP server spawned over stdio, opens its own
  connection, and node cannot tell whose child a connection belongs to. Linux can, through `/proc`; macOS
  and Windows need platform tools. An installation that grants `bash` has granted this route too.
- **`docker-bash` over Docker's default bridge network** can reach the host, and so the UI's port.
  A `docker-bash` that cannot reach the host, whether another implementation or an option on this one, is
  an implementation choice.
- **A dashboard opened in its own tab** runs on the UI's origin with the UI's access, so script in it
  can answer a prompt while it is open. Files served from `/files` are active content by design; the
  same page embedded in a reply is sandboxed instead.
- **An origin the user approved that forwards to matbot**: a `cors_origin`, or a service the model can
  reach that relays requests on.

## Code the model writes

A `tool_function` body runs under whichever `FunctionRunner` is registered. The runner is a **seam**:
`@matatbread/matbot-function-runner-node` is one implementation, not the feature, and an installation may
replace it.

- **Without a runner**, nothing is gated: a body's `import(…)`, `fetch` and `WebSocket` reach the
  platform directly, unbounded in time. That is the default until a runner is configured.
- **The node runner keeps a body from reaching past the gates.** It runs bodies in matbot's own process,
  withholds `process`, `globalThis` and `eval`, routes `import(…)` through the import gate and binds a
  gated `fetch` and `WebSocket`. Code a body compiles from a string would run in the global scope, where
  none of that applies, so the function constructors (`Function`, and every function's `.constructor`)
  and `process.getBuiltinModule` refuse a body however it reaches them, saying why. The type-check refuses
  the plain spellings when the function is defined (`ESCAPE-GATE`). This is aimed at a model that decides
  a task needs something it was not given and looks for another way to it: the intended path asks the
  user, and the other one says it is closed.
- **It is not a sandbox against hostile code.** A body shares the process's built-ins, so code written to
  interfere with matbot can rewrite them (`Object.prototype`, `JSON`, `Headers.prototype`) and see what
  matbot later passes through them, a provider's credential included. The type-check refuses the plain
  spellings of that too, and a computed spelling gets past it. Code that arrives through prompt injection
  (an email, a web page, a file the model was asked to read) is that kind of code. A runner that gives
  each body a context or a process of its own is the answer for an installation that processes untrusted
  content. A child-process runner is one such implementation, not currently part of this repo: whatever
  a body or its packages change is thrown away with the child. Any `FunctionRunner` can be swapped in
  without changing anything else, and a more thorough in-process one is possible; it is not this
  project's.
- **A granted package is trusted as itself.** Allowing a function to import `imapflow` trusts imapflow and
  what it imports, which may compile code or patch built-ins as it likes. It does not trust the body, so a
  callback of the body's that the package runs is still refused the code builders. A package that
  evaluates what it is given (a template engine) evaluates the body's strings: granting it grants that.
- **A body cannot answer a gate.** The tools it calls ask through the calling turn's channel, and
  `toolInContext` changes only the provider and can only add a reason to cancel, so a body cannot hand a
  callee a prompt, a session or tools of its own.
- **`execute`, and fetching code then executing it, are not an escalation.** A body reaches only what the
  gates allow, and the model can write the same code directly. Downloaded code runs with the body's reach,
  no more.
- **A tool that evaluates code its caller supplied must gate it, or run it as a body.** Tools a body calls
  run as matbot's own code, so one that compiled what it was handed would be a way round the runner.
- **A grant is the user's.** A standing answer covering "any function" applies to every function defined
  later, including one written under the influence of injected content, and an edit permitted to keep its
  grants keeps them whatever the edit added. That is what those answers say.

### Prompt injection

A body adds composition, not reach: every tool it can call, the model can call directly, and so can
anything that reaches the tool endpoint. The exposure that injected instructions exploit is the pair of
**an ungated tool that reads private data** (sessions, files, memory) **and an ungated way to send it
out** (a messaging tool, a granted origin). Gates cover the second only where a tool asks one. Which
tools should refuse when nobody can be asked is a separate question from the runner.

## Shells

- **`bash` is inherently insecure.** It runs commands as the user matbot runs as, and nothing is gated
  about what a command does: it reaches files, the network, other processes, `.env`, and the stored gate
  answers, which it can rewrite to grant itself every later gate. A command it starts can also reach the
  web UI's endpoints (see above). Loading it gives the model all of that.
- **`docker-bash` is safer, not safe.** What it adds:
  - scripts run in a container, with the project mounted read-only and its `.env` covered, so it reads
    as empty;
  - `.data` is read-write, except its `settings` and any SQLite database, which hold the gate answers
    and are mounted read-only.

  How much that is worth depends on where it runs:
  - **The Docker installation.** With rootful Docker, matbot's user is in the `docker` group, which is
    root-equivalent on the host, and the container shares the host's kernel, so an escape from it is
    an escape to the host. Rootless Docker, Podman or user-namespace remapping narrow that; they are the
    host's choice, not the plugin's.
  - **What this implementation fixes.**
    - **Network:** Docker's default bridge, which reaches the internet and the host, the UI's port
      included.
    - **Image:** `node:24-bookworm`.
    - **User:** root inside the container.
    - **Limits:** none on memory, CPU or processes.
    - **Configurable:** only through `bash_config` (DNS, the container's name, the output cap), and
      that tool is not gated.
  - **What it can still write.** Sessions, files, knowledge and stores under `.data` are writable, so a
    script can rewrite conversation history or a stored function's text. A function rewritten that way
    loses its grants: its lineage is kept in settings, which the container cannot write.

  A shell with no network, a non-root user, resource limits or another runtime is a different
  implementation of the same tool, which is a plugin like any other.

## Secrets

- The default vault reads `.env` next to `matbot.yaml`. Its keys are taken out of matbot's own environment
  once the vault holds them (also when a systemd `EnvironmentFile=` put them there), so no process
  matbot starts inherits them. A secret exported under a name `.env` does not use stays in the
  environment, so keep secrets in `.env`.
- A tool names a secret by key (`${KEY}`) and the vault supplies it: `http`'s `{ Vault: … }` headers
  (gated per origin and key), a provider's `credentials`, a local MCP server's `env`.
- The `.env` vault is a template, not a secrets manager. Code with filesystem access as matbot's user
  (`bash`, or a body using the runner escape) can read the file itself. A vault backed by an OS secrets
  manager is the fix for that.

## Profiles

Sharing an item (`share`, in `@matatbread/matbot-storage-profiles`) is its owner using their own
authority, so it is not gated. A different profiles implementation could choose to gate it.

## Deploying

- **Run matbot as a dedicated, unprivileged user.** Membership of the `docker` group is root-equivalent.
  Membership of `sudo` is not, unless `NOPASSWD` is set or a ticket is cached.
- **Treat the UI's network as the authentication boundary.** Everyone who can reach the port can use the
  installation, by principle 1.
- **An egress proxy** is the deployment-level control for where matbot may connect. The gates decide per
  request; a proxy can enforce a policy that nothing in the process can lift. See below.

### When egress is controlled outside matbot

An installation whose proxy or firewall decides where matbot may connect can turn off the per-origin
gates. A gate set to `true` allows every subject:

```yaml
default_settings:
  '@matatbread/matbot-default-gate':
    'http.request': true              # the http tool, any origin
    'tool_function.connect': true     # a function's fetch / WebSocket, any function, any origin
```

These are two settings, not one switch, because the questions differ: an installation may let the `http`
tool reach anything its proxy allows and still be asked about model-written functions. Other gates are not
affected and should stay: `http.secret` (sending a vault key to an origin) and `tool_function.import`
(including `node:http` and `node:net`) are not about where traffic may go.

- **There is nothing between `true` and exact subjects.** A list matches whole strings. There is no
  `https://*.example.com`, and `* <origin>` under `tool_function.connect` means any function reaching
  that one origin. Patterns would be a different policy: replace `PermissionGate` with one that has them.
- **A stored answer overrides the configured value.** Settings are layered per key: a stored answer wins
  over `default_settings:` as a whole, not merged with it. If someone answered "Always allow requests to
  `https://x`" before `true` was configured, the stored `['https://x']` is what applies, and other
  origins are still asked about. `gate_action` `clear` for that gate restores the configured value.
- **Enforce the proxy outside the process.** Node's `fetch` does not use `HTTP_PROXY`/`HTTPS_PROXY`
  unless its proxy support is switched on, and code that escapes the in-process runner can open sockets
  directly. A firewall that lets matbot's user out only through the proxy holds either way.
- **A standing answer means what it says.** "Always allow every `plugin.add`" means anything that
  reaches the tool endpoint can install any plugin with nobody asked, and a loaded plugin has full access.

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
| `provider.add`, `provider.update` | A provider profile is added or changed |
| `mcp_action.add` | An MCP server is connected or spawned; the prompt names any vault keys a local one is given |
| `http.request` | The `http` tool reaches an origin (scheme, host and port), including one a redirect leads to |
| `http.secret` | The `http` tool sends a vault key to an origin |
| `tool_function.import` | A function body imports a module |
| `tool_function.connect` | A function body's `fetch` or `WebSocket` reaches an origin, including by redirect |
| `tool_function.edit` | A function or package that uses `import(`, `fetch` or `WebSocket` is redefined: may the new version keep the grants? |
| `telegram_open_door.open` | The Telegram door is opened to new chats |
| `tools.overwrite` | A plugin registers a tool another plugin owns |

A function's own grants name its **lineage**: the version it descends from by edits the user permitted
to keep them. An edit nobody permitted, or one made where nobody can be asked (another process, a job,
an HTTP call), starts a lineage of its own, so its grants are asked for again. Permission to keep them is
given per function and per session ("always, for edits to this function in this session"), while the
grants themselves hold wherever the function runs. "Any function" answers name no lineage at all.

A provider's credential does not follow its endpoint to another origin: `provider update` points the
profile at a fresh, unset vault key instead, for the user to supply with `plugin store-key`.

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
- **The node runner is not a sandbox.** It runs bodies in matbot's own process. It withholds `process`,
  `globalThis`, `eval` and `Function`, routes `import(…)` through the import gate and binds a gated
  `fetch` and `WebSocket`. But `(()=>{}).constructor('return process')()` recovers the real `process` in one
  line, and with it every builtin and the real network globals. The runner raises the cost from "call a
  documented API" to "know a published trick", and makes the intended path gated and revocable.
- **Mitigations**: a runner that runs bodies in a separate process with a minimal environment and tool
  calls over IPC, or an egress proxy at the deployment level.
- **`execute`, and fetching code then executing it, are not an escalation.** A body reaches only what the
  gates allow, and the model can write the same code directly. Downloaded code runs with the body's reach,
  no more.

## Shells

- **`bash` grants everything** the user matbot runs as can do: files, network, processes, and the stored
  gate answers. Install it only where that is intended.
- **`docker-bash`** runs scripts in a container. The project is mounted read-only, with its `.env` covered
  so it reads as empty; `.data` is read-write, except its `settings` and any SQLite database, which hold the
  gate answers and are mounted read-only.
  Its network is Docker's default bridge (see the web UI section).

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
- **Prefer narrow standing answers.** "Always allow every `plugin.add`" means anything that reaches the
  tool endpoint can install any plugin with nobody asked, and a loaded plugin has full access.

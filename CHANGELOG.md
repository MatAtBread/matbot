# Changelog

All notable functional changes are documented here. Purely stylistic or
non-functional changes (CSS, refactoring, code tidying, docs-only merges) are
omitted.

Within each section, changes are grouped: **Breaking changes**, **API gaps
filled**, and **Bug fixes** cover `core` (the contract consumers depend on);
**Optional** covers new or updated plugins, frontends, and apps — more likely to
churn and less likely to affect a consumer who doesn't use them.

## 0.5.0

### Repository layout

0.5.0 redraws the line between the library and its hosts. In 0.4, core read the CLI's config file,
plugins were handed its path, and `tool-plugin` was a published package, yet every line of it was a CLI
convention. So no host other than the CLI could stand up a machine without taking on the CLI's layout.
The rule now is that core takes what it is given, and whatever belongs to one host lives in that host.
Each move is listed below under its own category; this section is the overview.

| 0.4 (`main`) | 0.5.0 | Why |
|---|---|---|
| `core/src/config/` (`loader.ts`, `yaml.ts`) | `apps/cli/src/config-parse.ts`, `yaml.ts` | `matbot.yaml` is how the CLI is configured, not a core format |
| `plugins/tool-plugin/` (published) | `apps/cli/src/plugins/` | acquisition and the `plugin`/`provider` tools edit `matbot.yaml` and write `.plugins/`, which only the CLI has |
| `plugins/browser`'s list of user-added plugins | `apps/web-bundle/src/extra-plugins.ts` | the same rule in the browser: the host owns its own plugin list (the `plugin` tool stays in `plugins/browser`, built by the bundle over that list) |
| `apps/cli/src/` `principal-als.ts`, `usage-als.ts`, `plugin-resolver.ts`, `plugin-description.ts`, `env-vault.ts` | `host-node/` (new package) | what any Node host needs and core cannot hold, being Node-only, without the CLI's config or layout |
| `plugins/default-gate/` | `core/src/default-gate/` | a minimal install's first act is gated, so the policy cannot depend on a `plugins:` line |
| `plugins/files/` (`files-node`) | `plugins/storage/filesystem/src/file-store.ts` | its only user |
| `plugins/skills-node/`, `plugins/background/`, `plugins/frontend/dom/`, `research/tool-search/` | removed | superseded or unused |
| — | `examples/minimal-matbot/` | a machine from core alone, importing published names only, so the boundary is tested rather than described |

Inside the CLI, the two files that had grown by accretion are split by job. `apps/cli/src/index.ts` (1,200
lines) is now a 60-line entry point beside one module per job:

- `args.ts`: options and help.
- `boot.ts`: finding the config and standing up the machine.
- `setup-wizard.ts`: the first-run wizard.
- `specifiers.ts`: plugin-specifier resolution.
- `banner.ts`: the version banner.
- `conversation.ts`: provider, session and the REPL.
- `turn.ts`: drawing one turn.
- `terminal.ts`: colour and prompts.
- `dump-tools.ts`: `--dump-tools`.

The `plugin` tool (1,400 lines) is now a dispatcher, `apps/cli/src/plugins/tools/plugin.ts`, with one file per action under `plugin/`. The
`matbot.yaml` list editing and the package-manager detection moved out of it, to
`plugins/config-entries.ts` and `plugins/package-manager.ts`, because `matbot install` shares them. The old
`plugins/index.ts` barrel only re-exported, so it is gone and callers import the module that defines what
they use. No new library was extracted from the CLI: with one Node host, a library would be guessing at
a second host's needs.

### Breaking changes

- **`PLUGIN_API_VERSION` is `0.5`, and every published package is 0.5.0.** plugin-api removes exports
  (`importPermitted`, `configPath`) and changes signatures (`PermissionGate.decide`/`snapshot`,
  `ToolTypeIndex.check`, `bindGate`), so a 0.4.x plugin that uses one of those fails: at link time for a
  removed export, at its first call for a changed signature. One that uses none of them still loads, since
  the loader refuses only a different major. npm will not install a 0.4.x plugin beside 0.5.0 anyway: each
  plugin peer-depends on `plugin-api` with a caret range, and on 0.x `^0.4.x` excludes 0.5.0 (`ERESOLVE`).
  Plugins with no change of their own are republished at 0.5.0 for that reason; upgrade them together
  with the CLI.
- **`FunctionRunSettings.permittedImports` and `importPermitted` are removed from `plugin-api`.** What a
  `tool_function` body may import is the permission gate's alone: a module refused outright is a standing
  denial (`deny:tool_function.import`, e.g. `{ '*': ['* node:child_process'] }` for every function), not a list the
  runner carries in front of the gate. `FunctionRunSettings` declares nothing now; a runner's own fields
  (the node runner's time bound) ride on it as before. A runner that set `permittedImports` should drop
  it — nothing reads it.
- **A plugin cannot open the `settings` store, and removes only what it registered.** `settings` holds every
  plugin's settings, the default gate's standing answers among them, so a plugin able to open it could
  grant itself anything, and tool-store's `expose` let a model do exactly that. A plugin reaches its own
  through `services.settings()`; `createStore('settings')` on its machine now throws, in any case, and a
  store name on a plugin's machine is letters, digits, `_` and `-` (the filesystem backend joins it into a
  path, where `x/../settings` was the same directory). `services.tools.remove` on a plugin's machine leaves
  another plugin's or the host's tool in place, with a warning: removing it and registering into the gap
  replaced it without the `tools.overwrite` collision ever being decided. `tools`, `hooks` and
  `systemContext.removeByPlugin` likewise act only on the calling plugin's own name.
- **The `ToolCallValidator` service is removed**, as announced in 0.4.21. Register a `validate` hook
  instead: several co-exist and every one is asked, where the service key held one validator and a second
  had to capture and delegate to the first. A plugin still registering the key is no longer consulted.
- **`turnActivity` / `usageEntries` / `usageByProvider` no longer read the pre-0.4.3 usage shapes** — an
  assistant message's own `usage`, and a `tool-result`'s `usage` array. Sessions written before 0.4.3
  report no usage for those turns.
- **`matbotRuntime` is required: it is what makes a package a plugin.** The loader refuses a package whose
  `package.json` declares no runtimes (or an empty list) before importing it — a `NotAPluginError` for an
  explicit load, a skip recorded in `plugin list`'s `failed` at boot — where it used to import it on
  trust. A third-party plugin without the field must add it, e.g. `"matbotRuntime": ["node", "browser"]`.
  `plugin add` already refused such a package on the npm and http routes; `discover_local` now passes over
  one without importing it. core, plugin-api, host-node and the apps do not
  declare it, since they are not plugins. A host whose `PluginResolver` has no
  `runtimes` has nothing to check, and imports as before.
- **Two migration warnings are removed.** `default_settings.__matbot_core__.overwriteToolsOnCollision` (moved
  to `'@matatbread/matbot-default-gate': { 'tools.overwrite': … }` in 0.4.14) and the CLI's top-level
  `function_timeout_ms` / `function_imports` (moved to `@matatbread/matbot-function-runner-node`'s
  `timeout_ms` / `permit_imports` in 0.4.20) were already unread; they are now unread silently.
- **The default permission policy is core's, and `@matatbread/matbot-default-gate` is no longer
  published.** `defaultGate`, `createDefaultGate`, `makeGateActionTool`, `createGateTools`, `denyKey`,
  `toStandingAnswer` and `DEFAULT_GATE_SETTINGS_NS` are exported from `@matatbread/matbot-core`; import them
  from there. Behaviour is unchanged, and so is the settings namespace, `@matatbread/matbot-default-gate`:
  stored answers and `default_settings:` keyed by it keep working.
- **`@matatbread/matbot-tool-plugin` is no longer published; its code is the CLI's** (`apps/cli/src/plugins`).
  Both halves were CLI conventions rather than something another host could reuse: the `plugin` and
  `provider` tools edit `matbot.yaml`, and acquisition fetches into `.plugins/` and installs with npm beside
  it. Nothing changes for a CLI user. An application that imported it builds its own against its own
  persistence, as the browser's tools do.
- **core no longer parses `matbot.yaml`.** `parseConfig`, `parseYaml` and `MatbotConfig` are the CLI's
  (`apps/cli/src/config-parse.ts`, `yaml.ts`): a config file is how the CLI chooses to be configured, and
  core takes what a host hands `assembleMachine` rather than reading a format of its own. A host that
  parsed `matbot.yaml` with them parses its own configuration; `installSettingsDefaults` stays in core,
  taking a map.
- **`configPath` is gone from `MatbotMachine` and `ToolContext`; a host supplies `projectDir` and `dataDir`
  instead.** A plugin was handed the path of the CLI's config file and derived what it actually needed from
  it — `.data` beside it for storage, its directory for where packages are installed — so it worked only
  under the CLI's layout. `projectDir` is where the host resolves packages and relative plugin specifiers
  from (`tool-types`, `function-runner-node`, `skills_compiler`); `dataDir` is where plugins keep state on
  disk (the storage plugins, `docker-bash`). Both are optional, and a plugin degrades without one as it did
  without a config path. The CLI sets them to the config file's directory and `.data` beside it, so nothing
  changes for a CLI user; `nodePluginMembers` reports its base directory as `projectDir`. A plugin that read
  `configPath` reads whichever of the two it meant.
- **`@matatbread/matbot-skills-node` is no longer published.** Its `.md` import and directory watch added
  nothing `skills` and its tool do not, and the directory it watched is not one anything else writes to.
  Load `@matatbread/matbot-skills` in its place.
- **`PermissionGate` gains `snapshot()`, and `ToolContext` gains `gateSnapshot()`.** A snapshot is what the
  policy would answer with nobody to ask (`decide(req, undefined)`), read once and queried
  *synchronously*. It exists for a call site that interposes on a synchronous API (`readFileSync`), which
  blocks the thread a prompt or a settings read would need. Take one per invocation, never cache it across
  invocations (whose answers they are depends on how settings are partitioned), and take a fresh one after
  `decide` obtains an answer. A policy that delegates takes the displaced gate's snapshot alongside its
  own. Every `PermissionGate` must implement it: core's default gate builds it from one `entries()` read,
  and `askPermissionGate`'s answers the call site's `fallback`.
- **A configured denial now covers what the matching allow would.** The default gate checked a denial
  against the exact subject only, so `deny:<gate>` could not name a directory or `* x` for every
  function. It now matches the call site's standing subjects too, as an allow does. "Always deny" from a
  prompt still stores only the exact subject asked about.
- **`PermissionRequest.separators`** declares that a gate's subjects form a hierarchy. A standing answer
  (allow or deny) ending in one of the separators then covers every subject that starts with it, so
  `/home/me/` covers `/home/me/a/b.txt` and `node:` covers `node:fs/promises`. It is opt-in per request,
  and matches only at a boundary: a stored subject not ending in a separator still matches exactly, so a
  file grant does not cover a sibling whose name it prefixes, nor `lodash` cover `lodash-es`. gate-fs-node
  declares `[path.sep]`; the import gate declares `[':', '/']`, so a configured `* node:` (every function,
  every builtin) now applies. A gate whose subjects are not a hierarchy (an origin, a secret's name)
  leaves it unset.
- **`FunctionRunner.import(spec, caller, options?)`** takes the importing invocation as an `ImportCaller`
  (who is asking, and the gate it asks through), which a runner hands to whatever mediates the module it
  returns. function-tools builds one per invocation, keyed and qualified as its import gate is.
- **`PermissionGate.decide(req, ask, context)` and `snapshot(context)`** take a `PermissionContext` — where
  the act is made, as the host states it (today its `session`). `bindGate(gate, tool, ask, context, tools?)`
  requires one: the runner passes the turn's session, `invokeTool` `opts.session`, a registration none, and
  `POST /tools/:name` `HTTP_TOOL_SESSION`. Not a request field, which a tool writes and could use to borrow
  another session's answers. A replacement gate that delegates passes it on.
- **The default gate's standing answers are scoped, and the format before 0.5.0 is not read.** A gate's
  value is a map from scope to answer — `{ '*': [bash, plugin] }`, `'*'` being everywhere, a session's id
  that session, `#http` the HTTP tool door — and `default_settings:` must use it. A stored answer in the old
  shape (a bare list or `true`) is migrated once, from the stored document alone so no configured default
  is copied into it; one in `default_settings:` is ignored, with a warning naming the key.
- **The most specific standing answer wins, not every denial.** Ranked by how near the act it lies (an
  exact match, then the deeper prefix, where subjects nest), then the narrowest subject the call site
  offered, then this session's answer over one held everywhere, then a denial on a tie. So an allow of
  `* node:fs` beside a denial of `* node:` admits `node:fs` and no other builtin, where every builtin was
  refused before; an allow beneath a broader denial now applies; and a denial of one file or subdirectory
  inside a granted directory refuses it, whether the directory was granted to one function or to any.
- **`PermissionRequest.lifetimes: []` means "ask every time"**: nothing is remembered, and no stored or
  configured standing answer decides the act.
- **A standing answer's label names what is allowed, never for how long** (`function "probe" to import
  node:fs`, not `Always allow …`): the policy words the lifetime. Every call site in this repository is
  updated; a plugin offering `standing` answers should drop the prefix.

### API gaps filled

- **`ToolCheckOptions.importRefused`** — whether the gate refuses the code being checked an import
  outright. Whoever owns the import gate supplies it (`function-tools`, from one gate snapshot per check),
  and a `ToolTypeIndex` declares no types for a refused module and reports a literal `import(…)` of one as
  `IMPORT-GATE`. "Nobody decided" is not a refusal — that is asked at the call — so it is typed.

- **`@matatbread/matbot-host-node`** (new) — what a Node application needs to embed matbot that core
  cannot hold, being Node-only, until now inside the CLI: the `AsyncLocalStorage` principal and usage
  carriers (so a server authenticating its own users can set a principal per request), `nodePluginMembers`
  (`loadPlugin`/`unloadPlugin`/`resolver` for plugins already on disk; nothing fetched or installed), and
  `EnvFileVault`. `node --import @matatbread/matbot-host-node/register` registers the module hooks loading
  matbot's TypeScript-source packages needs (a `.js` import resolved to its `.ts`; types stripped under
  `node_modules`); `/typescript-hooks` exports them for a host with hooks of its own, and the CLI now
  registers them beneath its own.
- **`MemoryStorageBackend`, `MemoryFileStore`** (`core/storage-base`) — a backend that persists nothing,
  so core alone can stand a machine up: with `VaultImpl` and the constant principal carrier it needs no
  other package, for a test, a short-lived embedder, or a single-principal one. `MemoryStore` gains `size`.
- **`invokeTool`, `toolResult`, `toolText`** are re-exported by core as values, not only as types, so an
  application calling a tool from its own request handler needs no direct plugin-api dependency.
- **`assembleMachine`'s `gate` is optional**, defaulting to core's `defaultGate`, so an embedder that wants
  matbot's ordinary policy passes nothing.
- **One machine per process at a time, enforced.** A second `assembleMachine` while one stands throws:
  core's plugin registry and settings defaults belong to the module, and a plugin is one module instance
  whatever machine loads it, so a second machine shared the first's plugins and replaced its defaults.
  `AssembledMachine.dispose()` unloads every plugin and frees the slot; `services.sessions` and
  `services.run`, which `assembleMachine` always provides, are typed as present.
- **`plugin` and `provider` are declared in `ToolContracts` by plugin-api**, beside the shapes it already
  held, rather than by each host's implementation. A host builds both tools itself, so a frontend or client
  typing calls to them needs only plugin-api.
- **`splitContract`, `parseContractArms`, `splitTypeText`** (plugin-api, beside `contractArms`) — a
  `ToolContract<…>` string flattened to the wire's `params`/`result` text without a compiler. Both
  `ToolTypeIndex` implementations had a copy, neither of which knew a string literal or an arrow, so
  `'a|b'` split an arm and the `>` of `=>` closed a bracket. A `toolContract` that mixes arms with a bare
  type keeps its arms in the browser too, as it did on node; the browser used to read it as `unknown`.
- **`describePlugins`, `storeSecret`** (core) — `plugin list`'s report from the registries, and `plugin
  store-key`. Both hosts' `plugin` tools use them; `list` now carries `resolvedUrl` in the browser when
  the loader recorded one.
- **`confirmUnlistedModel`, `movedCredentialNote`** (plugin-api, beside `checkProviderModel`) — the gate
  for a model the endpoint does not list, and the note when an update leaves a credential behind. Both
  hosts' `provider` tools use them, so they ask the same question in the same words.
- **`ToolTypeIndex.check(snippet, { parametersOf })`** — names functions declared at the snippet's top level,
  and the report's new `parameters` gives each one's parameters (`ToolCheckParameter`: name, optional, and
  the JSON Schema its resolved type projects to), read from the program the check just ran. An index that
  cannot resolve types (the browser) omits it.
- **Permission lifetimes: an answer for this session.** The default gate asks allow or deny, *this time*,
  *for this session* or *always*, and for which of the subjects the call site offers — "this work needs my
  photos directory" without granting it for ever or answering a prompt per file. `PermissionLifetime`
  (open, like a gate id), `PermissionRequest.lifetimes` (what a call site permits remembering an act for),
  the `'session'` `PermissionSource` with its `refusalMessage`, and `HTTP_TOOL_SESSION`. A session answer
  is kept in memory by default, keyed by principal and session, and out of reach of every tool;
  `'#session-store': settings` in the gate's namespace persists it instead — or `gate_action
  session-store`, which also moves the answers already in memory. It is offered only where there is a
  session someone works in. `gate_action` reports and clears session answers (`session`, `inMemory`).
- **`gate_action deny`** — a standing denial, everywhere, for what is never prompted for because a broader
  allow covers it (one file inside a granted directory). Asked every time (`gate_action.deny`); refuses
  `gate_action`'s own gates. Forgetting a denial (`gate_action.forget-denial`) is now asked every time
  too: it no longer offers "always", and no standing answer decides it. Both prompts are two buttons
  that say what they do (Deny / Cancel, Forget / Keep), via the new `PermissionRequest.answers`.
- **`FormField.axes`, `FormAxis`, `FORM_AXIS_SEPARATOR`** — a select that is the product of independent
  choices, which a frontend may draw as one control each, answering with the values joined by `|`; an axis
  marked `submit` is drawn as the buttons that send the answer.
  `options` stays the answer for a frontend that ignores it, in the same encoding.

### Bug fixes

- **A secret stored in the `.env` vault comes back as it was written.** The writer and the reader of the
  file lived in different packages and disagreed: a value was written bare and read with comment and quote
  rules, so `abc #1` came back as `abc`, `"x"` as `x` and ` padded ` as `padded` after a restart.
  `EnvFileVault` now reads its own file (`EnvFileVault.open`), quotes a value the reader would otherwise
  reinterpret, and refuses one containing a line break rather than writing it broken.

### Optional

- **`frontend-web`** — a permission prompt reads as a phrase: what, and for how long, as dropdowns, then
  Allow and Deny as the buttons that answer (an axis marked `submit`). `POST /tools/:name` runs its tool in the fixed session `#http`, which an
  installation configures that door's unattended answers against.
- **`function-tools`** — keeping a function's grants across an edit (`tool_function.edit`) is remembered
  for this session only, a real lifetime rather than the session's id inside the subject.
- **`function-runner-node`** — `permit_imports` is retired, and `function_runner_config` reads and sets
  `timeoutMs` alone. An installation that authored it gets a warning naming the replacement, a standing
  denial in the default gate's `default_settings:`, rather than its restriction silently becoming "ask at
  the call"; `clear` forgets a stored override of it. It duplicated the gate, which can refuse a module
  outright by rule and, with "most specific wins", allow narrowly beneath a broad denial.
- **`tool-types`** — the modules a body is typed against are every builtin less those the gate refuses
  it, and `IMPORT-GATE` refuses a literal import of any refused module, a package included: a package
  resolves by ordinary lookup, so leaving it out of `paths` refused nothing. The checker's worker sends the
  literal specifiers it found back to the main thread once and is told which are refused. The verdict
  fingerprint no longer carries an import list (stored verdicts read `checkedElsewhere` once, until
  `check` re-stamps them); a permission is the gate's to report at the call, not a type verdict's claim.
- **`function-tools`** — every check (define, re-check, package, session, `execute`) passes
  `importRefused`, asking under the subject the call would use, so the check refuses what the call would.
  A redefinition is asked under its new version, so a grant or denial for its earlier versions is not
  consulted until the edit is linked; the call sees both.
- **`function-runner-node`** gains the **`ImportedModuleWrapper`** service: a seam by which a plugin
  interposes on a module a body is granted, before the body sees it. The import gate decides *whether* a
  body may import `node:fs`; a wrapper decides *what it can do* with it, asking through the importing
  invocation's own gate (`ModuleWrapContext.caller`), so there is one policy and one store of standing
  answers, not one per module. Registered per specifier and applied in order at `import`. A wrapper may be
  async, and a specifier with no wrapper is handed through raw. The registry is the process's, so a
  reloaded runner keeps the wrappers registered with the one it replaced. A guardrail against an
  over-reaching body, not a sandbox: a granted package still gets the raw module, and bounding the process
  is the deployment's (`docs/SECURITY.md`). `hideFromBody(owner, key, standIn)` makes a property a body would
  reach by walking a prototype read as a stand-in to the body and as itself to host code, by the same caller
  rule that refuses a body the function constructors.
- **`gate-fs-node`** (new, node) — puts each path a body's `node:fs`/`node:fs/promises` names to the
  gate: `tool_function.fs-read`, `tool_function.fs-write`, and `tool_function.fs-access` for permissions,
  owner and timestamps (`chmod`, `chown`, `utimes`), three independent questions, keyed `<function> <realpath>`, offering the
  path and everything in its directory, each for this function or for any (a directory grant covers its
  whole subtree; a denial of the file for any function excludes it from one). Async and callback
  calls ask; sync calls consult a snapshot of the answers in force and throw `EACCES` saying how to be
  asked. Symlinks are resolved first (to the name as stored, so `.ENV` is `.env` on a case-insensitive
  filesystem), and two-path operations ask about both ends; `link` and `rename` read and change their
  source. The module's CommonJS view (`.default`), the stream classes, `Uint8Array` and URL-shaped paths,
  and glob patterns whose braces or `..` reach outside their prefix are all asked about, and a function
  member that takes a path but is in neither of its tables is refused rather than handed through. The
  filesystem root is never offered as a directory to grant, and is itself refused rather than asked
  about, since any answer for it is one for every path. Pre-authorising or
  denying is a standing answer, configured under the default gate's `default_settings:` (`deny:` entries
  may name a directory).

  What a call opens is what was asked about. A path is read once and only that string goes to node, so a
  `Buffer` or `URL` changed after an async call, a glob's patterns and `cwd`, and an options getter cannot
  change it; a path that is not valid UTF-8 is refused. A stream asks again when it opens, so assigning its
  `path` or `flags`, or calling `Utf8Stream.reopen`, is asked about, and the raw module is no longer reachable
  through it. A flag is asked about as what it does (`readFile(p, { flag: 'w' })` needs the write gate, `open(p,
  'r+')` needs both), a symlink changed while a question is open is asked about again, and a dangling one is
  asked about at the file a write through it would create. The module's property descriptors are guarded and
  it cannot be written through, and a stream's `constructor` is the guarded class.

  Node's own stream and watcher classes, reached by walking a prototype, and a file handle's own `chmod`, `chown`
  and `utimes`, refuse a body; host code still sees node's own. A body may use only the descriptors it opened
  through the gate, until it closes them, so trying numbers reaches none of the process's own files; `fchmod`,
  `fchown` and `futimes` ask `fs-access`, which a handle opened for reading no longer bypasses. A directory that
  holds a path under a standing denial cannot be renamed, and the error names the path and why.

  This stops a body that over-reaches by using the module. It does not stop code written to defeat it by
  rewriting a built-in the gate or the policy reads, and a recursive copy or delete of a granted directory acts
  on what is denied inside it. See its README, and `docs/SECURITY.md` for those limits and a default setup.
- **`background-jobs-node`** — its host is the matbot CLI, which it starts again for each job, and it now
  says so: it extends the config the CLI publishes as `MATBOT_CONFIG` rather than reading one off the
  machine. Under any other host it disables itself, as before; `background-jobs` runs jobs in-process
  anywhere.
- **`docker-bash`** — mounts the host's `projectDir` read-only and its `dataDir` read-write, instead of the
  working directory and `.data` inside it. A data directory inside the project keeps its place in the
  container, so under the CLI scripts see `/app/.data/bash-cwd` as before, and an existing container is
  kept; one outside it is mounted at `/data`.
- **`browser`** / **web bundle** — the `plugin` tool and the list of plugins a user added are the web
  bundle's, as the CLI's are, rather than the `browser` plugin's. The plugins a user added load after the
  configured ones instead of inside the `browser` plugin's own load, and removing the `browser` plugin no
  longer removes the `plugin` tool. The list is read from where it was kept, so nothing is re-added. The
  plugin now only makes its backend nameable, and is bundled rather than loaded at start-up.
- **`workspace`** — its package description no longer tells the model files are served at
  `/workspace/<path>`, a route the web frontend replaced with `/files/…` and which answers 404; it
  points at the serving frontend's `url_for_resource` instead.

- **`tool-types`** — the tools a host and `assembleMachine` register themselves (`plugin`, `provider`,
  `gate_action`, `about_matbot`, `single_turn`) are typed in an installed matbot. The scan found them only
  through a source checkout's `plugins/` tree, or, for core's, through whichever loaded plugin happened to
  import core; otherwise a generator was shown no contract for them. Core is now a scan root, as plugin-api
  was.
- **`function-tools`** — on node a defined function's, and a package export's, `inputSchema` comes from the
  checker's resolved parameter types instead of from the parameter text, so a named or imported type, an
  alias or `Omit<…>` reaches the provider and `json-validation` as its real shape rather than as `{}`. It is
  stored with the definition; one defined with `noTypeCheck`, in the browser, or before 0.5.0 keeps the
  text-derived schema. A package export whose parameter only an alias showed to be a non-object is now
  refused, as a visibly non-object one already was.
- **`tool-types`** — implements `parametersOf`.
- **`function-tools`** — a `tool_function` call the caller must fix (a definition that does not parse,
  type-check or fit a tool's shape, a name it cannot use, an unknown action) is reported with code 422,
  as a validator's refusal is, so `POST /tools/tool_function` answers 422 instead of 500. A body that
  throws while running, a store failure, or no type-checker being available stays a server error.
- **`json-validation`** — names an undeclared key in a refused call `unexpected property`, as
  `ts-validation` does, so with both loaded a wrongly-named parameter (`command` for `bash`'s `script`) is
  reported once instead of twice, each time with its own copy of the value.
- **`http`** — the contract's `method` is the schema's seven verbs rather than `string`. Validation runs at
  the executor since 0.5.0, so a composition's `tool.http({ method: 'PROPFIND' })` (or `'get'`) passed the
  type-check and was then refused; it is now a type error at definition.

- **Storage: two in-place migrations of very old data are removed** (see *Upgrading to 0.5.0* in the
  README):
  - `storage-sqlite` no longer renames a table named under the pre-0.4.4 scheme (`a-b` stored as
    `a_b_store`). Start a pre-0.4.4 database once with matbot >=0.4.4 <0.5.0 before upgrading; opened by
    0.5.0, an affected namespace looks empty and the old table is left in the file.
  - `storage-filesystem` and `storage-profiles` no longer read an unnamed file's sidecar written before 0.2.4 (an `id`
    field and no `dataFile`). No version rewrites these; add `"dataFile": "<id>.data"` to keep one.
- **`tool-background` is removed** (`@matatbread/matbot-tool-background`: `background`, `every_action`),
  superseded by `background-jobs` / `background-jobs-node` since 0.4.18. An installation still listing it
  under `plugins:` fails to load it. Its schedules, in the `schedules` store, are not run by anything.
- **`background-jobs`** — `background_job_action` no longer lists or cancels the old plugin's schedules
  (the `"legacy": true` rows, and `cancel`'s `legacy` field). A warning at startup still counts any that
  are left; re-create each with `background_job` and delete the old row. To list and cancel them with a
  tool, run 0.4.x once.
- **`background-jobs` / `background-jobs-node`** — `background_job_action list` shows what is running in this
  process: a stored job carries `inFlight`, and a run-now job, which has no row, is listed while it runs, to the
  principal who started it. `background_job` returns a run-now job's `id`, and `cancel` stops one. `cancel` of an
  id the caller cannot see reports "not found" rather than `cancelled: true`, and stops a run only once the store
  has accepted deleting its row.
- **CLI** — a duplicated `core` or `plugin-api` is warned about once, after plugins load, rather than on
  the version banner as well; `plugin list` reports copies reachable from the CLI's own dependencies too.
  At boot a plugin that failed to load is probed as well, so a copy it nests is named beside its failure.
  A package's `exports` is read as Node reads it for `import` — conditions in the order the package lists
  them — in all three places the CLI reads one, which had each used a different order.
- **CLI `plugin` tool** (formerly `tool-plugin`) — a `github:owner/repo#path:sub` specifier (pnpm's git-subdirectory fragment) is
  refused; write `github:owner/repo/sub` (with `#ref` after it, if any), which fetches the same files. It
  never worked as an install, and since 0.4.5 it was folded into the path with a warning. Refused when the
  plugin is fetched, so a configured one is a recorded load failure naming the rewrite, not a boot that
  stops. `Classified`'s `http` arm loses `url` and `advice`; `githubToHttps` is exported instead.
- **The CLI no longer installs `provenance`.** It was a runtime dependency of `@matatbread/matbot-cli`
  only because a CLI test imports it, so an npm install of the CLI carried it while every other plugin
  needed `plugin add`. An installation whose `plugins:` names `@matatbread/matbot-provenance` adds it
  (`plugin add @matatbread/matbot-provenance`); a source checkout is unaffected.
- **`matbot install` adds a plugin whose name is a prefix of one already configured.** It took
  `- ./plugins/foo` as present when `- ./plugins/foobar` was listed, and wrote nothing — the fix `plugin
  add` already had; the two now share one writer. `matbot --help` lists the `install` subcommand.
- **The `plugin` tool reads `matbot.yaml`'s plugin list as boot does.** It used regexes over the text, so
  a comment line inside `plugins:` ended the list: `list` and `discover_local` missed every entry below
  it, and `remove` could release cached files a later remote entry still used. A quoted entry was not
  recognised, so `add` listed it twice, and an entry with a trailing comment could not be removed. Edits
  still splice the text, keeping comments, and are checked by parsing the result. A key with nothing
  beneath it (`plugins:` followed by `providers:`) now reads as empty rather than failing boot.
- **`provider-store-test`** is no longer published. It is a test/reference plugin nothing depends on; it
  stays in the repository, typechecked with the rest. The versions already on npm are left there.
- **`frontend-dom` is removed** (`@matatbread/matbot-frontend-dom`), and with it the `matbot-demo.html`
  web bundle it was the frontend of (`matbot.web-demo.json`, `assemble:demo`). In the browser, use
  `frontend-web`'s browser entry, which `matbot.html` already loads. The versions already on npm are left
  there.
- **`@matatbread/matbot-files-node` is no longer published.** Its one export, `FilesystemFileStore`, moved
  into `storage-filesystem`, its only user, and is exported from `@matatbread/matbot-storage-filesystem`.
  Import it from there. The versions already on npm are left there.
- **`triggers`** — a provider profile named `skills-classifier` is no longer used as the classifier by
  name; the classifier uses the `classifierProvider` setting, else the turn's provider. An install that
  has such a profile and no pin is warned at startup, with the one line that keeps it:
  `default_settings: { '@matatbread/matbot-triggers': { classifierProvider: skills-classifier } }`.
- **`triggers`** — a stored condition of kind `augment` (what `ephemeral` was called) is migrated to
  `ephemeral` when it is read, with a warning. Unmigrated, it was judged on no surface, so its trigger
  never fired and nothing said so. A write-back that fails or is refused (a trigger shared in read-only) still
  reads as `ephemeral`, and costs no other trigger.
- **`cognition`** — a trigger seeded before 0.2.4 that loads the retired "Remember this" skill is no
  longer repointed at `remember_fact`. Startup names any that are left; delete them with `trigger_action`.
  Nor is the Inner Voice trigger's cool-down backfilled onto one seeded before 0.3.8; set it with
  `trigger_action` if that trigger fires repeatedly.
- **`function-tools`** exports its source scanner as `@matatbread/matbot-function-tools/scan`
  (`inertEnd`, `withoutComments`, `matchParen`, `matchBrace`). A `'` or `"` that reaches the end of its
  line is no longer read as a string, so an apostrophe in a definition outside a comment cannot swallow
  the rest of it.
- **`tool-store`: a model creates stores of its own and cannot open anyone else's.** `expose` is removed:
  it gave a model read and write over any namespace, `settings` included. `create` keeps its documents in
  a namespace of tool-store's own (`store-<name>`), so a model can no longer claim a store a plugin will
  use once it is installed. A plugin that wants its own store exposed calls `defineStore`, as cognition
  does. The generated tool is still `<name>_action`. `store_action`'s `namespace` parameter is now
  `name`. A name whose tool another plugin provides is refused rather than replaced, and `remove`
  removes a tool only when it removes a definition. One
  whose namespace the host now refuses (`settings`) is skipped at boot, with a warning, rather than
  failing the plugin. A name is at most 57 characters, so its tool name fits a provider's 64. A store a
  plugin exposes is that plugin's alone: its definition records the `owner`, tool-store's boot leaves it
  for the owner to register (registering it first made the owner's own setup a tool collision, warned
  about at every boot, and kept the store exposed with its owner unloaded), and `store_action remove`
  refuses it while the owner holds the tool. A definition from before 0.5.0, which nothing marked as a
  store `create` made or an `expose` over a plugin's namespace, is handed to that plugin if it defines the
  store (cognition's `remembered_facts`); otherwise, on the tool's first use, its documents are copied into
  `store-<name>` and the store keeps them there — so a model's store keeps its contents, and an old
  exposure stops reaching the live namespace. The originals stay where they were; removing such a store
  before it is first used says that its documents are orphaned. Whether to move is decided per call, per
  principal: each principal's def moves with that principal's documents, a failed move is tried again by the
  next call, and a def another process has moved or handed to its owner is honoured without a restart. `defineStore`
  takes over any def of its name that has no owner, including one already moved and one a model created, whose
  documents stay in `store-<name>`.
- **`tool-store`** depends on `function-tools` for that scanner, as a package — installing `tool-store`
  installs it; nothing loads it as a plugin. A `/` in a shape that opens a regex literal is now skipped
  like a string.

---

Earlier releases: [v0.4 CHANGELOG](docs/CHANGELOG-v0.4.md).

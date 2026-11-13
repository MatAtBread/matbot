# Changelog

All notable functional changes are documented here. Purely stylistic or
non-functional changes (CSS, refactoring, code tidying, docs-only merges) are
omitted.

Within each section, changes are grouped: **Breaking changes**, **API gaps
filled**, and **Bug fixes** cover `core` (the contract consumers depend on);
**Optional** covers new or updated plugins, frontends, and apps — more likely to
churn and less likely to affect a consumer who doesn't use them.

## 0.5.0

Matbot v0.5.0 is a significant release that removes old, deprecated features and introduces some new ones.
Upgrade the CLI and every plugin together: a 0.4.x plugin will not install beside 0.5.0
([why](#plugin-api-0-5)).

**New**

- [Provider aliases](#provider-aliases): a provider name that stays stable even if the model or
  provider behind it changes.
- [Tool-generated user prompts](#robo-submit) that can continue a session in your absence. A background
  job or a tool can post a message that the conversation answers. After three in a row with no message
  from a person, matbot asks before going on.
- [`single_turn` with tools](#single-turn-tools): hand a full agent turn, or several at once, to a
  sub-turn and get back what each one said.
- [Permissions for this session](#permission-lifetimes): a prompt can be answered for this time, for this
  session or always. [The most specific standing answer wins](#most-specific-wins), so a narrow allow
  can sit inside a broad denial and the reverse.
- [`gate-fs-node`](#gate-fs-node): each path a `tool_function` body reads or writes is put to the
  permission gate.
- [`session-data`](#session-data): keep a tool's output in a conversation and pass it to a later tool
  without the model reading it.
- [Failure classes](#failure-class): a failure says whether trying again could help (`unavailable`,
  `denied` or `invalid`).
- [Embedding](#repository-layout): core no longer assumes the CLI's config file or layout, and
  [`host-node`](#host-node) holds what a Node application needs to stand up a machine of its own.
- [Unread tracking](#sessions-read-tracking) for sessions, kept on the server.

**Removed or changed**

- Packages no longer published: [`tool-background`](#tool-background-removed) (use `background-jobs`),
  [`frontend-dom`](#frontend-dom-removed), [`skills-node`](#skills-node-removed) and
  [`files-node`](#files-node-removed). [`default-gate`](#default-gate-moved) moved into core and
  [`tool-plugin`](#tool-plugin-moved) into the CLI.
- The [`ToolCallValidator` service](#toolcallvalidator-removed) is replaced by `validate` hooks, and
  [`permit_imports`](#permit-imports-removed) by standing denials in the permission gate.
- A plugin must [declare `matbotRuntime`](#matbotruntime-required) in its `package.json`.
- [`configPath` is gone](#configpath-removed); a plugin reads `projectDir` or `dataDir` instead.
- The default gate's [standing answers are scoped](#scoped-answers), and `default_settings:` must use
  the new shape.
- No plugin can open the [`settings` store](#settings-store-closed), and `tool-store`'s
  [`expose` is removed](#tool-store-expose).
- [Migrations of very old stored data](#old-migrations-removed) are removed. A database from before 0.4.4
  must be opened once by 0.4.x first.

**Fixed**

- A failure in detached work no longer ends the process: neither [a store failure in the turn
  pump](#pump-failures) (#115) nor [one a function body leaves behind](#body-failures-contained).

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

- <a id="plugin-api-0-5"></a>**`PLUGIN_API_VERSION` is `0.5`, and every published package is 0.5.0.** plugin-api removes exports
  (`importPermitted`, `configPath`) and changes signatures (`PermissionGate.decide`/`snapshot`,
  `ToolTypeIndex.check`, `bindGate`), so a 0.4.x plugin that uses one of those fails: at link time for a
  removed export, at its first call for a changed signature. One that uses none of them still loads, since
  the loader refuses only a different major. npm will not install a 0.4.x plugin beside 0.5.0 anyway: each
  plugin peer-depends on `plugin-api` with a caret range, and on 0.x `^0.4.x` excludes 0.5.0 (`ERESOLVE`).
  Plugins with no change of their own are republished at 0.5.0 for that reason; upgrade them together
  with the CLI.
- <a id="permit-imports-removed"></a>**`FunctionRunSettings.permittedImports` and `importPermitted` are removed from `plugin-api`.** What a
  `tool_function` body may import is the permission gate's alone: a module refused outright is a standing
  denial (`deny:tool_function.import`, e.g. `{ '*': ['* node:child_process'] }` for every function), not a list the
  runner carries in front of the gate. `FunctionRunSettings` declares nothing now; a runner's own fields
  (the node runner's time bound) ride on it as before. A runner that set `permittedImports` should drop
  it — nothing reads it.
- <a id="settings-store-closed"></a>**A plugin cannot open the `settings` store, and removes only what it registered.** `settings` holds every
  plugin's settings, the default gate's standing answers among them, so a plugin able to open it could
  grant itself anything, and tool-store's `expose` let a model do exactly that. A plugin reaches its own
  through `services.settings()`; `createStore('settings')` on its machine now throws, in any case, and a
  store name on a plugin's machine is letters, digits, `_` and `-` (the filesystem backend joins it into a
  path, where `x/../settings` was the same directory). `services.tools.remove` on a plugin's machine leaves
  another plugin's or the host's tool in place, with a warning: removing it and registering into the gap
  replaced it without the `tools.overwrite` collision ever being decided. `tools`, `hooks` and
  `systemContext.removeByPlugin` likewise act only on the calling plugin's own name.
- <a id="toolcallvalidator-removed"></a>**The `ToolCallValidator` service is removed**, as announced in 0.4.21. Register a `validate` hook
  instead: several co-exist and every one is asked, where the service key held one validator and a second
  had to capture and delegate to the first. A plugin still registering the key is no longer consulted.
- **`turnActivity` / `usageEntries` / `usageByProvider` no longer read the pre-0.4.3 usage shapes** — an
  assistant message's own `usage`, and a `tool-result`'s `usage` array. Sessions written before 0.4.3
  report no usage for those turns.
- <a id="matbotruntime-required"></a>**`matbotRuntime` is required: it is what makes a package a plugin.** The loader refuses a package whose
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
- <a id="default-gate-moved"></a>**The default permission policy is core's, and `@matatbread/matbot-default-gate` is no longer
  published.** `defaultGate`, `createDefaultGate`, `makeGateActionTool`, `createGateTools`, `denyKey`,
  `toStandingAnswer` and `DEFAULT_GATE_SETTINGS_NS` are exported from `@matatbread/matbot-core`; import them
  from there. Behaviour is unchanged, and so is the settings namespace, `@matatbread/matbot-default-gate`:
  stored answers and `default_settings:` keyed by it keep working.
- <a id="tool-plugin-moved"></a>**`@matatbread/matbot-tool-plugin` is no longer published; its code is the CLI's** (`apps/cli/src/plugins`).
  Both halves were CLI conventions rather than something another host could reuse: the `plugin` and
  `provider` tools edit `matbot.yaml`, and acquisition fetches into `.plugins/` and installs with npm beside
  it. Nothing changes for a CLI user. An application that imported it builds its own against its own
  persistence, as the browser's tools do.
- **core no longer parses `matbot.yaml`.** `parseConfig`, `parseYaml` and `MatbotConfig` are the CLI's
  (`apps/cli/src/config-parse.ts`, `yaml.ts`): a config file is how the CLI chooses to be configured, and
  core takes what a host hands `assembleMachine` rather than reading a format of its own. A host that
  parsed `matbot.yaml` with them parses its own configuration; `installSettingsDefaults` stays in core,
  taking a map.
- <a id="configpath-removed"></a>**`configPath` is gone from `MatbotMachine` and `ToolContext`; a host supplies `projectDir` and `dataDir`
  instead.** A plugin was handed the path of the CLI's config file and derived what it actually needed from
  it — `.data` beside it for storage, its directory for where packages are installed — so it worked only
  under the CLI's layout. `projectDir` is where the host resolves packages and relative plugin specifiers
  from (`tool-types`, `function-runner-node`, `skills_compiler`); `dataDir` is where plugins keep state on
  disk (the storage plugins, `docker-bash`). Both are optional, and a plugin degrades without one as it did
  without a config path. The CLI sets them to the config file's directory and `.data` beside it, so nothing
  changes for a CLI user; `nodePluginMembers` reports its base directory as `projectDir`. A plugin that read
  `configPath` reads whichever of the two it meant.
- <a id="skills-node-removed"></a>**`@matatbread/matbot-skills-node` is no longer published.** Its `.md` import and directory watch added
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
- <a id="scoped-answers"></a>**The default gate's standing answers are scoped, and the format before 0.5.0 is not read.** A gate's
  value is a map from scope to answer — `{ '*': [bash, plugin] }`, `'*'` being everywhere, a session's id
  that session, `#http` the HTTP tool door — and `default_settings:` must use it. A stored answer in the old
  shape (a bare list or `true`) is migrated once, from the stored document alone so no configured default
  is copied into it; one in `default_settings:` is ignored, with a warning naming the key.
- <a id="most-specific-wins"></a>**The most specific standing answer wins, not every denial.** Ranked by how near the act it lies (an
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

- **`SessionRunner.open` returns a `SubmittedView` for a submission, with no `session`** (and a required
  `traceId`); observing a session still returns a `SessionView`, which no longer has `traceId`. The session
  was read back after the submission had been queued, for a field no submitter read: a failed read made
  `open()` throw while the submission ran anyway, so a caller that sent it again ran it twice, and every
  submission paid a store round trip before its turn could start. Now `open()` awaits nothing after
  queueing, so if it throws, nothing was queued. A submission to a session that does not exist no longer
  throws: it is an `error` on the submission's `events`, with `failure: 'invalid'`.
- <a id="robo-submit"></a>**An appended user message is a robo-submit, and runs a turn.** `SessionAppender.append` with a
  `role: 'user'` message no longer just writes it. The message is submitted to the session as a turn,
  which answers it beside any running turn (`parallel`), as the caller (a job's creator) and on the
  session's own model. It is persisted when its turn starts, so the result's `messageIds` is empty and
  `traceId` names the turn. A user message must be the only message in its append, and needs a principal
  in scope. A user message nothing answered had no use: providers fold it into whatever the person types
  next. Nothing in matbot appended one before this. A downstream caller that did now starts a turn, so
  check for `role: 'user'` appends.

- **`services.providers` holds provider aliases beside profiles.** Its values are `ProviderEntry`
  (`ProviderConfig | ProviderAlias`), so code reading `module`, `model` or another profile field off an
  entry narrows first (`isProviderAlias`), or asks `providers.resolve(name)` for the profile a name runs on.
  `has`, `get` and the keys answer for an alias as for a profile, so code that only checks or passes a name
  is unchanged. `register` throws for an alias whose target is not a profile, and `remove` for a profile an
  alias points at.

  **A plugin that implements the `provider` tool, or a `ProviderAdmin` for the browser one** (as
  `storage-google-drive` does), has to change, for the reasons above:
  - It narrows before reading a profile's fields off an entry, in `list`, `get` and `update`.
    `providerRows(services.providers, summarise)` builds `list`'s rows with aliases included, and the
    `summarise` callback is the per-profile mapping such a plugin already has.
  - `remove` lets the registry's error through as the tool's error, since the registry now refuses to
    remove a profile that an alias points at.
  - If it replays profiles from storage, it registers profiles before aliases, because an alias needs its
    target in place.

  `ProviderAdmin.alias` is optional, so an admin that stores no aliases compiles without it, and the
  tool's `alias` action reports that the runtime cannot store them.

### API gaps filled

- **A tool's marker records the calls that produced it (`Marker.by`, `CallFrame`).** The host stamps each
  marker a tool yields with the chain of calls it came through, outermost first: the runner's call (`tool`,
  the registering `plugin`, `callId`), each nested call a `makeToolBox` made, and a sub-turn's own calls
  when `single_turn` hands its markers back. A tool cannot supply the frames, so a reader can tell who wrote
  a record (`plugin`) without trusting the record. `/host` exports `callFrame`, `callFramesOf` and
  `withCallFrames` for a host relaying markers.

- **`SessionTypes`, a sixth open registry, and `Tool.sessionType`.** A tool whose contract depends on what a
  session holds declares it once, naming its own key of `SessionTypes`; for a type-check made on a session's
  behalf, `sessionType(session)` answers that key, and the checker adds it under the tool's name. A check
  made for no session (a global function) sees it empty. `session_data` uses it to type a read by the
  entry's id.

- <a id="single-turn-tools"></a>**`single_turn` runs a turn with tools, and several turns at once.** `tools: true` makes it a full agent
  turn within the calling session: it has the session's id, principal, tools and gate answers, sees none of
  its conversation, does not add its working to it, and returns its text with the tool calls it made. `turns: [...]`
  runs several, with tools or without, at the same time, and returns their results in order; one failing
  does not stop the others (`ok: false` beside the rest). A turn may still append to a conversation, as any
  turn can (an append naming no session goes to the calling one). At most 4 of a call's turns run at once, and turns
  with tools nest at most 2 deep. `context` briefs a turn, and `transcript: true` adds a tool turn's
  `messages`. A field beside `turns` (`tools: true`, a shared `context`) applies to every turn. A turn with
  tools has its spend recorded on the calling turn. The one-turn form is unchanged, and its result gains
  `ok`. What a turn's tools record in markers (data kept with `session_data`, a session function defined)
  comes back as `single_turn`'s own markers, so it is kept in the calling session; core's record of the
  turn itself (its depth, a truncation, a retraction, a hook that threw) is not, and a turn that failed
  brings nothing back.
- **`subTurnDepth`** and **`SUB_TURN_CREATOR`** — how many turns below a conversation a session's messages
  are, for a hook that has nothing to judge in a turn another turn started.
- **`ToolContract<Result, Args, Call>`** — an optional third argument, the exact call signature `ToolProxy`
  declares, for a result shaped by the call's own params. Existing contracts are unaffected.
- **`drainEphemeralTurn`** and **`runEphemeralTurn`'s `initialMessages`** — run an ephemeral turn to its end
  and be told whether it failed, which a transcript alone cannot say; and start it from something other
  than nothing.
- **A model can name an attachment.** Each one on the outgoing copy now has `[Attachment "name", id …]`
  beside it, and `single_turn`'s `attach` takes that id. An image used to reach a model with no name or id,
  so nothing could refer to it.
- **`InvokeToolOptions.appender`** — a composed call on an ephemeral run now reports where the run reports.
  It reached the machine's appender instead. `function-tools` forwards it.

- **`ToolCheckOptions.importRefused`** — whether the gate refuses the code being checked an import
  outright. Whoever owns the import gate supplies it (`function-tools`, from one gate snapshot per check),
  and a `ToolTypeIndex` declares no types for a refused module and reports a literal `import(…)` of one as
  `IMPORT-GATE`. "Nobody decided" is not a refusal — that is asked at the call — so it is typed.

- <a id="host-node"></a>**`@matatbread/matbot-host-node`** (new) — what a Node application needs to embed matbot that core
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
- <a id="permission-lifetimes"></a>**Permission lifetimes: an answer for this session.** The default gate asks allow or deny, *this time*,
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
- **`makeToolBox` returns `inFlight()` and `stopInFlight(reason?)`**: the number of calls it has started
  that have not settled, and a way to abort those calls and nothing started afterwards. The box stays
  usable, so work its caller scheduled for later still runs. Each call's promise is marked handled as it
  is made, so a call the caller never awaits no longer becomes an unhandled rejection (which ends a Node
  process) when it fails; a caller that awaits still sees the error.

- **`ROBO_SUBMIT`, `isRoboSubmit(message)` and `isRequest(message)`.** A robo-submit's message carries
  `metadata[ROBO_SUBMIT]`. `isRequest` is true for a person's message or a robo-submit, and false for a
  `followup` resubmit, which continues the turn before it. It replaces "not wholly `origin: 'robo'`" as the
  test for a new request, leaving `origin` to presentation.
- **`SubmitOpenOpts.metadata`** stamps the user message a submission persists as. It is in-process only:
  no frontend passes a client's metadata through.
- **`AppendResult.traceId`**: the robo-submit's turn.
- **`SessionPrompter`** (`services.SessionPrompter`, optional): where a turn no frontend submitted asks its
  questions. A robo-submit's turn uses it, so its permission prompts reach whoever views the session
  instead of falling to their non-interactive default.
- **The runner asks before a run of robo-submits continues.** Past `UNATTENDED_ROBO_SUBMITS` (3) in a row
  with no message from a person, the next robo-submit's turn asks first (`tools.robo-submit`, subject the
  session id). Nobody to ask means it stops. A refusal is reported as `cancelled`, and nothing of the
  submission is written. `trailingRoboSubmits(session)` counts the run.
- **A model is told who sent a robo-submit.** `origin` and metadata never reach the provider, so a model
  answered a job's question as if the person had asked it. On the outgoing copy only, a robo-submit
  starts with `[Sent by <from>, not by the person in this conversation.]` (`withSenderShown`). `<from>` is
  `AppendMessage.from`, set by whoever knows who is asking: background jobs set `background job "<name>"`
  and a `single_turn` sub-turn sets `a sub-turn run from this conversation`. Without it, the line says an
  automated process sent the message. It is never stored, and is the same text every round, so it costs
  no prompt cache.
- **`SessionRunner.status()` reports `prompting`**: a turn of the session has asked its submitter's
  `prompt` a question nobody has answered. The runner counts this across every submission's `prompt`, so
  it means the same whichever frontend draws the question. The return type is now named
  `SessionStatusReport`.

- <a id="failure-class"></a>**`FailureClass`: a failure says whether trying again could help.** matbot does not retry on a caller's
  behalf; it reports, and the caller decides, which needs more than a message. `failure?: 'unavailable' |
  'denied' | 'invalid'` (may work later / not allowed / the request is wrong) is a property on a thrown
  error and a field on both `error` events (a turn's and a tool's); absent means whoever failed did not say.
  `withFailure(e, class)` marks an error, `failureOf(e)` reads one, `failureForStatus(status)` maps an
  HTTP status and `FAILURE_STATUS` maps back. `ReadOnlyError` is `denied`, `MediaRejectedError` and
  input the executor's validator refuses are `invalid`. A tool's failure reaches the model beside its
  message (`{ error, failure }`), `single_turn`'s failures say it in their text, and a turn's `error` event
  carries it from whichever layer raised it — a store, a provider adapter, a tool.
- **`responseError(label, res)`** (`@matatbread/matbot-core/providers-base`) is the error for an endpoint's
  non-ok answer: its status and body in the message, its class from the status.
- **A turn's `error`, and a tool's thrown error, include the error's `cause`** (`TypeError: fetch failed
  (SocketError: other side closed)`), which is usually the half that says what happened.

- <a id="provider-aliases"></a>**Provider aliases.** A provider entry may be `alias: <profile>` and nothing else: a stable name for a
  role (`text_classifier`) that code, pinned settings and stored functions can name, and that keeps
  working when the profile behind it changes. What is kept is the name chosen: a message's `providerName`
  and a pinned setting record the alias, and it is resolved only where a provider is called, in
  `complete()` and at the start of a turn. A usage entry records the profile that ran, since an alias
  moves and the rates are the model's. One hop: an alias points at a profile, never at another alias. The
  `provider` tool's `alias` action creates or repoints one (gated, `provider.alias`); `remove` takes either;
  `add` and `update` refuse an alias's name, and an alias carrying settings of its own is refused however
  it is written; `list` reports an alias as its profile's row under its own name, with `alias` naming the
  profile, so every row has every field (the web UI's picker skips them). An alias left without its target (by a plugin's unload) is refused at
  the call, naming the target (`invalid`). plugin-api exports `isProviderAlias`, `aliasProblem`,
  `removalProblem`, `aliasesOf`, `describeProvider`, `describeProviders` and `providerRows`; `single_turn`'s
  unknown-provider error lists aliases as `alias → profile`.
- **A thinking block carries `meta?: ProviderMeta`**, on the stored `thinking` content and the
  `thinking-block` event, as a tool call already did, for an adapter's round-trip state about the block.

### Bug fixes

- **A marker a tool yields when called from a composed body is kept.** The `tool` proxy that
  `function-tools` bodies and compiled skills call through (`makeToolBox`) kept a callee's result and
  dropped its markers, so a tool that recorded something reported success and the record was gone. A
  session function defined from a body (`tool.tool_function({ action: 'define', scope: 'session', … })`)
  said "Defined" and did not exist the next round. A box now passes a callee's markers to its `onEvent`,
  which `function-tools` yields as its own, so the runner stores them as it would from a direct call. A
  box with no `onEvent` (a compiled skill's) still has nowhere to put them.

- **A secret stored in the `.env` vault comes back as it was written.** The writer and the reader of the
  file lived in different packages and disagreed: a value was written bare and read with comment and quote
  rules, so `abc #1` came back as `abc`, `"x"` as `x` and ` padded ` as `padded` after a restart.
  `EnvFileVault` now reads its own file (`EnvFileVault.open`), quotes a value the reader would otherwise
  reinterpret, and refuses one containing a line break rather than writing it broken.

- <a id="pump-failures"></a>**A store failure in the turn pump no longer exits the process (#115).** The pump runs detached, and a
  failed store read or write at a turn's start, a failure resolving its provider or its tool types, a
  failed usage flush, or a failed write of a settled parallel reply rejected its promise with nothing
  awaiting it — an unhandled rejection, which ends a Node process and every turn in it. The turn just
  taken off the queue also vanished, with no terminal event. Each is now reported where it belongs: the
  turn's own `error` (with the store's `failure`, if it gave one) after which the next turn runs, an
  `error` against the parallel reply that could not be saved (saying, when it made tool calls, that sending
  it again would make them again), a log line for the usage. None is retried. Every start of a pump also
  goes through one place that logs whatever else might reach it.
- **A parallel turn stopped before it started is recorded**, with a note where its reply would have been,
  as it was when the stop landed a moment later. A stop arriving while it read its session dropped the
  submission without trace.

### Optional

- <a id="session-data"></a>**`session-data`** (new) — `session_data` keeps a JSON value in a conversation and reads it back by a
  short id: a tool's output written from a `tool_function` body (`write { description, data }`) and handed
  to another tool turns later (`read { id }`), without the model reading it. Entries are markers, so they
  are private to the session, shared when it is, carried by fork and compaction, and never sent to a model;
  `list` and `drop` manage them. An entry is written once, holds at most 65536 bytes of JSON, and is
  readable within the call that wrote it. Code checked on a conversation's behalf (an `execute` body, a
  session function) reading an entry by its literal id gets the type inferred from what the entry holds, so
  its rows pass to a typed tool unnarrowed; a global function may call it too, reads `unknown`, and fails at
  the read in a conversation that does not hold the id. Node and browser.
- **`function-tools`** — a check made on a conversation's behalf (`execute`, a session `define`, its
  re-`check`, `types`) adds what each tool's `sessionType` says that conversation holds; a global function's
  check does not.

- **`frontend-web`** — a permission prompt reads as a phrase: what, and for how long, as dropdowns, then
  Allow and Deny as the buttons that answer (an axis marked `submit`). `POST /tools/:name` runs its tool in the fixed session `#http`, which an
  installation configures that door's unattended answers against.
- **`function-tools`** — the tool calls a body leaves running stop when it settles (#114). They were handed
  the calling turn's signal, so a `Promise.race` loser, a sibling of a rejected call in `Promise.all`, or a
  call left running by an early return, a throw or the runner's time bound ran on until the turn ended —
  with `single_turn`'s `tools: true`, as a whole agent turn. Each invocation now has its own signal inside
  the turn's (also `context.signal`), aborted as the body settles or its caller stops reading; a warning
  names the function when that stops calls still running. A call the body starts after it has returned
  (from a timer it set) runs, as it would in any JavaScript. A body whose caller stops reading before it
  settles has been abandoned, and every call it starts from then on is refused. Work meant to outlive the
  call is a `background_job`.
- <a id="body-failures-contained"></a>**`function-runner-node`** — a failure a function body leaves unhandled no longer ends the process. This
  covers a throw in a timer it scheduled, a rejection nothing awaits, and a tool call refused because its
  caller abandoned the body. Each is logged as contained. Node reports these in the async context they
  came from, so they are recognised by the body's span, including a rejection with no stack. Any other
  unhandled failure ends the process exactly as before.
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
  answers, not one per module. The service is an object: `wrapModule(specifier, wrap)` registers per specifier,
  applied in order at `import`. A wrapper may be
  async, and a specifier with no wrapper is handed through raw. The registry is the process's, so a
  reloaded runner keeps the wrappers registered with the one it replaced. A guardrail against an
  over-reaching body, not a sandbox: a granted package still gets the raw module, and bounding the process
  is the deployment's (`docs/SECURITY.md`). Its optional `hideFromBody(owner, key, standIn)` makes a property a
  body would reach by walking a prototype read as a stand-in to the body and as itself to host code, by the
  same caller rule that refuses a body the function constructors. It is the runner's because only a runner knows
  what code is a body's, so a wrapper reaches it through the service rather than by importing a runner.
- <a id="gate-fs-node"></a>**`gate-fs-node`** (new, node) — puts each path a body's `node:fs`/`node:fs/promises` names to the
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
  and `utimes`, refuse a body, under a runner whose `ImportedModuleWrapper` offers `hideFromBody` (the node runner
  does); host code still sees node's own. A body may use only the descriptors it opened
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

- <a id="old-migrations-removed"></a>**Storage: two in-place migrations of very old data are removed** (see *Upgrading to 0.5.0* in the
  README):
  - `storage-sqlite` no longer renames a table named under the pre-0.4.4 scheme (`a-b` stored as
    `a_b_store`). Start a pre-0.4.4 database once with matbot >=0.4.4 <0.5.0 before upgrading; opened by
    0.5.0, an affected namespace looks empty and the old table is left in the file.
  - `storage-filesystem` and `storage-profiles` no longer read an unnamed file's sidecar written before 0.2.4 (an `id`
    field and no `dataFile`). No version rewrites these; add `"dataFile": "<id>.data"` to keep one.
- <a id="tool-background-removed"></a>**`tool-background` is removed** (`@matatbread/matbot-tool-background`: `background`, `every_action`),
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
- <a id="frontend-dom-removed"></a>**`frontend-dom` is removed** (`@matatbread/matbot-frontend-dom`), and with it the `matbot-demo.html`
  web bundle it was the frontend of (`matbot.web-demo.json`, `assemble:demo`). In the browser, use
  `frontend-web`'s browser entry, which `matbot.html` already loads. The versions already on npm are left
  there.
- <a id="files-node-removed"></a>**`@matatbread/matbot-files-node` is no longer published.** Its one export, `FilesystemFileStore`, moved
  into `storage-filesystem`, its only user, and is exported from `@matatbread/matbot-storage-filesystem`.
  Import it from there. The versions already on npm are left there.
- **`triggers`** — a turn another turn started (`single_turn` with `tools: true`) is not judged on either
  surface. Its prompt is another model's and its answer goes back to that model, whose own reply is judged;
  judging it cost two classifier calls per sub-turn, most of what one spent.
- **`triggers`** — a provider profile named `skills-classifier` is no longer used as the classifier by
  name; the classifier uses the `classifierProvider` setting, else the turn's provider. An install that
  has such a profile and no pin is warned at startup, with the one line that keeps it:
  `default_settings: { '@matatbread/matbot-triggers': { classifierProvider: skills-classifier } }`.
- **`triggers`** — a stored condition of kind `augment` (what `ephemeral` was called) is migrated to
  `ephemeral` when it is read, with a warning. Unmigrated, it was judged on no surface, so its trigger
  never fired and nothing said so. A write-back that fails or is refused (a trigger shared in read-only) still
  reads as `ephemeral`, and costs no other trigger.
- **`triggers`** — the classifier lists only the conditions that match, each with its evidence
  (`{ "matched": [{ "id", "why" }] }`), and its conditions are in the system prompt rather than after the
  exchange. A verdict per condition cost output in proportion to the trigger set (~6,500 tokens and two
  minutes for 125 conditions), and with the exchange ahead of the conditions only the rubric was a stable
  prefix; now the conditions are a prefix any provider's prompt cache can reuse. A reply in the old
  per-condition shape counts only an explicit `{ "match": true }` or `true`. `TriggerManager.evaluate` takes
  the session as its first argument. A reply is read for its LAST verdict: a classifier that
  second-guesses itself ("Wait, let me re-check…") and writes a corrected object was refused as non-JSON —
  one greedy brace match spanned both objects and the prose between — and that turn fired nothing.
- **`triggers`** — with `classifierGraceMs` set, the hold's timer is cleared when the verdict wins, so a
  turn no longer leaves one pending for the rest of the window.
- **`triggers`** gains the **`TriggerFilter`** service: a policy that withholds triggers from one
  conversation. Registered by the plugin that holds the policy and read by `triggers` at every evaluation,
  `admit(triggers, { session, surface })` answers with those that may be judged; a withheld trigger is never
  shown to the classifier, so it cannot fire. The answer is read as a subset of the offer, in stored order,
  and a filter that throws is skipped with every trigger judged. Absent, every trigger is judged, as before.
- **`cognition`** — a trigger seeded before 0.2.4 that loads the retired "Remember this" skill is no
  longer repointed at `remember_fact`. Startup names any that are left; delete them with `trigger_action`.
  Nor is the Inner Voice trigger's cool-down backfilled onto one seeded before 0.3.8; set it with
  `trigger_action` if that trigger fires repeatedly.
- **`function-tools`** exports its source scanner as `@matatbread/matbot-function-tools/scan`
  (`inertEnd`, `withoutComments`, `matchParen`, `matchBrace`). A `'` or `"` that reaches the end of its
  line is no longer read as a string, so an apostrophe in a definition outside a comment cannot swallow
  the rest of it.
- <a id="tool-store-expose"></a>**`tool-store`: a model creates stores of its own and cannot open anyone else's.** `expose` is removed:
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
- **Provider adapters classify their failures** (`anthropic`, `openai-compat`, `google`, `chatjimmy`,
  `webllm`), so an overloaded or rate-limited endpoint (`unavailable`) reads differently from a rejected key
  (`denied`) or a malformed or too-long request (`invalid`). An HTTP status is classified by
  `failureForStatus`; an error sent in the stream after a 200 by the endpoint's own word for it
  (Anthropic's error `type`, Gemini's `status`, a numeric `code` from an OpenAI-compatible host). The
  messages are unchanged. A network failure is left unclassified: a reset and a failed lookup look the
  same from the adapter.
- **`openai-compat`** — an error an endpoint sends mid-stream (OpenRouter does, after its 200) ends the call
  with that error. It was ignored, and the turn ended as an empty completion with the reason thrown away.
- **`storage-sqlite`** — a database another connection holds (`SQLITE_BUSY`, `SQLITE_LOCKED`) fails as
  `unavailable`, and a read-only one as `denied`.
- **`storage-google-drive`** — failures carry the class of Drive's status; a 403 that is a rate limit is
  `unavailable`, not `denied`.
- **`mcp-http`** — a tool call the MCP server answers with an HTTP error carries that status's class to
  the model.
- **`frontend-web`** — `POST /tools/:name` answers a classified failure with its status (503 for
  `unavailable`, so a client knows asking again later may work) and puts `failure` in the body; the submit
  route does the same for a submission `open()` refused.

- <a id="sessions-read-tracking"></a>**`sessions`** — read tracking. It adds `Session.readAt` by augmentation: how far a session has been
  read. It exports `isUnread(session)`, and `SessionIndicator` (`'prompting' | 'running' | 'unread'`) with
  `sessionIndicator(session, live)`. A session that has never been shown to a reader has no `readAt` and
  reads as read, so nothing lights up at once; tracking starts the first time a frontend marks it read.
  Core carries none of it, so an install without the plugin pays nothing for it.
- **`sessions`** — each `session_action` `list`/`query` row carries `state`, a `SessionIndicator`. `get`
  takes `markRead: true`, which records that the returned session has been shown to its reader. It marks
  only what it returned, so a mark that waits behind a running turn never marks that turn's reply as read.
  It never moves `readAt` backwards.
- **`sessions`** — `session_action append` takes `submit: true`, which posts `text` as a robo-submit (a
  request the conversation answers) rather than as a message from the caller. The result carries the
  turn's `traceId`.
- **`triggers`** — robo-submits are judged like a person's message. Every test for "a genuine user turn" is
  now `isRequest`, so `followup` resubmits are still skipped.
- **`background-jobs-node`** — a job may append a user message, a robo-submit, over its channel. Its blocks
  are still forced to `origin: 'robo'`, and anything but assistant or user text is refused. Both job
  plugins count a robo-submit as having reported, so its reply is not posted a second time.
- **`frontend-web`** — registers `SessionPrompter`. A robo-submit's questions park on its session as a
  submitter's do, and a busy tracker is armed for its turn.
- **`frontend-web`** — the sidebar's unread dot is now the server's, so it survives a reload, is the same
  on every device, and lights for messages appended to a session (a background job's report) as well as
  for a turn that ended. A session is marked read when it is on screen in a page that is visible. If the
  sessions plugin refuses `markRead` (one without read tracking), the session opens without it.

- **`provider-google`, `provider-openai-compat`** — a Gemini thought signature records the model that
  minted it (`meta.google.model`), and is replayed only to that model. A message's provider name no longer
  says which model that was, an alias keeping its name while its profile changes. History from before
  falls back to the old rule (the same profile name); the OpenAI-compatible gemini mode, which checked
  nothing, now drops a signature another model minted.
- **`storage-google-drive`, the browser `provider` tool** — aliases are persisted and replayed with
  profiles (profiles first; an alias whose target is gone is skipped with a warning), and the browser
  tool has the `alias` action. The web bundle skips a stored alias whose target this build dropped rather
  than failing to boot, and a bundle's `matbot.web.json` may declare aliases.
- **`frontend-telegram`** — with no provider saved, a chat starts on the first configured profile, never an
  alias.

---

Earlier releases: [v0.4 CHANGELOG](docs/CHANGELOG-v0.4.md).

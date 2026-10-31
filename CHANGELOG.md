# Changelog

All notable functional changes are documented here. Purely stylistic or
non-functional changes (CSS, refactoring, code tidying, docs-only merges) are
omitted.

Within each section, changes are grouped: **Breaking changes**, **API gaps
filled**, and **Bug fixes** cover `core` (the contract consumers depend on);
**Optional** covers new or updated plugins, frontends, and apps — more likely to
churn and less likely to affect a consumer who doesn't use them.

## 0.5.0

### Breaking changes

- **Every published package is 0.5.0, and npm will not install a 0.4.x plugin beside it.** This is
  packaging, not the plugin contract: `PLUGIN_API_VERSION` is still `0.4` and plugin-api's changes are
  additive, so a 0.4.x plugin loads. But each plugin peer-depends on `plugin-api` with a caret range, and
  on 0.x `^0.4.x` excludes 0.5.0, so npm refuses the install (`ERESOLVE`). Plugins with no change of their
  own are republished at 0.5.0 for that reason alone; upgrade them together with the CLI.
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
  one without importing it. core, plugin-api, the apps and the library package `tool-plugin` no longer
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

### API gaps filled

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

### Bug fixes

- **A secret stored in the `.env` vault comes back as it was written.** The writer and the reader of the
  file lived in different packages and disagreed: a value was written bare and read with comment and quote
  rules, so `abc #1` came back as `abc`, `"x"` as `x` and ` padded ` as `padded` after a restart.
  `EnvFileVault` now reads its own file (`EnvFileVault.open`), quotes a value the reader would otherwise
  reinterpret, and refuses one containing a line break rather than writing it broken.

### Optional

- **`background-jobs-node`** — its host is the matbot CLI, which it starts again for each job, and it now
  says so: it extends the config the CLI publishes as `MATBOT_CONFIG` rather than reading one off the
  machine. Under any other host it disables itself, as before; `background-jobs` runs jobs in-process
  anywhere.
- **`docker-bash`** — mounts the host's `projectDir` read-only and its `dataDir` read-write, instead of the
  working directory and `.data` inside it. A data directory inside the project keeps its place in the
  container, so under the CLI scripts see `/app/.data/bash-cwd` as before; one outside it is mounted at
  `/data`.
- **`browser`** / **web bundle** — the `plugin` tool and the list of plugins a user added are the web
  bundle's, as the CLI's are, rather than the `browser` plugin's. The plugins a user added load after the
  configured ones instead of inside the `browser` plugin's own load, and removing the `browser` plugin no
  longer removes the `plugin` tool. The list is read from where it was kept, so nothing is re-added. The
  plugin now only makes its backend nameable, and is bundled rather than loaded at start-up; its
  package adds `localExtraPlugins`, the pinned list the bundle uses.
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
- **`tool-plugin`** — a `github:owner/repo#path:sub` specifier (pnpm's git-subdirectory fragment) is
  refused; write `github:owner/repo/sub` (with `#ref` after it, if any), which fetches the same files. It
  never worked as an install, and since 0.4.5 it was folded into the path with a warning. Refused when the
  plugin is fetched, so a configured one is a recorded load failure naming the rewrite, not a boot that
  stops. `Classified`'s `http` arm loses `url` and `advice`; `githubToHttps` is exported instead.
- **The CLI no longer installs `provenance`.** It was a runtime dependency of `@matatbread/matbot-cli`
  only because a CLI test imports it, so an npm install of the CLI carried it while every other plugin
  needed `plugin add`. An installation whose `plugins:` names `@matatbread/matbot-provenance` adds it
  (`plugin add @matatbread/matbot-provenance`); a source checkout is unaffected.
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
- **`cognition`** — a trigger seeded before 0.2.4 that loads the retired "Remember this" skill is no
  longer repointed at `remember_fact`. Startup names any that are left; delete them with `trigger_action`.
  Nor is the Inner Voice trigger's cool-down backfilled onto one seeded before 0.3.8; set it with
  `trigger_action` if that trigger fires repeatedly.
- **`function-tools`** exports its source scanner as `@matatbread/matbot-function-tools/scan`
  (`inertEnd`, `withoutComments`, `matchParen`, `matchBrace`). A `'` or `"` that reaches the end of its
  line is no longer read as a string, so an apostrophe in a definition outside a comment cannot swallow
  the rest of it.
- **`tool-store`** depends on `function-tools` for that scanner, as a package — installing `tool-store`
  installs it; nothing loads it as a plugin. A `/` in a shape that opens a regex literal is now skipped
  like a string.

---

Earlier releases: [v0.4 CHANGELOG](docs/CHANGELOG-v0.4.md).

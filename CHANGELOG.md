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
  one without importing it. core, plugin-api, the apps and the library packages `default-gate`, `files`
  and `tool-plugin` no longer declare it, since they are not plugins. A host whose `PluginResolver` has no
  `runtimes` has nothing to check, and imports as before.
- **Two migration warnings are removed.** `default_settings.__matbot_core__.overwriteToolsOnCollision` (moved
  to `'@matatbread/matbot-default-gate': { 'tools.overwrite': … }` in 0.4.14) and the CLI's top-level
  `function_timeout_ms` / `function_imports` (moved to `@matatbread/matbot-function-runner-node`'s
  `timeout_ms` / `permit_imports` in 0.4.20) were already unread; they are now unread silently.

### API gaps filled

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

### Optional

- **`function-tools`** — on node a defined function's, and a package export's, `inputSchema` comes from the
  checker's resolved parameter types instead of from the parameter text, so a named or imported type, an
  alias or `Omit<…>` reaches the provider and `json-validation` as its real shape rather than as `{}`. It is
  stored with the definition; one defined with `noTypeCheck`, in the browser, or before 0.5.0 keeps the
  text-derived schema. A package export whose parameter only an alias showed to be a non-object is now
  refused, as a visibly non-object one already was.
- **`tool-types`** — implements `parametersOf`.

- **Storage: two in-place migrations of very old data are removed** (see *Upgrading to 0.5.0* in the
  README):
  - `storage-sqlite` no longer renames a table named under the pre-0.4.4 scheme (`a-b` stored as
    `a_b_store`). Start a pre-0.4.4 database once with matbot >=0.4.4 <0.5.0 before upgrading; opened by
    0.5.0, an affected namespace looks empty and the old table is left in the file.
  - `files` and `storage-profiles` no longer read an unnamed file's sidecar written before 0.2.4 (an `id`
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
- **`provider-store-test`** is no longer published. It is a test/reference plugin nothing depends on; it
  stays in the repository, typechecked with the rest. The versions already on npm are left there.
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

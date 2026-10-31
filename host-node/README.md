# @matatbread/matbot-host-node

What a Node application needs to embed [matbot](https://github.com/MatAtBread/matbot) that
`@matatbread/matbot-core` cannot hold, because it uses Node APIs and core must also run in a browser. Not a
plugin: an application building a machine with `assembleMachine` imports these and passes them in. Nothing
here assumes a config file, a directory layout or how plugins are acquired; each takes the path or
directory it works on.

**`@matatbread/matbot-host-node/register`** — start the application with
`node --import @matatbread/matbot-host-node/register app.ts`. matbot's packages are published as TypeScript
source, so this registers the two module hooks Node needs to load them: a `.js` import resolves to the `.ts`
file, and types are stripped under `node_modules` too, where Node refuses to. A host with hooks of its own
registers the pair from **`/typescript-hooks`** (`typescriptHooks()`) beneath them, as the matbot CLI does.

**`@matatbread/matbot-host-node`**:

- `createAlsPrincipalCarrier`, `createAlsUsageCarrier` — `AsyncLocalStorage` carriers, so concurrent
  requests and turns each keep their own principal and token accounting. Install them before anything
  reads one, then `runAs(principal, …)` at each entry point (a request handler, a message). core's
  `createConstantPrincipalCarrier` is the alternative for a single-principal process.
- `nodePluginMembers(machine, baseDir)` — `loadPlugin`, `unloadPlugin`, `resolver` and
  `TypeScriptStripper` for a host that loads plugins already on disk: a path (relative to `baseDir`), or a
  package installed where `baseDir` resolves. Nothing is fetched or installed. Built from
  `resolveInstalledPlugin`, `packageEntry`, `installedEntry`, `loadRequest`,
  `loadPluginsWithDescriptions`, `unloadNodePlugin` and `nodePluginResolver`, which a host with its own
  resolution uses directly.
- `EnvFileVault.open(path, env?)` — a vault persisted to an environment file. Values are plaintext,
  readable by anything that can read the file. `parseEnvFile`/`readEnvFile` read the same format.

Storage is a plugin's: `@matatbread/matbot-storage-filesystem` exports `FilesystemStorageBackend` for a
host to boot on, and core's `MemoryStorageBackend` (`@matatbread/matbot-core/storage-base`) persists
nothing.

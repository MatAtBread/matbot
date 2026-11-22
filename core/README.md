# @matatbread/matbot-core

The core runtime for [matbot](https://github.com/MatAtBread/matbot) — a thin, composable
TypeScript AI harness.

It contains the agentic loop, hook dispatch, the plugin loader, security (`VaultImpl`,
principal origin), the default permission policy, and the default in-memory knowledge index. An
**app** stands a machine up from it with `assembleMachine` — the CLI and the web bundle do, and so can
your own program, with no other matbot package: `MemoryStorageBackend` (from `./storage-base`) for
storage, and any plugins it chooses. Plugins rarely import it directly.

To embed it, see *Embedding matbot in a Node application* in
[DEVELOPING.md](https://github.com/MatAtBread/matbot/blob/main/docs/DEVELOPING.md), and the smallest
working program, [`examples/minimal-matbot`](https://github.com/MatAtBread/matbot/tree/main/examples/minimal-matbot).

Two **subpath exports** are provided for plugin authors, so you can link against them without
pulling in the runtime:

- `@matatbread/matbot-core/providers-base` — SSE parser and HTTP helpers (write a provider)
- `@matatbread/matbot-core/storage-base` — the `StoreQuery` filter/sort engine (write a storage backend),
  and `MemoryStorageBackend`, which persists nothing

Depends only on [`@matatbread/matbot-plugin-api`](https://www.npmjs.com/package/@matatbread/matbot-plugin-api).
Ships as raw TypeScript, importing its own files as `./x.js`, and requires **Node 24+** or a bundler.
Node's native type stripping alone is not enough once the package is under `node_modules`: start your
program with `node --import @matatbread/matbot-host-node/register`, which registers the two module hooks
it needs (or copy the dozen lines of them, as `examples/minimal-matbot` does).

See the [main repository](https://github.com/MatAtBread/matbot) for the full design guide.

## License

Apache-2.0

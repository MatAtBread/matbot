# @matatbread/matbot-core

The core runtime for [matbot](https://github.com/MatAtBread/matbot) — a thin, composable
TypeScript AI harness.

It contains the agentic loop, hook dispatch, the plugin loader, config (YAML + `.env`),
security (`VaultImpl`, principal origin), and the default in-memory knowledge index. It is
the runtime an **app** (such as the CLI) instantiates; plugins rarely import it directly.

Two **subpath exports** are provided for plugin authors, so you can link against them without
pulling in the runtime:

- `@matatbread/matbot-core/providers-base` — SSE parser and HTTP helpers (write a provider)
- `@matatbread/matbot-core/storage-base` — the `StoreQuery` filter/sort engine (write a storage backend)

Depends only on [`@matatbread/matbot-plugin-api`](https://www.npmjs.com/package/@matatbread/matbot-plugin-api).
Ships as raw TypeScript and requires **Node 24+** (native type stripping) or a bundler.

See the [main repository](https://github.com/MatAtBread/matbot) for the full design guide.

## License

Apache-2.0

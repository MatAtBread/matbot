# @matatbread/matbot-plugin-api

The plugin API for [matbot](https://github.com/MatAtBread/matbot) — a thin, composable
TypeScript AI harness.

This is the **singleton contract** every matbot plugin builds against: the `MatbotPlugin`
type, the `MatbotServices`/`MatbotRuntime`/`MatbotMachine` registry, the hook channels, the
ambient principal carrier, the `Vault`/`Store` interfaces, and the shared error types.

Plugins should declare it as a **peer dependency** (the host provides the single shared copy
— two copies would break `instanceof` checks, the principal carrier, and module
augmentation). It ships as raw TypeScript and requires **Node 24+** (native type stripping)
or a bundler.

See the [main repository](https://github.com/MatAtBread/matbot) for the full design guide and
plugin-authoring docs.

## License

Apache-2.0

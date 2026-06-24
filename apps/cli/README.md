# @matatbread/matbot-cli

The command-line interface for [matbot](https://github.com/MatAtBread/matbot) — a thin,
composable TypeScript AI harness. Provides the `matbot` command: an interactive REPL and a
single-turn runner, with plugins that hot-load at runtime.

Requires **Node 24+** (matbot ships raw TypeScript and relies on Node's native type
stripping; no build step).

## Install

matbot is a CLI plus a set of optional plugins you install alongside it, so install it **into
a project**, not globally — that way the CLI and its plugins share one `node_modules` and
resolve to a single core:

```sh
mkdir my-matbot && cd my-matbot
npm init -y
npm i @matatbread/matbot-cli
npx matbot
```

No config file is needed — on first run matbot walks you through setting up a provider. After
that, add capabilities with the built-in `plugin` tool (each is its own npm package):

```
you: add a tool for running shell commands
⚙ plugin { "action": "add", "specifier": "@matatbread/matbot-tool-bash" }
```

## Usage

```sh
matbot                      # interactive REPL (ephemeral session)
matbot "What is 2 + 2?"     # single turn, then exit
matbot --session create     # new persistent session
matbot start                # headless server mode (waits for a frontend plugin)
matbot --help               # full option list
```

See the [main repository](https://github.com/MatAtBread/matbot) and
[Getting Started](https://github.com/MatAtBread/matbot/blob/main/docs/GETTING-STARTED.md) for
the complete guide.

## License

Apache-2.0

# Getting Started with matbot

This document covers installation, configuration, and the full CLI reference. For the
big-picture overview see [README.md](../README.md); for writing plugins see
[DEVELOPING.md](DEVELOPING.md).

---

## Requirements

- Node 24+ (matbot ships raw TypeScript and relies on Node's native type stripping)
- An LLM API key (Anthropic, OpenAI-compatible, DeepSeek, Ollama, …)
- pnpm 9+ — only needed to run from source

---

## Installation

matbot loads plugins from the project it runs in, so install it **into a project**, not
globally. A `-g` or bare `npx` install runs, but the CLI then lives in a different
`node_modules` than any plugin you `plugin add` — two copies of the core, which breaks the
singleton contract. A local install keeps the CLI and its plugins in one tree:

```sh
mkdir my-matbot && cd my-matbot
npm i @matatbread/matbot-cli   # creates a minimal package.json + node_modules
```

Run it with `npx matbot` (the locally-installed bin) or via an npm script. From source, for
development:

```sh
git clone https://github.com/MatAtBread/matbot
cd matbot
pnpm install
```

---

## Running matbot

```sh
matbot                             # interactive REPL (ephemeral session)
matbot "What is 2 + 2?"            # single turn, then exit
matbot --session create            # new persistent session
matbot --session <id>              # resume an existing session
matbot start                       # headless server mode (waits for a frontend plugin)
```

> The examples write `matbot` for brevity. With a project install, invoke it as
> `npx matbot …` (or via an npm script); from source, substitute `pnpm repl` / `pnpm start`.
> All three run the same entrypoint.

Sessions are **ephemeral by default** — nothing is written to disk unless you pass
`--session create`. On exit, a persistent session prints a `--session <id>` resume
command. Setting `ephemeral: true` in `matbot.yaml` is a hard override — it takes
effect even if `--session` is passed on the command line. Background sub-agents use
this to avoid leaving session traces.

---

## Auto-configuration

You don't need a config file to start. On first run with no providers configured,
matbot walks you through setting one up interactively:

```
$ matbot

No providers configured. Let's set one up.

Available provider types:
  1. anthropic  (@matatbread/matbot-provider-anthropic)
  2. openai-compat  (@matatbread/matbot-provider-openai-compat)
  3. google  (@matatbread/matbot-provider-google)
  4. customer-services  (@matatbread/matbot-provider-customer-services)

Choose a type [1-4]: 1
Provider name: deepseek
Model name: deepseek-v4-flash
Endpoint URL: https://api.deepseek.com/anthropic
API key: ************************************

Configuration written to ~/matbot/matbot.yaml
```

> **No API key?** Try option 4 — `customer-services` is a free built-in provider that
> needs no endpoint or API key. It's not a real LLM, but it's useful for testing your
> setup.

Once a provider is configured, use the built-in `plugin` tool to discover and add
capabilities without ever editing the config file:

```
you: got any cool plugins?
```

---

## Configuration file

The config file is `matbot.yaml`, located next to your working directory (or specified
with `--config`). Everything in it is optional — matbot will prompt for what it needs.

### Full example

```yaml
providers:
  claude:
    module: ./plugins/providers/anthropic
    endpoint: https://api.anthropic.com
    model: claude-sonnet-4-6
    credentials:
      apiKey: ${ANTHROPIC_API_KEY}
    parameters:
      maxTokens: 8192
      temperature: 0.7

  deepseek:
    module: ./plugins/providers/anthropic
    endpoint: https://api.deepseek.com/anthropic
    model: deepseek-v4-flash
    credentials:
      apiKey: ${DEEPSEEK_API_KEY}
    parameters:
      maxTokens: 16384
    fallback: claude                 # used on 429 / 5xx

plugins:
  - @matatbread/matbot-tool-bash
  - @matatbread/matbot-tool-http
  - @matatbread/matbot-tool-workspace
  - @matatbread/matbot-frontend-web
```

When working in the monorepo, reference packages by relative path (no install step needed):

```yaml
plugins:
  - ./plugins/bash
  - ./plugins/http
  - ./plugins/workspace
  - ./plugins/frontend/web
```

---

## Provider configuration reference

```yaml
providers:
  <name>:
    module:     <npm-package | ./relative/path>   # adapter module
    endpoint:   https://...                       # base URL for this provider
    model:      <model-id>
    credentials:
      apiKey:   ${SECRET_NAME} | literal          # ${NAME} resolved by the Vault
    parameters:                                   # optional; passed to the API
      maxTokens:      4096
      temperature:    0.7
      thinking:                                   # Anthropic extended thinking
        type:         enabled
        budgetTokens: 2000
    fallback:   <other-provider-name>             # used on 429 / 5xx
```

### Secret resolution

Credentials use a single placeholder syntax — `${NAME}` — resolved by the active Vault
at runtime. The default Node vault reads from a `.env` file next to `matbot.yaml`; the
browser build uses a `localStorage` vault, which of course you can replace with your
own plugin. Either way:

| Syntax         | Resolves to                                          |
|----------------|------------------------------------------------------|
| `${NAME}`      | The entry stored under `NAME` in the active Vault    |
| literal string | Used as-is (avoid for real credentials)              |

A missing secret throws `MissingSecretError`. Secrets are resolved on use and never
written to session storage.

`.env` example:

```sh
ANTHROPIC_API_KEY=sk-ant-...
DEEPSEEK_API_KEY=sk-...
```

---

## Plugin configuration reference

Plugins are listed in order under `plugins:`. They are imported in parallel and
registered in declaration order. A failed import logs a warning and is skipped; it does
not abort startup.

```yaml
plugins:
  - @matatbread/matbot-tool-bash          # npm package
  - ./my-plugin                           # local package directory
  - ./my-plugin/src/index.ts              # explicit entry point
```

Provider adapter plugins (`@matatbread/matbot-provider-*`) are loaded automatically
when their `module` is referenced in a provider config entry — they don't need an
explicit `plugins:` entry.

---

## CLI reference

| Option | Behaviour |
|---|---|
| `[prompt]` (positional) | Single-turn prompt; runs one turn and exits. Omit for interactive REPL |
| `--provider <name>` | Provider key from `matbot.yaml` (default: first in file) |
| `--session create` | New persistent session; saved to the store |
| `--session <id>` | Resume an existing session |
| `--ephemeral` | Force ephemeral even when `--session` is given |
| `--system <text>` | System prompt injected at session start |
| `--config <path>` | Config file path (default: `./matbot.yaml`; `-` reads YAML from stdin) |
| `--prompt-file <path>` | Read the prompt from a file; runs a single turn and exits |
| `--principal <id\|json>` | Boot identity: a bare id (type `user`) or JSON `{"id","type"}`. Overrides `MATBOT_PRINCIPAL` and the config `principal:` |
| `--help` | Show help and exit |
| `--version`, `-v` | Print the version banner and exit |

---

## Data directory

With the default filesystem storage backend, all runtime state lives in `.data/` next to
`matbot.yaml` and is `.gitignore`d:

```
.data/
  sessions/    — session store (only created when persistence is active)
  settings/    — per-plugin key-value settings
  skills/      — skill documents (skills plugin)
  triggers/    — trigger documents (triggers plugin)
  schedules/   — recurring background job definitions (background plugin)
  knowledge/   — KnowledgeIndex entries (persist-ki-bge plugin)
  bash-cwd/    — default working directory for bash tool execution
  files/       — file store blobs; workspace_action writes go here
```

Each store namespace becomes its own subdirectory, so plugins add more as needed (e.g. cognition's
`remembered_facts/` and `dream_runs/`).

The SQLite storage plugin (`@matatbread/matbot-storage-sqlite`) is a drop-in replacement
that collapses the per-directory filesystem stores into a single `.data/matbot.db` file.

---

## Example 1 — minimal bot (no tools, just the CLI)

Purely conversational — one provider, no plugins.

```yaml
# matbot.yaml
providers:
  deepseek:
    module: ./plugins/providers/anthropic
    endpoint: https://api.deepseek.com/anthropic
    model: deepseek-v4-flash
    credentials:
      apiKey: ${DEEPSEEK_API_KEY}
    parameters:
      maxTokens: 16384
```

```sh
# .env
DEEPSEEK_API_KEY=sk-...
```

```sh
matbot
```

---

## Example 2 — bot with tools and a web UI

Adds bash execution, HTTP requests, workspace files, and a browser-accessible chat UI.

```yaml
# matbot.yaml
providers:
  claude:
    module: ./plugins/providers/anthropic
    endpoint: https://api.anthropic.com
    model: claude-sonnet-4-6
    credentials:
      apiKey: ${ANTHROPIC_API_KEY}
    parameters:
      maxTokens: 8192

plugins:
  - ./plugins/bash
  - ./plugins/http
  - ./plugins/workspace
  - ./plugins/frontend/web
```

```sh
matbot
# The web frontend prints its URL on startup:
# [frontend-web] http://localhost:19778
```

Open the URL in your browser — the same session continues in the web UI.

---

## Example 3 — persistent sessions with skills and memory

```yaml
providers:
  deepseek:
    module: ./plugins/providers/anthropic
    endpoint: https://api.deepseek.com/anthropic
    model: deepseek-v4-flash
    credentials:
      apiKey: ${DEEPSEEK_API_KEY}
    parameters:
      maxTokens: 16384

plugins:
  - ./plugins/skills
  - ./plugins/triggers
  - ./plugins/rumsfeld
  - ./plugins/cognition
  - ./plugins/sessions
  - ./plugins/frontend/web
```

```sh
matbot --session create
```

The `triggers` plugin fires skills/tools on behavioural conditions (judged by an LLM classifier);
the `cognition` plugin adds inner-voice critique (the `ask_inner_voice` tool), persistent fact memory
(`remember_fact`, with a generated `remembered_facts_action` CRUD tool), and background consolidation
(the `dream_time` tool). It also seeds one skill — Inner Voice.

**No dedicated provider profiles are needed for these.** Each subsystem that consults a model for an
internal job — the triggers classifier, skills' content analysis, cognition's inner voice — uses the
**current turn's provider** by default. Those roles are *aliases* for an already-configured provider,
not new profiles to stand up: to point one at a cheaper/faster (or, for the inner voice, a
different-lineage) model, pin it to an existing provider with the relevant config tool —
`triggers_config`, `skills_config`, or `cognition_config` (action `set`). Installs that historically
defined a provider literally named `skills-classifier` keep working — it stays the classifier default.
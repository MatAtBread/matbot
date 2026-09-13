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
  5. chatjimmy  (@matatbread/matbot-provider-chatjimmy)

Choose a type [1-5]: 1
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
    maxRounds: 12                    # ceiling on agentic rounds per turn against this provider

plugins:
  - @matatbread/matbot-tool-bash
  - @matatbread/matbot-tool-http
  - @matatbread/matbot-tool-workspace
  - @matatbread/matbot-frontend-web

default_settings:                  # install defaults for plugins' own settings (read-only)
  @matatbread/matbot-triggers:
    classifierProvider: deepseek
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
    parameters:                                   # optional; forwarded to the API unmodified
      maxTokens:      4096
      temperature:    0.7
      thinking:                                   # Anthropic extended thinking
        type:         enabled
        budgetTokens: 2000
    maxRounds:  12                                # optional; agentic rounds per turn (see below)
```

`maxRounds` caps the agentic rounds one turn may take against this provider — a round being one
provider call plus the tool batch it asked for. Reaching it ends the turn (`aborted`, reason
`round-limit`) rather than starting another round; absent means unbounded. It sits per provider
rather than as one global because that is the unit spend is denominated in: a local model can
afford to grind where a frontier model at 100× the rate cannot, and one deployment runs both. It
is deliberately *not* in `parameters` — those are forwarded to the endpoint untouched, and this
never leaves matbot.

**There is no automatic failover between providers**, and no `fallback:` key — a `fallback:` in an
older config is ignored, silently, as it always was. It is deliberately unimplemented rather than
merely missing: failover has to decide how two providers billed for one turn are accounted, and what
happens to a tool call's round-trip `ProviderMeta` token (a Gemini thought signature, say) when the
turn continues on a provider that never issued it. A stub answering neither would be worse than
nothing. Until those are settled, retry across profiles belongs to whoever is submitting turns.

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

## Default plugin settings reference

Plugins keep their own runtime settings in matbot's store (a classifier provider to use, a
list of tools to ignore, a tuning knob). `default_settings:` supplies the install's value
for any of them, so a plugin can be dropped into a project already configured — without
wrapping it in a package of your own just to initialise it.

```yaml
default_settings:
  @matatbread/matbot-triggers:
    classifierProvider: fast-haiku
  @matatbread/matbot-cognition:
    innerVoiceProvider: fast-haiku
    dream:
      maxItems: 5
```

Keys are plugin **package names** — the name `plugin list` reports, which is not necessarily
the specifier you wrote under `plugins:` (a plugin loaded as `./plugins/triggers` is still
named `@matatbread/matbot-triggers`). A key naming no loaded plugin is warned about at
startup, because it would otherwise look like it had worked. Values are whatever the plugin
stores under that key, and matbot does not interpret them.

The rules, all of which follow from this being a *default* rather than a setting:

- **A stored value always wins.** Anything set at runtime — by a tool, by the web UI —
  overrides the default for as long as it is stored.
- **Nothing is seeded and nothing is written back.** The store holds only what was
  explicitly set, so editing `default_settings:` still takes effect (on the next start) for
  every key nobody has overridden, and a plugin or provider update cannot destroy it.
- **Clearing a setting reverts to the default here**, not to nothing — so a plugin's
  `clear`/`reset` action returns you to the install's intended value.
- **Merging is per key.** A key's value is replaced wholesale, never merged into; matbot
  does not look inside it.
- **`${NAME}` placeholders are not resolved** in these values. Secrets belong in the vault
  (`.env` / `plugin store-key`), which plugins request by name when they need them.
- **It applies to every user.** A default is configuration rather than data, so it is not
  partitioned per principal the way stored settings are.

### Tool-name collisions, and other privileged operations

Two plugins can claim the same tool name — deliberately, when one is meant to replace the
other's tool, or by accident. That is one of matbot's **gates**: a privileged operation that
declares it needs acceptance. Installing a plugin, adding or removing a provider profile, and
connecting an MCP server are the others.

A gate says *what* is being asked and what happens when nobody can be asked; the installation's
**permission policy** decides how the acceptance is obtained. The one matbot ships
(`@matatbread/matbot-default-gate`) asks, offers to remember the answer, and honours what it
remembered. It is built in — like the `plugin` and `provider` tools, it is there on every install,
including a minimal one with an empty `plugins:` list, and needs no config line. Interactively that is *Deny* / *Allow* / *Always allow "<subject>"* / *Always allow
every `<gate>`*; non-interactively — a boot, an HTTP install — each call site's own stated answer
applies, which for a tool collision is "overwrite" (what lets a deliberate override win with nobody
there to answer) and for everything else is "no".

Standing answers live in that plugin's own settings namespace, one key per gate id, so an
installation can author them up front — the same thing the two *Always* options write:

```yaml
default_settings:
  '@matatbread/matbot-default-gate':
    'tools.overwrite': [bash, plugin]   # or: true
    'plugin.add': ['@acme/our-tools']
```

A **list of subjects** allows exactly those and asks about everything else — the form to reach for
when one particular override is intended and any *other* collision is a surprise you want to hear
about. `true` allows every subject of that gate. Anything else asks. As everywhere in
`default_settings:`, a stored answer then wins over this one;
`.data/settings/_matatbread_matbot-default-gate.json` is where it lands, and `gate_action`
(`{ action: 'get' }` / `{ action: 'clear' }`) reports and forgets answers without going near the file.
`get` lists the answers in force — nothing on a fresh install, since a gate nobody has answered is
simply not reported; pass a `gate` to ask about one by name.

The gate ids are `tools.overwrite` (subject: the tool name), `plugin.add` /
`plugin.provision-deps` / `plugin.remove` / `plugin.npm-uninstall` / `plugin.load`,
`provider.add` / `provider.add-unverified` / `provider.update` / `provider.update-unverified` /
`provider.remove`, and `mcp_action.add` / `mcp_action.remove`. A tool's ids are qualified with the
name it is *registered* under, so one answer covers both the node and browser implementations of a
tool. The list is open: a plugin can declare ids of its own, and an id the policy does not recognise
is asked about rather than allowed.

Be clear-eyed about what a standing answer buys and costs. **A policy that auto-approves
`plugin.add` has granted everything**, because a loaded plugin has full Node capability and there is
no in-process sandbox. A standing answer is a **decision, not a channel** — it applies at every door,
including `POST /tools/:name` and anything the model reaches through its own `http` or `bash` tool —
so prefer the per-subject form to *Always allow every …*. And the answers live in `.data/settings/`,
which a shell tool can write: on an install that loads one, the model can author its own standing
answer. What the gate guarantees is that a privileged operation is *decided somewhere replaceable*,
and by default that means a human is asked — not that it cannot be changed. A deployment that needs a
real boundary ships a gate with its rules compiled in.

An installation that wants different rules — approve from a console, consult a roster, refuse
outright — ships a plugin registering its own `PermissionGate` instead of undoing this one. See
[DEVELOPING](DEVELOPING.md) *Declaring a gate*.

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
| `--dump-tools [path]` | Serialize the live tool registry — wire descriptions with folded TS contracts, plus `inputSchema` — to a JSON file and exit (default `tools-dump.json`) |
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
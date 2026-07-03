// Real tool descriptions harvested from matbot source (the tool's top-level `description`, not arg docs).
// This is a SEED: it covers source-defined tools only — runtime-generated tools (function-tools like
// `temperature_check`, MCP proxies like `mcp__anysearch__*`) are absent and need a live-registry dump
// for the authoritative run. `temperature_check → home heating` is the canonical vocabulary-bridge case
// to add from a live dump. Descriptions are trimmed to their substantive (noun-bearing) text.

export interface ToolDoc { name: string; description: string }

export const TOOLS: ToolDoc[] = [
  { name: 'about_matbot', description:
    'Report what you are running: the matbot harness version and a one-line description. Use it when asked what version of matbot this is, or for an "about" of the harness itself (distinct from the plugin tool, which lists loaded plugins).' },

  { name: 'whoami', description:
    'Report the security principal that originated the current operation — the identity the runtime is acting as right now. Returns { id, type } where type is "user", "agent", or "system". Useful for confirming who a turn (or a delegated background job) is running as.' },

  { name: 'http', description:
    'Make an HTTP request and return the response body.' },

  { name: 'workspace_action', description:
    'Read, write, list, and delete files in the workspace — a small scratch and transfer area, NOT the host filesystem. Use it for files the user uploads or downloads, generated artifacts (reports, charts, exports), and working notes or to-do lists. It is not a code workspace: files here are not executable. Workspace files are publicly viewable.' },

  { name: 'url_for_resource', description:
    'Return a shareable HTTP URL for a stored file the user can open, or null when it is not publicly viewable. Use this to hand the user a link to a file (e.g. a workspace artifact) rather than guessing a path. Only files marked viewable are served.' },

  { name: 'background', description:
    'Run a prompt in a detached background process. With no interval it runs once and returns immediately; with an interval it becomes a recurring schedule that persists across restarts (manage it afterwards with the every_action tool). The background process has access to the same tools and providers. Optionally name a workspace file to capture stdout. interval is a duration like "30s", "5m", "1h", "24h".' },

  { name: 'every_action', description:
    'Manage recurring background schedules created by the background tool. Actions: list — show every schedule with its id, interval, next run time, and active state; suspend — pause a schedule; resume — resume a suspended schedule; cancel — permanently delete a schedule.' },

  { name: 'ask_inner_voice', description:
    'Consult the Inner voice — a second model that constructively critiques your draft response — and return its critique. This is a one-shot call to a SEPARATE model (not your own response): send a prompt summarising the problem and your draft, plus an optional system framing, and get back its text.' },

  { name: 'single_turn', description:
    'Run a single-turn completion against a configured provider and return its reply. This is a one-shot call — not your own response: you send one prompt (and optional system), and get back its text. Use it to consult a different model, or any generation that should run on a specific provider.' },

  { name: 'find_fact', description:
    "Retrieve a specific FACT from stored knowledge — their home city, a system's URL, someone's birthday, a configured threshold. Use this, not contextual_search, when you want one precise datum rather than a whole document to read. It searches stored knowledge, reads across the best matches, and returns just the answers as an array of strings — or null. It never invents an answer." },

  { name: 'contextual_search', description:
    'Load context for an unknown concept, system, term, or entity — returns a whole knowledge document to read. For a single specific fact (a city, a URL, a date) rather than a document, use find_fact instead. Examples: Is <unknown> currently working? Tell me about <unknown>.' },

  { name: 'remember_fact', description:
    'Extracts facts from the latest user message and reads provenance (session id, message id, timestamp) from context — takes no parameters. Writes one document per fact to the remembered_facts store. You may also call it directly to capture the current message.' },

  { name: 'dream_time', description:
    'Run one pass of background memory consolidation. Scores every unassigned fact in the remembered_facts store, promotes the salient ones into long-term memory, and discards noise. Memory maintenance / consolidation run on a schedule.' },

  { name: 'skill_action', description:
    'Manage skills — named, reusable markdown playbooks (procedures, conventions, reference material) the model can load and follow. List, get, create, update, delete a skill; set which provider analyses skill content for search.' },

  { name: 'skill_compiler', description:
    'Compile a procedural markdown skill into an executable TypeScript plugin, then install it. Loads from the skill manager, classifies (only procedural skills compile), demonstrates in a scratch session capturing the real working trace, distils the trace to the method that worked, generates TypeScript, typechecks, and installs.' },

  { name: 'telegram_provider', description:
    "Get or set the LLM provider the Telegram bot uses. A 'set' is persisted and restored on restart." },

  { name: 'telegram_send', description:
    'Send an out-of-band notification to Telegram, outside of any session. The message is prepended with a bell. Sends to all chats that have previously contacted the bot, or to a specific chat if chatId is given.' },

  { name: 'telegram_open_door', description:
    'Open the door for new chats to join the bot channel. The door remains open for 30 seconds or until the first message from a new user is received, whichever comes first.' },

  { name: 'mcp_action', description:
    'Manage remote MCP (Model Context Protocol) server connections. An MCP server exposes a set of tools; once connected, each is registered under mcp__<server>__<tool> and is callable for the rest of the session. Actions: add — connect a server and register its tools; list — show connected servers and their tools; remove — disconnect a server.' },

  { name: 'plugin', description:
    'Manage matbot plugins — the units that contribute tools, providers, storage, hooks, and frontends to the running process. List them, install or remove one by specifier, reload one to pick up code changes, or supply a secret a plugin or provider reported missing.' },

  { name: 'session_action', description:
    'Manage conversation sessions. A session is a stored conversation — a chronological list of messages identified by a unique ID, with a title and a status (active or archived). This tool covers the lifecycle: list sessions, fetch one in full, rename one, or hide (archive) one.' },

  { name: 'session_edit', description:
    "Edit the message history of a session. Every action takes a session ID and a message index: cut — truncate, remove all messages from the index onward; fork — branch, create a new session with earlier messages; split — move earlier messages to a new session; compact — shrink, strip thinking blocks, tool calls, and tool results, keeping user/assistant text." },

  { name: 'compact_sessions', description:
    'Apply the session compaction policy to the entire session store. Two tiers: full compact for archived or long-untouched sessions (strips tool calls, tool results, thinking blocks); partial compact for active sessions with many messages, keeping the last few intact. Idempotent — safe to run on a schedule.' },

  { name: 'store_action', description:
    'Define named persistent stores and expose a generated tool over each. A store is a typed key-value collection (documents keyed by id). Exposing a store mints a tool the model can use to get/set/cas/delete/query its documents. Both create and expose require a plain-English description of what the store holds and a shape.' },

  { name: 'trigger_action', description:
    'Manage triggers — data-driven hooks that invoke a tool when an LLM classifier judges one of their conditions matched against the current turn. List triggers, find the ones that invoke a given tool, read one, create one, edit one by id, suspend one (disable) or bring it back (enable), delete one, or bulk re-target a set onto a new tool.' },

  { name: 'triggers_config', description:
    "Configure the triggers subsystem. Currently one setting: classifierProvider — which configured provider judges trigger conditions. Unset, the classifier uses the current turn's own provider; set it to pin a small/fast model." },

  { name: 'skills_config', description:
    'Configure the skills subsystem. Currently one setting: analysisProvider — which configured provider analyses skill content (summary/entities/tags for search). Unset, analysis uses the first configured provider; set it to pin a small/fast model.' },
];

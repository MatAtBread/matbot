// (request → expected tool) pairs. Phrased as a USER states a need, deliberately NOT reusing the tool's
// own vocabulary, so this measures real vocabulary-bridging recall — not string echo. FIRST DRAFT: needs
// review/expansion (and a live-registry tool dump) before it's the authoritative gate. Each query has one
// clearly-correct tool among tools.ts; near-ambiguous pairs (background vs every_action, single_turn vs
// ask_inner_voice, find_fact vs contextual_search) are phrased to disambiguate.

export interface Query { query: string; expected: string }

export const CORPUS: Query[] = [
  { query: 'what version of matbot am I running', expected: 'about_matbot' },
  { query: 'who am I authenticated as right now', expected: 'whoami' },
  { query: 'what identity is this job running under', expected: 'whoami' },
  { query: 'fetch the JSON from this API endpoint', expected: 'http' },
  { query: 'make a POST request to a webhook', expected: 'http' },
  { query: 'save this report as a file I can download later', expected: 'workspace_action' },
  { query: 'list the files that were uploaded', expected: 'workspace_action' },
  { query: 'give me a link to that chart file', expected: 'url_for_resource' },
  { query: 'run this prompt once in the background', expected: 'background' },
  { query: 'check my email every 15 minutes and summarise it', expected: 'background' },
  { query: 'pause my recurring digest job', expected: 'every_action' },
  { query: 'show me my scheduled tasks', expected: 'every_action' },
  { query: 'have a second, different model critique my draft answer', expected: 'ask_inner_voice' },
  { query: 'get a critique of this response from another model', expected: 'ask_inner_voice' },
  { query: 'run this prompt on a specific provider and give me the reply', expected: 'single_turn' },
  { query: "what is the user's home city", expected: 'find_fact' },
  { query: 'look up the configured deployment threshold', expected: 'find_fact' },
  { query: 'tell me about the Glasswing project', expected: 'contextual_search' },
  { query: 'load background on an unfamiliar system I keep hearing about', expected: 'contextual_search' },
  { query: 'remember that the user prefers metric units', expected: 'remember_fact' },
  { query: 'consolidate the facts collected so far into long-term memory', expected: 'dream_time' },
  { query: 'create a reusable playbook for onboarding new hires', expected: 'skill_action' },
  { query: 'list my saved skills', expected: 'skill_action' },
  { query: 'turn my deployment skill into an actual tool', expected: 'skill_compiler' },
  { query: 'compile a procedure into a plugin', expected: 'skill_compiler' },
  { query: 'which model does the telegram bot use', expected: 'telegram_provider' },
  { query: 'send me a notification on telegram', expected: 'telegram_send' },
  { query: 'let a new person join the telegram channel', expected: 'telegram_open_door' },
  { query: 'connect to a github MCP server', expected: 'mcp_action' },
  { query: 'add a remote model context protocol tool server', expected: 'mcp_action' },
  { query: 'install a plugin from a URL', expected: 'plugin' },
  { query: 'reload a plugin after I changed its code', expected: 'plugin' },
  { query: 'rename this conversation', expected: 'session_action' },
  { query: 'archive this chat', expected: 'session_action' },
  { query: 'shorten this conversation to save tokens', expected: 'session_edit' },
  { query: 'fork the conversation from this point into a new thread', expected: 'session_edit' },
  { query: 'clean up all my old conversations', expected: 'compact_sessions' },
  { query: 'create a persistent store for customer records', expected: 'store_action' },
  { query: 'set up a rule that fires a tool automatically when a condition is met', expected: 'trigger_action' },
  { query: 'which model judges my triggers', expected: 'triggers_config' },
];

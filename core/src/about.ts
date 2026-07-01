import type { Tool, ToolExecutor, ToolResultOf, ToolContext } from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolResults {
    about_matbot: { version: string; about: string };
  }
}

const ABOUT = 'Matbot composable LLM harness';

/**
 * Reports what the model is running: the harness `version` and a one-line description. The harness is
 * not a plugin (so it has no row in `plugin list`), and its version is a singleton fact rather than a
 * per-plugin one — hence a dedicated tool. The factory lives in core (like `single_turn`) because it is
 * the one cross-runtime home both the node app and the browser bundle register it from, each passing its
 * own app package version.
 */
export function createAboutMatbotTool(version: string): Tool<ToolResultOf<'about_matbot'>> {
  const executor: ToolExecutor<ToolResultOf<'about_matbot'>> = {
    async *execute(_input: unknown, _ctx: ToolContext) {
      yield { type: 'result', value: { version, about: ABOUT } };
    },
  };

  return {
    name: 'about_matbot',
    description:
      'Report what you are running: the matbot harness version and a one-line description. Use it when ' +
      'asked what version of matbot this is, or for an "about" of the harness itself (distinct from the ' +
      'plugin tool, which lists loaded plugins).\n\n' +
      'Parameters (TypeScript):\n' +
      '```ts\n' +
      '{}  // -> { version, about }\n' +
      '```',
    inputSchema: { type: 'object', properties: {} },
    executor,
  };
}

import type { Tool, ToolExecutor, ToolContract, ToolResultOf, ToolContext } from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    about_matbot: ToolContract<{ version: string; about: string, currentProvider: string | undefined }, Record<string, never>>;
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
    async *execute(_input: unknown, ctx: ToolContext) {
      yield { type: 'result', value: { version, about: ABOUT, currentProvider: ctx.provider } };
    },
  };

  return {
    name: 'about_matbot',
    description:
      'Report what you are running right now: the current model / LLM and provider profile powering THIS ' +
      'conversation, plus the matbot harness version and a one-line description. Use it whenever asked ' +
      '"what model / LLM are you using?", "which provider is this?", what version of matbot this is, or for ' +
      'an "about" of the harness itself — distinct from the `provider` tool (which lists all configured ' +
      'provider profiles) and the `plugin` tool (which lists loaded plugins).',
    inputSchema: { type: 'object', properties: {} },
    executor,
  };
}

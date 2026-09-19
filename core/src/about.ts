import type {
  Tool, ToolExecutor, ToolContract, NoParams, ToolResultOf, ToolContext, MatbotMachine, SystemContextPart,
} from '@matatbread/matbot-plugin-api';
import { joinSystemContext } from './system-context.js';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    about_matbot: ToolContract<{
      version:         string;
      about:           string;
      currentProvider: string | undefined;
      /** The system prompt in force, exactly as the model receives it — the joined `systemContext`
       *  texts. `null` when no contributor produced anything (there is then no system message at all). */
      systemPrompt:    string | null;
      /** The same text kept apart and attributed, so a contribution can be traced to its plugin. */
      systemContext:   SystemContextPart[];
    }, NoParams>;
  }
}

const ABOUT = 'Matbot composable LLM harness';

/**
 * Reports what the model is running: the harness `version`, a one-line description, the provider
 * driving this turn, and the system prompt in force. The harness is not a plugin (so it has no row in
 * `plugin list`), and its version is a singleton fact rather than a per-plugin one — hence a dedicated
 * tool. The factory lives in core (like `single_turn`) because it is the one cross-runtime home both the
 * node app and the browser bundle register it from, each passing its own app package version.
 *
 * The system prompt is REBUILT here rather than read back: it is assembled once per submit and never
 * persisted (see `runner`'s `system-context` event), so there is nothing on the session to read. Rebuilt
 * against this turn's session it is the same text the turn was given, unless a contributor's own source
 * changed mid-turn — a skill added, a plugin loaded — in which case it correctly reports what the NEXT
 * call will carry.
 */
export function createAboutMatbotTool(version: string, services: MatbotMachine): Tool<ToolResultOf<'about_matbot'>> {
  const executor: ToolExecutor<ToolResultOf<'about_matbot'>> = {
    async *execute(_input: unknown, ctx: ToolContext) {
      const systemContext = await services.systemContext.parts({ session: ctx.session, signal: ctx.signal });
      const systemPrompt  = joinSystemContext(systemContext);
      yield { type: 'result', value: { version, about: ABOUT, currentProvider: ctx.provider, systemPrompt, systemContext } };
    },
  };

  return {
    name: 'about_matbot',
    description:
      'Report what you are running right now: the current model / LLM and provider profile powering THIS ' +
      'conversation, the matbot harness version and a one-line description, and the SYSTEM PROMPT in force ' +
      'for this conversation — both as one string (`systemPrompt`, exactly what you were given) and broken ' +
      'down per contributing plugin (`systemContext`), which is how to answer "why are you being told that?" ' +
      'or "what is in your system prompt?". Use it whenever asked "what model / LLM are you using?", "which ' +
      'provider is this?", what version of matbot this is, what your instructions or system prompt are, or ' +
      'for an "about" of the harness itself — distinct from the `provider` tool (which lists all configured ' +
      'provider profiles) and the `plugin` tool (which lists loaded plugins).',
    inputSchema: { type: 'object', properties: {} },
    executor,
  };
}

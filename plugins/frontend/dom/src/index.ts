import type { MatbotPluginSpec, MatbotMachine, Tool, ToolContext, ToolContract, ToolResultOf } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, collectBytes } from '@matatbread/matbot-plugin-api';
import { ChatUI } from './ui.js';

// Same tool name (and therefore the same one merged entry) as the served web frontend — declared
// identically so the two augmentations agree.
declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    url_for_resource: ToolContract<{ url: string | null }, { name: string }>;  // a URL for the file, or null if not publicly viewable
  }
}

// No HTTP server in-process, so a file is addressed by materialising its bytes into a `blob:` URL.
// These are page-scoped and deliberately never revoked — the URL is handed straight to the user/DOM,
// and revoking would break a link still in view; the leak is bounded by the document lifetime.
// Same default-deny gate as the served frontend: only files marked `allowed` get a URL.
const urlForResourceTool: Tool<ToolResultOf<'url_for_resource'>> = {
  name: 'url_for_resource',
  description:
    'Return a URL for a stored file the user can open, or null when it is not publicly viewable. Use this ' +
    'to hand the user a link to a file rather than guessing a path. Pass the same path the file was ' +
    'stored under. Only files marked viewable get a URL.',
  inputSchema: {
    type:     'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The path the file was stored under (e.g. "report.md", "charts/data.csv").' },
    },
  },
  executor: {
    async *execute(input: unknown, ctx: ToolContext) {
      const { name } = input as { name?: string };
      if (!name) { yield { type: 'error', message: 'url_for_resource requires "name".' }; return; }
      if (!ctx.files) { yield { type: 'result', value: { url: null } }; return; }
      const handle = await ctx.files.getByName(name);
      if (!handle || !handle.allowed) { yield { type: 'result', value: { url: null } }; return; }

      const bytes = await collectBytes(handle.stream(ctx.signal));
      yield { type: 'result', value: { url: URL.createObjectURL(new Blob([bytes], { type: handle.mimeType })) } };
    },
  },
};

/**
 * In-process browser frontend. Mounts a chat UI into the DOM and drives `services.run` directly —
 * the same contract a remote frontend uses over HTTP/SSE, minus the wire. The mount point is
 * `#matbot-root` if present, else `document.body`.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest:   { description: 'Browser chat frontend rendering to the DOM (in-process, no server).' },
  tools:      [urlForResourceTool],

  async setup(services: MatbotMachine): Promise<void> {
    services.registerFrontend({ name: 'frontend-dom' });
    const root = document.getElementById('matbot-root') ?? document.body;
    await new ChatUI(services, root).mount();
  },
};

import type { MatbotPluginSpec, MatbotMachine, Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { ChatUI } from './ui.js';

// No HTTP server in-process, so a file is addressed by materialising its bytes into a `blob:` URL.
// These are page-scoped and deliberately never revoked — the URL is handed straight to the user/DOM,
// and revoking would break a link still in view; the leak is bounded by the document lifetime.
// Same default-deny gate as the served frontend: only files marked `allowed` get a URL.
const urlForResourceTool: Tool = {
  name: 'url_for_resource',
  description:
    'Return a URL for a stored file the user can open, or null when it is not publicly viewable. Use this ' +
    'to hand the user a link to a file (e.g. a workspace artifact) rather than guessing a path. Only files ' +
    'marked viewable are served — workspace files are (namespace "workspace"); most other namespaces return null.\n\n' +
    'Parameters: { namespace: string, name: string } — `name` is the file path within the namespace (for a ' +
    'workspace file, the same path you wrote it under).',
  inputSchema: {
    type:     'object',
    required: ['namespace', 'name'],
    properties: {
      namespace: { type: 'string', description: 'The file namespace, e.g. "workspace".' },
      name:      { type: 'string', description: 'The file path/name within the namespace.' },
    },
  },
  executor: {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { namespace, name } = input as { namespace?: string; name?: string };
      if (!namespace || !name) { yield { type: 'error', message: 'url_for_resource requires "namespace" and "name".' }; return; }
      if (!ctx.files) { yield { type: 'result', value: { url: null } }; return; }
      const handle = await ctx.files.getByName(name, namespace);
      if (!handle || !handle.allowed) { yield { type: 'result', value: { url: null } }; return; }

      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of handle.stream(ctx.signal)) { chunks.push(chunk); total += chunk.byteLength; }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
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

import type { MatbotPluginSpec, MatbotServices, Tool, ToolContext, ToolEvent, ToolRegistry } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION }                from '@matatbread/matbot-plugin-api';
import { watchPlugins }                      from '@matatbread/matbot-core';
// Type import also brings the `SkillManager` augmentation of MatbotServices into scope.
import type { SkillManager }                 from '@matatbread/matbot-skills';
import { createWebServer, defaultWebPrincipal } from './server.js';
import process                               from 'node:process';

let webServer: Awaited<ReturnType<typeof createWebServer>> | undefined;
let toolRegistry: ToolRegistry | undefined;
const port = Number(process.env['MATBOT_WEB_PORT'] ?? 19778); // 19778 is "MB" in hex, a cute easter egg :)

// Mint a shareable URL for a stored file — but only one this server actually serves: a file marked
// `allowed` (default-deny). The path mirrors the GET /files/<namespace>/<name> route in server.ts.
// Registered only when the server is up (below), so the tool is absent when nothing is serving.
const urlForResourceTool: Tool = {
  name: 'url_for_resource',
  description:
    'Return a shareable HTTP URL for a stored file, or null when it is not publicly viewable. Use this ' +
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
      const path = `${encodeURIComponent(namespace)}/${name.split('/').map(encodeURIComponent).join('/')}`;
      yield { type: 'result', value: { url: `/files/${path}` } };
    },
  },
};


export const plugin: MatbotPluginSpec = {
  apiVersion:  PLUGIN_API_VERSION,

  async installationMessage(): Promise<string> {
    return `Go to http://localhost:${port}/ to access the web interface.`;
  },

  async setup(services: MatbotServices) {
    if (services.isSubAgent()) return;

    services.registerFrontend({ name: 'frontend-web' });

    const sessions = services.sessions;
    if (!sessions) throw new Error('frontend-web requires services.sessions');
    const run = services.run;
    if (!run) throw new Error('frontend-web requires services.run');

    webServer = createWebServer({
      store: sessions,
      run,
      vault: services.vault,
      loadPlugin:    services.loadPlugin.bind(services),
      unloadPlugin:  services.unloadPlugin.bind(services),
      watchPlugins,
      tools:         services.tools,
      ...(services.SkillManager !== undefined ? { skills: services.SkillManager } : {}),
      // Look up the resolver per request so an override registered in any load order takes effect.
      resolvePrincipal: (req) => (services.WebPrincipalResolver ?? defaultWebPrincipal)(req),
      ...(services.workdir    !== undefined ? { workdir:    services.workdir    } : {}),
      ...(services.files      !== undefined ? { files:      services.files      } : {}),
      ...(services.configPath !== undefined ? { configPath: services.configPath } : {}),
    });

    await new Promise<void>((resolve, reject) => {
      webServer!.server.once('error', (ex) => {
        if ((ex as any).code === 'EADDRINUSE') {
          console.warn(`[frontend-web] Port ${port} is already in use. Ignoring error and continuing without starting web server.`);
          webServer?.close();
          webServer = undefined;
          resolve();
        } else {
          reject(ex);
        }
      });
      webServer!.server.listen(port, '0.0.0.0', () => {
        process.stderr.write(`[frontend-web] http://localhost:${port}\n`);
        resolve();
      });
    });

    // Only advertise URL minting when a server is actually serving (not on EADDRINUSE).
    if (webServer) { services.tools.register(urlForResourceTool); toolRegistry = services.tools; }
  },

  async teardown() {
    toolRegistry?.remove('url_for_resource');
    toolRegistry = undefined;
    if (webServer) await webServer.close();
  },
};

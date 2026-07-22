import type { MatbotPluginSpec, MatbotMachine, Tool, ToolContext, ToolContract, ToolResultOf, ToolRegistry } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION }                from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    url_for_resource: ToolContract<{ url: string | null }, { namespace: string; name: string }>;  // a shareable URL for the file, or null if not publicly viewable
  }
}
import { watchPlugins, tryCurrentPrincipal }  from '@matatbread/matbot-core';
// Type import also brings the `SkillManager` augmentation of MatbotMachine into scope.
import type { SkillManager }                 from '@matatbread/matbot-skills';
import { createWebServer, defaultWebPrincipal, headerPrincipal } from './server.js';
import process                               from 'node:process';

let webServer: Awaited<ReturnType<typeof createWebServer>> | undefined;
let toolRegistry: ToolRegistry | undefined;
const port = Number(process.env['MATBOT_WEB_PORT'] ?? 19778); // 19778 is "MB" in hex, a cute easter egg :)

// Mint a shareable URL for a stored file — but only one this server actually serves: a file marked
// `allowed` (default-deny). The path mirrors the GET /files/[~<principal>/]<namespace>/<name> route in
// server.ts. Registered only when the server is up (below), so the tool is absent when nothing is serving.
//
// Built with `services` so it can detect profile-aware storage (the `profile` tool is registered iff
// profiles are active — the same capability signal the UI gates on) and bake the current principal into
// the path as `~<id>`: a plain browser GET can't send the x-matbot-principal header, so a profiled file's
// partition has to travel in the URL itself. Without profiles the path stays byte-identical to before.
function makeUrlForResourceTool(services: MatbotMachine): Tool<ToolResultOf<'url_for_resource'>> {
  return {
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
      async *execute(input: unknown, ctx: ToolContext) {
        const { namespace, name } = input as { namespace?: string; name?: string };
        if (!namespace || !name) { yield { type: 'error', message: 'url_for_resource requires "namespace" and "name".' }; return; }
        if (!ctx.files) { yield { type: 'result', value: { url: null } }; return; }
        const handle = await ctx.files.getByName(name, namespace);
        if (!handle || !handle.allowed) { yield { type: 'result', value: { url: null } }; return; }
        const principalId = services.tools?.resolve('profile') ? tryCurrentPrincipal()?.id : undefined;
        const prefix = principalId ? `~${encodeURIComponent(principalId)}/` : '';
        const path = `${encodeURIComponent(namespace)}/${name.split('/').map(encodeURIComponent).join('/')}`;
        yield { type: 'result', value: { url: `/files/${prefix}${path}` } };
      },
    },
  };
}


export const plugin: MatbotPluginSpec = {
  apiVersion:  PLUGIN_API_VERSION,

  async installationMessage(): Promise<string> {
    return `Go to http://localhost:${port}/ to access the web interface.`;
  },

  async setup(services: MatbotMachine) {
    if (services.isSubAgent()) return;

    services.registerFrontend({ name: 'frontend-web' });

    const sessions = services.sessions;
    if (!sessions) throw new Error('frontend-web requires services.sessions');
    const run = services.run;
    if (!run) throw new Error('frontend-web requires services.run');

    webServer = createWebServer({
      store: sessions,
      run,
      vault: services.Vault,
      loadPlugin:    services.loadPlugin.bind(services),
      unloadPlugin:  services.unloadPlugin.bind(services),
      watchPlugins,
      tools:         services.tools,
      // Resolve the SkillManager per call, not once here: frontend-web loads before the skills plugin,
      // so a snapshot would capture undefined forever (services.SkillManager is a live registry getter).
      skills:        () => services.SkillManager,
      // An explicit `x-matbot-principal` header wins over any registered resolver (so a browser acting as
      // a chosen profile is honoured even when web-principal-user/auth pins a default identity); absent it,
      // a registered WebPrincipalResolver takes effect, else the header-aware default. Resolver looked up
      // per request so a registration in any load order applies.
      resolvePrincipal: (req) => headerPrincipal(req) ?? (services.WebPrincipalResolver ?? defaultWebPrincipal)(req),
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

    // Only advertise these when a server is actually serving (not on EADDRINUSE): both need a live
    // browser on the other end — url minting serves over the HTTP routes, web_user_environment
    // round-trips an expression to the attached browser's sandboxed Worker.
    if (webServer) {
      services.tools.register(makeUrlForResourceTool(services));
      services.tools.register(webServer.webEnvTool);
      toolRegistry = services.tools;
    }
  },

  async teardown() {
    toolRegistry?.remove('url_for_resource');
    toolRegistry?.remove('web_user_environment');
    toolRegistry = undefined;
    if (webServer) await webServer.close();
  },
};

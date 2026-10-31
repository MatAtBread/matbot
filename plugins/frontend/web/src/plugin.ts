import type { MatbotPluginSpec, MatbotMachine, Tool, ToolContext, ToolContract, ToolResultOf, ToolRegistry } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION }                from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    url_for_resource: ToolContract<{ url: string | null }, { name: string }>;  // a server-relative URL PATH for the file, or null if not publicly viewable
  }
}
import { createWebServer, defaultWebPrincipal, headerPrincipal, urlPrincipal } from './server.js';
import process                               from 'node:process';

let webServer: Awaited<ReturnType<typeof createWebServer>> | undefined;
let toolRegistry: ToolRegistry | undefined;
const port = Number(process.env['MATBOT_WEB_PORT'] ?? 19778); // 19778 is "MB" in hex, a cute easter egg :)

// Mint a shareable URL for a stored file — but only one this server actually serves: a file marked
// `allowed` (default-deny). The path mirrors the GET /files/[~<principal>/]<namespace>/<name> route in
// server.ts. Registered only when the server is up (below), so the tool is absent when nothing is serving.
//
// Built with `services` so it can ask `FilePartition` which file area the bytes actually went to and bake
// that into the path as `~<token>`: a plain browser GET can't send the x-matbot-principal header, so a
// partitioned file's area has to travel in the URL itself. The base area answers `undefined` and the path
// stays byte-identical to an unpartitioned deployment's.
function makeUrlForResourceTool(services: MatbotMachine): Tool<ToolResultOf<'url_for_resource'>> {
  return {
    name: 'url_for_resource',
    description:
      'Return the URL PATH a stored file is served at, or null when it is not publicly viewable. Use this ' +
      'to hand the user a link to a file rather than guessing a path. Pass the same path the file was ' +
      'stored under. Only files marked viewable get one.\n' +
      'The result is a PATH relative to this server\'s own origin (e.g. "/files/workspace/report.md"), ' +
      'and this server cannot know what host or port a reader reaches it on. Quote it exactly as ' +
      'returned. Prefix an origin only if one was actually supplied in this conversation — the ' +
      'browser\'s own origin, or one the user gave; never infer one, and never substitute a ' +
      'development default such as localhost:19778.',
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
        // The route's namespace segment comes from the stored handle, never from the caller: the file's
        // content namespace is an implementation detail of whichever tool wrote it, and asking the model
        // for it invited confusion with `share`'s isolation-axis namespace (they are different levels).
        // No stored namespace ⇒ no addressable path under this route, so report it as not viewable.
        if (handle.namespace === undefined) { yield { type: 'result', value: { url: null } }; return; }
        // The partition, NOT the principal: one principal may hold several profiles, and a profile may
        // alias its files onto another's area, so the identity in force does not name the area its writes
        // land in. Asking the router (the same one `ctx.files.put` routed through) is the only way to get
        // an address that reads back — and it answers `undefined` for the shared base, which is why an
        // unprofiled file no longer acquires a spurious `~<id>`.
        const partition = services.FilePartition?.current();
        const prefix = partition ? `~${encodeURIComponent(partition)}/` : '';
        const path = `${encodeURIComponent(handle.namespace)}/${name.split('/').map(encodeURIComponent).join('/')}`;
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

    // A browser origin other than this server's own that may call it — a dashboard hosted elsewhere.
    // Absent means same-origin only, which is all the UI and the files this server serves need.
    const cors = await services.settings().get<unknown>('cors_origin');

    webServer = createWebServer({
      store: sessions,
      run,
      vault: services.Vault,
      loadPlugin:    services.loadPlugin.bind(services),
      unloadPlugin:  services.unloadPlugin.bind(services),
      tools:         services.tools,
      ...(typeof cors === 'string' && cors !== '' ? { cors } : {}),
      refuseOwnProcess: true,
      // An explicit `x-matbot-principal` header wins over any registered resolver (so a browser acting as
      // a chosen profile is honoured even when web-principal-user/auth pins a default identity); absent it,
      // a registered WebPrincipalResolver takes effect, else the header-aware default. Resolver looked up
      // per request so a registration in any load order applies.
      resolvePrincipal: (req) => headerPrincipal(req) ?? urlPrincipal(req) ?? (services.WebPrincipalResolver ?? defaultWebPrincipal)(req),
      ...(services.workdir    !== undefined ? { workdir:    services.workdir    } : {}),
      ...(services.files      !== undefined ? { files:      services.files      } : {}),
      // Partition-aware file watch, resolved per call (a thunk, like `skills`): a partitioning backend may
      // register it after frontend-web sets up, and the firehose only reads it on the first /events connect.
      watchVisibility: () => services.WatchVisibility,
      filePartition:   () => services.FilePartition,
      mediaStore:      () => services.MediaStore,
      permissionGate:  () => services.PermissionGate,
      notifier:        services.Notifier,
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
        // A dashboard the model writes is served from here and calls tools from the browser; nothing else
        // tells the model that the route exists. Its own process is refused (`refuseOwnProcess`), so this is
        // not an invitation to reach the UI's endpoints with `http` — it already holds every tool directly.
        services.systemContext.register(() =>
          'Every registered tool can be invoked over HTTP via the relative URL `/tools`. ' +
          '`POST /tools/<name>` with the JSON params as the body (sent as `Content-Type: application/json` — ' +
          'any other POST is refused) returns the result as JSON (a tool error is a ' +
          'non-2xx status with `{ error }`); `POST /stream/tools/<name>` streams the tool\'s events as SSE. ' +
          'It is for pages this server serves, such as a live dashboard, calling tools from the browser. ' +
          'Requests from matbot\'s own process are refused; call the tool directly instead.');
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

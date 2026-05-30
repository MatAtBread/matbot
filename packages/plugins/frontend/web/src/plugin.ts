import type { MatbotPlugin, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION }                from '@matatbread/matbot-plugin-api';
import { resolveProviderFactory }            from '@matatbread/matbot-core';
import { createWebServer }                   from './server.js';
import process                               from 'node:process';

let webServer: Awaited<ReturnType<typeof createWebServer>> | undefined;

export const plugin: MatbotPlugin = {
  name:       'frontend-web',
  apiVersion: PLUGIN_API_VERSION,

  async setup(services: MatbotServices) {
    if (process.env['MATBOT_BACKGROUND'] === '1') return;

    services.registerFrontend?.();

    const sessions = services.sessions;
    if (!sessions) throw new Error('frontend-web requires services.sessions');

    const providers = new Map(
      [...services.providers.values()]
        .filter((cfg, i, arr) => arr.findIndex(c => c.type === cfg.type) === i)
        .map(cfg => [cfg.type, resolveProviderFactory(cfg.type)(cfg)]),
    );

    services.systemContext.register(() => {
      const tools = services.tools.list();
      if (tools.length === 0) return null;
      const lines = tools.map(t => `- \`${t.name}\`: ${t.description}`).join('\n');
      return (
        `Tools are available via HTTP from the current host.n\n` +
        `POST /tools/<name>\n` +
        `Request body: the tool's JSON input directly (matches the tool's inputSchema).\n` +
        `Response: the tool's result as JSON on success (200), or { error, stdout?, stderr? } on failure (500).\n\n` +
        `Available tools:\n${lines}`
      );
    });

    webServer = createWebServer({
      store:         sessions,
      providers,
      configs:       /*new Map(*/services.providers/*)*/,
      vault:         services.vault,
      loadPlugin:    services.loadPlugin.bind(services),
      unloadPlugin:  services.unloadPlugin.bind(services),
      tools:         services.tools,
      hooks:         services.hooks,
      systemContext: services.systemContext,
      ...(services.workdir    !== undefined ? { workdir:    services.workdir    } : {}),
      ...(services.files      !== undefined ? { files:      services.files      } : {}),
      ...(services.configPath !== undefined ? { configPath: services.configPath } : {}),
    });

    const port = Number(process.env['MATBOT_WEB_PORT'] ?? 19778); // 19778 is "MB" in hex, a cute easter egg :)

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
  },

  async teardown() {
    if (webServer) await webServer.close();
  },
};

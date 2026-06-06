import type { MatbotPlugin, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION }                from '@matatbread/matbot-plugin-api';
import { createWebServer }                   from './server.js';
import process                               from 'node:process';

let webServer: Awaited<ReturnType<typeof createWebServer>> | undefined;
const port = Number(process.env['MATBOT_WEB_PORT'] ?? 19778); // 19778 is "MB" in hex, a cute easter egg :)


export const plugin: MatbotPlugin = {
  name:        'frontend-web',
  apiVersion:  PLUGIN_API_VERSION,

  async installationMessage(): Promise<string> {
    return `Go to http://localhost:${port}/ to access the web interface.`;
  },

  async setup(services: MatbotServices) {
    if (process.env['IS_SUB_AGENT'] === '1') return;

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
      tools:         services.tools,
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
  },

  async teardown() {
    if (webServer) await webServer.close();
  },
};

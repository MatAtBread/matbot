import type { MatbotPlugin, MatbotServices } from '@matbot/plugin-api';
import { PLUGIN_API_VERSION }                from '@matbot/plugin-api';
import { resolveProviderFactory }            from '@matbot/core';
import { createWebServer }                   from './server.js';
import { makeSessionTools }                  from './tools/session.js';
import type { Server }                       from 'node:http';
import process                               from 'node:process';

let server: Server | undefined;

export const plugin: MatbotPlugin = {
  name:       'frontend-web',
  apiVersion: PLUGIN_API_VERSION,

  async setup(services: MatbotServices) {
    const sessions = services.stores?.sessions;
    if (!sessions) throw new Error('frontend-web requires services.stores.sessions');

    for (const tool of makeSessionTools(sessions)) {
      services.tools.register(tool);
    }

    const providers = new Map(
      [...services.providers.values()]
        .filter((cfg, i, arr) => arr.findIndex(c => c.type === cfg.type) === i)
        .map(cfg => [cfg.type, resolveProviderFactory(cfg.type)(cfg)]),
    );

    const port  = Number(process.env['MATBOT_WEB_PORT'] ?? 19778); // 19778 is "MB" in hex, a cute easter egg :)

    server = createWebServer({
      store:      sessions,
      providers,
      configs:    new Map(services.providers),
      vault:      services.vault,
      loadPlugin: services.loadPlugin.bind(services),
      tools:      services.tools,
      hooks:      services.hooks,
      ...(services.workdir !== undefined ? { workdir: services.workdir } : {}),
    });

    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(port, () => {
        process.stderr.write(`[frontend-web] http://localhost:${port}\n`);
        resolve();
      });
    });
  },

  async teardown() {
    await new Promise<void>((resolve, reject) => {
      if (!server) { resolve(); return; }
      server.close(err => (err ? reject(err) : resolve()));
    });
  },
};

import { registerHooks, createRequire } from 'node:module';
import { dirname } from 'node:path';
import { createHooks } from './ts-hooks.js';

// Host-shared packages that must stay singletons across the plugin/host boundary:
// the plugin API loads them, plugins import them, and they carry runtime identity
// (e.g. MissingSecretError, matched with `instanceof`). The hot-reload freshness
// hook (ts-hooks.js) must NOT re-stamp anything under these directories, or a
// reloaded plugin gets a duplicate copy and identity checks silently fail.
//
// Resolved location-independently: anchor on @matatbread/matbot-core (a direct
// dependency of this app), then resolve plugin-api from core's own context. The
// package root is two levels up from the entry (…/<pkg>/{src,dist}/index.*), which
// holds whether running from TS source or a compiled build.
function hostSharedDirs() {
  const dirs = [];
  const here = createRequire(import.meta.url);
  const pkgRoot = (req, name) => {
    try { return dirname(dirname(req.resolve(name))); }
    catch { return undefined; }
  };
  const coreRoot = pkgRoot(here, '@matatbread/matbot-core');
  if (coreRoot !== undefined) {
    dirs.push(coreRoot);
    const fromCore = createRequire(here.resolve('@matatbread/matbot-core'));
    const apiRoot = pkgRoot(fromCore, '@matatbread/matbot-plugin-api');
    if (apiRoot !== undefined) dirs.push(apiRoot);
  }
  return dirs;
}

// In-thread, through `registerHooks()`. `register()` runs hooks on a thread of their own, and since Node 24.12
// the main thread blocks on a round trip to it for every resolve and every load — most of a boot's time, with
// the few hundred modules matbot loads. It is also deprecated (DEP0205).
registerHooks(createHooks({ exclude: hostSharedDirs() }));

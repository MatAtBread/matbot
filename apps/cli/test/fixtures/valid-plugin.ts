// A minimal, well-formed plugin: exports a `plugin` object with a compatible apiVersion and no
// lifecycle work. Used to prove a successful (re)load clears any prior recorded load failure for the
// same specifier — the "fix it and reload, it drops off the failed list" path.
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';

export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
};

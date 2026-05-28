import { PLUGIN_API_VERSION } from '@matbot/plugin-api';
import type { MatbotPlugin } from '@matbot/plugin-api';
import path from 'node:path';
import process from 'node:process';
import { createSkillIndexHook, createClassifierSetupHook, createSkillClassifierHook } from '@matbot/skills-base';
import type { SkillEntry } from '@matbot/skills-base';
import { watchSkillDir } from './watcher.js';
import { readSkillContent } from './reader.js';
import { createSkillTools } from './tools.js';

export interface SkillsPluginConfig {
  skillsDir: string;
  pollMs?:   number;
}

export function createSkillsPlugin(config: SkillsPluginConfig): MatbotPlugin {
  const skills = new Map<string, SkillEntry>();
  const getSkills = (): SkillEntry[] => [...skills.values()];
  const registerSkill = (entry: SkillEntry): void => {
    const ref = entry.contentRef;
    if (ref.kind === 'file') skills.set(ref.path, entry);
  };
  let abortController: AbortController | undefined;

  const tools = createSkillTools(config.skillsDir, getSkills, registerSkill);

  return {
    name:       'skills',
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      description: 'File-backed skill documents injected into sessions on demand.',
      config:      ['skillsDir'],
    },
    tools,

    async setup(services) {
      abortController = new AbortController();
      const { signal } = abortController;

      void (async () => {
        try {
          for await (const entry of watchSkillDir(config.skillsDir, signal, config.pollMs)) {
            const { contentRef } = entry;
            if (contentRef.kind === 'file') {
              skills.set(contentRef.path, entry);
            }
          }
        } catch {
          // Watcher exits on abort — not an error
        }
      })();

      const pluginSettings = services.settings('skills');
      services.hooks.register(createClassifierSetupHook(pluginSettings, services.providers, getSkills));
      // services.hooks.register(createSkillIndexHook(getSkills));
      services.hooks.register(createSkillClassifierHook(getSkills, readSkillContent, pluginSettings, req => services.complete(req)));
    },

    async teardown() {
      abortController?.abort();
    },
  };
}

// ── Default plugin export ─────────────────────────────────────────────────────

// Exported as a singleton so the loader can import it without a factory call.
// skillsDir is resolved in setup() because it depends on services.extensions,
// which is only available at runtime.
export const plugin: MatbotPlugin = (() => {
  let inner: MatbotPlugin | undefined;

  return {
    name:       'skills',
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      description: 'File-backed skill documents injected into sessions on demand.',
      config:      ['skillsDir'],
    },

    async setup(services) {
      const extCfg = (services.extensions?.['skills'] as Record<string, unknown> | undefined) ?? {};
      const rawDir = extCfg['skillsDir'];
      const skillsDir = typeof rawDir === 'string'
        ? rawDir
        : path.join(process.cwd(), '.data', 'skills');

      inner = createSkillsPlugin({ skillsDir });

      // Register tools explicitly — they can't be on plugin.tools because
      // skillsDir isn't known at module evaluation time.
      for (const tool of inner.tools ?? []) {
        services.tools.register(tool);
      }

      await inner.setup?.(services);
    },

    async teardown() {
      await inner?.teardown?.();
    },
  };
})();

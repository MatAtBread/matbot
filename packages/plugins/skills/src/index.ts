export type { SkillEntry }                  from './types.js';
export { makeSkillEntry }                   from './types.js';
export { createSkillIndexHook,
         createClassifierSetupHook,
         createSkillClassifierHook }        from './hooks.js';
export { watchSkillDir }                    from './watcher.js';
export { readSkillContent }                 from './reader.js';
export { createSkillTools }                 from './tools.js';
export { createSkillsPlugin, plugin }       from './plugin.js';
export type { SkillsPluginConfig }          from './plugin.js';

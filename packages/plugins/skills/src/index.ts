export type { SkillDoc }                    from './types.js';
export { createSkillIndexHook,
         createUserMessageClassifierHook,
         createAgentMessageClassifierHook }        from './hooks.js';
export { watchAndImportSkillDir }           from './watcher.js';
export { createSkillTools }                 from './tools.js';
export { createSkillsPlugin, plugin }       from './plugin.js';
export type { SkillsPluginConfig }          from './plugin.js';

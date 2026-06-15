export type { SkillDoc, SkillTrigger, TriggerPhase } from './types.js';
export { SkillManager, skillToKnowledgeEntry } from './manager.js';
export type { SkillSummary }                from './manager.js';
export { createSkillTool, createSkillTriggersTool, createSingleTurnTool } from './tools.js';
export { createSkillsPlugin, setupSkills, plugin } from './plugin.js';

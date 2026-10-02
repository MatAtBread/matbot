import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { createBackgroundJobsPlugin } from './jobs.js';
import { inProcessRunner } from './in-process.js';

export * from './jobs.js';
export { inProcessRunner } from './in-process.js';

/** Jobs run in this process, on an ephemeral run — the cross-runtime choice, and the browser's only one. */
export const plugin: MatbotPluginSpec = createBackgroundJobsPlugin({
  description: 'Background jobs — now, at a time, or on an interval — that report into a conversation by appending to it. '
    + 'Jobs run in this process; @matatbread/matbot-background-jobs-node runs each in its own.',
  runner:      inProcessRunner,
});

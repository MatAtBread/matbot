// A stand-in job for background-jobs.test.ts: speaks the real protocol over the real IPC channel, then exits on its
// own — which it can only do if its end of the channel does not hold the event loop open.
import { connectToParent, type Endpoint, type JobInfo } from '../../../../plugins/background-jobs/src/channel.ts';

const link = connectToParent(process as unknown as Endpoint, process.channel);
const job  = await link.request<JobInfo>({ op: 'job' });
const sent = await link.request({ op: 'append', messages: [{ role: 'assistant', content: [{ type: 'text', text: `hello from ${job.id}` }] }] });
let refused = '';
try { await link.request({ op: 'append', messages: [{ role: 'user', content: [{ type: 'text', text: 'pretending' }] }] as never }); }
catch (e) { refused = (e as Error).message; }
link.post({ op: 'notify', notification: {
  kind: '@matatbread/matbot-plugin-api#ItemChange', plugin: 'workspace', source: 'workspace',
  namespace: 'files', id: 'f1', operation: 'saved',
} });
await link.flush();
process.stdout.write(JSON.stringify({ job, sent, refused }));

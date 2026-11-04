// A stand-in for the CLI a job process would be, for background-jobs-in-flight.test.ts: records what it was
// started with, then runs until it is killed, so a cancel has a real process to end.
import { writeFileSync } from 'node:fs';

let config = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => { config += chunk; });
process.stdin.on('end', () => {
  writeFileSync(process.env['JOB_PROBE_FILE']!, JSON.stringify({
    pid: process.pid, config,
    isSubAgent: process.env['IS_SUB_AGENT'], principal: process.env['MATBOT_PRINCIPAL'],
  }));
});
setInterval(() => {}, 1000);

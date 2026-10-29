import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MatbotMachine, Tool, ToolEvent } from '../../../plugin-api/src/index.ts';

// docker-bash finds its container by NAME, and the name is the model's to change (`bash_config set`). Every
// path that reuses, replaces or removes one went by that name alone, so naming another container — a
// database, another project's shell — got it exec'd into or deleted with `rm -f`. A container is now used
// or removed only if docker-bash made it for this project.
//
// Against a fake `docker` on PATH, which keeps its containers in a JSON file.

interface Fake { running: boolean; labels: Record<string, string>; mounts: { Source: string; Destination: string }[] }
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.FAKE_DOCKER_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const [cmd, ...rest] = process.argv.slice(2);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
state.log.push([cmd, ...rest].join(' '));
const c = state.containers;
if (cmd === 'inspect') {
  const name = rest[rest.length - 1];
  if (!c[name]) { save(); process.stderr.write('Error: No such object: ' + name); process.exit(1); }
  save();
  process.stdout.write([JSON.stringify(c[name].running), JSON.stringify(c[name].labels), JSON.stringify(c[name].mounts)].join('\\t') + '\\n');
} else if (cmd === 'rm') {
  delete c[rest[rest.length - 1]]; save();
} else if (cmd === 'start') {
  c[rest[0]].running = true; save();
} else if (cmd === 'run') {
  const labels = {}, mounts = [];
  let name;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--name') name = rest[++i];
    else if (rest[i] === '--label') { const [k, ...v] = rest[++i].split('='); labels[k] = v.join('='); }
    else if (rest[i] === '-v') { const [s, d] = rest[++i].split(':'); mounts.push({ Source: s, Destination: d }); }
  }
  c[name] = { running: true, labels, mounts }; save();
} else { save(); }
`;

const dir = await mkdtemp(join(tmpdir(), 'docker-bash-own-'));
const project = join(dir, 'project');
const stateFile = join(dir, 'state.json');
await writeFile(join(dir, 'docker'), FAKE_DOCKER);
await chmod(join(dir, 'docker'), 0o755);
process.env['PATH'] = `${dir}:${process.env['PATH'] ?? ''}`;
process.env['FAKE_DOCKER_STATE'] = stateFile;
await (await import('node:fs/promises')).mkdir(project, { recursive: true });
// The plugin takes its project root from the working directory when it loads.
process.chdir(project);
const { plugin } = await import('../../../plugins/docker-bash/src/index.ts');

const tools = new Map<string, Tool>();
const stored = new Map<string, unknown>();
await plugin.setup!({
  settings: () => ({
    get: async (k: string) => stored.get(k),
    set: async (k: string, v: unknown) => { stored.set(k, v); },
    delete: async (k: string) => { stored.delete(k); },
  }),
  tools: { register: (t: Tool) => { tools.set(t.name, t); } },
} as unknown as MatbotMachine);

async function reset(containers: Record<string, Fake>): Promise<void> {
  stored.clear();
  await writeFile(stateFile, JSON.stringify({ containers, log: [] }));
}
async function state(): Promise<{ containers: Record<string, Fake>; log: string[] }> {
  return JSON.parse(await readFile(stateFile, 'utf8')) as { containers: Record<string, Fake>; log: string[] };
}
async function config(params: object): Promise<ToolEvent> {
  let last: ToolEvent | undefined;
  for await (const ev of tools.get('bash_config')!.executor.execute(params, { signal: new AbortController().signal } as never)) last = ev as ToolEvent;
  return last!;
}

const foreign: Fake = { running: true, labels: { 'com.example': 'db' }, mounts: [{ Source: '/srv/db', Destination: '/var/lib/db' }] };

test("a container of docker-bash's name that it did not make is neither used nor removed", async () => {
  await reset({ 'matbot-bash': foreign });
  const ev = await config({ action: 'restart' });
  assert.equal(ev.type, 'error');
  assert.match((ev as { message: string }).message, /did not create for this project/);
  const s = await state();
  assert.deepEqual(s.containers['matbot-bash'], foreign, 'still there, untouched');
  assert.ok(!s.log.some(l => l.startsWith('rm') || l.startsWith('run')), s.log.join('\n'));
});

test('naming another container is refused before anything changes', async () => {
  await reset({ postgres: foreign });
  const ev = await config({ action: 'set', name: 'postgres' });
  assert.equal(ev.type, 'error');
  assert.match((ev as { message: string }).message, /"postgres" exists that docker-bash did not create/);
  assert.equal(stored.size, 0, 'the setting is not written');
  assert.deepEqual((await state()).containers['postgres'], foreign);
});

test('another project\'s docker-bash container is not this one\'s', async () => {
  await reset({ 'matbot-bash': { running: true, labels: { 'matbot.docker-bash.project': '/elsewhere' }, mounts: [] } });
  assert.equal((await config({ action: 'restart' })).type, 'error');
  assert.ok((await state()).containers['matbot-bash'], 'left alone');
});

test('its own container is recreated, and labelled with the project it belongs to', async () => {
  // One from before the project label: recognised by mounting this project where docker-bash mounts it.
  await reset({ 'matbot-bash': { running: true, labels: { 'matbot.readonly': 'ro:settings;hidden:' }, mounts: [{ Source: project, Destination: '/app' }] } });
  const ev = await config({ action: 'restart' });
  assert.equal(ev.type, 'result', JSON.stringify(ev));
  const s = await state();
  assert.ok(s.log.some(l => l === 'rm -f matbot-bash'));
  assert.equal(s.containers['matbot-bash']!.labels['matbot.docker-bash.project'], project);
  // And now it is recognised by its label.
  assert.equal((await config({ action: 'restart' })).type, 'result');
});

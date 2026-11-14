import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-core';

// core-alone.test.ts and embedder.test.ts build their machines inside this process, which runs under the
// CLI's own module hooks — so neither shows that an application gets by with what host-node documents:
// `node --import @matatbread/matbot-host-node/register app.ts` and nothing else. This runs that, in a fresh
// process with none of the CLI's hooks loaded.
//
// The application is laid out as an installed one would be: its own directory, with a node_modules beside
// it. matbot's packages are linked in (they resolve to their source, outside any node_modules), and the
// provider plugin is a REAL directory inside node_modules, written in TypeScript — which is the case Node
// refuses to strip by itself, and the reason the register hook exists.

const cliModules = join(import.meta.dirname, '..', 'node_modules', '@matatbread');

const app = `
import { assembleMachine, ProviderRegistryImpl, VaultImpl, createSession, runAs, installPrincipalCarrier, installUsageCarrier } from '@matatbread/matbot-core';
import type { Principal } from '@matatbread/matbot-core';
import { MemoryStorageBackend } from '@matatbread/matbot-core/storage-base';
import { createAlsPrincipalCarrier, createAlsUsageCarrier, nodePluginMembers } from '@matatbread/matbot-host-node';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

const me: Principal = { id: 'me', type: 'user' };
const { services, loaded } = assembleMachine({
  bootBackend: new MemoryStorageBackend(),
  vault:       new VaultImpl({}),
  providers:   new ProviderRegistryImpl([['p', { name: 'p', module: 'echo-provider', model: 'm' }]]),
  version:     'embedded',
  host: machine => ({ ...nodePluginMembers(machine, import.meta.dirname), isSubAgent: () => false }),
});
loaded();

let reply = '';
await runAs(me, async () => {
  const session = createSession();
  await services.sessions.set(session.id, session);
  const turn = await services.run.open({
    sessionId: session.id, provider: 'p', principal: me,
    content: [{ type: 'text', text: 'hi' }], signal: AbortSignal.timeout(10_000),
  });
  for await (const event of turn.events) {
    if (event.type === 'text-delta') reply += event.delta;
    if (event.type === 'error') throw new Error(event.error);
    if (event.type === 'idle') break;
  }
});
console.log(JSON.stringify({ reply }));
process.exit(0);
`;

const provider = `
interface Adapter { name: string; health(): Promise<{ ok: boolean }>; complete(): AsyncIterable<unknown> }
const adapter: Adapter = {
  name: 'echo-provider',
  async health() { return { ok: true }; },
  async *complete() { yield { type: 'text-delta', delta: 'hello from node_modules' }; yield { type: 'done' }; },
};
export const plugin = { apiVersion: ${JSON.stringify(PLUGIN_API_VERSION)}, provider: () => adapter };
`;

async function layOut(dir: string): Promise<void> {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'embedder', private: true, type: 'module' }));
  await writeFile(join(dir, 'app.ts'), app);
  await mkdir(join(dir, 'node_modules', 'echo-provider'), { recursive: true });
  await symlink(cliModules, join(dir, 'node_modules', '@matatbread'), 'dir');
  await writeFile(join(dir, 'node_modules', 'echo-provider', 'package.json'), JSON.stringify({
    name: 'echo-provider', version: '1.0.0', type: 'module', matbotRuntime: ['node'], exports: './index.ts',
  }));
  await writeFile(join(dir, 'node_modules', 'echo-provider', 'index.ts'), provider);
}

function run(dir: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  // NODE_OPTIONS is dropped so nothing of the caller's — a --import of the CLI's hooks included — reaches the child.
  const { NODE_OPTIONS: _, ...env } = process.env;
  const child = spawn(process.execPath, [...args, 'app.ts'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => { out += c; });
  child.stderr.setEncoding('utf8').on('data', (c: string) => { err += c; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  return new Promise(resolve => child.once('close', code => { clearTimeout(timer); resolve({ code, out, err }); }));
}

test('an application started with only host-node\'s register hook boots, loads a plugin from node_modules and runs a turn', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-embedder-process-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await layOut(dir);

  const { code, out, err } = await run(dir, ['--import', '@matatbread/matbot-host-node/register']);
  assert.equal(code, 0, `the application exited cleanly\n--- stderr ---\n${err}`);
  assert.deepEqual(JSON.parse(out.trim().split('\n').at(-1) ?? 'null'), { reply: 'hello from node_modules' }, `stdout:\n${out}\nstderr:\n${err}`);
});

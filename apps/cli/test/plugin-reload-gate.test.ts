import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { ToolContext, ToolEvent } from '@matatbread/matbot-core';
import { pluginTool, pluginFingerprint, recordLoaded } from '../src/plugins/index.js';

// A reload imports whatever is on disk now, or freshly fetched upstream — and the model can change both. So
// reloading a resident plugin is unasked only while its code is what was loaded; changed code is the
// user's to approve (#111). These drive the real executor; the host's record is made as the CLI makes it.

async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-reload-gate-'));
  await writeFile(join(dir, 'matbot.yaml'), 'plugins:\n');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'host-project', private: true }));
  const plugin = join(dir, 'mine');
  await mkdir(plugin);
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'mine', matbotRuntime: ['node'], exports: './index.ts' }));
  await writeFile(join(plugin, 'index.ts'), 'export const plugin = { v: 1 };\n');
  return { dir, plugin, configPath: join(dir, 'matbot.yaml'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function host(configPath: string, allow: boolean) {
  const asked: string[] = [];
  const did: string[] = [];
  const ctx = {
    callId: 't', signal: new AbortController().signal, configPath, prompt: async () => undefined,
    gate: async (req: { gate: string; subject: string }) => { asked.push(`${req.gate} ${req.subject}`); return { allowed: allow, source: 'user' }; },
    loadPlugin:   async (s: string) => { did.push(`load ${s}`); return {}; },
    unloadPlugin: async (s: string) => { did.push(`unload ${s}`); return true; },
  } as unknown as ToolContext;
  const call = async (input: Record<string, unknown>): Promise<string> => {
    const events: ToolEvent[] = [];
    for await (const e of pluginTool.executor.execute(input, ctx)) events.push(e as ToolEvent);
    return events.map(e => e.type === 'result' ? (e.value as { message?: string }).message ?? '' : e.type === 'error' ? e.message : '').join('');
  };
  return { asked, did, call };
}

test('unchanged code reloads unasked; changed code is asked about before anything is unloaded', async () => {
  const p = await project();
  try {
    recordLoaded(p.plugin, pluginFingerprint(p.plugin, p.dir));

    const same = host(p.configPath, false);
    assert.match(await same.call({ action: 'reload', specifier: p.plugin }), /reloaded successfully/);
    assert.deepEqual(same.asked, []);

    await writeFile(join(p.plugin, 'index.ts'), 'export const plugin = { v: 2 };\n');
    const refused = host(p.configPath, false);
    assert.match(await refused.call({ action: 'reload', specifier: p.plugin }), /changed code/);
    assert.deepEqual(refused.asked, [`reload ${p.plugin}`]);
    assert.deepEqual(refused.did, [], 'a refusal leaves the plugin running as it was');

    const allowed = host(p.configPath, true);
    assert.match(await allowed.call({ action: 'reload', specifier: p.plugin }), /reloaded successfully/);
    assert.deepEqual(allowed.did, [`unload ${p.plugin}`, `load ${p.plugin}`]);
  } finally { await p.cleanup(); }
});

test('a new file counts as a change; node_modules and dot-directories do not', async () => {
  const p = await project();
  try {
    const before = await pluginFingerprint(p.plugin, p.dir);
    await mkdir(join(p.plugin, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(p.plugin, 'node_modules', 'dep', 'x.js'), '1');
    await mkdir(join(p.plugin, '.cache'));
    await writeFile(join(p.plugin, '.cache', 'y'), '1');
    assert.equal(await pluginFingerprint(p.plugin, p.dir), before);
    await writeFile(join(p.plugin, 'helper.ts'), 'export const h = 1;\n');
    assert.notEqual(await pluginFingerprint(p.plugin, p.dir), before);
  } finally { await p.cleanup(); }
});

test('a refreshed upstream copy that changed is asked about, and refused restores the cached one', { timeout: 60_000 }, async () => {
  const files: Record<string, string> = {
    '/p/package.json': JSON.stringify({ name: '@fixture/reload-gate', matbotRuntime: ['node'], exports: './index.ts' }),
    '/p/index.ts': 'export const plugin = { v: 1 };\n',
  };
  const server = http.createServer((req, res) => {
    const body = files[req.url ?? ''];
    if (body === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(body);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const spec = `http://127.0.0.1:${(server.address() as { port: number }).port}/p/`;
  const p = await project();
  try {
    recordLoaded(spec, pluginFingerprint(spec, p.dir));
    assert.notEqual(await pluginFingerprint(spec, p.dir), undefined);

    files['/p/index.ts'] = 'export const plugin = { v: 2 };\n';
    const refused = host(p.configPath, false);
    assert.match(await refused.call({ action: 'reload', specifier: spec }), /restored and is active again/);
    assert.deepEqual(refused.asked, [`reload ${spec}`]);
    assert.match(await import('node:fs/promises').then(fs => fs.readFile(join(p.dir, '.plugins', new URL(spec).host, 'p', 'index.ts'), 'utf8')), /v: 1/);
  } finally { await p.cleanup(); await new Promise<void>(r => server.close(() => r())); }
});

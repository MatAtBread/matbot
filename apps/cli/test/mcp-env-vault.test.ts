import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionRequest, Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import { VaultImpl, permitted } from '@matatbread/matbot-core';
import { createMCPPlugin } from '../../../plugins/mcp/src/plugin.ts';

// `.env` no longer reaches a server by inheritance (#111), so a local server's token is named in its `env`
// as `${KEY}` and read from the vault as it starts — never written into the stored config — and the spawn
// prompt says which keys it is given.

// A stdio MCP server whose one tool is named after what it found in its environment.
const SERVER = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === 'initialize' ? {}
    : m.method === 'tools/list' ? { tools: [{ name: 'saw_' + String(process.env.SERVER_TOKEN) + '_' + String(process.env.INHERITED_SECRET), inputSchema: { type: 'object' } }] }
    : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});`;

test("a ${KEY} in a local server's env is read from the vault, named in the prompt, and stored as written", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-mcp-env-'));
  const saved = process.env['INHERITED_SECRET'];
  delete process.env['INHERITED_SECRET'];
  try {
    const script = join(dir, 'server.cjs');
    await writeFile(script, SERVER);
    const stored = new Map<string, unknown>();
    const tools = new Map<string, Tool>();
    const plugin = createMCPPlugin();
    await plugin.setup?.({
      tools: { register: (t: Tool) => { tools.set(t.name, t); }, remove: (n: string) => tools.delete(n), resolve: (n: string) => tools.get(n) ?? null, list: () => [...tools.values()] },
      Vault: new VaultImpl({ SERVER_TOKEN: 'sk-abc', INHERITED_SECRET: 'nope' }),
      settings: () => ({ get: async (k: string) => stored.get(k), set: async (k: string, v: unknown) => { stored.set(k, v); }, delete: async (k: string) => { stored.delete(k); } }),
    } as never);

    const asked: PermissionRequest[] = [];
    const ctx = { callId: 'c', signal: new AbortController().signal, gate: async (r: PermissionRequest) => { asked.push(r); return permitted('user'); } } as unknown as ToolContext;
    const events: ToolEvent[] = [];
    for await (const e of tools.get('mcp_action')!.executor.execute(
      { action: 'add', name: 'probe', type: 'local', command: process.execPath, args: [script], env: { SERVER_TOKEN: '${SERVER_TOKEN}' } }, ctx)) events.push(e);

    const result = events.find(e => e.type === 'result') as { value: { tools: string[] } } | undefined;
    assert.ok(result, JSON.stringify(events));
    assert.deepEqual(result.value.tools, ['mcp__probe__saw_sk-abc_undefined'], 'given the key it names, and nothing inherited');
    assert.match(asked[0]?.label ?? '', /given the vault key \*\*SERVER_TOKEN\*\*/);
    assert.deepEqual((stored.get('servers') as { servers: { env: unknown }[] }).servers[0]?.env, { SERVER_TOKEN: '${SERVER_TOKEN}' });
    await plugin.teardown?.();
  } finally {
    if (saved !== undefined) process.env['INHERITED_SECRET'] = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

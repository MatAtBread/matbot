import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadDotEnv, readDotEnv, withholdDotEnv } from '../src/config.js';

// A secret in `process.env` is inherited by every process matbot starts — `bash`, an MCP server, `npm`
// running a fetched plugin's install scripts — with no gate asked (#111). So `.env` is the vault's alone.

test(".env's secrets never reach the environment, however they got there; matbot's own settings do", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-dotenv-'));
  const keys = ['MATBOT_TEST_SECRET', 'MATBOT_TEST_PRESET', 'MATBOT_WEB_PORT'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    await writeFile(join(dir, '.env'), 'MATBOT_TEST_SECRET=sk-1\nMATBOT_TEST_PRESET=sk-2\nMATBOT_WEB_PORT=12345\n');
    delete process.env['MATBOT_TEST_SECRET'];
    delete process.env['MATBOT_WEB_PORT'];
    process.env['MATBOT_TEST_PRESET'] = 'sk-2';       // as a systemd EnvironmentFile= would have put it

    await loadDotEnv(dir);
    assert.equal(process.env['MATBOT_TEST_SECRET'], undefined, 'not copied in');
    assert.equal(process.env['MATBOT_WEB_PORT'], '12345', 'a setting matbot reads from the environment is');

    const dotEnv = await readDotEnv(dir);
    assert.deepEqual(dotEnv, { MATBOT_TEST_SECRET: 'sk-1', MATBOT_TEST_PRESET: 'sk-2', MATBOT_WEB_PORT: '12345' });
    withholdDotEnv(dotEnv);
    assert.equal(process.env['MATBOT_TEST_PRESET'], undefined, 'and taken out when something else put it there');
    assert.equal(process.env['MATBOT_WEB_PORT'], '12345');

    const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'console.log(String(process.env.MATBOT_TEST_PRESET))']);
    assert.equal(stdout.trim(), 'undefined', 'so a child process inherits nothing');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing .env is nothing to read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-dotenv-'));
  try { assert.deepEqual(await readDotEnv(dir), {}); } finally { await rm(dir, { recursive: true, force: true }); }
});

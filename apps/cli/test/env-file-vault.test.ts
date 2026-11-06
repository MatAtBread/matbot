import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvFileVault, readEnvFile } from '@matatbread/matbot-host-node';

// The writer and the reader of one format, in one class: every value comes back from the file as it went
// in. They lived in two packages, and `abc #1` came back `abc` — the reader took ` #1` for a comment.
const AWKWARD = {
  HASH: 'abc #1', DQUOTED: '"quoted"', SQUOTED: "'quoted'", PADDED: ' padded ', APOS: " it's ",
  BOTH: `a'b"c`, LONE: "'", PLAIN: 'plain', EQUALS: 'a=b==', HASHSTART: '#notacomment',
};

test('EnvFileVault: every value written reads back unchanged, through open() and readEnvFile', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, '.env');
  await writeFile(file, '# kept\nexport EXISTING=1\n');

  const vault = await EnvFileVault.open(file);
  for (const [name, value] of Object.entries(AWKWARD)) await vault.writeSecret(name, value);

  assert.deepEqual(await readEnvFile(file), { EXISTING: '1', ...AWKWARD });
  const reopened = await EnvFileVault.open(file);
  for (const [name, value] of Object.entries(AWKWARD)) assert.equal(await reopened.readSecret(name), value, name);
});

test('EnvFileVault: a line break is refused rather than written broken; the environment wins over the file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, '.env');
  await writeFile(file, 'K=from-file\n');

  const vault = await EnvFileVault.open(file, { K: 'from-env' });
  assert.equal(await vault.readSecret('K'), 'from-env');
  await assert.rejects(vault.writeSecret('NL', 'a\nb'), /line break/);
  assert.equal(await readFile(file, 'utf8'), 'K=from-file\n');
});

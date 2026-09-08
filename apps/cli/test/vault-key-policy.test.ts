import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VaultImpl, isInvalidSecretNameError, unreferenceableKey } from '@matatbread/matbot-core';
import { EnvFileVault } from '../src/env-vault.ts';

// What is storable is the BACKEND's business, and it is the only thing that knows: a .env-backed
// vault takes environment-variable names, and everything else it writes is dropped by whoever reads
// the file back ("Ignoring invalid environment assignment"), with the failure landing a boot later
// on a secret that has silently ceased to exist. So a name it cannot hold is refused at the write,
// carrying the rule that says what to use instead.

async function envVault(): Promise<{ vault: EnvFileVault; envPath: string }> {
  const dir     = await mkdtemp(path.join(tmpdir(), 'matbot-vault-'));
  const envPath = path.join(dir, '.env');
  return { vault: new EnvFileVault(envPath), envPath };
}

test('the base vault stores any referenceable name', async () => {
  const vault = new VaultImpl();
  await vault.writeSecret('email:acme:password', 'hunter2');
  assert.equal(await vault.resolve('${email:acme:password}'), 'hunter2');
});

test('a name no ${...} placeholder could carry is refused', async () => {
  const vault = new VaultImpl();
  for (const bad of ['', 'has space', 'braced{', 'closed}', '$dollar']) {
    await assert.rejects(
      () => vault.writeSecret(bad, 'v'),
      e => isInvalidSecretNameError(e) && e.key === bad && e.rule.includes('${NAME}'),
      `expected "${bad}" to be refused`,
    );
  }
  assert.equal(unreferenceableKey('FINE_NAME'), undefined);
});

test('the .env vault refuses a name systemd would drop, and writes nothing', async () => {
  const { vault, envPath } = await envVault();
  await assert.rejects(
    () => vault.writeSecret('email:70de70:password', 'MatBot.aa1604'),
    e => isInvalidSecretNameError(e) && e.rule.includes('environment-variable name'),
  );
  assert.equal(vault.hasKey('email:70de70:password'), false);
  await assert.rejects(() => readFile(envPath, 'utf8'));
});

test('createSecret is refused through the same policy, since it ends in a write', async () => {
  const { vault } = await envVault();
  await assert.rejects(
    () => vault.createSecret('my key', 'secret-value'),
    e => isInvalidSecretNameError(e),
  );
  // The reference and dedup paths never write, so they are unaffected by the policy.
  await vault.writeSecret('ACME_KEY', 'secret-value');
  assert.equal(await vault.createSecret('ignored name', 'secret-value'), 'ACME_KEY');
});

test('an unstorable name already in the file can still be removed', async () => {
  const dir     = await mkdtemp(path.join(tmpdir(), 'matbot-vault-'));
  const envPath = path.join(dir, '.env');
  await writeFile(envPath, 'email:70de70:password=MatBot.aa1604\nACME_KEY=v\n', 'utf8');
  // Removal is the one write that skips the policy: a name that arrived before the rule (or from an
  // environment snapshot) must not be undeletable.
  const vault = new EnvFileVault(envPath, { 'email:70de70:password': 'MatBot.aa1604' });
  await vault.writeSecret('email:70de70:password', '');
  assert.equal(vault.hasKey('email:70de70:password'), false);
  assert.equal(await readFile(envPath, 'utf8'), 'ACME_KEY=v\n');
});

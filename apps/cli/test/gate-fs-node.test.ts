import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { wrapFsModule, type FsPolicy } from '@matatbread/matbot-gate-fs-node';

// A real project tree, so realpath (symlink collapsing) is exercised rather than mocked.
let dir: string;
before(() => {
  dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'gatefs-'));
  realFs.writeFileSync(path.join(dir, '.env'), 'ANTHROPIC_API_KEY=secret');
  realFs.mkdirSync(path.join(dir, '.data'));
  realFs.writeFileSync(path.join(dir, '.data', 'session.json'), '{}');
  realFs.mkdirSync(path.join(dir, 'src'));
  realFs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;');
  // A symlink inside .data pointing at the real secrets file elsewhere on the box.
  realFs.symlinkSync('/etc/hostname', path.join(dir, 'src', 'escape'));
});
after(() => realFs.rmSync(dir, { recursive: true, force: true }));

function guarded(allow: string[] = []): typeof import('node:fs') {
  const policy: FsPolicy = { projectDir: dir, allow };
  return wrapFsModule(realFs, policy, 'fs') as typeof import('node:fs');
}

test('the secrets vault and runtime-state trees are refused; source is allowed', () => {
  const fs = guarded();
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.ts'), 'utf8'), 'export const a = 1;', 'source reads work');
  assert.throws(() => fs.readFileSync(path.join(dir, '.env'), 'utf8'), /secrets vault/, '.env refused');
  assert.throws(() => fs.readFileSync(path.join(dir, '.data', 'session.json'), 'utf8'), /runtime state/, '.data refused');
  assert.throws(() => fs.readdirSync(path.join(dir, '.data')), /runtime state/, '.data readdir refused');
});

test('paths outside the project are refused, absolute or via ..', () => {
  const fs = guarded();
  assert.throws(() => fs.readFileSync('/etc/hostname', 'utf8'), /outside the project/, 'absolute outside');
  assert.throws(() => fs.readFileSync(path.join(dir, 'src', '..', '..', '..', 'etc', 'hostname')), /outside the project/, 'traversal');
});

test('a symlink is resolved before the check, so it cannot escape', () => {
  const fs = guarded();
  // src/escape is inside the (allowed) project but points at /etc/hostname.
  assert.throws(() => fs.readFileSync(path.join(dir, 'src', 'escape'), 'utf8'), /outside the project/,
    'the real target, not the link path, is what is checked');
});

test('two-path operations check both ends', () => {
  const fs = guarded();
  assert.throws(() => fs.copyFileSync(path.join(dir, 'src', 'a.ts'), path.join(dir, '.data', 'leak')), /runtime state/,
    'copy INTO .data refused');
  assert.throws(() => fs.copyFileSync(path.join(dir, '.env'), path.join(dir, 'src', 'stolen')), /secrets vault/,
    'copy FROM .env refused');
});

test('fs/promises is wrapped too', async () => {
  const fs = guarded();
  await assert.rejects(() => fs.promises.readFile(path.join(dir, '.env'), 'utf8'), /secrets vault/);
  assert.equal(await fs.promises.readFile(path.join(dir, 'src', 'a.ts'), 'utf8'), 'export const a = 1;');
});

test('permit_fs_paths confines to the listed roots, deny-set still applies', () => {
  const only = path.join(dir, 'src');
  const fs = guarded([only]);
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.ts'), 'utf8'), 'export const a = 1;', 'inside allowed root');
  // An ancestor of the allowed root is no longer reachable.
  assert.throws(() => fs.readdirSync(dir), /permitted paths/, 'project root not in allow-list');
  // The deny-set still wins even if someone lists the project root.
  const fs2 = wrapFsModule(realFs, { projectDir: dir, allow: [dir] }, 'fs') as typeof import('node:fs');
  assert.throws(() => fs2.readFileSync(path.join(dir, '.env'), 'utf8'), /secrets vault/, 'deny-set wins over allow');
});

test('fd-based and non-path members pass through', () => {
  const fs = guarded();
  const fd = fs.openSync(path.join(dir, 'src', 'a.ts'), 'r');
  const buf = Buffer.alloc(6);
  fs.readSync(fd, buf, 0, 6, 0);              // fd-based read is not path-checked
  fs.closeSync(fd);
  assert.equal(buf.toString(), 'export');
  assert.equal(typeof fs.constants.O_RDONLY, 'number', 'constants pass through');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// What npm installs is what `files` lists, not this checkout. A module the loader imports but `files`
// leaves out works here and fails for every npm user at boot, which is how 0.4.9–0.4.16 shipped: their
// ts-hooks.js imports remote-loader.js, and the tarball has no remote-loader.js. So this boots the PACKED
// package — packed by npm itself, unpacked, and given this checkout's dependencies, which a tarball
// carries none of.
const cli = join(import.meta.dirname, '..');

test('the CLI as npm packs it boots', { timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'matbot-packed-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dir], {
      cwd: cli, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })) as { filename: string }[];
    execFileSync('tar', ['xzf', join(dir, packed[0]!.filename), '-C', dir]);
    symlinkSync(join(cli, 'node_modules'), join(dir, 'package', 'node_modules'), 'dir');
    const banner = execFileSync(process.execPath, [join(dir, 'package', 'bin.js'), '--version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(banner, /\d+\.\d+\.\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

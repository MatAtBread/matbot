import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// A failure a tool_function body left unhandled ended the process: a body that scheduled
// `setTimeout(async () => { await tool.x() })` and returned had its late call refused (as #114 then did), the
// refusal rejected the timer's promise, nothing handled it, and node's default exited — every session with it.
// The node FunctionRunner now contains what fails in a body's span, and hands everything else back to node.
// Each case runs in a process of its own: the test runner listens for these events itself, which would hide
// whether a host failure still ends the process.

async function child(mode: string): Promise<{ code: number | null; out: string; err: string }> {
  const register = pathToFileURL(join(import.meta.dirname, '..', 'register.js')).href;
  const proc = spawn(process.execPath, ['--import', register, join(import.meta.dirname, 'fixtures', 'body-failure-child.ts'), mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  proc.stdout.setEncoding('utf8').on('data', (c: string) => { out += c; });
  proc.stderr.setEncoding('utf8').on('data', (c: string) => { err += c; });
  const code = await new Promise<number | null>(r => proc.once('close', c => r(c)));
  return { code, out, err };
}

test('what a body leaves failing is contained, and the process goes on', { timeout: 30000 }, async () => {
  const { code, out, err } = await child('body');
  assert.equal(code, 0, err);
  assert.match(out, /result:done/);
  assert.match(out, /alive/, 'still running after every failure the body left');
  assert.match(out, /late ran/, 'a call the body scheduled for after it returned ran');
  assert.match(err, /the late call failed/, 'a late call that failed, contained');
  assert.match(err, /thrown in a timer/);
  assert.match(err, /rejected at once/);
  assert.equal(err.match(/It was contained/g)?.length, 4, 'each one reported, the stackless rejection included');
});

test('a host\'s unhandled rejection still ends the process, as node\'s default does', { timeout: 30000 }, async () => {
  const { code, out, err } = await child('host-rejection');
  assert.notEqual(code, 0);
  assert.doesNotMatch(out, /alive/);
  assert.match(err, /a host rejection/);
  assert.doesNotMatch(err, /contained/);
});

test('a host\'s uncaught exception still ends the process', { timeout: 30000 }, async () => {
  const { code, out, err } = await child('host-throw');
  assert.notEqual(code, 0);
  assert.doesNotMatch(out, /alive/);
  assert.match(err, /a host throw/);
  assert.doesNotMatch(err, /contained/);
});

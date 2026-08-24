import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import type { Session, ToolContext, ToolEvent, Vault } from '@matatbread/matbot-core';
import { createSession } from '@matatbread/matbot-core';
import { bashTool } from '../../../plugins/bash/src/index.js';

// `bash -c` forks every pipeline stage as its own process, which made two invariants fail together:
//
//   1. signalling the child reached `bash` and nothing else, so an abort or a timeout left the stages
//      running, reparented to init (`find / | head` outliving the turn that asked for it);
//   2. completion waited on 'close' — process exited AND every stdio stream at EOF — so one surviving
//      process holding the script's stdout pinned the tool call for as long as it lived.
//
// Together they made a turn unrecoverable: abort reported success and the session sat at "working" for
// ever, with the only fix a manual kill from outside the app. These tests pin both, plus the misreport
// they hid — a signal-killed script gives `code === null`, which the success arm read as exit code 0.
//
// Everything here needs a real `bash` and POSIX process groups; skipped on Windows, which keeps the
// direct-child kill it always had.
const posix = process.platform !== 'win32';

async function collect(input: Record<string, unknown>, signal?: AbortSignal): Promise<{ events: ToolEvent[]; ms: number }> {
  const ctx = {
    callId: 'c1', session: createSession() as Session, signal: signal ?? new AbortController().signal,
    vault: { resolve: async (v: string) => v } as unknown as Vault,
    prompt: async () => { throw new Error('prompt unused'); },
    loadPlugin: async () => { throw new Error('unused'); }, unloadPlugin: async () => false,
  } as unknown as ToolContext;
  const events: ToolEvent[] = [];
  const t0 = Date.now();
  for await (const ev of bashTool.executor.execute(input, ctx)) events.push(ev);
  return { events, ms: Date.now() - t0 };
}

const resultOf = (events: ToolEvent[]): { exitCode: number; stdout: string; stderr: string } => {
  const r = events.find(e => e.type === 'result');
  assert.ok(r && r.type === 'result', `expected a result, got ${JSON.stringify(events.map(e => e.type))}`);
  return r.value as { exitCode: number; stdout: string; stderr: string };
};

const errorOf = (events: ToolEvent[]): string => {
  const e = events.find(ev => ev.type === 'error');
  assert.ok(e && e.type === 'error', `expected an error, got ${JSON.stringify(events.map(ev => ev.type))}`);
  return e.message;
};

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Bounded, because a killed process lingers as a zombie until init reaps it. */
async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 10000;
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

test('a surviving process holding stdout does not pin the tool call', { skip: !posix, timeout: 30000 }, async () => {
  // The script exits at once but leaves a background child holding its stdout, so 'close' is 30s away
  // while 'exit' is immediate. `echo $!` hands the orphan's pid back so the test can clean up after itself.
  const { events, ms } = await collect({ script: 'sleep 30 & echo $!; exit 0' });
  const result = resultOf(events);
  const orphan = Number(result.stdout.trim());
  try {
    assert.ok(ms < 10000, `call ended on process exit, not stdio EOF (took ${ms}ms)`);
    assert.ok(Number.isInteger(orphan) && orphan > 0, `stdout carried the orphan pid, got ${JSON.stringify(result.stdout)}`);
    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /output may be truncated/, 'says so when it stopped reading a pipe something else holds');
  } finally {
    try { process.kill(orphan); } catch { /* already gone */ }
  }
});

test('abort kills every stage of the pipeline, and their children', { skip: !posix, timeout: 30000 }, async () => {
  const dir     = await mkdtemp(join(tmpdir(), 'matbot-bash-'));
  const pidFile = join(dir, 'pids');
  let pids: number[] = [];
  try {
    const ac = new AbortController();
    // Two levels, both of which used to outlive the turn: the left side of a pipe is its own process
    // (`$BASHPID`, not `$$`, which a bash subshell inherits), and it has a child of its own — the shape
    // of the `find / … | head -5` that started this. Both report themselves and then sleep far longer
    // than the test.
    //
    // Asserted on the pids rather than on work the killed stage was about to do: a bash subshell whose
    // foreground child is signalled continues to the NEXT command in its list before exiting, so a
    // sentinel file gets written even though the group kill worked exactly as intended.
    const run = collect({ script: `(echo $BASHPID > '${pidFile}'; sleep 30 & echo $! >> '${pidFile}'; wait) | cat` }, ac.signal);
    const deadline = Date.now() + 15000;
    for (;;) {
      pids = existsSync(pidFile)
        ? readFileSync(pidFile, 'utf8').split('\n').map(l => Number(l.trim())).filter(n => Number.isInteger(n) && n > 0)
        : [];
      if (pids.length === 2 || Date.now() >= deadline) break;
      await sleep(20);
    }
    assert.equal(pids.length, 2, `the stage and its child reported themselves, got ${JSON.stringify(pids)}`);

    ac.abort('test');
    const { events, ms } = await run;
    assert.ok(ms < 15000, `call ended on the abort, not on the script (took ${ms}ms)`);
    assert.match(errorOf(events), /aborted and was killed/, 'reported as a kill, not as a clean exit');

    for (const pid of pids) assert.ok(await gone(pid), `pid ${pid} was killed with the shell (of ${JSON.stringify(pids)})`);
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* the point of the test */ } }
    await rm(dir, { recursive: true, force: true });
  }
});

test('a timeout is reported as a kill, never as exit code 0', { skip: !posix, timeout: 20000 }, async () => {
  const { events } = await collect({ script: 'sleep 30', timeout: 250 });
  assert.ok(!events.some(e => e.type === 'result'), 'a killed script is not a successful one');
  assert.match(errorOf(events), /timed out after 250ms and was killed/);
});

test('the bounds the description states are the bounds the code enforces', async () => {
  // Both are defaults the model is told it may override, so the numbers in the prose it reads have to be
  // the numbers actually applied — a stale default here is a tool that lies about when it will kill you.
  const schema = bashTool.inputSchema as { properties: Record<string, { description: string }> };
  assert.match(schema.properties.timeout!.description,        /600000/);
  assert.match(schema.properties.maxOutputBytes!.description, /1000000/);
  assert.match(bashTool.description, /600000/);
  assert.match(bashTool.description, /1000000/);
});

test('a clean run still captures its whole output', { skip: !posix, timeout: 20000 }, async () => {
  // Guards the drain window added for the pin: a script whose last output is still in the pipe buffer
  // when it exits must not lose it. 1000 lines is well inside the 100000-byte cap.
  const { events } = await collect({ script: 'for i in $(seq 1 1000); do echo "line $i"; done' });
  const result = resultOf(events);
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1000, 'no truncation across the exit/drain path');
  assert.equal(lines[999], 'line 1000');
  assert.doesNotMatch(result.stderr, /truncated/, 'nothing was holding the pipe, so nothing is claimed');
});

test('a caller-supplied maxOutputBytes is honoured, and names how to raise it', { skip: !posix, timeout: 30000 }, async () => {
  // The cap is a default, not a hard limit: an LLM that knows this command is verbose must be able to say
  // so. Asserted with a tiny value, which also keeps the test off the 1MB default.
  const { events, ms } = await collect({ script: 'yes matbot', maxOutputBytes: 5_000 });
  assert.ok(ms < 20000, `stopped on the cap rather than the timeout (took ${ms}ms)`);
  const message = errorOf(events);
  assert.match(message, /exceeded the 5000-byte output limit/, 'the caller\'s number, not the default');
  assert.match(message, /maxOutputBytes/, 'and says how to raise it');

  const out = events.filter(e => e.type === 'stdout').map(e => e.chunk).join('');
  assert.ok(out.length <= 5_000, `nothing past the cap was accumulated (got ${out.length} bytes)`);
});

test('a run under the cap is untouched by it', { skip: !posix, timeout: 30000 }, async () => {
  const { events } = await collect({ script: 'for i in $(seq 1 100); do echo "line $i"; done', maxOutputBytes: 100_000 });
  const result = resultOf(events);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trimEnd().split('\n').length, 100);
});

test('a nonsensical maxOutputBytes is refused rather than silently ignored', { skip: !posix, timeout: 30000 }, async () => {
  for (const bad of [0, -1, Number.NaN]) {
    const { events } = await collect({ script: 'echo hi', maxOutputBytes: bad });
    assert.match(errorOf(events), /"maxOutputBytes" must be a positive number/, `rejected ${String(bad)}`);
    assert.ok(!events.some(e => e.type === 'result'), 'and the script did not run');
  }
});

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDefaultGate, DEFAULT_GATE_SETTINGS_NS, installSettingsDefaults, makePluginSettings, permitted, refused } from '@matatbread/matbot-core';
import type { FormField, ImportCaller, PermissionDecision, PermissionRequest, PromptFn, SettingsDoc, Store } from '@matatbread/matbot-core';
import { decisionsFor, wrapFsModule } from '@matatbread/matbot-gate-fs-node';

const NOWHERE = {};

// gate-fs-node puts each path a body's `node:fs` names to the SAME gate as the import: an async call asks
// (prompting when nothing standing decides), a sync call consults a snapshot of what is in force.

let dir: string;
let real: string;   // the temp dir's realpath (macOS /var → /private/var, etc.)
before(() => {
  dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'gatefs-'));
  real = realFs.realpathSync(dir);
  realFs.writeFileSync(path.join(dir, '.env'), 'ANTHROPIC_API_KEY=secret');
  realFs.mkdirSync(path.join(dir, 'src'));
  realFs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;');
  realFs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 2;');
  realFs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'src', 'escape'));
});
after(() => realFs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => { installSettingsDefaults(undefined); });

/** A caller whose gate is a function of the request, recording what it is asked; its snapshot answers
 *  from `standing` (fallback-refused otherwise). */
function fakeCaller(decide: (r: PermissionRequest) => PermissionDecision, standing: (r: PermissionRequest) => PermissionDecision | undefined = () => undefined) {
  const asked: PermissionRequest[] = [];
  let snapshots = 0;
  const caller: ImportCaller = {
    fn: 'probe@1', who: 'function "probe"',
    gate: async r => { asked.push(r); return decide(r); },
    snapshot: async () => { snapshots++; return r => standing(r) ?? refused('fallback'); },
  };
  return { caller, asked, snapshots: () => snapshots };
}

async function guarded(caller: ImportCaller): Promise<typeof import('node:fs')> {
  return wrapFsModule(realFs, 'fs', await decisionsFor(caller), caller) as typeof import('node:fs');
}

test('an async read is asked about by realpath, with the file and its directory, each for this function and for any, on offer', async () => {
  const { caller, asked } = fakeCaller(() => permitted('user'));
  const fs = await guarded(caller);
  // Spelled relatively and through `..`: one subject however it is written.
  const spelled = path.relative(process.cwd(), path.join(dir, 'src', '..', 'src', 'a.ts'));
  assert.equal(await fs.promises.readFile(spelled, 'utf8'), 'export const a = 1;');
  assert.equal(asked.length, 1);
  const file = path.join(real, 'src', 'a.ts');
  const srcDir = path.join(real, 'src') + path.sep;
  assert.equal(asked[0]!.gate, 'fs-read');
  assert.equal(asked[0]!.subject, `probe@1 ${file}`);
  assert.deepEqual(asked[0]!.standing!.map(s => s.subject), [`probe@1 ${file}`, `* ${file}`, `probe@1 ${srcDir}`, `* ${srcDir}`]);
  assert.deepEqual(asked[0]!.separators, [path.sep], 'subjects are a hierarchy at the path separator');
});

test('a refused async call rejects with EACCES and the refusal, and is not asked again in the same invocation', async () => {
  const { caller, asked } = fakeCaller(() => refused('user'));
  const fs = await guarded(caller);
  const env = path.join(dir, '.env');
  await assert.rejects(fs.promises.readFile(env, 'utf8'), (e: NodeJS.ErrnoException) => e.code === 'EACCES' && /the user declined/.test(e.message));
  await assert.rejects(fs.promises.readFile(env, 'utf8'), /the user declined/);
  assert.equal(asked.length, 1, 'a refusal is remembered for the invocation, not re-prompted in a loop');
});

test('a symlink is asked about at its real target', async () => {
  const { caller, asked } = fakeCaller(() => refused('user'));
  const fs = await guarded(caller);
  await assert.rejects(fs.promises.readFile(path.join(dir, 'src', 'escape'), 'utf8'), /declined/);
  assert.equal(asked[0]!.subject, `probe@1 ${path.join(real, '.env')}`);
});

test('a sync call never asks: it consults the snapshot, and says how to be asked when nothing allows it', async () => {
  const file = path.join(real, 'src', 'a.ts');
  const { caller, asked } = fakeCaller(() => permitted('user'), r => r.subject === `probe@1 ${file}` ? permitted('configuration') : undefined);
  const fs = await guarded(caller);
  assert.equal(fs.readFileSync(file, 'utf8'), 'export const a = 1;', 'a standing answer allows it');
  assert.throws(() => fs.readFileSync(path.join(dir, '.env'), 'utf8'),
    (e: NodeJS.ErrnoException) => e.code === 'EACCES' && /cannot ask/.test(e.message) && /fs\.promises\.readFile/.test(e.message));
  assert.equal(asked.length, 0, 'nothing was prompted');
});

test('reads and writes are separate questions; two-path calls ask about each end', async () => {
  const { caller, asked } = fakeCaller(() => permitted('user'));
  const fs = await guarded(caller);
  await fs.promises.copyFile(path.join(dir, 'src', 'a.ts'), path.join(dir, 'src', 'copy.ts'));
  assert.deepEqual(asked.map(r => [r.gate, r.subject]), [
    ['fs-read',  `probe@1 ${path.join(real, 'src', 'a.ts')}`],
    ['fs-write', `probe@1 ${path.join(real, 'src', 'copy.ts')}`],
  ]);
  asked.length = 0;
  const h = await fs.promises.open(path.join(dir, 'src', 'b.ts'));          // default flags: read
  await h.close();
  const w = await fs.promises.open(path.join(dir, 'src', 'new.ts'), 'w');   // write
  await w.close();
  assert.deepEqual(asked.map(r => r.gate), ['fs-read', 'fs-write']);
});

test('the callback form asks, and a refusal reaches the callback', async () => {
  const { caller, asked } = fakeCaller(r => r.subject.endsWith('.env') ? refused('user') : permitted('user'));
  const fs = await guarded(caller);
  const ok = await new Promise<string>((res, rej) => fs.readFile(path.join(dir, 'src', 'a.ts'), 'utf8', (e, d) => e ? rej(e) : res(d)));
  assert.equal(ok, 'export const a = 1;');
  const err = await new Promise<NodeJS.ErrnoException | null>(res => fs.readFile(path.join(dir, '.env'), 'utf8', e => res(e)));
  assert.equal(err?.code, 'EACCES');
  assert.equal(asked.length, 2);
});

test('fd-based and non-path members pass through unasked', async () => {
  const { caller, asked } = fakeCaller(() => permitted('user'), () => permitted('configuration'));
  const fs = await guarded(caller);
  const fd = fs.openSync(path.join(dir, 'src', 'a.ts'), 'r');
  const buf = Buffer.alloc(6);
  fs.readSync(fd, buf, 0, 6, 0);
  fs.closeSync(fd);
  assert.equal(buf.toString(), 'export');
  assert.equal(typeof fs.constants.O_RDONLY, 'number');
  assert.equal(asked.length, 0);
});

// ── End to end, against core's default policy ─────────────────────────────────

function defaultPolicy(defaults: Record<string, unknown> | undefined, answer: string) {
  installSettingsDefaults(defaults === undefined ? undefined : new Map([[DEFAULT_GATE_SETTINGS_NS, defaults]]));
  const docs = new Map<string, unknown>();
  const store = {
    get:    async (id: string) => docs.get(id) ?? null,
    set:    async (id: string, doc: unknown) => { docs.set(id, doc); },
    cas:    async (id: string, _v: string, doc: unknown) => { docs.set(id, doc); return { ok: true }; },
    delete: async (id: string) => { docs.delete(id); },
  } as unknown as Store<SettingsDoc>;
  const gate = createDefaultGate(makePluginSettings(store, DEFAULT_GATE_SETTINGS_NS));
  const prompts: FormField[] = [];
  const ask = (async (f: string | FormField) => { prompts.push(f as FormField); return answer; }) as PromptFn;
  // As function-tools qualifies it: the gate suffix under `tool_function`.
  const q = (r: PermissionRequest): PermissionRequest => ({ ...r, gate: `tool_function.${r.gate}` });
  const caller: ImportCaller = {
    fn: 'probe@1', who: 'function "probe"',
    gate: r => gate.decide(q(r), ask, NOWHERE),
    snapshot: async () => { const s = await gate.snapshot(NOWHERE); return r => s(q(r)); },
  };
  return { caller, prompts };
}

test('a configured directory deny for every function refuses everything under it, sync and async, unasked', async () => {
  const { caller, prompts } = defaultPolicy({ 'deny:tool_function.fs-read': { '*': [`* ${real}${path.sep}`] } }, '0|once|allow');
  const fs = await guarded(caller);
  assert.throws(() => fs.readFileSync(path.join(dir, '.env'), 'utf8'), /permission policy does not allow it/);
  await assert.rejects(fs.promises.readFile(path.join(dir, '.env'), 'utf8'), /permission policy does not allow it/);
  // Below it too: a directory subject covers its whole subtree.
  await assert.rejects(fs.promises.readFile(path.join(dir, 'src', 'a.ts'), 'utf8'), /permission policy does not allow it/);
  assert.equal(prompts.length, 0);
});

test('a directory grant covers its subtree, a deny carves one out, and a file grant stays exact', async () => {
  const { caller, prompts } = defaultPolicy({
    'tool_function.fs-read':      { '*': [`* ${real}${path.sep}`, `* ${path.join(real, 'src', 'a.ts')}`] },
    'deny:tool_function.fs-read': { '*': [`* ${path.join(real, 'src')}${path.sep}`] },
  }, '0|once|deny');
  const fs = await guarded(caller);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'ANTHROPIC_API_KEY=secret', 'under the granted directory');
  assert.throws(() => fs.readFileSync(path.join(dir, 'src', 'b.ts'), 'utf8'), /permission policy does not allow it/,
    'the denied subtree wins over the broader grant');
  assert.equal(prompts.length, 0);
});

test('a file grant does not cover a sibling whose name it prefixes, and a granted tree cannot be left by a symlink', async () => {
  const sibling = path.join(dir, 'src', 'a.ts.bak');
  realFs.writeFileSync(sibling, 'backup');
  const { caller } = defaultPolicy({ 'tool_function.fs-read': { '*': [`probe@1 ${path.join(real, 'src', 'a.ts')}`, `probe@1 ${path.join(real, 'src')}${path.sep}`] } }, '0|once|deny');
  try {
    const fs = await guarded(caller);
    // Exact file subject, no trailing separator: it matches only itself.
    const exactOnly = defaultPolicy({ 'tool_function.fs-read': { '*': [`probe@1 ${path.join(real, 'src', 'a.ts')}`] } }, '0|once|deny');
    const narrow = await guarded(exactOnly.caller);
    assert.equal(narrow.readFileSync(path.join(dir, 'src', 'a.ts'), 'utf8'), 'export const a = 1;');
    assert.throws(() => narrow.readFileSync(sibling, 'utf8'), /cannot ask/, 'a.ts does not cover a.ts.bak');
    // src/escape → ../.env: asked about at the target, which is outside the granted src/.
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'backup', 'inside the granted directory');
    assert.throws(() => fs.readFileSync(path.join(dir, 'src', 'escape'), 'utf8'), /cannot ask/);
  } finally { realFs.rmSync(sibling); }
});

// The case a user meets: a directory granted — to one function and to any, as two prompts answered it —
// and one file or subdirectory inside it to be excluded. The nearer answer wins whichever way the
// directory was granted.
test('a file denied for every function is carved out of a directory granted to one function and to any', async () => {
  const { caller, prompts } = defaultPolicy({
    'tool_function.fs-read':      { '*': [`probe@1 ${real}${path.sep}`, `* ${real}${path.sep}`] },
    'deny:tool_function.fs-read': { '*': [`* ${path.join(real, '.env')}`] },
  }, '0|once|allow');
  const fs = await guarded(caller);
  assert.throws(() => fs.readFileSync(path.join(dir, '.env'), 'utf8'), /permission policy does not allow it/);
  await assert.rejects(fs.promises.readFile(path.join(dir, '.env'), 'utf8'), /permission policy does not allow it/);
  await assert.rejects(fs.promises.readFile(path.join(dir, 'src', 'escape'), 'utf8'), /permission policy does not allow it/,
    'nor through a link to it');
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.ts'), 'utf8'), 'export const a = 1;', 'the rest is still granted');
  assert.equal(prompts.length, 0);
});

test('a subdirectory denied for every function is carved out of a directory granted to one function', async () => {
  const { caller, prompts } = defaultPolicy({
    'tool_function.fs-read':      { '*': [`probe@1 ${real}${path.sep}`] },
    'deny:tool_function.fs-read': { '*': [`* ${path.join(real, 'src')}${path.sep}`] },
  }, '0|once|allow');
  const fs = await guarded(caller);
  assert.throws(() => fs.readFileSync(path.join(dir, 'src', 'a.ts'), 'utf8'), /permission policy does not allow it/);
  await assert.rejects(fs.promises.readFile(path.join(dir, 'src', 'b.ts'), 'utf8'), /permission policy does not allow it/);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'ANTHROPIC_API_KEY=secret', 'outside it, still granted');
  assert.equal(prompts.length, 0);
});

test('at the same depth this function\'s answer wins over any function\'s', async () => {
  const { caller } = defaultPolicy({
    'tool_function.fs-read':      { '*': [`probe@1 ${path.join(real, 'src')}${path.sep}`] },
    'deny:tool_function.fs-read': { '*': [`* ${path.join(real, 'src')}${path.sep}`] },
  }, '0|once|deny');
  const fs = await guarded(caller);
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.ts'), 'utf8'), 'export const a = 1;');
});

test('a configured directory allow lets a sync call through with no prompt', async () => {
  const { caller, prompts } = defaultPolicy({ 'tool_function.fs-read': { '*': [`* ${path.join(real, 'src')}${path.sep}`] } }, '0|once|deny');
  const fs = await guarded(caller);
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'b.ts'), 'utf8'), 'export const b = 2;');
  assert.throws(() => fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'x'), /cannot ask/, 'a read grant does not allow a write');
  assert.equal(prompts.length, 0);
});

test('an "always, in this directory" answer to an async call is seen by later sync calls, and by queued async ones', async () => {
  // always-2 is the third standing option: this function, anything in the directory.
  const { caller, prompts } = defaultPolicy(undefined, '2|always|allow');
  const fs = await guarded(caller);
  assert.throws(() => fs.readFileSync(path.join(dir, 'src', 'b.ts'), 'utf8'), /cannot ask/, 'nothing standing yet');
  // Concurrent: serialised, so only the first prompts and the second finds the standing answer it gave.
  const [a, b] = await Promise.all([
    fs.promises.readFile(path.join(dir, 'src', 'a.ts'), 'utf8'),
    fs.promises.readFile(path.join(dir, 'src', 'b.ts'), 'utf8'),
  ]);
  assert.equal(a + b, 'export const a = 1;export const b = 2;');
  assert.equal(prompts.length, 1, 'one prompt for the directory, not one per file');
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'b.ts'), 'utf8'), 'export const b = 2;', 'the refreshed snapshot allows it');
});

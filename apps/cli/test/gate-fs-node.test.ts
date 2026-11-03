import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDefaultGate, DEFAULT_GATE_SETTINGS_NS, installSettingsDefaults, makePluginSettings, permitted, refused } from '@matatbread/matbot-core';
import type { FormField, ImportCaller, PermissionDecision, PermissionRequest, PromptFn, SettingsDoc, Store } from '@matatbread/matbot-core';
import { caseInsensitiveAt, decisionsFor, fsRequest, wrapFsModule } from '@matatbread/matbot-gate-fs-node';
import { createModuleWrapperRegistry, createVmFunctionRunner } from '@matatbread/matbot-function-runner-node';

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

// ── Every way node:fs offers to a path is guarded ─────────────────────────────

test('the module\'s CommonJS view — `(await import(\'node:fs\')).default` — is guarded like the namespace', async () => {
  const { caller, asked } = fakeCaller(() => refused('user'));
  const fs = await guarded(caller) as unknown as { default: typeof import('node:fs') };
  const env = path.join(dir, '.env');
  assert.throws(() => fs.default.readFileSync(env, 'utf8'), /cannot ask/);
  await assert.rejects(fs.default.promises.readFile(env, 'utf8'), /declined/);
  const st = await decisionsFor(caller);
  const fsp = wrapFsModule(await import('node:fs/promises'), 'promises', st, caller) as unknown as { default: typeof import('node:fs/promises') };
  await assert.rejects(fsp.default.readFile(env, 'utf8'), /declined/);
  assert.equal(asked.length, 1, 'the second async refusal is the remembered one');
});

test('a case-variant spelling is the same subject on a case-insensitive filesystem', async (t) => {
  if (!realFs.existsSync(path.join(dir, '.ENV'))) return t.skip('case-sensitive filesystem');
  const { caller, prompts } = defaultPolicy({
    'tool_function.fs-read':      { '*': [`* ${real}${path.sep}`] },
    'deny:tool_function.fs-read': { '*': [`* ${path.join(real, '.env')}`] },
  }, '0|once|allow');
  const fs = await guarded(caller);
  assert.throws(() => fs.readFileSync(path.join(dir, '.ENV'), 'utf8'), /permission policy does not allow it/);
  assert.equal(fs.readFileSync(path.join(dir, 'SRC', 'a.ts'), 'utf8'), 'export const a = 1;', 'a case-variant directory is still inside the grant');
  assert.equal(prompts.length, 0);
});

test('a hard link needs write access to its source, since writing through it changes the source', async () => {
  const { caller, asked } = fakeCaller(() => permitted('user'));
  const fs = await guarded(caller);
  const link = path.join(dir, 'src', 'hard');
  try {
    await fs.promises.link(path.join(dir, 'src', 'a.ts'), link);
    assert.deepEqual(asked.map(r => r.gate), ['fs-read', 'fs-write', 'fs-write']);
  } finally { realFs.rmSync(link, { force: true }); }
});

test('stream classes, called or constructed, and mkdtempDisposable are asked about', async () => {
  const { caller } = fakeCaller(() => refused('user'));
  const fs = await guarded(caller);
  const env = path.join(dir, '.env');
  const ReadStream = fs.ReadStream as unknown as (p: string) => unknown;
  assert.throws(() => ReadStream(env), /cannot ask/, 'called without new');
  assert.throws(() => new fs.ReadStream(env as never), /cannot ask/);
  assert.throws(() => new fs.WriteStream(path.join(dir, 'w') as never), /cannot ask/);
  assert.throws(() => fs.mkdtempDisposableSync(path.join(dir, 'tmp-')), /cannot ask/);
  const st = await decisionsFor(caller);
  const fsp = wrapFsModule(await import('node:fs/promises'), 'promises', st, caller) as typeof import('node:fs/promises');
  await assert.rejects(fsp.mkdtempDisposable(path.join(dir, 'tmp-')), /declined/);
  // A granted stream class still constructs a real stream.
  const ok = await guarded(fakeCaller(() => permitted('user'), () => permitted('configuration')).caller);
  const s = new ok.ReadStream(path.join(dir, 'src', 'a.ts') as never);
  assert.ok(s instanceof realFs.ReadStream);
  s.destroy();
});

test('a Uint8Array path and a URL-shaped object are asked about as the path node reads', async () => {
  const { caller, asked } = fakeCaller(() => refused('user'));
  const fs = await guarded(caller);
  const env = path.join(dir, '.env');
  await assert.rejects(fs.promises.readFile(new TextEncoder().encode(env)), /declined/);
  const u = new URL(`file://${env}`);
  const urlish = { href: u.href, protocol: u.protocol, hostname: u.hostname, pathname: u.pathname };
  await assert.rejects(fs.promises.readFile(urlish as unknown as URL), /declined/);
  assert.deepEqual(asked.map(r => r.subject), [`probe@1 ${path.join(real, '.env')}`]);
});

test('a bad argument to a callback call reaches the callback instead of crashing the process', async () => {
  const { caller } = fakeCaller(() => permitted('user'));
  const fs = await guarded(caller);
  const err = await new Promise<NodeJS.ErrnoException | null>(res =>
    fs.writeFile(path.join(dir, 'src', 'bad'), undefined as never, e => res(e)));
  assert.equal(err?.code, 'ERR_INVALID_ARG_TYPE');
});

test('fs/promises glob is asked about before it yields, and still iterates', async () => {
  const { caller, asked } = fakeCaller(() => permitted('user'));
  const st = await decisionsFor(caller);
  const fsp = wrapFsModule(await import('node:fs/promises'), 'promises', st, caller) as typeof import('node:fs/promises');
  const found: string[] = [];
  for await (const f of fsp.glob('[ab].ts', { cwd: path.join(dir, 'src') })) found.push(f);
  assert.deepEqual(found.sort(), ['a.ts', 'b.ts']);
  assert.equal(asked.length, 1);
});

test('a glob is asked about where its braces and its `..` segments reach, not only its static prefix', async () => {
  const src = path.join(real, 'src');
  const { caller } = fakeCaller(() => refused('user'), r => r.subject === `probe@1 ${src}` || r.subject.startsWith(`probe@1 ${src}${path.sep}`) ? permitted('configuration') : undefined);
  const fs = await guarded(caller);
  const inside = fs.globSync('{a,b}.{ts,js}', { cwd: src }).sort();
  assert.deepEqual(inside, ['a.ts', 'b.ts'], 'braces inside the granted directory');
  assert.throws(() => fs.globSync(`{${real}/*,x}`, { cwd: src }), /cannot ask/, 'an alternative that is an absolute path');
  assert.throws(() => fs.globSync('{../*,x}', { cwd: src }), /cannot ask/, 'an alternative that climbs');
  assert.throws(() => fs.globSync('*/../../*', { cwd: src }), /cannot ask/, 'a `..` after a wildcard');
});

test('link and rename read their source: a file denied for reading cannot be renamed into a readable name', async () => {
  const { caller, asked } = fakeCaller(r => r.gate === 'fs-read' && r.subject.endsWith(`${path.sep}.env`) ? refused('user') : permitted('user'));
  const fs = await guarded(caller);
  await assert.rejects(fs.promises.rename(path.join(dir, '.env'), path.join(dir, 'src', 'not-env')), /declined/);
  await assert.rejects(fs.promises.link(path.join(dir, '.env'), path.join(dir, 'src', 'not-env')), /declined/);
  assert.ok(realFs.existsSync(path.join(dir, '.env')) && !realFs.existsSync(path.join(dir, 'src', 'not-env')));
  assert.ok(asked.length >= 1);
});

test('through the runner, a body\'s `import(\'fs\')` is guarded whichever way it reaches the module', async () => {
  const reg = createModuleWrapperRegistry(s => s.startsWith('node:') ? s : `node:${s}`);
  const runner = createVmFunctionRunner(2000, { wrapModule: reg.apply });
  for (const spec of ['node:fs', 'node:fs/promises'] as const) {
    reg.service(spec, async (mod, ctx) => wrapFsModule(mod as object, spec === 'node:fs' ? 'fs' : 'promises', await decisionsFor(ctx.caller), ctx.caller));
  }
  const { caller } = fakeCaller(() => refused('user'));
  const env = path.join(dir, '.env');
  const ns = await runner.import!('fs', caller) as typeof import('node:fs') & { default: typeof import('node:fs') };
  assert.throws(() => ns.readFileSync(env, 'utf8'), /cannot ask/);
  assert.throws(() => ns.default.readFileSync(env, 'utf8'), /cannot ask/);
  const fsp = await runner.import!('node:fs/promises', caller) as { default: typeof import('node:fs/promises') };
  await assert.rejects(fsp.default.readFile(env, 'utf8'), /declined/);
});

test('a function node:fs has that is in neither table is refused, not handed through', async () => {
  const { caller } = fakeCaller(() => permitted('user'), () => permitted('configuration'));
  const st = await decisionsFor(caller);
  // As if node added a path-taking call after the table was written.
  const future = { ...realFs, readEverything: (p: string) => realFs.readFileSync(p, 'utf8') };
  const fs = wrapFsModule(future, 'fs', st, caller) as typeof future;
  assert.throws(() => fs.readEverything(path.join(dir, '.env')), (e: NodeJS.ErrnoException) => e.code === 'EACCES' && /fs\.readEverything is not available/.test(e.message));
  const fsp = wrapFsModule({ ...realFs.promises, readEverything: async () => 'x' }, 'promises', st, caller) as { readEverything(): Promise<string> };
  await assert.rejects(fsp.readEverything(), /not available/);
  assert.equal(typeof fs.fstatSync, 'function', 'a known pathless call still passes');
});

test('whether a volume ignores case is measured, and agrees with the filesystem', () => {
  const swapped = path.join(path.dirname(real), path.basename(real).toUpperCase() === path.basename(real)
    ? path.basename(real).toLowerCase() : path.basename(real).toUpperCase());
  assert.equal(caseInsensitiveAt(path.join(real, 'src', 'not-yet.txt')), realFs.existsSync(swapped));
});

test('on a volume that ignores case, a denial written in lower case holds for every spelling, and an allow does not', async (t) => {
  if (!caseInsensitiveAt(real)) return t.skip('case-sensitive filesystem');
  realFs.writeFileSync(path.join(dir, 'Mixed.TXT'), 'secret');
  try {
    const lower = real.toLowerCase();
    const { caller, prompts } = defaultPolicy({
      'tool_function.fs-read':       { '*': [`* ${real}${path.sep}`] },
      'tool_function.fs-write':      { '*': [`* ${real}${path.sep}`] },
      'deny:tool_function.fs-read':  { '*': [`* ${path.join(lower, 'mixed.txt')}`] },
      'deny:tool_function.fs-write': { '*': [`* ${path.join(lower, 'later.txt')}`] },
    }, '0|once|allow');
    const fs = await guarded(caller);
    assert.throws(() => fs.readFileSync(path.join(dir, 'Mixed.TXT'), 'utf8'), /permission policy does not allow it/, 'an existing file, stored in another case');
    await assert.rejects(fs.promises.readFile(path.join(dir, 'MIXED.txt'), 'utf8'), /permission policy does not allow it/);
    assert.throws(() => fs.writeFileSync(path.join(dir, 'Later.TXT'), 'x'), /permission policy does not allow it/, 'a file that does not exist yet');
    assert.equal(realFs.existsSync(path.join(dir, 'later.txt')), false);
    assert.equal(prompts.length, 0);

    const allowLower = defaultPolicy({ 'tool_function.fs-read': { '*': [`* ${path.join(lower, 'src')}${path.sep}`] } }, '0|once|deny');
    const narrow = await guarded(allowLower.caller);
    if (lower !== real) assert.throws(() => narrow.readFileSync(path.join(dir, 'src', 'a.ts'), 'utf8'), /cannot ask/, 'a folded allow grants nothing');
  } finally { realFs.rmSync(path.join(dir, 'Mixed.TXT'), { force: true }); }
});

test('the filesystem root is never offered as a directory to grant, and is not itself asked about', async () => {
  const root = path.parse(real).root;
  const inRoot = fsRequest({ fn: 'probe@1', who: 'function "probe"' }, 'read', 'readFile', path.join(root, 'no-such-file.txt'));
  assert.deepEqual(inRoot.standing!.map(s => s.subject), [`probe@1 ${path.join(root, 'no-such-file.txt')}`, `* ${path.join(root, 'no-such-file.txt')}`],
    'the file, and not "anything in" the root');
  const { caller, asked } = fakeCaller(() => permitted('user'), () => permitted('configuration'));
  const fs = await guarded(caller);
  assert.throws(() => fs.readdirSync(root), /filesystem root is not asked about.*remove the gate-fs-node plugin/);
  await assert.rejects(fs.promises.readdir(root), /filesystem root/);
  assert.equal(asked.length, 0);
});

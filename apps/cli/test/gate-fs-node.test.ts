import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDefaultGate, DEFAULT_GATE_SETTINGS_NS, installSettingsDefaults, makePluginSettings, permitted, refused } from '@matatbread/matbot-core';
import type { FormField, ImportCaller, PermissionDecision, PermissionRequest, PromptFn, SettingsDoc, Store } from '@matatbread/matbot-core';
import { caseInsensitiveAt, decisionsFor, fsRequest, openAccesses, realResolve, wrapFsModule } from '@matatbread/matbot-gate-fs-node';
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

// ── What a call acts on is what was asked about ───────────────────────────────
//
// Each of these rewrites nothing shared: it uses the module as handed, and changes only an object of its
// own, or the filesystem, after the question was asked. So the gate has to hold against all of them, which
// is the side of the line docs/SECURITY.md draws between reaching past a gate and tampering with built-ins.

/** A caller allowed `src/a.ts` and refused everything else, at the gate and in the snapshot alike. */
function onlyA(extra: (r: PermissionRequest) => boolean = () => false) {
  const a = () => path.join(real, 'src', 'a.ts');
  const allowed = (r: PermissionRequest) => r.subject === `probe@1 ${a()}` || extra(r);
  const seen: PermissionRequest[] = [];
  const caller: ImportCaller = {
    fn: 'probe@1', who: 'function "probe"',
    gate: async r => { seen.push(r); return allowed(r) ? permitted('user') : refused('user'); },
    snapshot: async () => r => allowed(r) ? permitted('configuration') : refused('fallback'),
  };
  return { caller, seen, subjects: () => seen.map(r => `${r.gate} ${r.subject.slice('probe@1 '.length)}`) };
}

/** The same caller, allowing what it allows for reading only. It still records every write it refuses. */
const readOnly = (caller: ImportCaller): ImportCaller => ({
  ...caller,
  gate: async r => { const d = await caller.gate(r); return r.gate === 'fs-read' ? d : refused('user'); },
  snapshot: async () => { const s = await caller.snapshot(); return r => r.gate === 'fs-read' ? s(r) : refused('fallback'); },
});

async function bothSurfaces(caller: ImportCaller) {
  const st = await decisionsFor(caller);
  return {
    fs:  wrapFsModule(realFs, 'fs', st, caller) as typeof import('node:fs'),
    fsp: wrapFsModule(await import('node:fs/promises'), 'promises', st, caller) as typeof import('node:fs/promises'),
  };
}

function drain(s: NodeJS.ReadableStream): Promise<{ data: string; code?: string }> {
  return new Promise(res => {
    let data = '';
    s.on('data', d => { data += String(d); });
    s.on('end', () => res({ data }));
    s.on('error', (e: NodeJS.ErrnoException) => res({ data, ...(e.code !== undefined ? { code: e.code } : {}) }));
  });
}

const closed = (s: NodeJS.EventEmitter): Promise<NodeJS.ErrnoException | undefined> =>
  new Promise(res => { s.once('error', e => res(e as NodeJS.ErrnoException)); s.once('close', () => res(undefined)); });

test('a stream repointed after it was granted is asked about at the path it opens, and reads nothing else', async () => {
  const { caller, subjects } = onlyA();
  const { fs } = await bothSurfaces(caller);
  const s = fs.createReadStream(path.join(dir, 'src', 'a.ts'));
  (s as unknown as { path: string }).path = path.join(dir, '.env');
  const got = await drain(s);
  assert.equal(got.code, 'EACCES');
  assert.equal(got.data, '', 'none of the file it was pointed at');
  assert.ok(subjects().includes(`fs-read ${path.join(real, '.env')}`), 'the gate was asked about where it really went');
  // The class, called and constructed, is the same stream by another name.
  const c = new fs.ReadStream(path.join(dir, 'src', 'a.ts') as never);
  (c as unknown as { path: string }).path = path.join(dir, '.env');
  assert.equal((await drain(c)).code, 'EACCES');
});

test('a write stream repointed after it was granted creates nothing at the path it was pointed at', async () => {
  const target = path.join(dir, 'never-written');
  const { caller } = onlyA();
  const { fs } = await bothSurfaces(caller);
  const w = fs.createWriteStream(path.join(dir, 'src', 'a.ts'), { flags: 'a' });
  (w as unknown as { path: string }).path = target;
  w.end('PWNED');
  assert.equal((await closed(w))?.code, 'EACCES');
  assert.equal(realFs.existsSync(target), false);
  assert.equal(realFs.readFileSync(path.join(dir, 'src', 'a.ts'), 'utf8'), 'export const a = 1;');
});

test('a stream\'s flags are asked about as what they do, whenever they are set', async () => {
  const a = path.join(dir, 'src', 'a.ts');
  const { caller, subjects } = onlyA();
  const { fs } = await bothSurfaces(readOnly(caller));
  assert.throws(() => fs.createReadStream(a, { flags: 'w' }), /cannot ask/, 'a read stream that would truncate');
  const s = fs.createReadStream(a);
  (s as unknown as { flags: string }).flags = 'w';
  assert.equal((await drain(s)).code, 'EACCES');
  assert.ok(subjects().includes(`fs-write ${path.join(real, 'src', 'a.ts')}`));
  assert.equal(realFs.readFileSync(a, 'utf8'), 'export const a = 1;', 'not truncated');
});

test('Utf8Stream is asked about wherever it opens: dest, reopen, and a path passed as `fd`', async () => {
  const Utf8 = (realFs as unknown as { Utf8Stream?: unknown }).Utf8Stream;
  const okFile = path.join(dir, 'src', 'utf8-ok');
  const denied = path.join(dir, 'utf8-denied');
  realFs.writeFileSync(okFile, '');
  const { caller } = onlyA(r => r.subject === `probe@1 ${path.join(real, 'src', 'utf8-ok')}`);
  const { fs } = await bothSurfaces(caller);
  const Stream = (fs as unknown as { Utf8Stream: new (o: object) => { reopen(f?: string): void; write(d: string): void; flushSync(): void; end(): void } & NodeJS.EventEmitter }).Utf8Stream;
  try {
    assert.equal(typeof Utf8, 'function');
    assert.throws(() => new Stream({ dest: denied, sync: true }), /cannot ask/);
    assert.throws(() => new Stream({ fd: denied, sync: true }), /cannot ask/, '`fd` takes a path too');

    const sync = new Stream({ dest: okFile, sync: true });
    assert.throws(() => sync.reopen(denied), (e: NodeJS.ErrnoException) => e.code === 'EACCES', 'reopen, sync');
    sync.on('error', () => {});
    sync.write('fine'); sync.flushSync(); sync.end();
    assert.equal(realFs.existsSync(denied), false);

    const stream = new Stream({ dest: okFile });
    await new Promise(res => stream.once('ready', res));
    const failed = new Promise<NodeJS.ErrnoException>(res => stream.once('error', res as (e: unknown) => void));
    stream.reopen(denied);
    assert.equal((await failed).code, 'EACCES', 'reopen, async: the refusal reaches the stream');
    assert.equal(realFs.existsSync(denied), false);
  } finally { realFs.rmSync(okFile, { force: true }); realFs.rmSync(denied, { force: true }); }
});

test('what a guarded stream hands back by name is gated, and is still the stream it was', async () => {
  const a = path.join(dir, 'src', 'a.ts');
  const env = path.join(dir, '.env');
  const { caller } = onlyA();
  const { fs, fsp } = await bothSurfaces(caller);
  const s = fs.createReadStream(a);
  assert.throws(() => new (s.constructor as new (p: string) => unknown)(env), /cannot ask/, 'its constructor');
  assert.throws(() => new (fs.ReadStream.prototype.constructor as new (p: string) => unknown)(env), /cannot ask/, 'the class\'s prototype');
  assert.equal((await drain(s)).data, 'export const a = 1;');

  const h = await fsp.open(a);
  const hs = h.createReadStream();
  assert.throws(() => new (hs.constructor as new (p: string) => unknown)(env), /cannot ask/, 'a stream made from a handle');
  assert.equal((await drain(hs)).data, 'export const a = 1;');

  assert.ok(s instanceof realFs.ReadStream && s instanceof fs.ReadStream && s instanceof fs.FileReadStream, 'instanceof holds both ways');
  class Mine extends fs.ReadStream { mine = true; }
  const sub = new (Mine as unknown as new (p: string) => Mine)(a);
  assert.ok(sub instanceof Mine && sub.mine, 'subclassing still works');
  sub.destroy();
  assert.throws(() => new (Mine as unknown as new (p: string) => Mine)(env), /cannot ask/, 'and is gated');
});

test('nothing reachable by name from what the wrapper hands out is a raw path-taking member of node:fs', async () => {
  const rawFsp = await import('node:fs/promises');
  const pathless = new Set(['close', 'fchown', 'fchmod', 'fdatasync', 'fstat', 'fsync', 'ftruncate', 'futimes', 'read', 'readv', 'write', 'writev', 'unwatchFile']
    .flatMap(n => [n, `${n}Sync`]));
  const raw = new Map<unknown, string>();
  for (const [from, label] of [[realFs, 'fs'], [realFs.promises, 'fs.promises'], [rawFsp, 'fsp']] as const) {
    for (const k of Reflect.ownKeys(from)) {
      if (typeof k !== 'string' || pathless.has(k) || ['Dirent', 'Stats', 'Dir', '_toUnixTimestamp', 'constants', 'default'].includes(k)) continue;
      const v = (from as Record<string, unknown>)[k];
      if (typeof v === 'function' || (k === 'promises')) raw.set(v, `${label}.${k}`);
    }
  }
  raw.set(realFs, 'fs itself');
  raw.set(realFs.promises, 'fs.promises itself');

  const { caller } = onlyA();
  const { fs, fsp } = await bothSurfaces(caller);
  const a = path.join(dir, 'src', 'a.ts');
  const handle = await fsp.open(a);
  const roots: Record<string, unknown> = {
    fs, fsp, default: (fs as unknown as { default: unknown }).default,
    readStream: fs.createReadStream(a), writeStream: fs.createWriteStream(a, { flags: 'a' }),
    classes: [fs.ReadStream, fs.WriteStream, fs.FileReadStream, fs.FileWriteStream],
    handle, handleStream: handle.createReadStream({ autoClose: false }),
    descriptors: Object.getOwnPropertyDescriptors(fs),
  };
  const found: string[] = [];
  const seen = new Set<unknown>();
  const names = (o: object): (string | symbol)[] => {
    const out = new Set<string | symbol>(Reflect.ownKeys(o));
    for (let p = Object.getPrototypeOf(o) as object | null; p !== null; p = Object.getPrototypeOf(p) as object | null) {
      for (const k of Object.getOwnPropertyNames(p)) out.add(k);
    }
    out.delete('__proto__');
    return [...out];
  };
  const walk = (v: unknown, where: string, depth: number): void => {
    if ((typeof v !== 'object' && typeof v !== 'function') || v === null || seen.has(v) || depth > 6) return;
    seen.add(v);
    if (raw.has(v)) { found.push(`${where} is ${raw.get(v)}`); return; }
    for (const k of names(v)) {
      let next: unknown;
      try { next = (v as Record<string | symbol, unknown>)[k]; } catch { continue; }
      walk(next, `${where}.${String(k)}`, depth + 1);
    }
  };
  for (const [k, v] of Object.entries(roots)) walk(v, k, 0);
  (roots['readStream'] as { destroy(): void }).destroy();
  (roots['writeStream'] as { destroy(): void }).destroy();
  await handle.close();
  assert.deepEqual(found, []);
});

test('the module cannot be read around or written through by reflection', async () => {
  const env = path.join(dir, '.env');
  const { caller } = onlyA();
  const { fs } = await bothSurfaces(caller);
  const ns = fs as unknown as { default: typeof realFs & Record<string, unknown> };
  const read = Object.getOwnPropertyDescriptor(fs, 'readFileSync')!.value as typeof realFs.readFileSync;
  assert.throws(() => read(env, 'utf8'), /cannot ask/, 'a descriptor of the namespace');
  const fromDefault = Object.getOwnPropertyDescriptor(ns.default, 'readFileSync')!.value as typeof realFs.readFileSync;
  assert.throws(() => fromDefault(env, 'utf8'), /cannot ask/, 'a descriptor of the CommonJS view');
  const promises = Object.getOwnPropertyDescriptor(ns.default, 'promises')!;
  await assert.rejects((promises.value as typeof realFs.promises).readFile(env), /declined/, 'an accessor comes back gated too');

  const shared = (realFs as unknown as { default: Record<string, unknown> }).default;
  const before = shared['readFileSync'];
  assert.throws(() => { ns.default['readFileSync'] = () => 'tampered'; }, TypeError);
  assert.throws(() => Object.defineProperty(ns.default, 'x', { value: 1 }), TypeError);
  assert.equal(Reflect.deleteProperty(ns.default, 'readFileSync'), false);
  assert.equal(Reflect.setPrototypeOf(ns.default, null), false);
  assert.equal(Reflect.preventExtensions(ns.default), false);
  assert.equal(shared['readFileSync'], before, 'matbot\'s own fs is what it was');
  assert.equal(shared['x'], undefined);
});

// `src/a.ts` and `src/b.ts` are the same length, so a Buffer can be rewritten in place.
const mutableSpellings: [string, () => { arg: unknown; swap: () => void }][] = [
  ['a Buffer', () => { const b = Buffer.from(path.join(dir, 'src', 'a.ts')); return { arg: b, swap: () => { b.write(path.join(dir, 'src', 'b.ts')); } }; }],
  ['a Uint8Array', () => { const u = new TextEncoder().encode(path.join(dir, 'src', 'a.ts')); return { arg: u, swap: () => { u.set(new TextEncoder().encode(path.join(dir, 'src', 'b.ts'))); } }; }],
  ['a URL', () => { const u = new URL(`file://${path.join(dir, 'src', 'a.ts')}`); return { arg: u, swap: () => { u.pathname = path.join(dir, 'src', 'b.ts'); } }; }],
];

for (const [name, spell] of mutableSpellings) {
  test(`${name} changed after an async call was made reads the file that was asked about (promise and callback)`, async () => {
    const { caller, subjects } = onlyA();
    const { fs, fsp } = await bothSurfaces(caller);
    const p = spell();
    const pending = fsp.readFile(p.arg as string, 'utf8');
    p.swap();
    assert.equal(await pending, 'export const a = 1;', 'promise');

    const c = spell();
    const viaCallback = new Promise<string>((res, rej) => fs.readFile(c.arg as string, 'utf8', (e, d) => e ? rej(e) : res(d)));
    c.swap();
    assert.equal(await viaCallback, 'export const a = 1;', 'callback');
    assert.deepEqual([...new Set(subjects())], [`fs-read ${path.join(real, 'src', 'a.ts')}`]);
  });
}

test('a mutable path changed while a human is deciding is still the path they were asked about', async () => {
  let answer!: (d: PermissionDecision) => void;
  const asked: string[] = [];
  const caller: ImportCaller = {
    fn: 'probe@1', who: 'function "probe"',
    gate: r => { asked.push(r.subject); return new Promise(res => { answer = res; }); },
    snapshot: async () => () => refused('fallback'),
  };
  const { fsp } = await bothSurfaces(caller);
  const u = new URL(`file://${path.join(dir, 'src', 'a.ts')}`);
  const pending = fsp.readFile(u, 'utf8');
  await new Promise(res => setTimeout(res, 5));     // parked on the prompt
  u.pathname = path.join(dir, '.env');
  answer(permitted('user'));
  assert.equal(await pending, 'export const a = 1;');
  assert.deepEqual(asked, [`probe@1 ${path.join(real, 'src', 'a.ts')}`]);
});

test('fs/promises iterators use the path and patterns they were asked about', async () => {
  const src = path.join(real, 'src');
  const { caller } = onlyA(r => r.subject === `probe@1 ${src}`);
  const { fsp } = await bothSurfaces(caller);

  const patterns = ['a.*'];
  const it = fsp.glob(patterns, { cwd: src });
  const first = it.next();
  patterns[0] = '../.*';
  assert.equal((await first).value, 'a.ts', 'an array of patterns changed after the call');

  const u = new URL(`file://${src}`);
  const opts = { cwd: u };
  const viaUrl = fsp.glob('a.*', opts as never);
  const got = viaUrl.next();
  u.pathname = real;
  assert.equal((await got).value, 'a.ts', 'a URL cwd changed after the call');

  const ac = new AbortController();
  const a = new URL(`file://${path.join(src, 'a.ts')}`);
  const watching = fsp.watch(a, { signal: ac.signal });
  const event = watching.next();
  a.pathname = path.join(dir, '.env');
  await new Promise(res => setTimeout(res, 20));
  realFs.appendFileSync(path.join(dir, '.env'), '');
  realFs.utimesSync(path.join(dir, '.env'), new Date(), new Date());
  realFs.utimesSync(path.join(src, 'a.ts'), new Date(), new Date());
  assert.equal(((await event).value as { filename: string }).filename, 'a.ts');
  ac.abort();
});

test('a glob\'s options cannot answer differently when read again', async () => {
  const src = path.join(real, 'src');
  const { caller } = onlyA(r => r.subject === `probe@1 ${src}`);
  const { fs } = await bothSurfaces(caller);
  let reads = 0;
  const lying = { get cwd() { return reads++ === 0 ? src : real; } };
  assert.ok(fs.globSync('*.ts', lying as never).includes('a.ts'), 'the granted directory, not the one read next');
});

test('a URL-shaped object that answers differently each time it is read is one path, or an error', async () => {
  const env = path.join(dir, '.env');
  const { caller } = onlyA();
  const { fs, fsp } = await bothSurfaces(caller);
  // Looks like no file: URL to the check, then is one to node.
  const liar = () => {
    let reads = 0;
    return { href: `file://${env}`, get protocol() { return reads++ < 2 ? 'http:' : 'file:'; }, hostname: '', pathname: env };
  };
  assert.throws(() => fs.readFileSync(liar() as never, 'utf8'), (e: NodeJS.ErrnoException) => e.code === 'ERR_INVALID_URL_SCHEME');
  await assert.rejects(fsp.readFile(liar() as never, 'utf8'), (e: NodeJS.ErrnoException) => e.code === 'ERR_INVALID_URL_SCHEME');
  assert.throws(() => fs.readFileSync({} as never, 'utf8'), (e: NodeJS.ErrnoException) => e.code === 'ERR_INVALID_ARG_TYPE', 'an object that is no path at all');
});

test('a path that is not valid UTF-8 is refused rather than asked about as some other name', async () => {
  const name = Buffer.concat([Buffer.from(`${real}${path.sep}`), Buffer.from([0xff])]);
  realFs.symlinkSync(path.join(real, '.env'), name);
  try {
    const { caller } = onlyA(r => r.subject.includes('�'));   // grants the name a lossy decode would ask about
    const { fs, fsp } = await bothSurfaces(caller);
    assert.throws(() => fs.readFileSync(name, 'utf8'), (e: NodeJS.ErrnoException) => e.code === 'EACCES' && /UTF-8/.test(e.message));
    await assert.rejects(fsp.readFile(name, 'utf8'), /UTF-8/);
  } finally { realFs.unlinkSync(name); }
});

test('a symlink changed while the question is open is asked about again at its new target', async () => {
  const link = path.join(dir, 'src', 'moves');
  realFs.symlinkSync(path.join(dir, 'src', 'a.ts'), link);
  try {
    const { caller, subjects } = onlyA();
    const { fsp } = await bothSurfaces(caller);
    const pending = fsp.readFile(link, 'utf8');
    realFs.unlinkSync(link);
    realFs.symlinkSync(path.join(dir, '.env'), link);
    await assert.rejects(pending, /declined/);
    assert.ok(subjects().includes(`fs-read ${path.join(real, '.env')}`));
  } finally { realFs.rmSync(link, { force: true }); }
});

test('a dangling symlink is asked about at the file a write through it would create', async () => {
  const link = path.join(dir, 'src', 'dangling');
  const target = path.join(dir, 'created-through-link');
  realFs.symlinkSync(target, link);
  try {
    const { caller, subjects } = onlyA(r => r.subject === `probe@1 ${path.join(real, 'src', 'dangling')}`);
    const { fs, fsp } = await bothSurfaces(caller);
    assert.throws(() => fs.writeFileSync(link, 'PWNED'), /cannot ask/);
    await assert.rejects(fsp.writeFile(link, 'PWNED'), /declined/);
    assert.equal(realFs.existsSync(target), false);
    assert.ok(subjects().includes(`fs-write ${path.join(real, 'created-through-link')}`));
  } finally { realFs.rmSync(link, { force: true }); }
});

test('a chain of dangling links and a parent that is one are followed; a cycle does not hang', async () => {
  const first = path.join(dir, 'src', 'l1');
  const second = path.join(dir, 'src', 'l2');
  const cycle = path.join(dir, 'src', 'loop');
  realFs.symlinkSync(second, first);
  realFs.symlinkSync(path.join(dir, 'no-such-dir'), second);
  realFs.symlinkSync(cycle, cycle);
  try {
    assert.equal(realResolve(path.join(first, 'x')), path.join(real, 'no-such-dir', 'x'));
    assert.equal(realResolve(cycle), path.join(real, 'src', 'loop'), 'a cycle resolves to itself, and the call fails with ELOOP');
  } finally { for (const l of [first, second, cycle]) realFs.rmSync(l, { force: true }); }
});

test('a flag is asked about as what it opens the file to do, on every call that takes one', async () => {
  const a = path.join(dir, 'src', 'a.ts');
  const { caller, subjects, seen } = onlyA();
  const { fsp } = await bothSurfaces(readOnly(caller));
  await assert.rejects(fsp.readFile(a, { flag: 'w' }), /declined/, 'a read that would truncate');
  assert.equal(realFs.readFileSync(a, 'utf8'), 'export const a = 1;');
  assert.deepEqual(subjects(), [`fs-write ${path.join(real, 'src', 'a.ts')}`]);

  // `r+` both reads and writes, so a grant to write does not let a body read through the handle.
  seen.length = 0;
  const writeOnly = { ...caller, gate: async (r: PermissionRequest) => { seen.push(r); return r.gate === 'fs-write' ? permitted('user') : refused('user'); } };
  const w = await bothSurfaces(writeOnly);
  await assert.rejects(w.fsp.open(path.join(dir, '.env'), 'r+'), /declined/);
  assert.equal(seen[0]!.gate, 'fs-read');

  // A getter cannot answer the check one way and node another.
  let reads = 0;
  const lying = { get flag() { return reads++ === 0 ? 'r' : 'w'; } };
  assert.equal(String(await fsp.readFile(a, lying as never)), 'export const a = 1;', 'read once, as `r`');
  assert.equal(realFs.readFileSync(a, 'utf8'), 'export const a = 1;');
});

test('openAccesses reports what each flag does', () => {
  const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = realFs.constants;
  const cases: [unknown, string[]][] = [
    [undefined, ['read']], [null, ['read']], [() => {}, ['read']],
    ['r', ['read']], ['rs', ['read']], ['r+', ['read', 'write']], ['rs+', ['read', 'write']],
    ['w', ['write']], ['wx', ['write']], ['w+', ['read', 'write']],
    ['a', ['write']], ['ax', ['write']], ['a+', ['read', 'write']],
    [O_RDONLY, ['read']], [O_WRONLY, ['write']], [O_RDWR, ['read', 'write']],
    [O_RDONLY | O_CREAT, ['read', 'write']], [O_RDONLY | O_TRUNC, ['read', 'write']], [O_WRONLY | O_APPEND, ['write']],
    ['nonsense', ['read', 'write']], [{}, ['read', 'write']],
  ];
  for (const [flags, want] of cases) assert.deepEqual(openAccesses(flags), want, String(flags));
});

test('guarded streams and handles still do their job', async () => {
  const a = path.join(dir, 'src', 'a.ts');
  const out = path.join(dir, 'src', 'out.txt');
  const { caller } = onlyA(r => r.subject === `probe@1 ${path.join(real, 'src', 'out.txt')}`);
  const { fs, fsp } = await bothSurfaces(caller);
  try {
    assert.equal((await drain(fs.createReadStream(a, { encoding: 'utf8', start: 7, end: 11 }))).data, 'const');
    assert.equal((await drain(fs.createReadStream(a, 'utf8'))).data, 'export const a = 1;', 'options as an encoding');
    assert.equal((await drain(fs.createReadStream(new URL(`file://${a}`)))).data, 'export const a = 1;', 'a URL path');

    const w = fs.createWriteStream(out);
    w.write('hello '); w.end('world');
    assert.equal(await closed(w), undefined);
    assert.equal(realFs.readFileSync(out, 'utf8'), 'hello world');

    // A descriptor it holds, whichever way: the path is ignored and nothing opens.
    const fd = fs.openSync(a, 'r');
    assert.equal((await drain(fs.createReadStream('/ignored' as string, { fd }))).data, 'export const a = 1;');

    const h = await fsp.open(a);
    assert.equal(await fsp.readFile(h, 'utf8'), 'export const a = 1;', 'a handle in the path position');
    const lines: string[] = [];
    const again = await fsp.open(a);
    for await (const l of again.readLines()) lines.push(l);
    assert.deepEqual(lines, ['export const a = 1;']);
    await h.close();

    const custom: string[] = [];
    const mine = fs.createReadStream(a, { fs: {
      open: (p: string, f: string, m: number, cb: (e: null, fd: number) => void) => { custom.push(p); realFs.open(p, f, m, cb as never); },
      read: realFs.read, close: realFs.close,
    } as never });
    assert.equal((await drain(mine)).data, 'export const a = 1;');
    assert.deepEqual(custom, [a], 'a body\'s own `fs` option is its own code, and is left in place');
  } finally { realFs.rmSync(out, { force: true }); }
});

test('through the runner, a body cannot repoint a stream', async () => {
  const reg = createModuleWrapperRegistry(s => s.startsWith('node:') ? s : `node:${s}`);
  const runner = createVmFunctionRunner(2000, { wrapModule: reg.apply });
  reg.service('node:fs', async (mod, ctx) => wrapFsModule(mod as object, 'fs', await decisionsFor(ctx.caller), ctx.caller));
  const { caller } = onlyA();
  const ns = await runner.import!('fs', caller) as typeof import('node:fs');
  const s = ns.createReadStream(path.join(dir, 'src', 'a.ts'));
  (s as unknown as { path: string }).path = path.join(dir, '.env');
  assert.equal((await drain(s)).code, 'EACCES');
});

test('a stream a standing answer allows opens with no prompt, though its open is asked about again', async () => {
  const { caller, prompts } = defaultPolicy({ 'tool_function.fs-read': { '*': [`* ${path.join(real, 'src')}${path.sep}`] } }, '0|once|deny');
  const { fs } = await bothSurfaces(caller);
  assert.equal((await drain(fs.createReadStream(path.join(dir, 'src', 'a.ts')))).data, 'export const a = 1;');
  const repointed = fs.createReadStream(path.join(dir, 'src', 'a.ts'));
  (repointed as unknown as { path: string }).path = path.join(dir, 'src', 'b.ts');
  assert.equal((await drain(repointed)).data, 'export const b = 2;', 'inside the grant, repointing is just another read');
  assert.equal(prompts.length, 0);
  const out = fs.createReadStream(path.join(dir, 'src', 'a.ts'));
  (out as unknown as { path: string }).path = path.join(dir, '.env');
  assert.equal((await drain(out)).code, 'EACCES', 'outside it, the human says no');
  assert.equal(prompts.length, 1, 'asked about the file it was pointed at');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// In a process of its own, so nothing of the CLI's hooks is registered: only host-node's.
const register = fileURLToPath(import.meta.resolve('@matatbread/matbot-host-node/register'));

async function run(dir: string, entry: string) {
  return promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', register, entry], { cwd: dir });
}

test('host-node/register: a TypeScript package under node_modules, importing ./x.js where the file is ./x.ts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-register-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pkg = join(dir, 'node_modules', 'ts-pkg');
  await mkdir(join(pkg, 'src'), { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'ts-pkg', type: 'module', exports: './src/index.ts' }));
  await writeFile(join(pkg, 'src', 'index.ts'), `import { two } from './two.js';\nexport const answer: number = two() + 40;\n`);
  await writeFile(join(pkg, 'src', 'two.ts'), `export function two(): number { return 2 as number; }\n`);
  // Both a .js and a .ts of one name: from TypeScript, `./x.js` is the spelling of the sibling source, so the
  // .ts wins; from compiled JavaScript it means the compiled file, which the source must not shadow.
  await writeFile(join(pkg, 'src', 'both.js'), `export const which = 'js';\n`);
  await writeFile(join(pkg, 'src', 'both.ts'), `export const which: string = 'ts';\n`);
  await writeFile(join(pkg, 'src', 'from-ts.ts'), `export { which } from './both.js';\n`);
  await writeFile(join(pkg, 'src', 'from-js.js'), `export { which } from './both.js';\n`);
  await writeFile(join(dir, 'app.ts'), [
    `import { answer } from 'ts-pkg';`,
    `import { which as fromTs } from './node_modules/ts-pkg/src/from-ts.ts';`,
    `import { which as fromJs } from './node_modules/ts-pkg/src/from-js.js';`,
    `const out: string = [answer, fromTs, fromJs].join(' ');`,
    `console.log(out);`,
  ].join('\n'));

  const { stdout } = await run(dir, 'app.ts');
  assert.equal(stdout.trim(), '42 ts js');
});

test('host-node/register: a missing module is still reported as missing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-register-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'app.ts'), `import './nowhere.js';\n`);
  await assert.rejects(run(dir, 'app.ts'), (e: { stderr: string }) => /ERR_MODULE_NOT_FOUND[\s\S]*nowhere\.js|nowhere\.js[\s\S]*ERR_MODULE_NOT_FOUND/.test(e.stderr));
});

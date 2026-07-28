#!/usr/bin/env node
// Publishes the workspace to npm, idempotently.
//
// Why this exists: `changeset publish` on its own is a fire-and-forget batch. When it half-fails
// (an expired token, a 5xx, a network blip mid-batch) you are left guessing which of ~45 packages
// landed, and re-running is scary because nobody knows what "already published" does. That
// uncertainty is the actual problem — not npm being flaky.
//
// The fix is to make the registry, not the exit code of one command, the source of truth:
//
//   1. PREFLIGHT — every reason a publish can fail *wholesale* is checked before anything is
//      pushed. Auth is checked first because that is the failure that silently eats a whole run.
//   2. PUBLISH   — `changeset publish` for the happy path.
//   3. RECONCILE — anything the registry still doesn't have is retried per-package, treating
//      "version already exists" as success. This is what makes a re-run safe: the script converges
//      on the desired state rather than replaying a transcript.
//   4. VERIFY    — poll until every expected version is *readable*. npm's read path is a CDN and
//      lags its write path by seconds; without this step that lag looks identical to a failure.
//
// Because every step is derived from live registry state, running this twice is a no-op, and
// running it after a partial failure finishes the job. There is no "clean up by hand" path.
//
// Usage:
//   node scripts/publish.mjs             # preflight, publish, reconcile, verify
//   node scripts/publish.mjs --check     # preflight + report drift only; publishes nothing
//   node scripts/publish.mjs --dry-run   # everything except the actual publish calls
//   node scripts/publish.mjs --no-git    # skip clean-tree/branch gates (CI already knows)
//   node scripts/publish.mjs --otp 123456  # one 2FA code for the whole batch

import { execFileSync, execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const dryRun = argv.includes('--dry-run');
const skipGit = argv.includes('--no-git');
const otp = argv.includes('--otp') ? argv[argv.indexOf('--otp') + 1] : null;

const REGISTRY = 'https://registry.npmjs.org';
// npm's read path is a CDN; a just-published version can 404 for a few seconds. Long enough to
// outlast that, short enough that a genuine failure doesn't hang a release.
const VERIFY_ATTEMPTS = 12;
const VERIFY_BASE_MS = 2000;

const c = { red: s => `\x1b[31m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m` };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

function step(n, title) {
  console.log(`\n${c.bold(`── ${n}. ${title}`)}`);
}

// ── workspace ────────────────────────────────────────────────────────────────

function workspacePackages() {
  const raw = run('pnpm', ['-r', 'list', '--depth', '-1', '--json']).trim();
  if (!raw) throw new Error('`pnpm -r list` returned nothing — is this being run from the workspace root?');
  const listed = JSON.parse(raw);
  const out = [];
  for (const entry of listed) {
    if (!entry.name || !entry.path || entry.path === root) continue;
    const manifestPath = path.join(entry.path, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.private) continue;
    out.push({ name: manifest.name, version: manifest.version, dir: entry.path, rel: path.relative(root, entry.path), manifest });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── registry ─────────────────────────────────────────────────────────────────

// A transient read failure must not be reported as "not published" — that would send RECONCILE
// off to republish something that is already there. Retry, then surface the error as an error.
async function fetchPackument(name, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      });
      if (res.status === 404) return { versions: {}, distTags: {} };
      if (res.ok) {
        const body = await res.json();
        return { versions: body.versions ?? {}, distTags: body['dist-tags'] ?? {} };
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(500 * 2 ** i);
  }
  throw new Error(`cannot read ${name} from the registry: ${lastError?.message}`);
}

async function registryState(pkgs) {
  const entries = await Promise.all(pkgs.map(async p => {
    const { versions, distTags } = await fetchPackument(p.name);
    return [p.name, { present: Object.hasOwn(versions, p.version), known: Object.keys(versions).length > 0, latest: distTags.latest }];
  }));
  return new Map(entries);
}

// ── preflight ────────────────────────────────────────────────────────────────

// Auth is checked against the registry itself rather than by looking for a token in .npmrc: a
// present-but-expired token is exactly the failure mode this is here to catch, and it looks
// identical to a good one on disk.
function checkAuth(problems) {
  try {
    const who = run('npm', ['whoami', '--registry', REGISTRY], { stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    console.log(`   ${c.green('✓')} authenticated to npm as ${c.bold(who)}`);
    return who;
  } catch {
    problems.push(
      'npm rejected the stored credentials (E401). The token in ~/.npmrc is missing, expired or revoked.\n' +
      '     Fix: `npm login --registry https://registry.npmjs.org` (or refresh the granular token and\n' +
      '     update //registry.npmjs.org/:_authToken), then re-run. Note npm is phasing out classic\n' +
      '     tokens that bypass 2FA for direct publishing, which expires them without warning.',
    );
    return null;
  }
}

const OTP_REQUIRED = /EOTP|ERR_PNPM_OTP|one-time pass|otp required|requires additional authentication/i;

function otpAdvice(who) {
  return 'the registry demands a 2FA one-time code for writes (EOTP), and a batch publish has no way to prompt for one.\n' +
    `     Fix (permanent): create a Granular Access Token at https://www.npmjs.com/settings/${who ?? '<user>'}/tokens\n` +
    '     with Read/Write on the @matatbread scope, and put it in ~/.npmrc as\n' +
    '     //registry.npmjs.org/:_authToken=<token>. Granular tokens publish without an OTP —\n' +
    "     the browser-session token `npm login` writes does not, whatever the account's 2FA mode says.\n" +
    '     Fix (one-off): re-run as `pnpm publish-all --otp <code>`.';
}

// There is no cheap preflight for "may this credential publish?". `whoami` only proves it can
// read, and a dist-tag write — the obvious no-op probe — is NOT gated the way publishing is, so it
// returns a confident pass on a credential publish will reject. A ✓ that can be wrong is worse
// than no check, so instead of predicting, publish ONE package and look: same cost (it had to be
// published anyway), but the batch stops after one failure rather than forty-five.

function checkGit(problems, advisories) {
  if (skipGit) return;
  const dirty = run('git', ['status', '--porcelain']).trim();
  if (dirty) problems.push(`working tree is dirty — publishing an unrecorded state:\n${dirty.split('\n').map(l => `       ${l}`).join('\n')}`);
  else console.log(`   ${c.green('✓')} working tree clean`);

  // Not an error: changesets accumulate between releases by design. It only means the versions
  // about to ship are older than the tip, which is worth saying out loud and nothing more.
  const pending = run('git', ['ls-files', '.changeset']).split('\n').filter(f => f.endsWith('.md') && !f.endsWith('README.md'));
  if (pending.length) advisories.push(`${pending.length} unconsumed changeset(s) — this release predates them; run \`pnpm version-packages\` to include them`);
  else console.log(`   ${c.green('✓')} no unconsumed changesets`);
}

// Everything in `problems` is a whole-run killer that npm only reports once it is already
// mid-batch. Everything in `advisories` ships fine but is worth seeing — kept out of the blocking
// set so packaging tidiness can never hold up a release.
function checkManifests(pkgs, problems, advisories) {
  const versions = new Set(pkgs.map(p => p.version));
  if (versions.size > 1) {
    // The changeset config puts every @matatbread/* package in one `fixed` group, so a split here
    // means a manual edit slipped through and consumers will resolve a peer range that has no match.
    problems.push(`fixed version group is not uniform: ${[...versions].sort().join(', ')}`);
  } else console.log(`   ${c.green('✓')} all ${pkgs.length} publishable packages at ${c.bold([...versions][0])}`);

  // changesets passes its config-level `access` to every publish, which is what has been carrying
  // the packages that omit publishConfig. Only the absence of *both* is a real rejection.
  const configAccess = JSON.parse(readFileSync(path.join(root, '.changeset/config.json'), 'utf8')).access;

  for (const p of pkgs) {
    if (p.manifest.publishConfig?.access !== 'public') {
      const msg = `${p.name}: scoped package without publishConfig.access="public"`;
      if (configAccess === 'public') advisories.push(`${msg} — relies on the changeset config's access setting`);
      else problems.push(`${msg} — npm will reject it as private`);
    }
    if (!p.manifest.files?.length) advisories.push(`${p.name}: no "files" field — the tarball ships the whole directory (build artefacts included)`);
    for (const target of exportTargets(p.manifest.exports)) {
      if (!existsSync(path.join(p.dir, target))) problems.push(`${p.name}: exports "${target}" does not exist on disk`);
      else if (!isPacked(p.manifest.files, target)) problems.push(`${p.name}: exports "${target}" is excluded by "files" — the published package would be unloadable`);
    }
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [dep, range] of Object.entries(p.manifest[field] ?? {})) {
        if (typeof range === 'string' && range.startsWith('workspace:') && !pkgs.some(o => o.name === dep)) {
          problems.push(`${p.name}: ${field}.${dep} is "${range}" but ${dep} is not a publishable workspace package — the protocol cannot be rewritten`);
        }
      }
    }
  }
}

// A coarse containment test, not an npm-ignore reimplementation: it only has to catch an entry
// point that no `files` entry could possibly cover.
function isPacked(files, target) {
  if (!files?.length) return true;
  const rel = target.replace(/^\.\//, '');
  return files.some(f => {
    const entry = f.replace(/^\.\//, '').replace(/\/$/, '');
    return rel === entry || rel.startsWith(`${entry}/`) || entry.includes('*');
  });
}

function exportTargets(exports) {
  if (!exports) return [];
  if (typeof exports === 'string') return [exports];
  const out = [];
  for (const value of Object.values(exports)) out.push(...exportTargets(value));
  return out.filter(t => typeof t === 'string' && t.startsWith('.'));
}

// ── publish ──────────────────────────────────────────────────────────────────

function publishBatch() {
  if (dryRun) return console.log(c.dim('   --dry-run: skipping `changeset publish`'));
  try {
    run('pnpm', ['exec', 'changeset', 'publish', ...(otp ? ['--otp', otp] : [])], { stdio: 'inherit' });
  } catch {
    // Not fatal on its own — RECONCILE reads the registry to find out what actually landed.
    console.log(c.yellow('   `changeset publish` exited non-zero; reconciling against the registry'));
  }
}

const ALREADY_PUBLISHED = /EPUBLISHCONFLICT|cannot publish over|previously published versions/i;

function publishOne(pkg) {
  if (dryRun) { console.log(c.dim(`   --dry-run: would publish ${pkg.name}@${pkg.version}`)); return 'dry'; }
  const args = ['publish', '--no-git-checks', '--access', 'public', ...(otp ? ['--otp', otp] : [])];
  // With no code supplied, hand the child the terminal so pnpm can prompt for one; piping is what
  // turns a promptable OTP into ERR_PNPM_OTP_NON_INTERACTIVE.
  const stdio = otp || !process.stdin.isTTY ? ['ignore', 'pipe', 'pipe'] : 'inherit';
  try {
    run('pnpm', args, { cwd: pkg.dir, stdio });
    return 'published';
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (ALREADY_PUBLISHED.test(output)) return 'exists';
    if (OTP_REQUIRED.test(output)) return 'otp';
    console.log(c.red(`   ✗ ${pkg.name}@${pkg.version}`));
    console.log(output.split('\n').filter(l => /error|ERR!/i.test(l)).map(l => `       ${l}`).join('\n'));
    return 'failed';
  }
}

// Tags are how the repo records what shipped. changeset publish only tags what it published
// itself, so anything RECONCILE pushed would otherwise go untagged.
function ensureTag(pkg) {
  const tag = `${pkg.name}@${pkg.version}`;
  if (skipGit || dryRun) return;
  try {
    run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    try { run('git', ['tag', tag]); } catch { /* tagging is bookkeeping; never fail a release on it */ }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const problems = [];
const advisories = [];
const pkgs = workspacePackages();

step(1, 'Preflight');
const who = checkAuth(problems);
checkGit(problems, advisories);
checkManifests(pkgs, problems, advisories);

let state = await registryState(pkgs);
const missing = () => pkgs.filter(p => !state.get(p.name).present);
const brandNew = pkgs.filter(p => !state.get(p.name).known);

console.log(`   ${c.green('✓')} registry read: ${pkgs.length - missing().length} already published, ${missing().length} to publish` +
  (brandNew.length ? ` (${brandNew.length} first-time: ${brandNew.map(p => p.name).join(', ')})` : ''));

for (const a of advisories) console.log(`   ${c.yellow('!')} ${a}`);

if (problems.length) {
  console.log(`\n${c.red(c.bold(`${problems.length} blocking problem(s):`))}`);
  for (const p of problems) console.log(`   ${c.red('✗')} ${p}`);
  process.exit(1);
}

if (checkOnly) {
  step(2, 'Drift report');
  for (const p of pkgs) {
    const s = state.get(p.name);
    console.log(`   ${s.present ? c.green('published') : c.yellow('MISSING  ')}  ${p.name}@${p.version}${s.present || !s.latest ? '' : c.dim(`  (npm latest: ${s.latest})`)}`);
  }
  process.exit(missing().length ? 1 : 0);
}

if (!missing().length) {
  console.log(c.green('\nEverything is already published. Nothing to do.'));
  process.exit(0);
}

step(2, `Publish (${missing().length} package(s))`);

const canary = missing()[0];
console.log(`   canary: ${canary.name}@${canary.version}`);
const canaryResult = publishOne(canary);
if (canaryResult === 'otp') {
  console.log(`\n${c.red(c.bold('Stopped before the batch: '))}${otpAdvice(who)}`);
  process.exit(1);
}
if (canaryResult === 'failed') {
  console.log(`\n${c.red(c.bold('Stopped before the batch'))} — the first package failed, so the other ${missing().length - 1} would too.`);
  process.exit(1);
}
console.log(`   ${c.green('✓')} canary ${canaryResult === 'exists' ? 'already on npm' : 'published'} — proceeding with the batch`);

publishBatch();

step(3, 'Reconcile');
state = await registryState(pkgs);
let outstanding = missing();
if (!outstanding.length) console.log(`   ${c.green('✓')} nothing left behind by the batch`);
for (const pkg of outstanding) {
  const result = publishOne(pkg);
  if (result === 'published') console.log(`   ${c.green('✓')} ${pkg.name}@${pkg.version} ${c.dim('(retried individually)')}`);
  if (result === 'exists') console.log(`   ${c.green('✓')} ${pkg.name}@${pkg.version} ${c.dim('(already on npm)')}`);
  if (result === 'otp') {
    // Every remaining package will fail identically; 44 more copies of the same error helps nobody.
    console.log(`\n${c.red(c.bold('Stopped: '))}${otpAdvice(who)}`);
    process.exit(1);
  }
}

step(4, 'Verify');
for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
  state = await registryState(pkgs);
  outstanding = missing();
  if (!outstanding.length) break;
  if (attempt === VERIFY_ATTEMPTS) break;
  const wait = Math.min(VERIFY_BASE_MS * attempt, 15000);
  console.log(c.dim(`   ${outstanding.length} not yet readable; retrying in ${wait / 1000}s (${attempt}/${VERIFY_ATTEMPTS - 1})`));
  await sleep(wait);
}

if (outstanding.length) {
  console.log(`\n${c.red(c.bold(`${outstanding.length} package(s) did not publish:`))}`);
  for (const p of outstanding) console.log(`   ${c.red('✗')} ${p.name}@${p.version}  ${c.dim(p.rel)}`);
  console.log(c.dim('\n   Re-run `pnpm publish-all` — it resumes from live registry state and skips what landed.'));
  process.exit(1);
}

for (const pkg of pkgs) ensureTag(pkg);
console.log(`\n${c.green(c.bold(`✓ all ${pkgs.length} packages published and readable at ${pkgs[0].version}`))}`);

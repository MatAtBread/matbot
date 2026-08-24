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
// npm's read path is a CDN; a just-published version can 404 for a while. Long enough to outlast
// that, short enough that a genuine failure doesn't hang a release. A brand-new package's FIRST
// version is the slow case — measured at over two minutes — so it gets its own budget.
const VERIFY_ATTEMPTS = 12;
const SETTLE_ATTEMPTS = 6;
const SETTLE_ATTEMPTS_NEW = 14;
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
    // A spread is now expected rather than broken. Two policies, deliberately different, both in
    // `.changeset/config.json`: the HARNESS (core, plugin-api, cli, web-bundle) is a `fixed` group and
    // always moves in lockstep, while plugins are in no group at all and version independently, each
    // keeping the number it last shipped at until it changes.
    //
    // The harness half is not tidiness. `versionBanner()` treats any difference between the CLI's version
    // and the resolved core/plugin-api versions as evidence of two physical copies of a host singleton and
    // tells the user to reinstall — so shipping core ahead of the CLI prints a false skew warning on every
    // boot. And `about_matbot` reports the APP's own package version, so a core-only release would change
    // behaviour while the version the model states stayed put. Lockstep is what makes both honest.
    //
    // A spread was a whole-run blocker while every package moved together — a split could then only mean a
    // hand-edited version — and the reason it gave ("consumers resolve a peer range with no match") does
    // not survive independent plugin versioning: the ranges are `workspace:^`, rewritten at pack time from
    // the dependency's OWN version, so a plugin at 0.4.8 asks for the plugin-api it was built against
    // whatever its siblings are at. A range that cannot be rewritten is still a problem, caught per-package
    // below.
    advisories.push(`versions span ${[...versions].sort().join(', ')} — expected: the harness (core/plugin-api/cli/web-bundle) moves in lockstep, plugins version independently`);
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

// Is this exact version on the registry? Retried, because the read path lags the write path — the
// answer immediately after a publish is "not yet" long before it is "no".
async function isPublished(pkg, attempts = 1) {
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(Math.min(2000 * i, 10000));
    const { versions } = await fetchPackument(pkg.name);
    if (Object.hasOwn(versions, pkg.version)) return true;
  }
  return false;
}

async function publishOne(pkg) {
  if (dryRun) { console.log(c.dim(`   --dry-run: would publish ${pkg.name}@${pkg.version}`)); return 'dry'; }
  const args = ['publish', '--no-git-checks', '--access', 'public', ...(otp ? ['--otp', otp] : [])];
  // With no code supplied, hand the child the terminal so pnpm can prompt for one (and so its
  // browser-auth flow is usable); piping is what turns a promptable OTP into
  // ERR_PNPM_OTP_NON_INTERACTIVE.
  const stdio = otp || !process.stdin.isTTY ? ['ignore', 'pipe', 'pipe'] : 'inherit';
  try {
    run('pnpm', args, { cwd: pkg.dir, stdio });
    return 'published';
  } catch (err) {
    // A non-zero exit does NOT mean the version isn't there — "you cannot publish over 0.3.5"
    // is a *failure to re-publish something that already succeeded*. Never classify that from the
    // child's stderr: with an inherited terminal nothing is captured, and pnpm's wording is not a
    // contract. Ask the registry; it is the only thing that actually knows.
    if (await isPublished(pkg, 4)) return 'exists';
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (OTP_REQUIRED.test(output)) return 'otp';
    console.log(c.red(`   ✗ ${pkg.name}@${pkg.version}`));
    const detail = output.split('\n').filter(l => /error|ERR!/i.test(l) && !/^\s+at /.test(l));
    if (detail.length) console.log(detail.map(l => `       ${l.trim()}`).join('\n'));
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
const canaryResult = await publishOne(canary);
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

// Poll until the registry agrees, or until patience runs out. Returns what is still absent.
async function settle(attempts, label) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    state = await registryState(pkgs);
    if (!missing().length || attempt === attempts) break;
    const wait = Math.min(VERIFY_BASE_MS * attempt, 15000);
    console.log(c.dim(`   ${missing().length} not yet readable; ${label} in ${wait / 1000}s (${attempt}/${attempts - 1})`));
    await sleep(wait);
  }
  return missing();
}

// Wait for the write to become readable BEFORE deciding anything is outstanding. Reconciling off a
// read taken the instant the batch returns means re-publishing packages that already succeeded and
// reading their "cannot publish over" rejection as failure — noise that looks exactly like a
// broken release. A first publish of a brand-new package propagates slowest, so it sets the pace.
step(3, 'Settle');
let outstanding = await settle(brandNew.length ? SETTLE_ATTEMPTS_NEW : SETTLE_ATTEMPTS, 'rechecking');
console.log(`   ${c.green('✓')} registry agrees on ${pkgs.length - outstanding.length}/${pkgs.length}`);

step(4, 'Reconcile');
if (!outstanding.length) console.log(`   ${c.green('✓')} nothing left behind by the batch`);
for (const pkg of outstanding) {
  const result = await publishOne(pkg);
  if (result === 'published') console.log(`   ${c.green('✓')} ${pkg.name}@${pkg.version} ${c.dim('(retried individually)')}`);
  if (result === 'exists') console.log(`   ${c.green('✓')} ${pkg.name}@${pkg.version} ${c.dim('(already on npm)')}`);
  if (result === 'otp') {
    // Every remaining package will fail identically; 44 more copies of the same error helps nobody.
    console.log(`\n${c.red(c.bold('Stopped: '))}${otpAdvice(who)}`);
    break;
  }
}

step(5, 'Verify');
outstanding = await settle(VERIFY_ATTEMPTS, 'retrying');

// However the run got here, it ends by saying plainly what is on npm and what is not. That
// sentence — not the exit code, not which subcommands complained — is the point of the script.
const landed = pkgs.length - outstanding.length;
console.log(`\n${c.bold('── Result')}`);
if (!outstanding.length) {
  for (const pkg of pkgs) ensureTag(pkg);
  console.log(`   ${c.green(c.bold(`✓ all ${pkgs.length} packages are on npm at ${pkgs[0].version}`))}`);
  process.exit(0);
}
console.log(`   ${c.green(`${landed}/${pkgs.length} published`)} — ${c.red(`${outstanding.length} missing:`)}`);
for (const p of outstanding) console.log(`   ${c.red('✗')} ${p.name}@${p.version}  ${c.dim(p.rel)}`);
console.log(c.dim('\n   Re-run `pnpm publish-all` — it resumes from live registry state and skips what landed.'));
console.log(c.dim('   If npm is merely slow, `pnpm publish-check` will show them as published shortly.'));
process.exit(1);

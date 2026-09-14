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
//      A version merely EXISTING on npm is not enough: its contents are compared with what would
//      be packed now, because an edit without a bump is otherwise skipped silently and npm keeps
//      serving the old code (0.4.14 shipped five such packages as "published").
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
//   node scripts/publish.mjs             # preflight, publish, reconcile, verify, push tags
//   node scripts/publish.mjs --check     # preflight + report drift only; publishes nothing, needs no npm login
//   node scripts/publish.mjs --check --no-git --allow-unpublished   # CI: fail only on blocking problems
//   node scripts/publish.mjs --dry-run   # everything except the actual publish calls
//   node scripts/publish.mjs --no-git    # skip clean-tree/branch gates and tag pushing (CI already knows)
//   node scripts/publish.mjs --otp 123456  # one 2FA code for the whole batch
//   node scripts/publish.mjs --release v0.4.15  # also move+push the umbrella tag and retarget the GitHub release

import { execFileSync, execFile } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';
import {
  compareVersions, highestVersion, nextFreePatch, readTree, diffTrees,
  parseChangeset, classifyChangeset, isPublishConflict, mapLimit,
} from './publish-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const dryRun = argv.includes('--dry-run');
const skipGit = argv.includes('--no-git');
const allowUnpublished = argv.includes('--allow-unpublished');
const otp = argv.includes('--otp') ? argv[argv.indexOf('--otp') + 1] : null;
const release = argv.includes('--release') ? argv[argv.indexOf('--release') + 1] : null;
if (argv.includes('--release') && !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(release ?? '')) {
  throw new Error(`--release needs a tag like v0.4.15, got ${release ?? 'nothing'}`);
}

const REGISTRY = 'https://registry.npmjs.org';
// npm's read path is a CDN; a just-published version can 404 for a while. Long enough to outlast
// that, short enough that a genuine failure doesn't hang a release. A brand-new package's FIRST
// version is the slow case — measured at over two minutes — so it gets its own budget.
const VERIFY_ATTEMPTS = 12;
const SETTLE_ATTEMPTS = 6;
const SETTLE_ATTEMPTS_NEW = 14;
const VERIFY_BASE_MS = 2000;
const CONTENT_CONCURRENCY = 8;

const c = { red: s => `\x1b[31m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m` };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const runAsync = (cmd, args, opts = {}) => promisify(execFile)(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

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
    const all = Object.keys(versions);
    return [p.name, {
      present: Object.hasOwn(versions, p.version),
      known: all.length > 0,
      latest: distTags.latest,
      highest: highestVersion(all),
      versions: all,
      tarball: versions[p.version]?.dist?.tarball,
    }];
  }));
  return new Map(entries);
}

// ── preflight ────────────────────────────────────────────────────────────────

// Auth is checked against the registry itself rather than by looking for a token in .npmrc: a
// present-but-expired token is exactly the failure mode this is here to catch, and it looks
// identical to a good one on disk. `--check` only reads the registry, so there it is advisory —
// which is what lets CI run the check with no credentials at all.
function checkAuth(problems, advisories) {
  try {
    const who = run('npm', ['whoami', '--registry', REGISTRY], { stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    console.log(`   ${c.green('✓')} authenticated to npm as ${c.bold(who)}`);
    return who;
  } catch {
    if (checkOnly) {
      advisories.push('not authenticated to npm — fine for --check, which only reads the registry');
      return null;
    }
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

function checkGit(problems) {
  if (skipGit) return;
  const dirty = run('git', ['status', '--porcelain']).trim();
  if (dirty) problems.push(`working tree is dirty — publishing an unrecorded state:\n${dirty.split('\n').map(l => `       ${l}`).join('\n')}`);
  else console.log(`   ${c.green('✓')} working tree clean`);
}

// A tag created by an earlier run and never pushed is a release the remote does not know about.
function checkRemoteTags(pkgs, advisories) {
  if (skipGit) return;
  let remote;
  try {
    remote = new Set(run('git', ['ls-remote', '--tags', 'origin'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map(l => l.split('\t')[1]?.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '')).filter(Boolean));
  } catch {
    advisories.push('could not list the remote\'s tags — skipped the unpushed-tag check');
    return;
  }
  const local = new Set(run('git', ['tag', '--list', '@matatbread/*']).split('\n').filter(Boolean));
  const unpushed = pkgs.map(tagOf).filter(t => local.has(t) && !remote.has(t));
  if (unpushed.length) advisories.push(`${unpushed.length} package tag(s) exist locally but not on origin: ${unpushed.join(', ')} — a successful run pushes them`);
}

// A clean tree only says the checkout matches the commit; it says nothing about whether the
// lockfile *inside* that commit agrees with the manifests beside it. v0.4.12 shipped exactly that
// combination — four packages' dependencies absent from the lock, tree clean, every package
// correct on npm — so `pnpm install` succeeded only on the machine the release was cut on and
// failed for every consumer, CI defaulting --frozen-lockfile to true. Nothing in a publish run
// looks wrong when this happens, because nothing in the publish PATH reads the lockfile: `pnpm
// pack` rewrites `workspace:` ranges from each manifest. So the artefact that breaks is the git
// tag, which this script never validates and cannot repair after the fact — npm forbids
// re-publishing a version, so the only fix is a new one.
//
// It pairs with the clean-tree gate to give the guarantee actually wanted: correct on disk AND
// nothing uncommitted means the lockfile in the commit about to be tagged is the one checked.
// Under --no-git that second half is the caller's.
//
// pnpm is the authority rather than a hand-rolled importer/manifest diff, for the reason stated
// above about probing publish rights: a reimplementation of someone else's comparison passes
// confidently right when it has drifted. `--lockfile-only` stops it writing and `--offline` keeps
// it off the network and out of the store — measured hermetic against a cold store, ~300ms — so a
// release can never be slowed or flaked by this.
function checkLockfile(problems) {
  try {
    run('pnpm', ['install', '--frozen-lockfile', '--lockfile-only', '--offline'], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`   ${c.green('✓')} pnpm-lock.yaml matches every workspace manifest`);
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    const detail = output.split('\n')
      .filter(l => l.trim() && !/^\s*(Scope:|Note that in CI|Progress:)/.test(l))
      .slice(0, 6)
      .map(l => `       ${l.trim()}`)
      .join('\n');
    problems.push(
      'pnpm-lock.yaml is out of date with the workspace manifests. This would tag a tree that cannot\n' +
      '     be built by `pnpm install` anywhere but here — in CI --frozen-lockfile is the default:\n' +
      `${detail}\n` +
      '     pnpm stops at the first manifest that disagrees, so more may be stale than it names.\n' +
      '     Fix: `pnpm install --lockfile-only` (regenerates all of them), commit pnpm-lock.yaml, re-run.',
    );
  }
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
    advisories.push(`versions span ${[...versions].sort(compareVersions).join(', ')} — expected: the harness (core/plugin-api/cli/web-bundle) moves in lockstep, plugins version independently`);
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

// Local below npm's highest means someone published from elsewhere, or a version went backwards.
// Publishing on would put the older number's code under a `latest` that is not the latest.
function checkBehind(pkgs, state, problems) {
  let behind = 0;
  for (const p of pkgs) {
    const { highest } = state.get(p.name);
    if (highest && compareVersions(p.version, highest) < 0) {
      behind++;
      problems.push(`BEHIND: ${p.name} is ${p.version} locally, npm has ${highest}. Pull the bump, or bump past it.`);
    }
  }
  if (!behind) console.log(`   ${c.green('✓')} no package is behind npm`);
}

async function fetchTarball(url, dest, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) { writeFileSync(dest, Buffer.from(await res.arrayBuffer())); return; }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(500 * 2 ** i);
  }
  throw new Error(`cannot download ${url}: ${lastError?.message}`);
}

async function unpack(tgz, dir) {
  mkdirSync(dir, { recursive: true });
  // npm tarballs have one top-level folder, conventionally `package/` but not guaranteed.
  await runAsync('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1']);
}

function lastCommit(pkg, file) {
  try {
    return run('git', ['log', '-1', '--format=%h %s', '--', path.join(pkg.rel, file)], { stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Only a version already on npm can be stale; anything missing is about to be published anyway.
// `pnpm pack` is the local side because it is exactly what `pnpm publish` would upload — `files`,
// `workspace:` rewrites and LICENSE applied — so pnpm stays the authority rather than a copy of it.
async function checkContent(pkgs, state, problems, advisories) {
  const present = pkgs.filter(p => state.get(p.name).present);
  const tmp = mkdtempSync(path.join(tmpdir(), 'matbot-publish-'));
  const stale = new Set();
  try {
    const results = await mapLimit(present, CONTENT_CONCURRENCY, async (p, i) => {
      const work = path.join(tmp, String(i));
      mkdirSync(work);
      const { stdout } = await runAsync('pnpm', ['pack', '--json', '--pack-destination', work], { cwd: p.dir });
      const localTgz = JSON.parse(stdout.slice(stdout.indexOf('{'))).filename;
      const npmTgz = path.join(work, 'npm.tgz');
      await fetchTarball(state.get(p.name).tarball, npmTgz);
      await Promise.all([unpack(localTgz, path.join(work, 'local')), unpack(npmTgz, path.join(work, 'npm'))]);
      return diffTrees(readTree(path.join(work, 'local')), readTree(path.join(work, 'npm')));
    });
    const ranges = [];
    present.forEach((p, i) => {
      const d = results[i];
      if (d.status === 'ranges') ranges.push(p);
      if (d.status !== 'stale') return;
      stale.add(p.name);
      const lines = [
        ...d.changed.map(f => [f === 'package.json' && d.manifestKeys.length ? `changed: ${d.manifestKeys.join(', ')}` : 'changed', f]),
        ...d.onlyLocal.map(f => ['new, not on npm', f]),
        ...d.onlyNpm.map(f => ['only on npm (deleted or now excluded by "files")', f]),
      ].map(([why, f]) => {
        const commit = why.startsWith('only on npm') ? '' : lastCommit(p, f);
        return `       ${f}  ${c.dim(`${why}${commit ? ` — last touched by ${commit}` : ''}`)}`;
      });
      const next = nextFreePatch(p.version, state.get(p.name).versions);
      problems.push(`STALE: ${p.name}@${p.version} differs from npm. Bump its version${next ? ` (next free patch: ${next})` : ''}.\n${lines.join('\n')}`);
    });
    // One line, not one per package: after any harness bump most plugins land here, and a wall of
    // advisories is how the one blocking STALE below gets scrolled past.
    if (ranges.length) {
      advisories.push(`${ranges.length} package(s) have the same code as npm but newer dependency ranges (a sibling was bumped) — republishing changes what they resolve, not what they run: ${ranges.map(p => p.name.replace('@matatbread/matbot-', '')).join(', ')}`);
    }
    const same = present.length - stale.size - ranges.length;
    console.log(`   ${stale.size ? c.red('✗') : c.green('✓')} contents compared for ${present.length} published version(s): ${same} identical, ${ranges.length} ranges-only, ${stale.size} stale`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return stale;
}

// A changeset only earns a bump if a package it names has something npm does not. Counting them
// said nothing about that, and seven redundant ones — one a `minor`, which cascades to 1.0.0 —
// nearly went into 0.4.14.
function checkChangesets(pkgs, differs, advisories) {
  const dir = path.join(root, '.changeset');
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md').sort() : [];
  if (!files.length) return console.log(`   ${c.green('✓')} no unconsumed changesets`);
  const known = new Set(pkgs.map(p => p.name));
  console.log(`   ${c.yellow('!')} ${files.length} unconsumed changeset(s) — this release predates them; \`pnpm version-packages\` includes them:`);
  for (const f of files) {
    const releases = parseChangeset(readFileSync(path.join(dir, f), 'utf8'));
    const verdict = classifyChangeset(releases, differs);
    const unknown = [...releases.keys()].filter(n => !known.has(n));
    console.log(verdict.status === 'pending'
      ? `       ${c.yellow('pending  ')} ${f}  ${c.dim(`differs from npm: ${verdict.pending.join(', ')}`)}`
      : `       ${c.dim('redundant')} ${f}  ${c.dim('every package it names is already on npm as-is')}`);
    if (unknown.length) advisories.push(`${f} names package(s) not in the workspace: ${unknown.join(', ')}`);
    if (verdict.needlessMinor.length) {
      advisories.push(c.red(c.bold(`${f} requests a minor/major bump for ${verdict.needlessMinor.join(', ')}, whose contents are already on npm — with peer ranges this cascades to 1.0.0. Use patch, or delete it.`)));
    }
  }
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
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    // The one refusal that IS classified from stderr, against the rule below: npm can only say
    // "previously staged" / "cannot publish over" if the version was written. With an inherited
    // terminal nothing is captured, so this never fires there and the registry is asked instead.
    if (isPublishConflict(output)) return 'exists-pending';
    // Otherwise a non-zero exit does NOT mean the version isn't there, and pnpm's wording is not a
    // contract. Ask the registry — with the settle budget, since a fresh write is slow to read.
    if (await isPublished(pkg, SETTLE_ATTEMPTS)) return 'exists';
    if (OTP_REQUIRED.test(output)) return 'otp';
    // Not ✗ yet: the write may still land and become readable. VERIFY is what says it failed.
    console.log(c.yellow(`   ! ${pkg.name}@${pkg.version} not confirmed — VERIFY will decide`));
    const detail = output.split('\n').filter(l => /error|ERR!/i.test(l) && !/^\s+at /.test(l));
    if (detail.length) console.log(detail.map(l => `       ${l.trim()}`).join('\n'));
    return 'failed';
  }
}

// ── tags ─────────────────────────────────────────────────────────────────────

const tagOf = pkg => `${pkg.name}@${pkg.version}`;

// Tags are how the repo records what shipped. changeset publish only tags what it published
// itself, so anything RECONCILE pushed would otherwise go untagged — and a tag nobody pushed
// records it only on the machine the release was cut on.
function ensureTags(pkgs) {
  if (skipGit || dryRun) return;
  for (const pkg of pkgs) {
    const tag = tagOf(pkg);
    try {
      run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      try { run('git', ['tag', tag]); } catch { /* tagging is bookkeeping; never fail a release on it */ }
    }
  }
  try {
    run('git', ['push', 'origin', ...pkgs.map(p => `refs/tags/${tagOf(p)}`)], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`   ${c.green('✓')} package tags pushed to origin`);
  } catch (err) {
    console.log(c.yellow(`   ! could not push package tags: ${`${err.stderr ?? err.message}`.trim().split('\n')[0]}`));
  }
}

// The umbrella tag names the whole release, so it moves to wherever the release was actually cut
// and the GitHub release follows it — the fix-up v0.4.14 needed by hand.
function moveRelease(tag) {
  if (dryRun) return console.log(c.dim(`   --dry-run: would move ${tag} to HEAD and retarget its GitHub release`));
  const sha = run('git', ['rev-parse', 'HEAD']).trim();
  try {
    run('git', ['tag', '-f', tag, sha], { stdio: ['ignore', 'pipe', 'pipe'] });
    run('git', ['push', '-f', 'origin', `refs/tags/${tag}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`   ${c.green('✓')} ${tag} → ${sha.slice(0, 7)}, pushed`);
  } catch (err) {
    return console.log(c.yellow(`   ! could not move ${tag}: ${`${err.stderr ?? err.message}`.trim().split('\n')[0]}`));
  }
  try {
    run('gh', ['release', 'edit', tag, '--target', sha], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`   ${c.green('✓')} GitHub release ${tag} retargeted`);
  } catch {
    try {
      run('gh', ['release', 'create', tag, '--verify-tag', '--generate-notes'], { stdio: ['ignore', 'pipe', 'pipe'] });
      console.log(`   ${c.green('✓')} GitHub release ${tag} created`);
    } catch (err) {
      console.log(c.yellow(`   ! could not update the GitHub release ${tag}: ${`${err.stderr ?? err.message}`.trim().split('\n')[0]}`));
    }
  }
}

function finish(pkgs) {
  if (skipGit) return;
  step('✓', 'Tags');
  ensureTags(pkgs);
  if (release) moveRelease(release);
}

// ── main ─────────────────────────────────────────────────────────────────────

const problems = [];
const advisories = [];
const pkgs = workspacePackages();

step(1, 'Preflight');
const who = checkAuth(problems, advisories);
checkGit(problems);
checkRemoteTags(pkgs, advisories);
checkLockfile(problems);
checkManifests(pkgs, problems, advisories);

let state = await registryState(pkgs);
const missing = () => pkgs.filter(p => !state.get(p.name).present);
const brandNew = pkgs.filter(p => !state.get(p.name).known);

console.log(`   ${c.green('✓')} registry read: ${pkgs.length - missing().length} already published, ${missing().length} to publish` +
  (brandNew.length ? ` (${brandNew.length} first-time: ${brandNew.map(p => p.name).join(', ')})` : ''));

checkBehind(pkgs, state, problems);
const stale = await checkContent(pkgs, state, problems, advisories);
checkChangesets(pkgs, new Set([...missing().map(p => p.name), ...stale]), advisories);

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
  process.exit(missing().length && !allowUnpublished ? 1 : 0);
}

if (!missing().length) {
  console.log(c.green('\nEverything is already published, with matching contents. Nothing to publish.'));
  finish(pkgs);
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
console.log(`   ${c.green('✓')} canary ${{ exists: 'already on npm', 'exists-pending': 'landed, npm not yet readable' }[canaryResult] ?? 'published'} — proceeding with the batch`);

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
  if (result === 'exists-pending') console.log(`   ${c.green('✓')} ${pkg.name}@${pkg.version} ${c.dim('(landed, npm not yet readable)')}`);
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
  console.log(`   ${c.green(c.bold(`✓ all ${pkgs.length} packages are on npm`))}`);
  finish(pkgs);
  process.exit(0);
}
console.log(`   ${c.green(`${landed}/${pkgs.length} published`)} — ${c.red(`${outstanding.length} missing:`)}`);
for (const p of outstanding) console.log(`   ${c.red('✗')} ${p.name}@${p.version}  ${c.dim(p.rel)}`);
console.log(c.dim('\n   Re-run `pnpm publish-all` — it resumes from live registry state and skips what landed.'));
console.log(c.dim('   If npm is merely slow, `pnpm publish-check` will show them as published shortly.'));
process.exit(1);

// The decisions publish.mjs makes, kept free of the registry, pnpm and git so they can be tested
// against fixtures. Everything here takes plain values (or a directory to read) and returns a verdict.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ── versions ─────────────────────────────────────────────────────────────────

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(v) {
  const m = SEMVER.exec(v);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

// Semver precedence, prereleases included: 1.0.0-rc.1 < 1.0.0, numeric identifiers compare
// numerically and sort below alphanumeric ones. Unparseable versions sort below everything, so a
// junk entry on npm can never make a real local version look BEHIND.
export function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i], y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; continue; }
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function highestVersion(versions) {
  let best;
  for (const v of versions) if (best === undefined || compareVersions(v, best) > 0) best = v;
  return best;
}

// The next patch above `version` that npm has not already had. Taken versions include unpublished
// ones — npm never lets a number be reused, which is the collision 0.4.14 hit.
export function nextFreePatch(version, taken) {
  const p = parseVersion(version);
  if (!p) return null;
  let [major, minor, patch] = p.core;
  const all = new Set(taken);
  do patch++; while (all.has(`${major}.${minor}.${patch}`));
  return `${major}.${minor}.${patch}`;
}

// ── contents ─────────────────────────────────────────────────────────────────

// An unpacked tarball as path → bytes, posix-separated so npm's and pnpm's trees key identically.
export function readTree(dir) {
  const out = new Map();
  const walk = rel => {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.set(child, readFileSync(path.join(dir, child)));
    }
  };
  walk('');
  return out;
}

const DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

// 'same', 'ranges' (only the version ranges of existing dependencies moved — a sibling was bumped,
// the code is identical) or 'changed'. Adding or dropping a dependency is 'changed': that alters
// what the package can import, not just which copy it resolves.
export function classifyManifestChange(localText, npmText) {
  let local, npm;
  try { local = JSON.parse(localText); npm = JSON.parse(npmText); } catch { return localText === npmText ? 'same' : 'changed'; }
  if (JSON.stringify(canonical(local)) === JSON.stringify(canonical(npm))) return 'same';
  const blank = m => {
    const copy = { ...m };
    for (const f of DEP_FIELDS) if (copy[f] && typeof copy[f] === 'object') copy[f] = Object.fromEntries(Object.keys(copy[f]).map(k => [k, '']));
    return JSON.stringify(canonical(copy));
  };
  return blank(local) === blank(npm) ? 'ranges' : 'changed';
}

export function rangeChanges(localText, npmText) {
  const local = JSON.parse(localText), npm = JSON.parse(npmText), out = new Set();
  for (const f of DEP_FIELDS) {
    for (const [dep, range] of Object.entries(local[f] ?? {})) {
      const before = npm[f]?.[dep];
      if (before !== undefined && before !== range) out.add(`${dep} ${before} → ${range}`);
    }
  }
  return [...out];
}

// The top-level manifest keys whose values differ, dotted one level into dependency fields so a
// STALE report says `dependencies.@x/c` rather than just "package.json".
export function manifestKeysChanged(localText, npmText) {
  const local = JSON.parse(localText), npm = JSON.parse(npmText), out = [];
  for (const key of [...new Set([...Object.keys(local), ...Object.keys(npm)])].sort()) {
    const a = canonical(local[key]), b = canonical(npm[key]);
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (DEP_FIELDS.includes(key) && a && b && typeof a === 'object' && typeof b === 'object') {
      for (const dep of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (!(dep in a) || !(dep in b)) out.push(`${key}.${dep} ${dep in a ? 'added' : 'removed'}`);
      }
    } else out.push(key);
  }
  return out;
}

// Compares two unpacked trees file by file. Tarball hashes are useless for this: compression level
// and mtimes change them when every file is identical.
export function diffTrees(local, npm) {
  const changed = [], onlyLocal = [], onlyNpm = [];
  let manifest = 'same', ranges = [], manifestKeys = [];
  for (const [file, bytes] of local) {
    const other = npm.get(file);
    if (!other) { onlyLocal.push(file); continue; }
    if (file === 'package.json') {
      const [l, n] = [bytes.toString('utf8'), other.toString('utf8')];
      manifest = classifyManifestChange(l, n);
      if (manifest === 'ranges') ranges = rangeChanges(l, n);
      if (manifest === 'changed') {
        changed.push(file);
        try { manifestKeys = manifestKeysChanged(l, n); } catch { /* unparseable: the file name is all there is to say */ }
      }
    } else if (!bytes.equals(other)) changed.push(file);
  }
  for (const file of npm.keys()) if (!local.has(file)) onlyNpm.push(file);
  const status = changed.length || onlyLocal.length || onlyNpm.length ? 'stale' : manifest === 'ranges' ? 'ranges' : 'same';
  return { status, changed: changed.sort(), onlyLocal: onlyLocal.sort(), onlyNpm: onlyNpm.sort(), ranges, manifestKeys };
}

// ── changesets ───────────────────────────────────────────────────────────────

// The frontmatter of a changeset: `"@scope/name": patch` per line between two `---` fences.
export function parseChangeset(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const releases = new Map();
  if (!m) return releases;
  for (const line of m[1].split(/\r?\n/)) {
    const entry = /^\s*["']?([^"':]+(?::[^"':]+)?)["']?\s*:\s*(major|minor|patch|none)\s*$/.exec(line);
    if (entry) releases.set(entry[1].trim(), entry[2]);
  }
  return releases;
}

// `differs` is every package whose current contents are NOT on npm (missing version or stale).
// A changeset naming only packages outside it would bump them for nothing.
export function classifyChangeset(releases, differs) {
  const pending = [...releases.keys()].filter(n => differs.has(n));
  const needlessMinor = [...releases].filter(([n, bump]) => (bump === 'minor' || bump === 'major') && !differs.has(n)).map(([n]) => n);
  return { status: pending.length ? 'pending' : 'redundant', pending, needlessMinor };
}

// ── publish errors ───────────────────────────────────────────────────────────

// npm refuses these only when the version was already written — by this run, a moment ago — so
// they are proof of a landing that the CDN has not caught up with, not a failure.
const PUBLISH_CONFLICT = /EPUBLISHCONFLICT|previously (been )?staged|cannot publish over|\bE409\b|409 Conflict/i;

export function isPublishConflict(output) {
  return PUBLISH_CONFLICT.test(output);
}

// ── concurrency ──────────────────────────────────────────────────────────────

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

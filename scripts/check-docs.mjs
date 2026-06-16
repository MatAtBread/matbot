#!/usr/bin/env node
// Flags docs that still reference APIs the code has since removed.
//
// Why this exists: docs drift because nothing ties an example to the code. The ground truth is
// git. A symbol is "dead" if its declaration was removed between a doc's baseline and HEAD AND it
// no longer appears anywhere in HEAD source. That second clause is what makes it precise — it
// auto-ignores moves/renames-in-place (still present) and catches genuine removals and the old
// half of a rename, at both export and type-member granularity. No hand-maintained list.
//
// Baseline per doc (most specific wins):
//   1. a `<!-- docs-verified: <sha> -->` comment in the doc
//   2. --since <ref> on the command line
//   3. the last commit that modified the doc (default — self-advancing, zero upkeep)
//
// It also runs a second, non-failing pass: exported symbols ADDED since the baseline that no doc
// mentions — likely-significant new surface (weighted: plugin-api public contract first), plus
// brand-new packages. Removals are bugs (the docs lie); additions are judgement calls (not
// everything needs a home), so they only advise.
//
// Usage:
//   node scripts/check-docs.mjs            # audit; exit 1 on stale refs, advise on gaps
//   node scripts/check-docs.mjs --since <ref>
//   node scripts/check-docs.mjs --all      # list every undocumented addition, not just core
//   node scripts/check-docs.mjs --bump     # stamp each doc as verified at HEAD

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const DOCS = [
  'README.md',
  'CLAUDE.md',
  'docs/ARCHITECTURE.md',
  'docs/DEVELOPING.md',
  'docs/GETTING-STARTED.md',
  'docs/PER-USER-PLUGINS.md',
  'docs/WEB-BUNDLE.md',
  'apps/web-bundle/README.md',
];

const argv = process.argv.slice(2);
const bump = argv.includes('--bump');
const sinceOverride = argv.includes('--since') ? argv[argv.indexOf('--since') + 1] : null;

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const HEAD = git('rev-parse', 'HEAD').trim();

// Every identifier present in HEAD source — membership means "not dead".
const tsFiles = git('ls-files', '*.ts').split('\n')
  .filter(f => f && !f.includes('node_modules') && !f.includes('.test.'));
const headIdents = new Set();
for (const f of tsFiles) {
  if (!existsSync(f)) continue;
  for (const m of readFileSync(f, 'utf8').matchAll(IDENT)) headIdents.add(m[0]);
}

// The declared name(s) on a single removed (`-`) source line — not every token, so comments and
// prose on removed lines don't become candidates.
function declaredNames(line) {
  const names = [];
  const exp = line.match(/export\s+(?:default\s+)?(?:abstract\s+)?(?:type|interface|class|function|const|enum|namespace)\s+([A-Za-z_$][\w$]*)/);
  if (exp) names.push(exp[1]);
  // type/interface member: `  name?: T`, `  readonly name: T`, `  name(...): T`
  const mem = line.match(/^[-]?\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:(<]/);
  if (mem && !/^(?:if|for|while|switch|catch|return|case)$/.test(mem[1])) names.push(mem[1]);
  return names;
}

function deadSymbolsSince(baseline) {
  let diff;
  try { diff = git('diff', '--unified=0', `${baseline}..${HEAD}`, '--', '*.ts'); }
  catch { return new Set(); }

  const removed = new Set();
  let file = null;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) { file = raw.slice(6); continue; }
    if (file && file.includes('.test.')) continue;
    if (raw.startsWith('-') && !raw.startsWith('---')) {
      for (const name of declaredNames(raw.slice(1))) removed.add(name);
    }
  }

  const dead = new Set();
  for (const name of removed) {
    if (name.length >= 3 && !headIdents.has(name)) dead.add(name);   // gone from HEAD entirely
  }
  return dead;
}

// A distinctive name (PascalCase or camelCase) is never an English word, so match it anywhere.
// A generic lowercase member (`receive`, `accept`) collides with prose, so only trust it inside
// code formatting (fenced blocks or `inline` spans) where API references actually appear.
const isDistinctive = (name) => /^[A-Z]/.test(name) || /[a-z][A-Z]/.test(name);

function baselineFor(doc, text) {
  const wm = text.match(/<!--\s*docs-verified:\s*([0-9a-fA-F]{7,40})\s*-->/);
  if (wm) return wm[1];
  if (sinceOverride) return sinceOverride;
  return git('log', '-1', '--format=%H', '--', doc).trim() || HEAD;
}

// Exported declarations added since baseline that survive in HEAD (added-and-kept, not added-then-
// reverted). Keyed by name; first declaring file wins for tiering.
function addedExportsSince(baseline) {
  let diff;
  try { diff = git('diff', '--unified=0', `${baseline}..${HEAD}`, '--', '*.ts'); }
  catch { return []; }
  const seen = new Map();
  let file = null;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) { file = raw.slice(6); continue; }
    if (file && (file.includes('.test.') || file.includes('node_modules'))) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      const e = raw.slice(1).match(/export\s+(?:default\s+)?(?:abstract\s+)?(?:type|interface|class|function|const|enum|namespace)\s+([A-Za-z_$][\w$]*)/);
      if (e && !seen.has(e[1])) seen.set(e[1], file);
    }
  }
  return [...seen].map(([name, file]) => ({ name, file })).filter(({ name }) => headIdents.has(name));
}

function newPackagesSince(baseline) {
  let out;
  try { out = git('diff', '--diff-filter=A', '--name-only', `${baseline}..${HEAD}`, '--', '**/package.json', 'package.json'); }
  catch { return []; }
  return out.split('\n').filter(p => p && !p.includes('node_modules')).map(p => p.replace(/\/?package\.json$/, '') || '.');
}

const tierOf = (file) =>
  file.startsWith('packages/core/plugin-api/') ? 0 : file.startsWith('packages/core/') ? 1 : 2;
const TIER_LABEL = ['public API (plugin-api)', 'core', 'plugins / apps'];

let findings = 0;
for (const doc of DOCS) {
  if (!existsSync(doc)) continue;
  let text = readFileSync(doc, 'utf8');

  if (bump) {
    text = /<!--\s*docs-verified:/.test(text)
      ? text.replace(/<!--\s*docs-verified:\s*[0-9a-fA-F]{7,40}\s*-->/, `<!-- docs-verified: ${HEAD.slice(0, 12)} -->`)
      : `<!-- docs-verified: ${HEAD.slice(0, 12)} -->\n${text}`;
    writeFileSync(doc, text);
    continue;
  }

  const baseline = baselineFor(doc, text);
  const dead = deadSymbolsSince(baseline);

  // Per line, the text to search: the whole line (for distinctive names) and just the code-formatted
  // part — fenced-block body or `inline` spans — (for generic names).
  const hits = [];
  let inFence = false;
  text.split('\n').forEach((l, i) => {
    if (/^\s*```/.test(l)) { inFence = !inFence; return; }
    const codeText = inFence ? l : [...l.matchAll(/`([^`]+)`/g)].map(m => m[1]).join(' ');
    for (const name of dead) {
      const re = new RegExp(`\\b${name.replace(/[$]/g, '\\$&')}\\b`);
      if (re.test(isDistinctive(name) ? l : codeText)) hits.push({ name, line: i + 1 });
    }
  });
  hits.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));

  if (hits.length) {
    findings += hits.length;
    console.log(`\n${doc}  (baseline ${baseline.slice(0, 12)} → ${HEAD.slice(0, 12)})`);
    for (const { name, line } of hits) console.log(`  ${doc}:${line}  ${name}`);
  }
}

if (bump) { console.log(`Stamped ${DOCS.join(', ')} as verified at ${HEAD.slice(0, 12)}`); process.exit(0); }

// ── Advisory: undocumented additions (nurture the vertebrates) ──────────────────
const existingDocs = DOCS.filter(existsSync);
const corpus = existingDocs.map(d => readFileSync(d, 'utf8')).join('\n');
const mentioned = (name) => new RegExp(`\\b${name.replace(/[$]/g, '\\$&')}\\b`).test(corpus);
const addBaseline = sinceOverride
  || existingDocs.map(d => baselineFor(d, readFileSync(d, 'utf8')))
       .reduce((a, b) => Number(git('log', '-1', '--format=%ct', a).trim()) <= Number(git('log', '-1', '--format=%ct', b).trim()) ? a : b);

const gaps = addedExportsSince(addBaseline).filter(a => !mentioned(a.name));
const pkgs = newPackagesSince(addBaseline);
if (gaps.length || pkgs.length) {
  console.log(`\nUndocumented new/changed exports since ${addBaseline.slice(0, 12)} (advisory — not everything needs a home):`);
  for (const t of [0, 1, 2]) {
    const group = gaps.filter(g => tierOf(g.file) === t);
    if (!group.length) continue;
    if (t === 2 && !argv.includes('--all')) {
      console.log(`  ${TIER_LABEL[t]}: ${group.length} new export(s) — use --all to list`);
      continue;
    }
    console.log(`  ${TIER_LABEL[t]}:`);
    const byFile = new Map();
    for (const { name, file } of group) (byFile.get(file) ?? byFile.set(file, []).get(file)).push(name);
    for (const [file, names] of byFile) console.log(`    ${file}: ${names.sort().join(', ')}`);
  }
  if (pkgs.length) { console.log('  new packages:'); for (const p of pkgs) console.log(`    ${p}`); }
}

if (findings) {
  console.log(`\n${findings} stale reference(s) to removed APIs. Fix the docs, then re-run (or \`--bump\` once clean).`);
  process.exit(1);
}
console.log('\nDocs reference no removed APIs.');

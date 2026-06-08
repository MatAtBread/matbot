// Assemble a single self-contained matbot.html.
//
// This is *not* a bundler: it transforms no code. It walks the static import graph from the
// bootstrap and the configured plugins, slurps each .ts file verbatim, and inlines them (plus the
// TypeScript compiler and the in-page loader) into one HTML file. All actual TS→JS stripping and
// module wiring happens in the browser at load time (see src/loader.js). The output runs from a
// file:// URL or any static host with no server, no build cache, and no network.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const localRequire = createRequire(import.meta.url);

// Build-time type stripper: sucrase (pure JS — no native binary, no postinstall, invisible to anyone
// installing matbot). Used per-module so each stays a separate module the import map wires up.
const stripTypes = (src, filePath) =>
  localRequire('sucrase').transform(src, { transforms: ['typescript'], filePath, preserveDynamicImport: true }).code;

const here     = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const idOf   = (abs) => '/' + path.relative(repoRoot, abs).split(path.sep).join('/');
const absOf  = (id)  => path.join(repoRoot, id);

// exports["."] may be a string or a condition/subpath map — prefer import > default > first.
function resolveExportsEntry(value) {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  if ('.' in value) return resolveExportsEntry(value['.']);
  for (const key of ['import', 'default', ...Object.keys(value)]) {
    if (key in value) return resolveExportsEntry(value[key]);
  }
  return undefined;
}

// Scan workspace package roots (mirrors pnpm-workspace.yaml globs) → { name: entryModuleId }.
async function buildNameMap() {
  const roots = [];
  const dirsAt = async (rel) => {
    try { return (await readdir(path.join(repoRoot, rel), { withFileTypes: true }))
      .filter(d => d.isDirectory()).map(d => path.join(rel, d.name)); }
    catch { return []; }
  };
  const lvl1 = await dirsAt('packages');
  const lvl2 = (await Promise.all(lvl1.map(d => dirsAt(d)))).flat();
  const lvl3 = (await Promise.all(lvl2.map(d => dirsAt(d)))).flat();
  const apps = await dirsAt('apps');
  roots.push(...lvl1, ...lvl2, ...lvl3, ...apps);

  const map = {};
  for (const rel of roots) {
    try {
      const pkg = JSON.parse(await readFile(path.join(repoRoot, rel, 'package.json'), 'utf8'));
      const entry = resolveExportsEntry(pkg.exports);
      if (pkg.name && typeof entry === 'string') {
        map[pkg.name] = idOf(path.join(repoRoot, rel, entry));
      }
    } catch { /* no/invalid package.json */ }
  }
  return map;
}

// A config plugin/provider path ("packages/plugins/http") → its entry module id.
async function entryForPath(rel) {
  const dir = path.join(repoRoot, rel);
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const entry = resolveExportsEntry(pkg.exports);
  if (typeof entry !== 'string') throw new Error(`No exports["."] for ${rel}`);
  const runtimes = Array.isArray(pkg.matbotRuntime)
    ? pkg.matbotRuntime.filter(r => r === 'node' || r === 'browser')
    : undefined;
  return { id: idOf(path.join(dir, entry)), name: pkg.name ?? rel, runtimes };
}

const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g;
const isRelative = (s) => s.startsWith('./') || s.startsWith('../');

function resolveRel(importerId, spec, sources) {
  const dir   = importerId.slice(0, importerId.lastIndexOf('/'));
  const parts = (dir + '/' + spec).split('/');
  const out   = [];
  for (const p of parts) { if (p === '' || p === '.') continue; if (p === '..') out.pop(); else out.push(p); }
  let id = '/' + out.join('/');
  if (sources[id] === undefined && id.endsWith('.js')) {
    const tsId = id.slice(0, -3) + '.ts';
    return tsId;
  }
  return id;
}

async function collect(rootIds, nameMap) {
  const sources = {};
  const usedNames = {};
  const queue = [...rootIds];
  const seen = new Set();

  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);

    let src;
    try { src = await readFile(absOf(id), 'utf8'); }
    catch { console.warn(`[assemble] missing source: ${id}`); continue; }
    sources[id] = src;

    for (const m of src.matchAll(SPEC_RE)) {
      const spec = m[2];
      if (isRelative(spec)) {
        queue.push(resolveRel(id, spec, sources));
      } else if (nameMap[spec] !== undefined) {
        usedNames[spec] = nameMap[spec];
        queue.push(nameMap[spec]);
      } else if (!spec.startsWith('node:') && !spec.includes(' ') && /^[@a-z]/.test(spec)) {
        // A bare specifier that isn't a workspace package — shouldn't happen in the browser graph.
        console.warn(`[assemble] unknown bare import "${spec}" (from ${id}) — not inlined.`);
      }
    }
  }
  return { sources, usedNames };
}

// Escape `</script` so an inlined <script> body cannot be terminated early. For the JSON payload this
// is loss-free (\/ is a valid JSON escape that parses back to /); for JS bodies it is the standard hack.
const guard = (s) => s.replace(/<\/(script)/gi, '<\\/$1');

async function main() {
  const config = JSON.parse(await readFile(path.join(here, 'matbot.web.json'), 'utf8'));
  const nameMap = await buildNameMap();

  const bootstrapId = idOf(path.join(here, 'src/bootstrap.ts'));

  // Resolve config plugin + provider paths to entry ids; build synthetic specifiers and name map.
  const SYN = (id) => 'mbmod:' + id;
  const specNames = {};
  // spec → declared matbotRuntime; the browser resolver reads this so the loader can skip a
  // node-only plugin before importing it (the build-time analogue of walking package.json on node).
  const specRuntimes = {};
  const rootIds = [bootstrapId];

  const pluginSpecs = [];
  for (const rel of config.plugins) {
    const { id, name, runtimes } = await entryForPath(rel);
    if (runtimes !== undefined && !runtimes.includes('browser')) {
      console.warn(`[matbot] assemble: plugin "${rel}" declares matbotRuntime [${runtimes.join(', ')}] — it cannot run in the browser; baking it anyway, but it will be skipped at boot.`);
    }
    rootIds.push(id);
    const spec = SYN(id);
    pluginSpecs.push(spec);
    specNames[spec] = name;
    if (runtimes !== undefined) specRuntimes[spec] = runtimes;
  }

  const providers = {};
  for (const [pname, cfg] of Object.entries(config.providers ?? {})) {
    const { id, name, runtimes } = await entryForPath(cfg.module);
    rootIds.push(id);
    const spec = SYN(id);
    specNames[spec] = name;
    if (runtimes !== undefined) specRuntimes[spec] = runtimes;
    providers[pname] = { ...cfg, module: spec };
  }

  // Adapter types the startup wizard offers. Inlined as graph roots so a wizard-configured provider's
  // module is present even though no baked provider references it.
  const availableProviders = [];
  for (const pm of config.providerModules ?? []) {
    const { id, name, runtimes } = await entryForPath(pm.module);
    rootIds.push(id);
    const spec = SYN(id);
    specNames[spec] = name;
    if (runtimes !== undefined) specRuntimes[spec] = runtimes;
    availableProviders.push({
      label: pm.label ?? name,
      module: spec,
      ...(pm.endpointHint !== undefined ? { endpointHint: pm.endpointHint } : {}),
      ...(pm.modelHint    !== undefined ? { modelHint:    pm.modelHint    } : {}),
    });
  }

  const { sources: rawSources, usedNames } = await collect(rootIds, nameMap);

  // Strip types at BUILD time so the browser loads ready-to-run JS and boots instantly (no in-page
  // stripping of 55 modules). Runtime remote-plugin loading lazy-loads sucrase from a CDN instead.
  const sources = {};
  for (const [id, src] of Object.entries(rawSources)) sources[id] = stripTypes(src, id);

  // packageEntries: every workspace package whose entry was pulled into the graph (so the import map
  // can map its bare name → blob), plus the ones referenced by config even if only dynamically.
  const packageEntries = { ...usedNames };
  for (const spec of [...pluginSpecs, ...Object.values(providers).map(p => p.module)]) {
    const id = spec.slice('mbmod:'.length);
    const name = specNames[spec];
    if (name) packageEntries[name] = id;
  }

  const payload = {
    sources,
    packageEntries,
    entry: bootstrapId,
    specNames,
    specRuntimes,
    config: {
      plugins:   pluginSpecs,
      providers,
      availableProviders,
      ...(config.defaultProvider ? { defaultProvider: config.defaultProvider } : {}),
    },
  };

  const loader   = await readFile(path.join(here, 'src/loader.js'), 'utf8');
  const template = await readFile(path.join(here, 'index.template.html'), 'utf8');

  const moduleCount = Object.keys(sources).length;
  const html = template
    .replace('%%PAYLOAD%%',  () => guard(JSON.stringify(payload)))
    .replace('%%LOADER%%',   () => guard(loader))
    .replace(/%%MODULE_COUNT%%/g, String(moduleCount));

  const outDir = path.join(here, 'dist');
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, 'matbot.html');
  await writeFile(outFile, html, 'utf8');

  const bytes = Buffer.byteLength(html, 'utf8');
  console.log(`[assemble] ${moduleCount} modules, ${Object.keys(packageEntries).length} packages → ${outFile} (${(bytes / 1e6).toFixed(1)} MB)`);
}

main().catch(e => { console.error(e); process.exit(1); });

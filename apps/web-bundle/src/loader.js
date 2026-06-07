// In-page module loader — the browser mirror of apps/cli/ts-hooks.js.
//
// A classic (non-module) script so no module graph — and therefore no import-map lock-in — exists
// until we explicitly trigger the first dynamic import() below. It reads the inlined payload
// (globalThis.__MB__), type-strips every .ts module with the inlined TypeScript compiler
// (globalThis.ts), rewrites each module's *relative* imports to synthetic `mbmod:<id>` specifiers,
// blob-ifies the result, and publishes one import map mapping every package name and every
// synthetic id to its blob URL. Bare `@matatbread/*` imports are left untouched so host and plugins
// resolve to the *same* module instance (the singleton boundary that `instanceof` depends on).
//
// Because everything is in-memory (blobs + an injected import map, no fetch, no service worker), the
// baseline runs identically from a file:// URL or any static host.

(async () => {
  const MB = globalThis.__MB__;
  if (!MB) throw new Error('matbot: missing inlined payload (__MB__).');
  const ts = globalThis.ts;
  if (!ts) throw new Error('matbot: missing inlined TypeScript compiler.');

  const SOURCES = MB.sources;          // { "/packages/.../index.ts": "<raw ts source>" }
  const PKG     = MB.packageEntries;   // { "@matatbread/matbot-core": "/packages/.../index.ts" }
  const ENTRY   = MB.entry;            // bootstrap module id
  const SYN = (id) => 'mbmod:' + id;

  const strip = (src, fileName) => ts.transpileModule(src, {
    fileName,
    reportDiagnostics: false,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
      removeComments: true,        // also avoids a `from '…'` in a comment tripping the specifier rewrite
    },
  }).outputText;

  // Normalise a relative specifier against its importer's module id, with .js -> .ts remap (the same
  // remap ts-hooks.js does in node, for source that ships no compiled output).
  const resolveRel = (importerId, spec) => {
    const dir   = importerId.slice(0, importerId.lastIndexOf('/'));
    const parts = (dir + '/' + spec).split('/');
    const out   = [];
    for (const p of parts) {
      if (p === '' || p === '.') continue;
      if (p === '..') out.pop();
      else out.push(p);
    }
    let id = '/' + out.join('/');
    if (SOURCES[id] === undefined && id.endsWith('.js') && SOURCES[id.slice(0, -3) + '.ts'] !== undefined) {
      id = id.slice(0, -3) + '.ts';
    }
    return id;
  };

  // Matches the specifier string in: `… from '…'`, side-effect `import '…'`, and dynamic `import('…')`.
  const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\2/g;

  // Rewrite relative specifiers via mapFn (returning a replacement specifier, or null to leave as-is).
  // Async to allow the remote loader to fetch dependencies while resolving.
  const rewrite = async (code, mapFn) => {
    const hits = [...code.matchAll(SPEC_RE)];
    let out = '', last = 0;
    for (const m of hits) {
      const [full, lead, quote, spec] = m;
      const start = m.index;
      const replacement = await mapFn(spec);
      out += code.slice(last, start);
      out += replacement === null ? full : `${lead}${quote}${replacement}${quote}`;
      last = start + full.length;
    }
    return out + code.slice(last);
  };

  const isRelative = (spec) => spec.startsWith('./') || spec.startsWith('../');

  // ── Build the inlined (baseline) graph ──────────────────────────────────────────────────────
  const blobUrl = {};
  for (const id of Object.keys(SOURCES)) {
    const stripped  = strip(SOURCES[id], id);
    const rewritten = await rewrite(stripped, (spec) => {
      if (!isRelative(spec)) return null;                 // bare → import map (singleton boundary)
      const target = resolveRel(id, spec);
      if (SOURCES[target] === undefined) {                // not one of ours (e.g. a string literal) — leave
        console.warn(`[matbot] unresolved relative import "${spec}" from ${id}`);
        return null;
      }
      return SYN(target);
    });
    blobUrl[id] = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
  }

  const imports = {};
  for (const [name, id] of Object.entries(PKG)) imports[name] = blobUrl[id];
  for (const id of Object.keys(SOURCES))         imports[SYN(id)] = blobUrl[id];

  const map = document.createElement('script');
  map.type = 'importmap';
  map.textContent = JSON.stringify({ imports });
  document.head.appendChild(map);

  // ── Runtime remote plugin loading (best-effort; needs http, not file://) ──────────────────────
  // Fetch a remote .ts module graph, type-strip it, and rewrite its *relative* imports straight to
  // the blob URLs of their (recursively loaded) dependencies — so no second import map is needed.
  // Bare imports still flow through the baseline import map, preserving the singleton boundary.
  const remoteCache = new Map();
  const loadRemoteModule = async (absUrl, stack) => {
    if (remoteCache.has(absUrl)) return remoteCache.get(absUrl);
    if (stack.includes(absUrl)) throw new Error(`matbot: import cycle in remote plugin at ${absUrl}`);

    let res = await fetch(absUrl);
    let url = absUrl;
    if (!res.ok && absUrl.endsWith('.js')) { url = absUrl.slice(0, -3) + '.ts'; res = await fetch(url); }
    if (!res.ok) throw new Error(`matbot: failed to fetch "${absUrl}" (${res.status})`);

    const raw      = await res.text();
    const stripped = url.endsWith('.ts') ? strip(raw, url) : raw;
    const rewritten = await rewrite(stripped, async (spec) => {
      if (spec.startsWith('node:')) {
        throw new Error(`remote plugin "${absUrl}" imports the Node-only module "${spec}" and cannot run in the browser`);
      }
      if (!isRelative(spec)) return null;   // bare → baseline import map (host singletons)
      const childAbs = new URL(spec, url).href;
      return await loadRemoteModule(childAbs, [...stack, url]);
    });
    const blob = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
    remoteCache.set(absUrl, blob);
    return blob;
  };

  // exports["."] may be a string or a condition/subpath map — prefer import > default > first.
  const resolveExportsEntry = (value) => {
    if (typeof value === 'string') return value;
    if (typeof value !== 'object' || value === null) return undefined;
    if ('.' in value) return resolveExportsEntry(value['.']);
    for (const k of ['import', 'default', ...Object.keys(value)]) if (k in value) return resolveExportsEntry(value[k]);
    return undefined;
  };

  const loader = {
    async loadRemote(specifier) {
      let absUrl = new URL(specifier, globalThis.location?.href ?? 'http://localhost/').href;
      let name;

      // Accept a package directory or a package.json URL: resolve exports["."] to the real entry,
      // mirroring how the node loader resolves a plugin path to its module.
      if (absUrl.endsWith('/')) absUrl += 'package.json';
      if (absUrl.endsWith('/package.json')) {
        const res = await fetch(absUrl);
        if (!res.ok) throw new Error(`matbot: failed to fetch "${absUrl}" (${res.status})`);
        const pkg   = JSON.parse(await res.text());
        const entry = resolveExportsEntry(pkg.exports) ?? pkg.module ?? pkg.main;
        if (!entry) throw new Error(`matbot: "${absUrl}" has no exports["."], module, or main entry`);
        name   = pkg.name;
        absUrl = new URL(entry, absUrl).href;
      }

      const spec = await loadRemoteModule(absUrl, []);
      if (name === undefined) {
        const base = (specifier.split('?')[0] || specifier).replace(/\/+$/, '').split('/').pop() || specifier;
        name = base.replace(/\.[^.]+$/, '') || base;
      }
      return { spec, name };
    },
  };

  // ── Boot ──────────────────────────────────────────────────────────────────────────────────────
  try {
    const mod = await import(SYN(ENTRY));
    await mod.boot({ config: MB.config, specNames: MB.specNames, loader });
  } catch (err) {
    console.error('[matbot] boot failed:', err);
    const pre = document.createElement('pre');
    pre.style.cssText = 'color:#b91c1c;padding:16px;white-space:pre-wrap;font:13px monospace';
    pre.textContent = 'matbot failed to start:\n' + (err && err.stack ? err.stack : String(err));
    document.body.appendChild(pre);
  }
})();

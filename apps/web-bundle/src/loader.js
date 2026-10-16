// In-page module loader — the browser mirror of apps/cli/ts-hooks.js.
//
// A classic (non-module) script so no module graph — and therefore no import-map lock-in — exists
// until we explicitly trigger the first dynamic import() below. It reads the inlined payload
// (globalThis.__MB__), whose modules are already type-stripped at build time, rewrites each module's
// *relative* imports to synthetic `mbmod:<id>` specifiers, blob-ifies the result, and publishes one
// import map mapping every package name and every synthetic id to its blob URL. Bare `@matatbread/*`
// imports are left untouched so host and plugins resolve to the *same* module instance (the singleton
// boundary that `instanceof` depends on).
//
// Everything is in-memory (blobs + an injected import map, no fetch, no service worker) and needs no
// stripping at load, so boot is instant and identical from a file:// URL or any static host. The
// inlined sucrase stripper is used only for *runtime* remote-plugin loading (loadRemote), the one
// path that fetches raw .ts in the browser.

// ── Insecure-context Web Crypto shims ─────────────────────────────────────────
// A non-secure browsing context (plain HTTP on a non-localhost origin) withholds part of Web Crypto:
// `crypto.randomUUID` and `crypto.subtle` are absent — only `crypto.getRandomValues` survives. matbot
// supports plain-HTTP local hosting, and in this single-file bundle the WHOLE runtime (core, every
// plugin, the bootstrap) executes in this one page, so the gap would otherwise crash plugin load
// (`crypto.randomUUID is not a function`, called in 20+ packages) and skill reindexing
// (`crypto.subtle.digest` of undefined). This is the consolidation point for those shims — it runs
// before the loader imports any module below, so every consumer sees a working API. Secure contexts
// (HTTPS / localhost) already provide both natively, so each shim installs only when its target is
// missing. The bundle's default vault is plaintext (LocalStorageVault), so nothing here needs the
// AES-GCM side of `crypto.subtle`; only SHA-256 `digest` (skills content hashing) is provided.
(() => {
  const c = globalThis.crypto;
  if (!c) return;  // no Crypto object at all is beyond a polyfill's reach

  if (typeof c.randomUUID !== 'function') {
    c.randomUUID = () => {
      const b = c.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    };
  }

  if (!c.subtle || typeof c.subtle.digest !== 'function') {
    // Standard SHA-256, 32-bit arithmetic; verified byte-for-byte against SubtleCrypto. Returns an
    // ArrayBuffer like the real `digest`. Only SHA-256 is implemented (the one digest the runtime
    // uses); any other algorithm throws rather than return a wrong hash.
    const sha256 = (bytes) => {
      const rotr = (n, x) => (x >>> n) | (x << (32 - n));
      const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
      const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
      const bitLen = bytes.length * 8;
      const totalLen = ((bytes.length + 1 + 8 + 63) >> 6) << 6;
      const padded = new Uint8Array(totalLen);
      padded.set(bytes); padded[bytes.length] = 0x80;
      const dv = new DataView(padded.buffer);
      dv.setUint32(totalLen - 4, bitLen >>> 0, false);
      dv.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);
      const w = new Uint32Array(64);
      for (let off = 0; off < totalLen; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
        for (let i = 16; i < 64; i++) {
          const s0 = rotr(7, w[i-15]) ^ rotr(18, w[i-15]) ^ (w[i-15] >>> 3);
          const s1 = rotr(17, w[i-2]) ^ rotr(19, w[i-2]) ^ (w[i-2] >>> 10);
          w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
        }
        let a=H[0],b=H[1],cc=H[2],d=H[3],e=H[4],f=H[5],g=H[6],hh=H[7];
        for (let i = 0; i < 64; i++) {
          const S1 = rotr(6,e) ^ rotr(11,e) ^ rotr(25,e), ch = (e & f) ^ (~e & g), t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
          const S0 = rotr(2,a) ^ rotr(13,a) ^ rotr(22,a), maj = (a & b) ^ (a & cc) ^ (b & cc), t2 = (S0 + maj) >>> 0;
          hh=g; g=f; f=e; e=(d+t1)>>>0; d=cc; cc=b; b=a; a=(t1+t2)>>>0;
        }
        H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+cc)>>>0;H[3]=(H[3]+d)>>>0;H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+hh)>>>0;
      }
      const out = new Uint8Array(32), odv = new DataView(out.buffer);
      for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i] >>> 0, false);
      return out;
    };
    const digest = async (algorithm, data) => {
      const name = (typeof algorithm === 'string' ? algorithm : algorithm && algorithm.name) || '';
      if (String(name).toUpperCase() !== 'SHA-256') throw new Error('insecure-context crypto shim: only SHA-256 digest is supported, got ' + name);
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
      return sha256(bytes).buffer;
    };
    // `subtle` is a getter-only accessor on Crypto.prototype here, so define an own data property to
    // shadow it rather than assigning (which would silently fail / throw).
    try { Object.defineProperty(c, 'subtle', { value: { digest }, configurable: true, writable: true }); }
    catch { /* engine forbids shadowing — nothing more we can do */ }
  }
})();

(async () => {
  const MB = globalThis.__MB__;
  if (!MB) throw new Error('matbot: missing inlined payload (__MB__).');

  const SOURCES = MB.sources;          // { "/core/.../index.ts": "<pre-stripped JS>" }
  const PKG     = MB.packageEntries;   // { "@matatbread/matbot-core": "/core/.../index.ts" }
  const ENTRY   = MB.entry;            // bootstrap module id
  const SYN = (id) => 'mbmod:' + id;

  // The host is stripped at build time, so boot needs no stripper. The ONLY thing that needs stripping
  // in-browser is a runtime-fetched remote .ts plugin (loadRemote) — and that path is http-only (you
  // can't fetch a remote plugin from file://), so we lazy-load sucrase from a CDN on first use rather
  // than inlining ~700 KB into every page. Cached after the first remote load.
  let _transform;
  const getTransform = async () => {
    if (_transform) return _transform;
    const mod = await import(/* @vite-ignore */ 'https://esm.sh/sucrase@3.35.1');
    _transform = mod.transform;
    return _transform;
  };
  // Sucrase's own parser, for finding a remote module's imports (see findRemoteImports). Same version as
  // the stripper, same lazy load.
  let _parser;
  const getParser = async () => {
    if (_parser) return _parser;
    const [{ parse }, { TokenType }] = await Promise.all([
      import(/* @vite-ignore */ 'https://esm.sh/sucrase@3.35.1/dist/esm/parser/index.js'),
      import(/* @vite-ignore */ 'https://esm.sh/sucrase@3.35.1/dist/esm/parser/tokenizer/types.js'),
    ]);
    _parser = { parse, tt: TokenType };
    return _parser;
  };

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
  // Used only for the inlined graph, which is our own build output and must boot without the CDN parser;
  // a remote module is parsed instead (findRemoteImports).
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
    const rewritten = await rewrite(SOURCES[id], (spec) => {   // SOURCES[id] is already stripped JS
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
  // Fetch a remote .ts module graph, type-strip it, and run each module from a `blob:` URL — which can
  // resolve no relative reference at all — so every way the module names its own location is rewritten to
  // what it would resolve to at its real URL:
  //   - a static relative or root-relative import → the blob URL of that (recursively loaded) dependency,
  //     so no second import map is needed;
  //   - `import(…)` → IMPORT_HELPER, which resolves the specifier when it is called, as Node's resolve hook
  //     does: a computed specifier works, and a dependency is fetched only if it is actually imported;
  //   - `import.meta.url` → the real URL.
  // Bare imports still flow through the baseline import map (the singleton boundary), and an absolute URL is
  // left to the browser, which gives a CDN module its real URL as identity.
  //
  // "Real URL" is the one that ANSWERED (`res.url`), not the one requested: a CDN redirect (unpkg `lit@3` →
  // `lit@3.3.3/index.js`) moves where `./x.js` lives, and keying the cache on it makes a redirect and its
  // target one module instance.

  // A real parse, never a scan: telling `import(` in code from the same text in a string, template, comment
  // or regex literal needs the tokenizer, and a scan that guesses wrong loses its place and misses imports
  // further on. Returns the spans to replace, in source order.
  const findRemoteImports = (code, url, { parse, tt }) => {
    let tokens;
    try { ({ tokens } = parse(code, false, false, false)); }
    catch (err) { throw new Error(`matbot: cannot parse remote module "${url}": ${err?.message ?? err}`); }
    const isName = (t, s) => t?.type === tt.name && code.slice(t.start, t.end) === s;
    const isSpec = (t) => t?.type === tt.string;
    const spans  = [];
    const specAt = (t) => spans.push({ kind: 'static', start: t.start, end: t.end, spec: code.slice(t.start + 1, t.end - 1) });
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i], next = tokens[i + 1];
      if (t.type === tt._import) {
        if (next?.type === tt.parenL) spans.push({ kind: 'dynamic', start: t.start, end: next.end });
        else if (isSpec(next)) specAt(next);                                         // import './x.js'
        else {
          let j = i + 1;
          while (j < tokens.length && !(isName(tokens[j], 'from') && isSpec(tokens[j + 1]))) j++;
          if (j < tokens.length) specAt(tokens[j + 1]);
        }
      } else if (t.type === tt._export) {                                            // export * [as ns] from, export { … } from
        let j = i + 1;
        if (tokens[j]?.type === tt.star) { j++; if (tokens[j]?.type === tt._as) j += 2; }
        else if (tokens[j]?.type === tt.braceL) { while (j < tokens.length && tokens[j].type !== tt.braceR) j++; j++; }
        else continue;
        if (isName(tokens[j], 'from') && isSpec(tokens[j + 1])) specAt(tokens[j + 1]);
      } else if (isName(t, 'import') && next?.type === tt.dot                       // the parser renames `import` in import.meta
                 && tokens[i - 1]?.type !== tt.dot && tokens[i - 1]?.type !== tt.questionDot
                 && isName(tokens[i + 2], 'meta') && tokens[i + 3]?.type === tt.dot && isName(tokens[i + 4], 'url')) {
        spans.push({ kind: 'meta', start: t.start, end: tokens[i + 4].end });
      }
    }
    return spans.sort((a, b) => a.start - b.start);
  };

  // Where a specifier written in the module at `base` lives, or null to leave it to the import map / the browser.
  const remoteTarget = (spec, base) => {
    if (spec.startsWith('node:')) {
      throw new Error(`remote plugin "${base}" imports the Node-only module "${spec}" and cannot run in the browser`);
    }
    if (isRelative(spec) || (spec.startsWith('/') && !spec.startsWith('//'))) return new URL(spec, base).href;
    return null;
  };

  // Promises, not results: a dynamic import can now start a load while another is in flight, and two loads
  // of one module must not make two instances. A failure is dropped so a retry fetches again.
  const remoteByRequest = new Map();   // requested URL → Promise<blob URL>
  const remoteByUrl     = new Map();   // answering URL → Promise<blob URL>
  const cached = (map, key, make) => {
    let p = map.get(key);
    if (!p) { p = make(); map.set(key, p); p.catch(() => map.delete(key)); }
    return p;
  };
  const cycle = (url) => new Error(`matbot: import cycle in remote plugin at ${url}`);

  // rawSink (optional) collects each fetched .ts's RAW (pre-strip) source, so the caller can scan it for
  // `ToolContracts` augmentations (type-only — gone after stripping) and give a remote plugin's tools real
  // TS contracts, the same as the baked built-ins. Only newly-fetched modules are collected (a cache hit
  // means the module was already scanned on its first load), and a module loaded later by a dynamic
  // import is not collected at all.
  //
  // `stack` holds both the requested and the answering URL of every module above this one. The cycle check
  // must come before the cache: an ancestor's entry is still in flight, and awaiting it would never settle.
  const loadRemoteModule = (absUrl, stack, rawSink) => {
    if (stack.includes(absUrl)) return Promise.reject(cycle(absUrl));
    return cached(remoteByRequest, absUrl, async () => {
      let fetched = absUrl;
      let res = await fetch(fetched);
      if (!res.ok && absUrl.endsWith('.js')) { fetched = absUrl.slice(0, -3) + '.ts'; res = await fetch(fetched); }
      if (!res.ok) throw new Error(`matbot: failed to fetch "${absUrl}" (${res.status})`);
      const url = res.url || fetched;
      if (stack.includes(url)) throw cycle(url);
      return cached(remoteByUrl, url, async () => buildRemoteModule(url, await res.text(), [...stack, absUrl, url], rawSink));
    });
  };

  const buildRemoteModule = async (url, raw, stack, rawSink) => {
    const isTs = new URL(url).pathname.endsWith('.ts');
    if (isTs && rawSink) rawSink.push(raw);
    // Strip types ONLY (disableESTransforms + keepUnusedImports): keep `??`/`?.` native and imports verbatim.
    const code = isTs ? (await getTransform())(raw, { transforms: ['typescript'], disableESTransforms: true, keepUnusedImports: true, filePath: url, preserveDynamicImport: true }).code : raw;
    let out = '', last = 0;
    for (const span of findRemoteImports(code, url, await getParser())) {
      let replacement;
      switch (span.kind) {
        case 'static': {
          const target = remoteTarget(span.spec, url);
          if (target !== null) replacement = JSON.stringify(await loadRemoteModule(target, stack, rawSink));
          break;
        }
        case 'dynamic': replacement = `${IMPORT_HELPER}(${JSON.stringify(url)}, `; break;
        case 'meta':    replacement = JSON.stringify(url); break;
      }
      if (replacement === undefined) continue;
      out += code.slice(last, span.start) + replacement;
      last = span.end;
    }
    out += code.slice(last);
    return URL.createObjectURL(new Blob([out], { type: 'text/javascript' }));
  };

  // What a remote module's `import(spec[, options])` becomes. A global because a blob module has no other way
  // to reach the loader; it is no grant, a loaded plugin having the page already. The two-argument form is
  // built only when a module uses it: written here, it is a syntax error that would stop this whole script
  // in a browser without import attributes, where a plugin using it could not have run anyway.
  const IMPORT_HELPER = '__matbot_import__';
  let importWith;
  globalThis[IMPORT_HELPER] = async (base, specifier, ...options) => {
    const spec   = String(specifier);
    const target = remoteTarget(spec, base);
    const real   = target === null ? spec : await loadRemoteModule(target, [], undefined);
    if (options.length === 0) return import(/* @vite-ignore */ real);
    importWith ??= new Function('s', 'o', 'return import(s, o)');
    return importWith(real, options[0]);
  };

  // exports["."] may be a string or a condition/subpath map — prefer import > default > first.
  const resolveExportsEntry = (value) => {
    if (typeof value === 'string') return value;
    if (typeof value !== 'object' || value === null) return undefined;
    if ('.' in value) return resolveExportsEntry(value['.']);
    for (const k of ['import', 'default', ...Object.keys(value)]) if (k in value) return resolveExportsEntry(value[k]);
    return undefined;
  };

  const runtimesOf = (pkg) => Array.isArray(pkg.matbotRuntime)
    ? pkg.matbotRuntime.filter(r => typeof r === 'string')
    : undefined;

  // matbot's remote-plugin contract: a plugin IS a package, so a direct entry URL (…/index.ts) must
  // sit beside its package.json — we check the sibling only, never fish up ancestors or down subdirs
  // (a URL into a tree could otherwise pick up an unrelated/monorepo manifest). Absence, or a missing
  // "name", is a hard error: point at the package directory or its package.json instead. Returns the
  // name plus the declared matbotRuntime (so the host can gate / record it).
  const readSiblingManifest = async (entryUrl) => {
    const url = new URL('./package.json', entryUrl).href;
    let res;
    try { res = await fetch(url); } catch { res = undefined; }
    if (res?.ok) {
      const pkg = JSON.parse(await res.text());
      if (pkg.name) return { name: pkg.name, runtimes: runtimesOf(pkg) };
    }
    throw new Error(`matbot: remote plugin "${entryUrl}" has no sibling package.json with a "name" at ${url} (a plugin must be a named package — point at the package directory or its package.json instead)`);
  };

  const loader = {
    async loadRemote(specifier) {
      let absUrl = new URL(specifier, globalThis.location?.href ?? 'http://localhost/').href;
      let name, runtimes;

      // Accept a package directory or a package.json URL: resolve exports["."] to the real entry,
      // mirroring how the node loader resolves a plugin path to its module.
      if (absUrl.endsWith('/')) absUrl += 'package.json';
      if (absUrl.endsWith('/package.json')) {
        const res = await fetch(absUrl);
        if (!res.ok) throw new Error(`matbot: failed to fetch "${absUrl}" (${res.status})`);
        const pkg   = JSON.parse(await res.text());
        const entry = resolveExportsEntry(pkg.exports) ?? pkg.module ?? pkg.main;
        if (!entry) throw new Error(`matbot: "${absUrl}" has no exports["."], module, or main entry`);
        if (!pkg.name) throw new Error(`matbot: package.json at "${absUrl}" has no "name" (a remote plugin must be a named package)`);
        name     = pkg.name;
        runtimes = runtimesOf(pkg);
        absUrl   = new URL(entry, absUrl).href;
      } else {
        // A direct entry URL: the package.json contract still holds — read the sibling manifest for
        // the name and declared runtimes. Throws if none is reachable.
        ({ name, runtimes } = await readSiblingManifest(absUrl));
      }

      const sources = [];
      const spec = await loadRemoteModule(absUrl, [], sources);
      return { spec, name, sources, ...(runtimes !== undefined ? { runtimes } : {}) };
    },
  };

  // ── Boot ──────────────────────────────────────────────────────────────────────────────────────
  try {
    const mod = await import(SYN(ENTRY));
    await mod.boot({ config: MB.config, specNames: MB.specNames, specRuntimes: MB.specRuntimes, specVersions: MB.specVersions, harnessVersion: MB.harnessVersion, toolContracts: MB.toolContracts, loader });
  } catch (err) {
    console.error('[matbot] boot failed:', err);
    const pre = document.createElement('pre');
    pre.style.cssText = 'color:#b91c1c;padding:16px;white-space:pre-wrap;font:13px monospace';
    pre.textContent = 'matbot failed to start:\n' + (err && err.stack ? err.stack : String(err));
    document.body.appendChild(pre);
  }
})();

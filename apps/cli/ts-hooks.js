// Node-only module-customization hooks, registered by register.js through `module.registerHooks()`:
// synchronous, and in-thread. Four concerns:
//
//   1. Remap *.js imports to *.ts for TypeScript source that ships no compiled
//      output. Required because Node's native strip-types does not perform this
//      remapping across pnpm workspace symlinks.
//
//   2. Strip TypeScript types ourselves in a `load` hook. matbot ships raw .ts and
//      relies on type stripping — but Node's *native* stripper refuses files under
//      node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), which is exactly
//      where every dependency lives once published. Returning already-stripped source
//      from a load hook bypasses that path, so installed packages load the same as
//      workspace ones. The code is erasable-only (enforced by tsconfig
//      `erasableSyntaxOnly`), so `mode: 'strip'` suffices — no transform, columns
//      preserved, no source map needed.
//
//   3. Plugin hot-reload freshness. When a plugin is reloaded, the core loader
//      stamps the plugin entry URL with `?mbfresh=<gen>` (see FRESH_PARAM in
//      core/src/loader.ts). On its own that re-evaluates only the
//      entry; its static imports stay cached. Here we propagate that stamp from a
//      stamped parent onto its first-party children, so the whole plugin subtree
//      re-evaluates — "fresh all the way down".
//
//      The stamp deliberately stops at the host-shared singleton boundary: any
//      module the plugin API itself loaded (e.g. @matatbread/matbot-plugin-api,
//      which exports `MissingSecretError` used with `instanceof`) must NOT be
//      duplicated, or cross-boundary identity silently breaks. Those package
//      directories arrive as `createHooks({ exclude })` from register.js.
//
//   4. On-demand fetching for a plugin fetched over http (see remote-loader.js).
//      A module inside `.plugins/<host>/…` gets its relative and root-relative
//      imports resolved against where it CAME from and fetched if absent, so Node
//      drives that graph instead of a regex predicting it. An absolute-URL import
//      keeps its URL as its identity, served from the cache by the load hook. Bare
//      imports mean host-provided, so they take the normal chain — and when that
//      fails, one retry against this host's own module graph, which is what
//      "bare = the host's copy" means once the symlink farm is gone.

import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveFetchedSync, bareAnchor, isFetched, loadStored } from './remote-loader.js';

// stripTypeScriptTypes is still flagged experimental, so it emits an ExperimentalWarning the
// first time it runs — on every launch, scary and irrelevant. The hooks run in the process's own
// thread, so this filter is process-wide: it silences *only* that one warning, and every other
// passes through untouched.
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const message = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (/stripTypeScriptTypes/.test(message)) return;
  return _emitWarning(warning, ...args);
};

const FRESH = 'mbfresh';

function freshOf(url) {
  try { return new URL(url).searchParams.get(FRESH) ?? undefined; }
  catch { return undefined; }
}

export function createHooks({ exclude = [] } = {}) {
  // Normalise to decoded, trailing-separator'd path prefixes so `startsWith`
  // cannot match a sibling dir (…/plugin-api vs …/plugin-api-extra).
  const excludePrefixes = exclude.map(p => {
    const s = String(p);
    return s.endsWith('/') ? s : s + '/';
  });

  function isExcluded(fileUrl) {
    let pathname;
    try { pathname = decodeURIComponent(new URL(fileUrl).pathname); }
    catch { return false; }
    return excludePrefixes.some(prefix => pathname.startsWith(prefix));
  }

  // `registerHooks()` also runs for `require()`, which `register()`'s hooks never saw, and CommonJS has rules
  // of its own for all four concerns: `require('/abs/x.json')` is a file, not a path on the plugin's origin,
  // a query string is not part of a file name, and a `.ts` it loads is not an ES module by fiat. Found in
  // the plugin tool's dependency notes, whose absolute-path require from inside a fetched tree became a fetch.
  // So a require passes through, as it always has.
  const isRequire = context => context.conditions?.includes('require') ?? false;

  function resolve(specifier, context, nextResolve) {
    if (isRequire(context)) return nextResolve(specifier, context);

    // (4) A module fetched over http: resolve its non-bare imports against its origin, fetching on demand.
    // Checked before the .js->.ts remap below because that remap asks the FILESYSTEM which of the two
    // exists, and for a module we have not fetched yet the answer is neither.
    // Stamped like any other result: a refresh re-fetches a changed import to disk, and unstamped it would come
    // back as the copy Node already evaluated under the same URL.
    const fetched = resolveFetchedSync(specifier, context.parentURL);
    if (fetched !== undefined) return fresh({ url: fetched, format: 'module', shortCircuit: true }, context.parentURL);

    // A module imported by URL has no directory for Node to walk up from, so its bare imports are looked up
    // from the cache instead.
    const anchor = bareAnchor(context.parentURL);
    const from = anchor === undefined ? context : { ...context, parentURL: anchor };

    // (1) .js -> .ts remap.
    let result;
    if (specifier.endsWith('.js')) {
      try {
        result = nextResolve(specifier.slice(0, -3) + '.ts', from);
      } catch {
        try { result = nextResolve(specifier, from); }
        catch (e) { result = resolveAsHost(specifier, from, nextResolve, e, context.parentURL); }
      }
    } else {
      try { result = nextResolve(specifier, from); }
      catch (e) { result = resolveAsHost(specifier, from, nextResolve, e, context.parentURL); }
    }

    return fresh(result, context.parentURL);
  }

  // (2) Freshness propagation. Fast path: the marker only exists during a reload,
  // so 99% of resolutions (startup, normal runs) bail on this cheap string test
  // before any URL parsing.
  function fresh(result, parent) {
    if (parent === undefined || !parent.includes(FRESH)) return result;

    const parentFresh = freshOf(parent);
    if (parentFresh === undefined) return result;
    if (!result.url.startsWith('file:')) return result;   // node:, data:, http: — never bust
    if (freshOf(result.url) !== undefined) return result; // already stamped (cycles / re-entry)
    if (isExcluded(result.url)) return result;            // host-shared singleton boundary

    const url = new URL(result.url);
    url.searchParams.set(FRESH, parentFresh);
    return { ...result, url: url.href };
  }

  function load(url, context, nextLoad) {
    if (isRequire(context)) return nextLoad(url, context);
    // Strip .ts ourselves (concern 2). Match a file: URL ending in .ts, allowing a
    // trailing ?mbfresh query. Everything else (real .js, node:, data:) passes through.
    if (url.startsWith('file:') && /\.ts(\?.*)?$/.test(url)) {
      const source = readFileSync(fileURLToPath(url.split('?')[0]), 'utf8');
      const code = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url });
      return { format: 'module', source: code, shortCircuit: true };
    }
    // (4) A module imported by URL: its source is in the cache, under the URL it answered at.
    const stored = /^https?:/.test(url) ? loadStored(url) : undefined;
    if (stored !== undefined) {
      const ts = /\.m?ts$/.test(new URL(url).pathname);
      return { format: 'module', source: ts ? stripTypeScriptTypes(stored, { mode: 'strip', sourceUrl: url }) : stored, shortCircuit: true };
    }
    return nextLoad(url, context);
  }

  return { resolve, load };
}

// A bare import from inside a fetched plugin means "the host's copy". Node resolves it by walking up from
// the cache directory, which finds a sibling plugin's self-link and the host singletons linked in beside it
// (see linkHostSingletons in src/plugins/remote-cache.ts). This retry covers the rest: any other package the
// HOST has that the cache tree cannot see, resolved as this file would resolve it.
//
// Deliberately NOT the mechanism for the singletons, which it cannot be: the only anchor available here is
// this file, and `apps/cli` depends on `core`, not on `plugin-api` — so the retry could never reach the
// package it would most be needed for. A disk link can, and every resolver honours it.
//
// `importer` is passed rather than read from `context`, which for a module imported by URL is already the
// cache anchor it was looked up from — and `nextResolve` merges the context it is handed into the shared one,
// so reading `context.parentURL` after the retry reports OUR anchor (measured: this error used to name
// ts-hooks.js as the file that imported the plugin's own dependency).
function resolveAsHost(specifier, context, nextResolve, original, importer) {
  if (!isFetched(importer)) throw original;
  try { return nextResolve(specifier, { ...context, parentURL: import.meta.url }); }
  catch {
    // Both attempts failed, which is the whole answer: it is not installed anywhere this plugin can see
    // and the host does not have it either. Said here rather than guessed from the source ahead of time —
    // the resolution actually happened, so there is no false positive to explain away, and the importer is
    // known. (`node:`-prefixed builtins never reach this path.)
    throw Object.assign(new Error(
      `Cannot resolve "${specifier}" imported by ${importer}: a bare import from a plugin fetched over http ` +
      `resolves from its cache directory, where what its package.json declares is installed, and then from the ` +
      `host — and neither has this one. If the plugin declares it, \`plugin reload\` offers to install it; ` +
      `otherwise install "${specifier}" alongside matbot, add it to \`plugins:\` if it is itself a matbot ` +
      `plugin, or import it by URL.`), { code: 'ERR_MODULE_NOT_FOUND' });
  }
}

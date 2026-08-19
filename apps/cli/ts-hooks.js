// Node-only module-customization hook (registered via register.js / --import).
// Three concerns:
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
//      directories arrive via `initialize(data.exclude)` from register.js.
//
//   4. On-demand fetching for a plugin fetched over http (see remote-loader.js).
//      A module inside `.plugins/<host>/…` gets its relative, root-relative and
//      absolute-URL imports resolved against where it CAME from and fetched if
//      absent, so Node drives that graph instead of a regex predicting it. Its
//      *bare* imports mean host-provided, so they take the normal chain — and
//      when that fails, one retry against this host's own module graph, which is
//      what "bare = the host's copy" means once the symlink farm is gone.

import { stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveFetched, cacheLocation } from './remote-loader.js';

// stripTypeScriptTypes is still flagged experimental, so it emits an ExperimentalWarning the
// first time it runs. This hook runs on the module-customization thread (where the strip in
// `load` happens), so we silence *only* that one warning here — on every launch it would
// otherwise print scary, irrelevant noise. All other warnings pass through untouched.
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const message = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (/stripTypeScriptTypes/.test(message)) return;
  return _emitWarning(warning, ...args);
};

const FRESH = 'mbfresh';

let excludePrefixes = [];

export async function initialize(data) {
  // Normalise to decoded, trailing-separator'd path prefixes so `startsWith`
  // cannot match a sibling dir (…/plugin-api vs …/plugin-api-extra).
  excludePrefixes = (data?.exclude ?? []).map(p => {
    const s = String(p);
    return s.endsWith('/') ? s : s + '/';
  });
}

function freshOf(url) {
  try { return new URL(url).searchParams.get(FRESH) ?? undefined; }
  catch { return undefined; }
}

function isExcluded(fileUrl) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(fileUrl).pathname); }
  catch { return false; }
  return excludePrefixes.some(prefix => pathname.startsWith(prefix));
}

export async function resolve(specifier, context, nextResolve) {
  // (4) A module fetched over http: resolve its non-bare imports against its origin, fetching on demand.
  // Checked before the .js->.ts remap below because that remap asks the FILESYSTEM which of the two
  // exists, and for a module we have not fetched yet the answer is neither.
  const fetched = await resolveFetched(specifier, context.parentURL);
  if (fetched !== undefined) return { url: fetched, format: 'module', shortCircuit: true };

  // (1) .js -> .ts remap.
  let result;
  if (specifier.endsWith('.js')) {
    try {
      result = await nextResolve(specifier.slice(0, -3) + '.ts', context);
    } catch {
      try { result = await nextResolve(specifier, context); }
      catch (e) { result = await resolveAsHost(specifier, context, nextResolve, e); }
    }
  } else {
    try { result = await nextResolve(specifier, context); }
    catch (e) { result = await resolveAsHost(specifier, context, nextResolve, e); }
  }

  // (2) Freshness propagation. Fast path: the marker only exists during a reload,
  // so 99% of resolutions (startup, normal runs) bail on this cheap string test
  // before any URL parsing.
  const parent = context.parentURL;
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

// A bare import from inside a fetched plugin means "the host's copy". Node resolves it by walking up from
// the cache directory, which finds a sibling plugin's self-link and the host singletons linked in beside it
// (see linkHostSingletons in tool-plugin's remote-cache). This retry covers the rest: any other package the
// HOST has that the cache tree cannot see, resolved as this file would resolve it.
//
// Deliberately NOT the mechanism for the singletons, which it cannot be: the only anchor available here is
// this file, and `apps/cli` depends on `core`, not on `plugin-api` — so the retry could never reach the
// package it would most be needed for. A disk link can, and every resolver honours it.
async function resolveAsHost(specifier, context, nextResolve, original) {
  // Captured BEFORE the retry: `nextResolve` merges the context it is handed into the shared one, so
  // reading `context.parentURL` afterwards reports OUR anchor as the importer — measured, and the reason
  // this error used to name ts-hooks.js as the file that imported the plugin's own dependency.
  const importer = context.parentURL;
  if (cacheLocation(importer) === undefined) throw original;
  try { return await nextResolve(specifier, { ...context, parentURL: import.meta.url }); }
  catch {
    // Both attempts failed, which is the whole answer: it is not installed anywhere this plugin can see
    // and the host does not have it either. Said here rather than guessed from the source ahead of time —
    // the resolution actually happened, so there is no false positive to explain away, and the importer is
    // known. (`node:`-prefixed builtins never reach this path.)
    throw Object.assign(new Error(
      `Cannot resolve "${specifier}" imported by ${importer}: a plugin fetched over http brings ` +
      `its own files only, not a dependency graph, and a bare import means the host's copy — which does not ` +
      `have this one. Install "${specifier}" alongside matbot, add it to \`plugins:\` if it is itself a ` +
      `matbot plugin, or import it by URL.`), { code: 'ERR_MODULE_NOT_FOUND' });
  }
}

export async function load(url, context, nextLoad) {
  // Strip .ts ourselves (concern 2). Match a file: URL ending in .ts, allowing a
  // trailing ?mbfresh query. Everything else (real .js, node:, data:) passes through.
  if (url.startsWith('file:') && /\.ts(\?.*)?$/.test(url)) {
    const source = await readFile(fileURLToPath(url.split('?')[0]), 'utf8');
    const code = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}

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

import { stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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
  // (1) .js -> .ts remap.
  let result;
  if (specifier.endsWith('.js')) {
    try {
      result = await nextResolve(specifier.slice(0, -3) + '.ts', context);
    } catch {
      result = await nextResolve(specifier, context);
    }
  } else {
    result = await nextResolve(specifier, context);
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

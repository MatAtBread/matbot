// Node-only module-customization hook (registered via register.js / --import).
// Two concerns, both pure resolution-time URL rewriting:
//
//   1. Remap *.js imports to *.ts for TypeScript source that ships no compiled
//      output. Required because Node's native strip-types does not perform this
//      remapping across pnpm workspace symlinks.
//
//   2. Plugin hot-reload freshness. When a plugin is reloaded, the core loader
//      stamps the plugin entry URL with `?mbfresh=<gen>` (see FRESH_PARAM in
//      packages/core/runner/src/loader.ts). On its own that re-evaluates only the
//      entry; its static imports stay cached. Here we propagate that stamp from a
//      stamped parent onto its first-party children, so the whole plugin subtree
//      re-evaluates — "fresh all the way down".
//
//      The stamp deliberately stops at the host-shared singleton boundary: any
//      module the plugin API itself loaded (e.g. @matatbread/matbot-plugin-api,
//      which exports `MissingSecretError` used with `instanceof`) must NOT be
//      duplicated, or cross-boundary identity silently breaks. Those package
//      directories arrive via `initialize(data.exclude)` from register.js.

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

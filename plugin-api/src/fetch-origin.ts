// `fetch`, with every URL a request reaches — the one asked for and each one a redirect leads to — put to
// `admit` before anything is sent there. A gate on the first URL alone is a gate on nothing: an approved
// host that answers 302 hands the request, and whatever it carries, to an origin nobody was asked about.
//
// So a `follow` request (the default) is followed here, one hop at a time, as the platform would: 303, and
// 301/302 after a POST, become a bodiless GET; 307/308 resend the body; credentials are dropped on a change
// of origin; twenty hops at most. What is lost is cosmetic: the final `Response` reports the last hop's URL
// and `redirected: false`. A `manual` or `error` request is one hop, admitted and handed to `fetch` as is.
//
// A browser's `manual` redirect is opaque, with no Location to read, so there it is refused rather than
// followed blind.

const MAX_REDIRECTS = 20;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location'];
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

export async function originGatedFetch(
  admit: (url: URL) => Promise<void>,
  input: Request | string | URL,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const first = new Request(input, init);
  await admit(new URL(first.url));
  if (first.redirect !== 'follow') return fetchImpl(first);

  // Read once, up front: a Request body is a stream, and a 307 or 308 sends it again.
  const payload = first.body === null ? null : await first.clone().arrayBuffer();
  let current = first;
  let res = await fetchImpl(first, { redirect: 'manual' });
  for (let hops = 0; ; hops++) {
    if (res.type === 'opaqueredirect') {
      throw new TypeError(`A redirect from ${current.url} was not followed: this platform does not say where it leads. Request the destination directly.`);
    }
    const location = res.headers.get('location');
    if (!REDIRECTS.has(res.status) || location === null) return res;
    if (hops >= MAX_REDIRECTS) throw new TypeError(`Too many redirects from ${first.url}.`);
    await res.body?.cancel();

    const next = new URL(location, current.url);
    const toGet = (res.status === 303 && current.method !== 'HEAD')
               || ((res.status === 301 || res.status === 302) && current.method === 'POST');
    const headers = new Headers(current.headers);
    if (toGet) for (const h of BODY_HEADERS) headers.delete(h);
    if (next.origin !== new URL(current.url).origin) for (const h of CREDENTIAL_HEADERS) headers.delete(h);

    await admit(next);
    current = new Request(next, {
      method:   toGet ? 'GET' : current.method,
      headers,
      body:     toGet ? null : payload,
      signal:   first.signal,
      redirect: 'manual',
    });
    res = await fetchImpl(current);
  }
}

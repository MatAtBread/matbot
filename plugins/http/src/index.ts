import type { Tool, ToolEvent, ToolContext, ToolContract, MatbotPluginSpec, Vault } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, REFERENCEABLE_KEY_RULE, originGatedFetch, refusalMessage, unreferenceableKey } from '@matatbread/matbot-plugin-api';

// Single arm: the request params paired with `unknown` (the body is parsed text or arbitrary JSON). The
// params are inlined structurally (not a `HttpInput` reference) so the derived wire text shows real fields.
declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    http: ToolContract<unknown, { url: string; method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'; headers?: Record<string, string | { Vault: string }>; body?: string; responseType?: 'text' | 'json' }>;
  }
}

// The schema's `method` enum, as a type, and spelled out again in the contract above. Validation runs at
// the executor, so the enum binds every caller, a composition included; were the contract `string`,
// `method: 'PROPFIND'` would type-check and then be refused.
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

interface HttpInput {
  url:           string;
  method?:       HttpMethod;
  headers?:      Record<string, HeaderValue>;
  body?:         string;
  responseType?: 'text' | 'json';
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

/** A header value: literal text, or `{ Vault }` naming the stored secret(s) to send in its place. */
export type HeaderValue = string | { Vault: string };

/**
 * The `headers` schema both this tool and a plugin taking headers in the same grammar advertise. No `anyOf`:
 * the object keywords apply only to an object, so this is both arms in keywords every validator enforces.
 * `additionalProperties: false` because the likeliest guess, `{ Vault, prefix: 'Bearer ' }`, must fail
 * rather than drop the prefix.
 */
export const headersSchema = {
  type: 'object',
  description: 'Header name → value. A value is a literal string, or { "Vault": "KEY_NAME" } to send a stored secret, '
             + 'or { "Vault": "Bearer ${KEY_NAME}" } to send it inside other text.',
  additionalProperties: {
    type: ['string', 'object'],
    required: ['Vault'],
    properties: { Vault: { type: 'string', description: 'A vault key name whose value is sent as this header, or text with each key written as ${KEY_NAME}.' } },
    additionalProperties: false,
  },
} as const;

type Part = { literal: string } | { key: string };

const PLACEHOLDER = /\$\{([^}]*)\}/g;

/**
 * A `{ Vault }` string is a bare key name, or a template whose `${NAME}`s are each a key — so
 * `Bearer ${ACME_KEY}` needs no key holding the prefix. Parsed here rather than by `Vault.resolve`: a
 * template is this tool's grammar, and each name it yields is gated and read on its own, so the names the
 * gate is asked about are exactly the names that are read. A `${` left over after the placeholders are
 * taken out is malformed, never literal text — there is no escape, because a header value needing one is
 * a plain string.
 */
function parseVaultValue(spec: string): Outcome<Part[]> {
  if (!spec.includes('${')) {
    return unreferenceableKey(spec) === undefined ? { ok: true, value: [{ key: spec }] }
      : { ok: false, message: `"${spec}" is not a vault key name: ${REFERENCEABLE_KEY_RULE}.` };
  }
  const parts: Part[] = [];
  let at = 0;
  for (const m of spec.matchAll(PLACEHOLDER)) {
    const key = m[1] ?? '';
    if (unreferenceableKey(key) !== undefined) return { ok: false, message: `"${key}" in "${spec}" is not a vault key name: ${REFERENCEABLE_KEY_RULE}.` };
    if (m.index > at) parts.push({ literal: spec.slice(at, m.index) });
    parts.push({ key });
    at = m.index + m[0].length;
  }
  if (at < spec.length) parts.push({ literal: spec.slice(at) });
  if (parts.some(p => 'literal' in p && p.literal.includes('${'))) {
    return { ok: false, message: `"${spec}" has an unterminated \${…}: write each vault key as \${KEY_NAME}.` };
  }
  return { ok: true, value: parts };
}

/** The vault keys a set of headers names, each with the headers it is sent as. */
export interface VaultHeaderKeys {
  readonly templates: ReadonlyMap<string, Part[]>;
  readonly usedAs:    ReadonlyMap<string, string[]>;
}

/** Parse every `{ Vault }` value in `headers`. A malformed one fails the whole set, before anything is asked. */
export function vaultHeaderKeys(headers: Record<string, HeaderValue>): Outcome<VaultHeaderKeys> {
  // The subject is `<origin> <key>`, which a name with whitespace would make ambiguous; no such name is
  // storable, so it could only ever miss anyway. Checked in parsing, before anything is asked.
  const templates = new Map<string, Part[]>();
  const usedAs = new Map<string, string[]>();
  for (const [header, v] of Object.entries(headers)) {
    if (typeof v === 'string') continue;
    const parsed = parseVaultValue(v.Vault);
    if (!parsed.ok) return parsed;
    templates.set(header, parsed.value);
    for (const p of parsed.value) {
      if ('key' in p && !usedAs.get(p.key)?.includes(header)) usedAs.set(p.key, [...usedAs.get(p.key) ?? [], header]);
    }
  }
  return { ok: true, value: { templates, usedAs } };
}

/**
 * The origin a vault key would be sent to, parsed once: that parse is what is fetched, so the origin the
 * gate approves is the origin that receives the key — never a second reading of the caller's string.
 */
export function secretTarget(url: string): Outcome<URL> {
  let target: URL;
  try { target = new URL(url); }
  catch { return { ok: false, message: `A vault key can only be sent to an absolute URL: ${url}` }; }
  // The ORIGIN, not the host: `http:` and another port are other acts, and `URL` renders a lookalike
  // host as punycode, so the human sees `xn--…` rather than something resembling the real API.
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { ok: false, message: `A vault key can only be sent to an http(s) URL, not ${target.protocol}` };
  }
  return { ok: true, value: target };
}

/**
 * Ask, per key, whether it may be sent to `origin` — under the CALLING tool's `secret` gate, so the
 * `http` tool asks `http.secret` and another tool asking the same question asks its own.
 *
 * One gate call per key, never one per request: the default policy ORs a request's subject with its
 * standing answers, so a batched `A`+`B` would be admitted by an approval only `A` was ever given.
 * Gated before the vault is read, so a refusal reads nothing, and the gate is only ever handed names.
 */
export async function gateVaultKeys(origin: string, keys: VaultHeaderKeys, ctx: ToolContext): Promise<Outcome<void>> {
  for (const [key, names] of keys.usedAs) {
    // Key and origin lead: they are what is being decided. The header name is model-chosen, so a rogue
    // call would give it an innocuous one, and it is never the headline. No value, not even masked — a
    // prompt is broadcast to every client attached to the session.
    const label = `Send the vault key **${key}** to **${origin}** (as the header ${names.map(n => `\`${n}\``).join(', ')})?`;
    // Never "this key, any host": that is the act this gate exists to ask about.
    const permit = await ctx.gate({
      gate: 'secret', subject: `${origin} ${key}`, label, fallback: false,
      standing: [
        { subject: `${origin} ${key}`, label: `sending ${key} to ${origin}` },
        { subject: origin,            label: `sending any vault key to ${origin}` },
      ],
    });
    if (!permit.allowed) return { ok: false, message: refusalMessage(permit, `Sending ${key} to ${origin}`) };
  }
  return { ok: true, value: undefined };
}

/**
 * Turn `{ Vault }` header values into the values they name. The keys come straight off the headers, so
 * the set the gate was asked about IS the set that is read — and the read is by name, never a template
 * handed to `resolve`, so there is no grammar for a name to smuggle a second lookup through. `secrets` is
 * the values sent, for redaction.
 */
export async function readVaultHeaders(
  headers: Record<string, HeaderValue>, keys: VaultHeaderKeys, vault: Pick<Vault, 'readSecret'>,
): Promise<Outcome<{ headers: Record<string, string>; secrets: string[] }>> {
  const values  = new Map(await Promise.all([...keys.usedAs.keys()].map(async k => [k, await vault.readSecret(k)] as const)));
  const missing = [...values].filter(([, v]) => v === undefined).map(([k]) => k);
  if (missing.length > 0) {
    // Never prompted for here: `store-key` already exists so that the value arrives on a channel the
    // transcript never touches, and two routes to storing a secret is one too many.
    return { ok: false, message: `Vault key(s) not set: ${missing.join(', ')}. Ask the user to supply each with the \`plugin\` tool's \`store-key\` action — the value is entered out-of-band and never enters the conversation.` };
  }
  return {
    ok: true,
    value: {
      headers: Object.fromEntries(Object.entries(headers).map(([h, v]) => [h,
        typeof v === 'string' ? v : (keys.templates.get(h) ?? []).map(p => 'key' in p ? values.get(p.key) ?? '' : p.literal).join('')])),
      secrets: [...values.values()].filter((v): v is string => v !== undefined && v !== ''),
    },
  };
}

/**
 * Only the values a request sent: `Vault.scrub` redacts everything the vault holds, which on node is all
 * of `process.env` — `true`, PIDs, $HOME — and would corrupt any JSON body it touched.
 */
export function redactor(secrets: readonly string[]): (s: string) => string {
  return s => secrets.reduce((t, v) => t.split(v).join('[REDACTED]'), s);
}

async function resolveHeaders(
  url: string, headers: Record<string, HeaderValue>, ctx: ToolContext,
): Promise<Outcome<{ target: string | URL; headers: Record<string, string>; secrets: string[] }>> {
  const keys = vaultHeaderKeys(headers);
  if (!keys.ok) return keys;
  if (keys.value.usedAs.size === 0) return { ok: true, value: { target: url, headers: headers as Record<string, string>, secrets: [] } };

  const target = secretTarget(url);
  if (!target.ok) return target;
  const permit = await gateVaultKeys(target.value.origin, keys.value, ctx);
  if (!permit.ok) return permit;

  const read = await readVaultHeaders(headers, keys.value, ctx.vault);
  if (!read.ok) return read;
  return { ok: true, value: { target: target.value, ...read.value } };
}

const NETWORK = new Set(['http:', 'https:']);

/**
 * One decision per ORIGIN a request reaches — scheme, host and port exactly — before anything is sent
 * there, and again for each origin a redirect leads to ({@link originGatedFetch}): an approved host that
 * answers 302 would otherwise forward the request to one nobody was asked about. A request can carry
 * whatever the conversation holds, so where it goes is the question. A `data:` URL reaches no network.
 */
function originGate(ctx: ToolContext): (url: URL) => Promise<void> {
  const decided = new Map<string, Promise<void>>();
  const decide = async (origin: string): Promise<void> => {
    const permit = await ctx.gate({
      gate: 'request', subject: origin, label: `Send an HTTP request to **${origin}**?`, fallback: false,
      standing: [{ subject: origin, label: `requests to ${origin}` }],
    });
    if (!permit.allowed) throw new Error(refusalMessage(permit, `A request to ${origin}`));
  };
  return async (url) => {
    if (!NETWORK.has(url.protocol)) return;
    let decision = decided.get(url.origin);
    if (decision === undefined) { decision = decide(url.origin); decided.set(url.origin, decision); }
    await decision;
  };
}

const executor = {
  async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const { url, method = 'GET', headers = {}, body, responseType = 'text' } = input as HttpInput;
    const admit = originGate(ctx);

    // Where it goes is asked before which keys go with it: refusing the origin then reads no secret.
    if (URL.canParse(url)) {
      try { await admit(new URL(url)); }
      catch (e) { yield { type: 'error', message: e instanceof Error ? e.message : String(e) }; return; }
    }

    const resolved = await resolveHeaders(url, headers, ctx);
    if (!resolved.ok) { yield { type: 'error', message: resolved.message }; return; }
    const { target, secrets } = resolved.value;

    // Applied to every string this yields, errors included: fetch quotes an invalid header value in its TypeError.
    const redact = redactor(secrets);

    let res: Response;
    try {
      res = await originGatedFetch(admit, target, {
        method,
        headers: resolved.value.headers,
        ...(body !== undefined ? { body } : {}),
        // A redirect is not followed with a key attached. fetch strips only `Authorization` and `Cookie`
        // when one changes origin, so an `X-API-Key` would arrive at wherever the approved host points.
        // Without one, a redirect is followed, each new origin asked about as the first was.
        ...(secrets.length > 0 ? { redirect: 'manual' as const } : {}),
        signal: ctx.signal,
      });
    } catch (e) {
      yield { type: 'error', message: redact(String(e)) };
      return;
    }

    if (secrets.length > 0 && (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400 && res.headers.has('location')))) {
      // Node hands back the real 3xx; a browser's manual redirect is opaque, with no Location to read.
      const location = res.headers.get('location');
      yield {
        type: 'error',
        message: `Redirect not followed, because a vault key was attached${location !== null ? `: the server redirected to ${redact(location)}` : ''}. ` +
                 'If that URL should receive the key, request it directly; sending a key to a new origin is asked about separately.',
        code: res.status,
      };
      return;
    }

    let text: string;
    try {
      text = redact(await res.text());
    } catch (e) {
      yield { type: 'error', message: redact(`Failed to read response: ${String(e)}`) };
      return;
    }

    if (!res.ok) {
      yield { type: 'error', message: `HTTP ${res.status}: ${text}`, code: res.status };
      return;
    }

    if (responseType === 'json') {
      try {
        yield { type: 'result', value: JSON.parse(text) as unknown };
      } catch {
        yield { type: 'error', message: `Non-JSON response: ${text.slice(0, 200)}` };
      }
    } else {
      yield { type: 'result', value: text };
    }
  },
};

export const httpTool: Tool = {
  name:        'http',
  description: 'Make an HTTP request and return the response body. A header can carry a credential without it '
             + 'entering the conversation: give its value as { "Vault": "KEY_NAME" } and the stored value is sent, e.g. '
             + '{ "X-API-Key": { "Vault": "ACME_API_KEY" } }. To send a key inside other text, write it as ${KEY_NAME}: '
             + '{ "Authorization": { "Vault": "Bearer ${ACME_API_KEY}" } }. The user is asked before a key is '
             + 'sent to an origin it has not been approved for, and a redirect is not followed while a key is attached. '
             + 'The user is also asked before a request goes to an origin (scheme, host and port) not yet approved, '
             + 'including one a redirect leads to; a call that has no one to ask is refused.',
  inputSchema: {
    type:       'object',
    required:   ['url'],
    properties: {
      url:          { type: 'string', description: 'The URL to request.' },
      // `fetch` takes any verb, but this enum is the tool's limit for every caller (validation is at the
      // executor), so it must list exactly `HttpMethod`. It was five, which rejected HEAD and OPTIONS.
      method:       { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'], default: 'GET' },
      headers:      headersSchema,
      body:         { type: 'string', description: 'Request body for POST/PUT/PATCH.' },
      responseType: { type: 'string', enum: ['text', 'json'], default: 'text' },
    },
  },
  executor,
};

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools:      [httpTool],
};

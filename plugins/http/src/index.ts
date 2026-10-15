import type { Tool, ToolEvent, ToolContext, ToolContract, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, REFERENCEABLE_KEY_RULE, refusalMessage, unreferenceableKey } from '@matatbread/matbot-plugin-api';

// Single arm: the request params paired with `unknown` (the body is parsed text or arbitrary JSON). The
// params are inlined structurally (not a `HttpInput` reference) so the derived wire text shows real fields.
declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    http: ToolContract<unknown, { url: string; method?: string; headers?: Record<string, string | { Vault: string }>; body?: string; responseType?: 'text' | 'json' }>;
  }
}

interface HttpInput {
  url:           string;
  method?:       string;
  headers?:      Record<string, string | { Vault: string }>;
  body?:         string;
  responseType?: 'text' | 'json';
}

type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Turn `{ Vault: name }` header values into the values they name, asking first. The keys come straight off
 * the params, so the set the gate is asked about IS the set that is sent — and the read is by name, never
 * a `${NAME}` handed to `resolve`, so there is no grammar for a name to smuggle a second lookup through.
 *
 * One gate call per key, never one per request: the default policy ORs a request's subject with its
 * standing answers, so a batched `A`+`B` would be admitted by an approval only `A` was ever given.
 * Gated before the vault is read, so a refusal reads nothing, and the gate is only ever handed names.
 */
async function resolveHeaders(
  url: string, headers: Record<string, string | { Vault: string }>, ctx: ToolContext,
): Promise<Outcome<{ target: string | URL; headers: Record<string, string>; secrets: string[] }>> {
  const usedAs = new Map<string, string[]>();
  for (const [header, v] of Object.entries(headers)) {
    if (typeof v !== 'string') usedAs.set(v.Vault, [...usedAs.get(v.Vault) ?? [], header]);
  }
  if (usedAs.size === 0) return { ok: true, value: { target: url, headers: headers as Record<string, string>, secrets: [] } };

  // The subject is `<origin> <key>`, which a name with whitespace would make ambiguous; no such name is
  // storable, so it could only ever miss anyway.
  for (const key of usedAs.keys()) {
    if (unreferenceableKey(key) !== undefined) return { ok: false, message: `"${key}" is not a vault key name: ${REFERENCEABLE_KEY_RULE}.` };
  }
  // Parsed once, and that parse is what is fetched, so the origin the gate approves is the origin that
  // receives the key — never a second reading of the caller's string.
  let target: URL;
  try { target = new URL(url); }
  catch { return { ok: false, message: `A vault key can only be sent to an absolute URL: ${url}` }; }
  // The ORIGIN, not the host: `http:` and another port are other acts, and `URL` renders a lookalike
  // host as punycode, so the human sees `xn--…` rather than something resembling the real API.
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { ok: false, message: `A vault key can only be sent to an http(s) URL, not ${target.protocol}` };
  }
  const origin = target.origin;

  for (const [key, names] of usedAs) {
    // Key and origin lead: they are what is being decided. The header name is model-chosen, so a rogue
    // call would give it an innocuous one, and it is never the headline. No value, not even masked — a
    // prompt is broadcast to every client attached to the session.
    const label = `Send the vault key **${key}** to **${origin}** (as the header ${names.map(n => `\`${n}\``).join(', ')})?`;
    // Never "this key, any host": that is the act this gate exists to ask about.
    const permit = await ctx.gate({
      gate: 'secret', subject: `${origin} ${key}`, label, fallback: false,
      standing: [
        { subject: `${origin} ${key}`, label: `Always allow sending ${key} to ${origin}` },
        { subject: origin,            label: `Always allow sending any vault key to ${origin}` },
      ],
    });
    if (!permit.allowed) return { ok: false, message: refusalMessage(permit, `Sending ${key} to ${origin}`) };
  }

  const values  = new Map(await Promise.all([...usedAs.keys()].map(async k => [k, await ctx.vault.readSecret(k)] as const)));
  const missing = [...values].filter(([, v]) => v === undefined).map(([k]) => k);
  if (missing.length > 0) {
    // Never prompted for here: `store-key` already exists so that the value arrives on a channel the
    // transcript never touches, and two routes to storing a secret is one too many.
    return { ok: false, message: `Vault key(s) not set: ${missing.join(', ')}. Ask the user to supply each with the \`plugin\` tool's \`store-key\` action — the value is entered out-of-band and never enters the conversation.` };
  }
  return {
    ok: true,
    value: {
      target,
      headers: Object.fromEntries(Object.entries(headers).map(([h, v]) => [h, typeof v === 'string' ? v : values.get(v.Vault) ?? ''])),
      secrets: [...values.values()].filter((v): v is string => v !== undefined && v !== ''),
    },
  };
}

const executor = {
  async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const { url, method = 'GET', headers = {}, body, responseType = 'text' } = input as HttpInput;

    const resolved = await resolveHeaders(url, headers, ctx);
    if (!resolved.ok) { yield { type: 'error', message: resolved.message }; return; }
    const { target, secrets } = resolved.value;

    // Only the values this request sent: `Vault.scrub` redacts everything the vault holds, which on node
    // is all of `process.env` — `true`, PIDs, $HOME — and would corrupt any JSON body it touched. Applied
    // to every string this yields, errors included: fetch quotes an invalid header value in its TypeError.
    const redact = (s: string): string => secrets.reduce((t, v) => t.split(v).join('[REDACTED]'), s);

    let res: Response;
    try {
      res = await fetch(target, {
        method,
        headers: resolved.value.headers,
        ...(body !== undefined ? { body } : {}),
        // A redirect is not followed with a key attached. fetch strips only `Authorization` and `Cookie`
        // when one changes origin, so an `X-API-Key` would arrive at wherever the approved host points.
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
             + '{ "X-API-Key": { "Vault": "ACME_API_KEY" } }. It replaces the whole header value, so for '
             + '"Authorization: Bearer …" the key must hold the full "Bearer …" string. The user is asked before a key is '
             + 'sent to an origin it has not been approved for, and a redirect is not followed while a key is attached.',
  inputSchema: {
    type:       'object',
    required:   ['url'],
    properties: {
      url:          { type: 'string', description: 'The URL to request.' },
      // The executor hands `method` straight to `fetch`, which takes any verb; this enum is the model's
      // guardrail, not the tool's limit, so it lists the ones worth offering rather than the ones that work.
      // It was five, which made `json-validation` reject the HEAD and OPTIONS requests the tool supports.
      method:       { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'], default: 'GET' },
      // Each header value is a string or `{ Vault }`. No `anyOf`: the object keywords apply only to an
      // object, so this is both arms in keywords every validator enforces. `additionalProperties: false`
      // because the likeliest guess, `{ Vault, prefix: 'Bearer ' }`, must fail rather than drop the prefix.
      headers:      {
        type: 'object',
        description: 'Header name → value. A value is a literal string, or { "Vault": "KEY_NAME" } to send a stored secret.',
        additionalProperties: {
          type: ['string', 'object'],
          required: ['Vault'],
          properties: { Vault: { type: 'string', description: 'The name of a vault key whose value is sent as this header.' } },
          additionalProperties: false,
        },
      },
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

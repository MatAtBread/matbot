import type { PermissionRequest, ToolContext } from '@matatbread/matbot-plugin-api';
import { refusalMessage, unreferenceableKey, REFERENCEABLE_KEY_RULE } from '@matatbread/matbot-plugin-api';
import type { Asker } from './network.js';

// `context.writeSecret`: a body storing a credential it OBTAINED — a key a server issued in a tool result or a
// response — without the value reaching the model. A body is the one place that can: the model writes the
// code, the body holds the value, and only what the body returns enters the transcript. A tool taking the
// value as a parameter could not, since its params are the model's own output; nor could it tell a body's
// call from the model's.
//
// What it does not do is make leaking impossible: the body holds the value, and can pass it to any tool. What
// leaves the body through this call's own output is redacted once it is written.

const MAX_SECRET_CHARS = 8192;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface SecretWriter {
  /** The body's `context.writeSecret`. */
  write(name: unknown, value: unknown): Promise<void>;
  /** `value` with every secret written so far replaced, deeply through arrays and plain objects. */
  redact<T>(value: T): T;
}

/**
 * Two gates, under the function's namespace and keyed `<function>@<version> <KEY>`, as an import is:
 * `write-secret` to create a key, which may be remembered; `replace-secret` to overwrite one, asked EVERY
 * time — a replaced key is a swapped credential, or (a provider's `endpoint` is read from the vault too)
 * every request sent somewhere else, and so is never something a standing answer should do unasked. A call
 * with nobody to ask (a background job) can therefore create under a standing answer and never replace.
 *
 * `source` is the text the function was defined with: a value written there is already in the conversation.
 */
export function gatedSecretWriter(ctx: ToolContext, asker: Asker, source: string): SecretWriter {
  const written: string[] = [];
  const redactString = (s: string): string => written.reduce((t, v) => t.split(v).join('[REDACTED]'), s);
  const redactDeep = (v: unknown, seen: WeakMap<object, unknown>): unknown => {
    if (typeof v === 'string') return redactString(v);
    if (typeof v !== 'object' || v === null) return v;
    const proto = Object.getPrototypeOf(v) as unknown;
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return v;
    const done = seen.get(v);
    if (done !== undefined) return done;
    const out: Record<string, unknown> | unknown[] = Array.isArray(v) ? [] : {};
    seen.set(v, out);
    for (const key of Reflect.ownKeys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (d === undefined) continue;
      // A symbol is the host's (a marker's call frames, which JSON never carries): kept exactly as it was.
      if (typeof key === 'symbol') Object.defineProperty(out, key, d);
      else if (d.enumerable === true) (out as Record<string, unknown>)[key] = redactDeep((v as Record<string, unknown>)[key], seen);
    }
    return out;
  };

  return {
    redact: <T>(value: T): T => (written.length === 0 ? value : redactDeep(value, new WeakMap()) as T),

    async write(name, value) {
      if (typeof name !== 'string' || typeof value !== 'string') throw new Error('writeSecret takes a key name and a value, both strings.');
      // An empty value REMOVES a key in the vault's own writeSecret; a body is given no way to delete one.
      if (value === '') throw new Error('writeSecret was given an empty value; nothing was stored. A key is removed only by the user.');
      if (CONTROL.test(value)) throw new Error(`The value for ${name} contains a control character (a line break, say), which a secret cannot hold; nothing was stored.`);
      if (value.length > MAX_SECRET_CHARS) throw new Error(`The value for ${name} is ${value.length} characters, over the ${MAX_SECRET_CHARS} a secret may be; nothing was stored.`);
      const unnamed = unreferenceableKey(name) !== undefined ? REFERENCEABLE_KEY_RULE : ctx.vault.unstorableKey?.(name);
      if (unnamed !== undefined) throw new Error(`"${name}" cannot name a vault key: ${unnamed}.`);
      if (source.includes(value)) {
        throw new Error(`The value for ${name} is written in the function's own text, so it is already in the conversation; ` +
                        'nothing was stored. A key the user has is stored with the `plugin` tool\'s `store-key` action, which asks them for it out-of-band.');
      }

      const exists = ctx.vault.hasKey(name);
      const permit = await ctx.gate(request(asker, name, value.length, exists, exposedIn(ctx, value)));
      if (!permit.allowed) throw new Error(refusalMessage(permit, `Storing ${name}`));
      // Created by someone else while the question was open: the answer given was to a create, not a replace.
      if (!exists && ctx.vault.hasKey(name)) throw new Error(`${name} was created by something else while you were being asked; nothing was stored. Ask again to replace it.`);

      written.push(value);
      try { await ctx.vault.writeSecret(name, value); }
      catch (e) { throw new Error(redactString(e instanceof Error ? e.message : String(e))); }
    },
  };
}

function request({ namespace, fn, who }: Asker, name: string, length: number, exists: boolean, exposed: boolean): PermissionRequest & { namespace: string } {
  // Never the value, not even masked: a prompt is broadcast to every client attached to the session.
  const note = exposed ? '\n\n_This value already appears in this conversation, so treat it as exposed._' : '';
  if (exists) {
    return {
      namespace, gate: 'replace-secret', subject: `${fn} ${name}`, fallback: false,
      label: `Allow ${who} to **replace** the vault key **${name}** with a ${length}-character value? ` +
             `Everything configured to use ${name} will use the new one.${note}`,
      lifetimes: [], answers: { yes: 'Replace', no: 'Cancel' },
    };
  }
  return {
    namespace, gate: 'write-secret', subject: `${fn} ${name}`, fallback: false,
    label: `Allow ${who} to store a ${length}-character value in the vault as **${name}**?${note}`,
    standing: [
      { subject: `${fn} ${name}`, label: `${who} to store ${name}` },
      { subject: `* ${name}`,     label: `ANY function to store ${name}` },
    ],
  };
}

/** Whether `value` is already somewhere in the session's history — a tool result that carried it, say. */
function exposedIn(ctx: ToolContext, value: string): boolean {
  const history = JSON.stringify(ctx.session.messages);
  return history.includes(value) || history.includes(JSON.stringify(value).slice(1, -1));
}

import { withFailure, type FailureClass } from '@matatbread/matbot-plugin-api';

// SQLite's result codes, as node:sqlite reports them (`errcode`). BUSY and LOCKED are another connection
// holding the database — another matbot process on the same file, a background job's — and clear when it
// lets go; READONLY is a file this process may not write. Anything else is left unclassified.
function classOf(e: unknown): FailureClass | undefined {
  const code = typeof e === 'object' && e !== null ? (e as { errcode?: unknown }).errcode : undefined;
  if (typeof code !== 'number') return undefined;
  switch (code & 0xff) {
    case 5: case 6: return 'unavailable';
    case 8:         return 'denied';
    default:        return undefined;
  }
}

const tag = (e: unknown): unknown => (e instanceof Error ? withFailure(e, classOf(e)) : e);

// Every method's failure carries its class, so a caller can tell "the database is busy, try again" from a
// fault — without each of the store's statements catching for it.
export function classified<O extends object>(target: O): O {
  return new Proxy(target, {
    get(t, key, receiver) {
      const v = Reflect.get(t, key, receiver) as unknown;
      if (typeof v !== 'function') return v;
      return (...args: unknown[]): unknown => {
        let r: unknown;
        try { r = (v as (...a: unknown[]) => unknown).apply(t, args); } catch (e) { throw tag(e); }
        return r instanceof Promise ? r.catch((e: unknown) => { throw tag(e); }) : r;
      };
    },
  });
}

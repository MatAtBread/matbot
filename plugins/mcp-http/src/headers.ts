import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { gateVaultKeys, secretTarget, vaultHeaderKeys, type HeaderValue, type Outcome } from '@matatbread/matbot-tool-http';

/** A remote server's headers, in the `http` tool's grammar: a literal, or `{ Vault }` naming stored secrets. */
export type RemoteHeaders = Record<string, HeaderValue>;

/**
 * Asked once, at `add`, for each vault key the headers name: whether it may be sent to the endpoint's
 * origin. Unlike the `http` tool there is no per-request question to put — a server's headers go with
 * every request it is sent, including the reconnect at boot, which has nobody to ask — so connecting it
 * is the act, as the `add` gate beside it already is. What persists is the `{ Vault }` form, so the
 * decision is about names and the value is read only to send.
 */
export async function gateRemoteHeaders(endpoint: string, headers: RemoteHeaders | undefined, ctx: ToolContext): Promise<Outcome<void>> {
  if (headers === undefined) return { ok: true, value: undefined };
  const keys = vaultHeaderKeys(headers);
  if (!keys.ok) return keys;
  if (keys.value.usedAs.size === 0) return { ok: true, value: undefined };
  const target = secretTarget(endpoint);
  if (!target.ok) return target;
  return gateVaultKeys(target.value.origin, keys.value, ctx);
}

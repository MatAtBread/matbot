// Browser OAuth for Google Drive via Google Identity Services (GIS).
//
// We use the GIS *token* model (OAuth 2.0 implicit/PKCE for SPAs): the only configuration a
// deployment needs is a public OAuth **client ID** (not a secret — it is embedded in every web
// client and scoped to an authorised JavaScript origin in the Google Cloud console). There is no
// client secret, no server, and no refresh token: GIS hands back a short-lived (~1h) access token
// and we silently re-request it (prompt: '') whenever it expires, which works as long as the user's
// Google session and prior consent are intact. The first request shows Google's account/consent
// popup; subsequent ones are invisible.
//
// CORS: the Drive REST + upload endpoints accept cross-origin requests bearing an `Authorization:
// Bearer` header, so the token is all the DriveClient needs. The bundle MUST be served from an
// http(s) origin registered with the client ID — OAuth refuses a `file://` origin.

const GSI_SRC = 'https://accounts.google.com/gsi/client';

// Persist the live token so a realm reload inside the token's lifetime skips a fresh popup.
const TOKEN_CACHE_KEY = 'matbot.gdrive.token';

interface TokenResponse {
  access_token?: string;
  expires_in?:   number;
  error?:        string;
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
  callback: (resp: TokenResponse) => void;
}

interface GisOAuth2 {
  initTokenClient(cfg: {
    client_id:       string;
    scope:           string;
    prompt?:         string;
    callback:        (resp: TokenResponse) => void;
    error_callback?: (err: { type?: string; message?: string }) => void;
  }): TokenClient;
}

type GisGlobal = { google?: { accounts?: { oauth2?: GisOAuth2 } } };

let gsiLoad: Promise<GisOAuth2> | undefined;

// The resolved GIS API, kept module-level so a click handler can reach it *synchronously*
// (initTokenClient + requestAccessToken are both sync; only the script load is async, and that is
// done ahead of the gesture via preloadGsi()).
let gsiReady: GisOAuth2 | undefined;

/** Inject the GIS client script once and resolve when `google.accounts.oauth2` is available. */
function loadGsi(): Promise<GisOAuth2> {
  if (gsiLoad !== undefined) return gsiLoad;
  gsiLoad = new Promise<GisOAuth2>((resolve, reject) => {
    const ready = (oauth2: GisOAuth2) => { gsiReady = oauth2; resolve(oauth2); };
    const existing = (globalThis as GisGlobal).google?.accounts?.oauth2;
    if (existing !== undefined) { ready(existing); return; }

    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const oauth2 = (globalThis as GisGlobal).google?.accounts?.oauth2;
      if (oauth2 === undefined) reject(new Error('GIS loaded but google.accounts.oauth2 is unavailable'));
      else ready(oauth2);
    };
    script.onerror = () => reject(new Error(`Failed to load Google Identity Services from ${GSI_SRC}`));
    document.head.appendChild(script);
  });
  return gsiLoad;
}

/** Load the GIS script ahead of any user gesture (call when the connect UI mounts). */
export function preloadGsi(): Promise<void> {
  return loadGsi().then(() => {});
}

function loadCachedToken(): { token: string; expiresAt: number } | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(TOKEN_CACHE_KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { token: string; expiresAt: number };
    return typeof v.token === 'string' && typeof v.expiresAt === 'number' ? v : undefined;
  } catch { return undefined; }
}

/**
 * Holds a Google OAuth access token for Drive and renews it on demand. One instance per backend;
 * `token()` is the single read path the DriveClient calls, and `invalidate()` is what a 401 handler
 * calls to force the next `token()` to re-request.
 */
export class DriveAuth {
  private readonly clientId: string;
  private readonly scope:    string;
  private client?:   TokenClient;
  private accessToken: string | undefined;
  private expiresAt = 0;            // epoch ms; 0 ⇒ no token
  private pending:   Promise<string> | undefined;

  constructor(clientId: string, scope: string) {
    this.clientId = clientId;
    this.scope    = scope;
    const cached = loadCachedToken();
    if (cached !== undefined) { this.accessToken = cached.token; this.expiresAt = cached.expiresAt; }
  }

  /** Whether a cached, non-expired token is in hand — i.e. we can reach Drive with no popup. */
  hasFreshToken(): boolean {
    // 30s skew guard so we don't hand out a token that dies mid-request.
    return this.accessToken !== undefined && Date.now() < this.expiresAt - 30_000;
  }

  private ensureClient(oauth2: GisOAuth2): TokenClient {
    if (this.client === undefined) {
      this.client = oauth2.initTokenClient({
        client_id: this.clientId,
        scope:     this.scope,
        callback:  () => {},   // replaced per-request
      });
    }
    return this.client;
  }

  /**
   * Open the Google consent/account popup and resolve with the token. **Must be called from within a
   * user gesture (a click), after `preloadGsi()` has resolved.** It opens the popup synchronously
   * (no `await` before `requestAccessToken`) so the gesture's transient activation is still live —
   * Chrome blocks a popup opened after an await. Throws if the GIS script hasn't preloaded yet.
   */
  requestInteractive(): Promise<string> {
    if (gsiReady === undefined) throw new Error('preloadGsi() must resolve before requestInteractive()');
    return this.awaitToken(this.ensureClient(gsiReady), '');
  }

  /**
   * A valid access token for non-interactive callers (the DriveClient). Returns the cached token, or
   * — when it has expired — attempts a renewal. Renewal may surface a popup if the Google session has
   * lapsed; that path is best-effort (a 401 mid-session is rare) and the user can always re-run the
   * setup flow, which re-authorises from a real gesture.
   */
  async token(): Promise<string> {
    if (this.hasFreshToken()) return this.accessToken!;
    if (this.pending !== undefined) return this.pending;
    this.pending = (async () => {
      const oauth2 = await loadGsi();
      return this.awaitToken(this.ensureClient(oauth2), '');
    })();
    try { return await this.pending; }
    finally { this.pending = undefined; }
  }

  /** Drop the current token (e.g. after a 401) so the next `token()` re-requests. */
  invalidate(): void {
    this.accessToken = undefined;
    this.expiresAt = 0;
    try { globalThis.localStorage?.removeItem(TOKEN_CACHE_KEY); } catch { /* unavailable */ }
  }

  private awaitToken(client: TokenClient, prompt: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      client.callback = (resp: TokenResponse) => {
        if (resp.error !== undefined || resp.access_token === undefined) {
          reject(new Error(`Google authorisation failed: ${resp.error ?? 'no access_token returned'}`));
          return;
        }
        this.accessToken = resp.access_token;
        this.expiresAt   = Date.now() + (resp.expires_in ?? 3600) * 1000;
        try {
          globalThis.localStorage?.setItem(
            TOKEN_CACHE_KEY,
            JSON.stringify({ token: this.accessToken, expiresAt: this.expiresAt }),
          );
        } catch { /* unavailable */ }
        resolve(resp.access_token);
      };
      // Empty prompt: silent if a prior grant + live session allow it, otherwise GIS shows the popup.
      client.requestAccessToken({ prompt });
    });
  }
}

import { DriveAuth, preloadGsi } from './drive-auth.js';
import { DRIVE_SCOPE } from './drive-backend.js';

const CREATE_CLIENT_URL = 'https://console.cloud.google.com/auth/clients/create';
const ENABLE_API_URL    = 'https://console.cloud.google.com/apis/library/drive.googleapis.com';

export interface DriveSetupResult {
  auth:       DriveAuth;
  clientId:   string;
  rootFolder: string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: string,
  props?: Partial<HTMLElementTagNameMap[K]>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = style;
  if (props) Object.assign(node, props);
  return node;
}

/**
 * The Google Drive connection dialog. Replaces a bare `prompt()` with a web overlay that:
 *  - collects the OAuth Client ID and target folder, prefilled from prior config;
 *  - links straight to the (hard-to-find) "create OAuth client" console page and shows the exact
 *    origin to authorise;
 *  - drives the Google sign-in **from the Connect button's click** — that user gesture is what lets
 *    Chrome open the consent popup (a popup opened during boot, with no gesture, is blocked). The GIS
 *    script is preloaded as the dialog mounts so the click handler can open the popup synchronously.
 *
 * Resolves with an authorised {@link DriveAuth} once sign-in succeeds; rejects if the user cancels.
 */
export function runDriveSetup(initial: { clientId?: string; rootFolder?: string }): Promise<DriveSetupResult> {
  const httpOrigin = location.protocol === 'http:' || location.protocol === 'https:';

  const backdrop = el('div',
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,.55);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;');

  const card = el('div',
    'background:#fff;color:#1a1a1a;max-width:520px;width:calc(100% - 32px);border-radius:12px;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.3);padding:28px;line-height:1.5;max-height:90vh;overflow:auto;');

  const h = el('h2', 'margin:0 0 8px;font-size:20px;', { textContent: 'Connect Google Drive' });
  const sub = el('p', 'margin:0 0 20px;color:#555;font-size:14px;',
    { textContent: 'Store your matbot data — chats, settings, files and secrets — in your own Google Drive, so it follows you between browsers and machines.' });

  // ── Step-by-step setup instructions, right in the dialog ────────────────────────────────────
  const code = (text: string) => el('code', 'background:#f0f0f0;padding:1px 6px;border-radius:4px;font-size:12px;', { textContent: text });
  const q = (text: string) => document.createTextNode(`“${text}”`);   // “smart quoted”

  const stepsTitle = el('p', 'margin:0 0 8px;font-size:13px;font-weight:600;', { textContent: 'One-time Google setup (≈2 min)' });
  const steps = el('ol', 'margin:0 0 20px;padding-left:22px;font-size:13px;color:#444;');

  const li = (...nodes: (string | Node)[]) => { const n = el('li', 'margin:0 0 9px;'); n.append(...nodes); return n; };

  const link = el('a', 'color:#1a73e8;text-decoration:none;font-weight:600;',
    { href: CREATE_CLIENT_URL, target: '_blank', rel: 'noopener', textContent: 'Open Google Cloud → Create OAuth client ID ↗' });
  const apiLink = el('a', 'color:#1a73e8;text-decoration:none;font-weight:600;',
    { href: ENABLE_API_URL, target: '_blank', rel: 'noopener', textContent: 'Enable the Google Drive API ↗' });

  const originCode = code(location.origin);
  const copyBtn = el('button',
    'margin-left:8px;padding:2px 9px;border:1px solid #ccc;background:#f7f7f7;border-radius:5px;font-size:11px;cursor:pointer;vertical-align:middle;',
    { type: 'button', textContent: 'Copy' });

  steps.append(
    li(link, ' (create or pick a project first).'),
    li('For ', q('Application type'), ' choose ', code('Web application'), '.'),
    li('Under ', q('Authorised JavaScript origins'), ' click ', q('Add URI'), ' and paste this exact origin: ', document.createElement('br'), originCode, copyBtn),
    li('Click ', q('Create'), ', then copy the ', q('Client ID'), ' Google shows you (ends in ', code('.apps.googleusercontent.com'), ') and paste it below.'),
    li(
      apiLink, ' for the same project, and click ', q('Enable'), '. ',
      'Without this, sign-in works but every Drive call returns ', code('403: API not enabled'),
      ' (wait ~1 min after enabling for it to take effect).',
    ),
    li(
      el('strong', '', { textContent: 'Add yourself as a test user' }),
      ' — on the ', q('Audience'), ' tab, under ', q('Test users'), ', click ', q('Add users'),
      ', enter your Google account, and Save. (Skip this and you get a ', code('403 access_denied'), '.)',
    ),
    li(
      'When you click Connect below and Google shows ', q('this app isn’t verified'), ', click ',
      q('Advanced'), ' → ', q('Go to … (unsafe)'), ' → ', q('Continue'),
      '. It’s your own app touching only files it creates (', code('drive.file'),
      '), so it’s safe — the warning just means you haven’t paid for Google’s verification review, which personal use doesn’t need.',
    ),
  );

  // Client ID field.
  const cidLabel = el('label', 'display:block;font-size:13px;font-weight:600;margin:0 0 4px;', { textContent: 'Client ID' });
  const cid = el('input',
    'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #ccc;border-radius:7px;font-size:14px;margin:0 0 16px;',
    { type: 'text', placeholder: '…apps.googleusercontent.com', value: initial.clientId ?? '' });

  // Folder field.
  const folderLabel = el('label', 'display:block;font-size:13px;font-weight:600;margin:0 0 4px;', { textContent: 'Drive folder (created if missing)' });
  const folder = el('input',
    'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #ccc;border-radius:7px;font-size:14px;',
    { type: 'text', value: initial.rootFolder ?? 'matbot' });

  // Status / error line.
  const status = el('p', 'margin:16px 0 0;font-size:13px;min-height:18px;');

  // Buttons.
  const row = el('div', 'display:flex;gap:10px;justify-content:flex-end;margin-top:20px;');
  const cancel = el('button',
    'padding:9px 16px;border:1px solid #ccc;background:#fff;border-radius:7px;font-size:14px;cursor:pointer;',
    { type: 'button', textContent: 'Cancel' });
  const connect = el('button',
    'padding:9px 16px;border:0;background:#1a73e8;color:#fff;border-radius:7px;font-size:14px;cursor:pointer;',
    { type: 'button', textContent: 'Connect Google Drive', disabled: true });
  row.append(cancel, connect);

  card.append(h, sub, stepsTitle, steps, cidLabel, cid, folderLabel, folder, status, row);
  if (!httpOrigin) {
    const warn = el('p', 'margin:16px 0 0;padding:10px 12px;background:#fff3cd;border:1px solid #ffe69c;border-radius:7px;font-size:13px;color:#664d03;',
      { textContent: `Google sign-in needs an http(s) origin — this page is "${location.protocol}". Serve the bundle from a local web server (e.g. apps/web-bundle: npm run serve) rather than opening the file directly.` });
    card.insertBefore(warn, row);
  }
  backdrop.append(card);
  document.body.append(backdrop);

  return new Promise<DriveSetupResult>((resolve, reject) => {
    const close = () => backdrop.remove();
    const setStatus = (msg: string, ok = false) => { status.textContent = msg; status.style.color = ok ? '#188038' : '#d93025'; };

    // Preload the GIS script so the Connect click can open the popup synchronously.
    preloadGsi().then(
      () => { connect.disabled = false; },
      (e: unknown) => { setStatus(`Could not load Google sign-in: ${String(e)}`); },
    );

    copyBtn.onclick = () => {
      navigator.clipboard?.writeText(location.origin).then(
        () => { copyBtn.textContent = 'Copied ✓'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500); },
        () => { copyBtn.textContent = 'Copy failed'; },
      );
    };

    cancel.onclick = () => { close(); reject(new Error('Google Drive setup cancelled')); };

    connect.onclick = () => {
      const clientId   = cid.value.trim();
      const rootFolder = folder.value.trim() || 'matbot';
      if (!clientId) { setStatus('Enter your OAuth Client ID first.'); return; }

      connect.disabled = true;
      setStatus('Opening Google sign-in…', true);

      const auth = new DriveAuth(clientId, DRIVE_SCOPE);
      // Must stay synchronous up to requestAccessToken — no await before this call (see DriveAuth).
      auth.requestInteractive().then(
        () => { close(); resolve({ auth, clientId, rootFolder }); },
        (e: unknown) => {
          connect.disabled = false;
          setStatus(`Sign-in failed: ${String(e instanceof Error ? e.message : e)}. If a popup was blocked, allow popups for this site and try again.`);
        },
      );
    };
  });
}

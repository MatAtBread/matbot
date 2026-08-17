// Insecure-context Web Crypto shims (crypto.randomUUID / crypto.subtle.digest, for plain-HTTP local
// hosting) live in the web-bundle loader (apps/web-bundle/src/loader.js), which runs before any module
// — including this frontend — so they're already in place by the time anything here runs. In
// server-backed mode the runtime executes in Node, where Web Crypto is always available.

// ── State ─────────────────────────────────────────────────────────────────────

// localStorage keys
const LS_FONT_SIZE      = 'fontSize';
const LS_PROVIDER       = 'provider';
const LS_STEER_MODE     = 'steerMode';
const LS_SIDEBAR        = 'sidebarSections';
const LS_SIDEBAR_WIDTH  = 'sidebarWidth';

let currentSessionId = null;
let profilesActive = false;   // set once initProfiles confirms a profile-aware storage backend (gates sharing UI)
let profileNames = new Set(); // valid profile names, populated by initProfiles — lets hashchange split a deep-link profile like load does
let composerReadOnly = false; // true while viewing a session shared IN from another profile (writes rejected by backend)
let sending = false;          // current session busy? mirrors the server's 'session-busy' status
const busySessions   = new Set();
const unreadSessions = new Set();
const updatedFiles   = new Set();
// path → owning profile id for files shared IN from another profile (read-only here). Refreshed with the
// file list in one `share`/`owner`/`*` call; empty when profiles are inactive. Gates the per-file share UI.
let   fileOwners     = {};
// Same, for sessions shared IN: session id → owning profile id. Refreshed with the session list.
let   sessionOwners  = {};

// ── Scroll control ────────────────────────────────────────────────────────────
//
// We want to avoid the "chasing the bottom" scroll behaviour that makes it
// impossible to read earlier output while the model is still generating.
//
// Strategy:
//   1. On the *first* content token of a turn we scroll so the assistant
//      wrapper sits at the top of the messages viewport.
//   2. After that we do NOT auto-scroll — the user can read at their own pace.
//   3. When the turn finishes, if the bottom of messages is below the fold
//      we morph the send button into a ▼ down-arrow that scrolls to bottom.
//   4. Any manual scroll by the user suppresses ALL auto-scrolling for 10 s.

let scrollSuppressUntil = 0;    // epoch ms — suppress auto-scroll until this time
let expectedScrollTop = 0;      // messagesEl.scrollTop as we last set it; a 'scroll'
                                // landing elsewhere means the user moved it, not us

function isScrollSuppressed() {
  return Date.now() < scrollSuppressUntil;
}

// Call this wrapper before any programmatic scroll so the scroll-listener can
// distinguish user-initiated scrolls from our own.
function programmaticScrollTo(fn) {
  fn();
  // Record where we left messagesEl so the 'scroll' handler can tell our own move from
  // the user's. A boolean flag can't: during streaming scrollToOutputStart re-sets it
  // every delta — faster than its rAF reset — so it stays true and every user scroll
  // reads as ours. Comparing the settled position has no such race; instant
  // scrollIntoView / scrollTop assignment both update scrollTop synchronously here.
  expectedScrollTop = messagesEl.scrollTop;
}

// Listen for user-initiated scrolls on the messages pane.
// 'wheel' catches mouse wheels and trackpad gestures.
// 'touchmove' catches finger-drags on touch screens.
// Together they cover the vast majority of deliberate user scrolls.
function onUserScroll() {
  // wheel/touchmove fire synchronously at input time, so arm suppression immediately:
  // the next streaming delta's auto-scroll then bails before it can override — and
  // thereby mask — the user's move. The 'scroll' handler's position check is the
  // backstop for scrollbar drags and keyboard paging, which emit no wheel/touch event.
  scrollSuppressUntil = Date.now() + 5000;
}

// True when the bottom edge of #messages is at or above the bottom of the
// viewport (i.e. the user can see the most recent content without scrolling).
function isMessagesBottomVisible() {
  // True when all content fits in the messages container without scrolling.
  // False when there's overflow — meaning content is hidden off-screen and
  // the user may want the scroll-down button to jump to the bottom.
  const textBlock = messagesEl.querySelector('.message.assistant:last-child .msg-text');
  if (!textBlock) {
    return true;
  }
  const h = window.innerHeight - (chatHeaderEl?.offsetHeight ?? 0)
           - (document.getElementById('input-area')?.offsetHeight ?? 0);
  const fits = textBlock.offsetHeight <= h;
  const atBottom = messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 2;
  return fits || atBottom;
}

// Send-button glyphs (SVG, so they render identically across platforms instead of relying on
// font-dependent unicode). Play triangle for send; down-chevron when the button morphs into a
// scroll-to-bottom control.
const ICON_SEND   = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M9 6v12l9-6z"/></svg>';
const ICON_SCROLL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

// Morph the send button into a scroll-down button. Stop is now its own button, and the input
// stays enabled while a turn runs (so you can type-ahead and queue), so neither is touched here.
function showScrollDownButton() {
  sendBtn.innerHTML = ICON_SCROLL;
  sendBtn.classList.add('scroll-down-mode');
}

// Scroll to the very bottom of the messages pane and restore the send button. The Stop button's
// visibility is driven independently by the server's busy status, so we don't reason about it here.
function scrollToBottomAndReset() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  resetSendButton();
  inputEl.focus();
}

// Restore the send button to its normal (play) state.
function resetSendButton() {
  sendBtn.innerHTML = ICON_SEND;
  sendBtn.classList.remove('scroll-down-mode', 'stop-mode');
  sendBtn.disabled = false;
}

// ── Floating scroll-down button ─────────────────────────────────
//
// A separate ▼ button that appears when the current message text is
// taller than the visible area, letting the user jump to the bottom
// without conflating scroll and send/stop actions.

let scrollDownBtn = null; // initialised in init()

function updateScrollDownButton() {
  if (!scrollDownBtn) return;
  if (isMessagesBottomVisible()) {
    scrollDownBtn.style.display = 'none';
  } else {
    scrollDownBtn.style.display = 'flex';
  }
}



// ── Elements ──────────────────────────────────────────────────────────────────

const messagesEl     = document.getElementById('messages');
const sessionsBanner = document.getElementById('sessions-banner');
const sessionListEl  = document.getElementById('session-list');
const chatHeaderEl   = document.getElementById('chat-header');
const chatTitleEl    = document.getElementById('chat-title');
const shareBtn       = document.getElementById('share-btn');
const inputEl        = document.getElementById('input');
const sendBtn        = document.getElementById('send-btn');
const stopBtn        = document.getElementById('stop-btn');
const newBtn         = document.getElementById('new-btn');
const providerSel    = document.getElementById('provider-select');

// Steering mode for /submit: 'queue' (wait for the running turn to finish) vs 'interrupt' (stop it —
// keeping its committed partial work — and steer immediately). A per-browser toggle beside the provider
// select, mainly for testing; defaults to 'interrupt'. Sent explicitly on every submit, so it overrides
// the server's own default.
const modeToggle = document.getElementById('mode-interrupt');
if (modeToggle) {
  const saved = localStorage[LS_STEER_MODE];
  modeToggle.checked = saved ? saved === 'interrupt' : true;   // default: interrupt
  modeToggle.addEventListener('change', () => {
    localStorage.setItem(LS_STEER_MODE, modeToggle.checked ? 'interrupt' : 'queue');
  });
}
const currentSteerMode = () => (modeToggle && !modeToggle.checked ? 'queue' : 'interrupt');
const burgerBtn      = document.getElementById('burger');
const sidebarOverlay = document.getElementById('sidebar-overlay');

function closeSidebar() { document.body.classList.remove('sidebar-open'); }
if (burgerBtn)      burgerBtn.onclick      = () => document.body.classList.toggle('sidebar-open');
if (sidebarOverlay) sidebarOverlay.onclick = closeSidebar;

// ── Sidebar section collapse / expand ──────────────────────────────────────────


function loadSidebarState() {
  try {
    const raw = localStorage[LS_SIDEBAR];
    if (!raw) return;
    const state = JSON.parse(raw);
    for (const [name, collapsed] of Object.entries(state)) {
      const section = document.querySelector('.sidebar-section[data-section="' + name + '"]');
      if (!section) continue;
      if (collapsed) section.classList.add('collapsed');
      else           section.classList.remove('collapsed');
    }
  } catch { /* ignore */ }
}

function saveSidebarState() {
  const state = {};
  for (const el of document.querySelectorAll('.sidebar-section[data-section]')) {
    state[el.dataset.section] = el.classList.contains('collapsed');
  }
  localStorage.setItem(LS_SIDEBAR, JSON.stringify(state));
}

document.getElementById('sidebar').addEventListener('click', (e) => {
  const heading = e.target.closest('.sidebar-heading');
  if (!heading) return;
  const section = heading.closest('.sidebar-section');
  if (!section) return;
  section.classList.toggle('collapsed');
  saveSidebarState();
});

loadSidebarState();

// ── Sidebar resize ────────────────────────────────────────────────────────────

{
  const sidebarEl  = document.getElementById('sidebar');
  const resizerEl  = document.getElementById('sidebar-resizer');
  const MIN_W = 160, MAX_W = 600;

  const savedW = parseInt(localStorage.getItem(LS_SIDEBAR_WIDTH) ?? '');
  if (savedW >= MIN_W && savedW <= MAX_W) sidebarEl.style.width = savedW + 'px';

  resizerEl?.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = sidebarEl.offsetWidth;
    resizerEl.classList.add('active');
    document.body.classList.add('sidebar-resizing');

    function onMove(e) {
      const w = Math.max(MIN_W, Math.min(MAX_W, startWidth + e.clientX - startX));
      sidebarEl.style.width = w + 'px';
    }
    function onUp() {
      resizerEl.classList.remove('active');
      document.body.classList.remove('sidebar-resizing');
      localStorage.setItem(LS_SIDEBAR_WIDTH, String(sidebarEl.offsetWidth));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

// ── Markdown ──────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/[&<>\"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c] ?? c));
}

function md(text) {
  if (!text) return '';
  if (typeof marked === 'undefined') return '<p>' + escHtml(text) + '</p>';
  const result = marked.parse(text);
  // Open all links in new tab
  return result.replace(/<a /g, '<a target=\"_blank\" rel=\"noopener noreferrer\" ');
}

// ── Transport ───────────────────────────────────────────────────────────────
//
// All server I/O goes through window.matbotTransport, set up before this script runs:
//   - http-transport.js  (Node-served: fetch + SSE to server.ts)
//   - browser.js         (in-process bundle: drives services.run directly)
// This file is byte-identical in both modes; only the transport behind T differs.
const T = window.matbotTransport;

// ── web_user_environment: run an LLM-supplied expression in a sandboxed Worker ──
// The tool (server.ts) pushes a `web-env-eval` event; we evaluate the expression in a throwaway Web
// Worker built from a blob URL — the only Worker construction that also works from a file:// bundle —
// and post the JSON-serialisable result back. The Worker has no DOM/storage/cookies/sensors, so this
// is read-only introspection of the standard web platform (Date, Intl, navigator.*), nothing more.
const WEB_ENV_WORKER_SRC = `self.onmessage = async (e) => {
  let out;
  try { out = { ok: true, value: await (0, eval)(e.data) }; }
  catch (err) { out = { ok: false, error: (err && err.message) ? String(err.message) : String(err) }; }
  try { self.postMessage(out); }
  catch (_) { self.postMessage({ ok: false, error: 'Result is not serialisable.' }); }
};`;

function runWebEnv(expression) {
  return new Promise((resolve) => {
    let worker, url, done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (worker) worker.terminate();
      if (url) URL.revokeObjectURL(url);
      resolve(out);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'Timed out after 5s.' }), 5000);
    try {
      url = URL.createObjectURL(new Blob([WEB_ENV_WORKER_SRC], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (e) => finish(e.data);
      worker.onerror = (e) => finish({ ok: false, error: (e && e.message) ? e.message : 'Worker error.' });
      worker.postMessage(expression);
    } catch (err) {
      finish({ ok: false, error: (err && err.message) ? String(err.message) : String(err) });
    }
  });
}

// ── API ───────────────────────────────────────────────────────────────────────

async function apiListSessions() {
  try {
    const sessions = await callTool('session_action', { action: 'list' });
    sessionsBanner.style.display = 'none';
    // Ownership is a profiles concern the session tool knows nothing about — resolve the whole list's
    // shared-in owners in one call, exactly as loadFiles() does, so every render can gate on it.
    sessionOwners = {};
    if (profilesActive) {
      try {
        const r = await callTool('share', { action: 'owner', namespace: 'sessions', id: '*' });
        sessionOwners = 'owners' in r ? r.owners : {};
      } catch { sessionOwners = {}; }
    }
    return sessions;
  } catch (e) {
    if (String(e).includes('404')) sessionsBanner.style.display = 'flex';
    return [];
  }
}
// Every trigger for "re-draw the session list" funnels through here, and they coalesce.
//
// `session_action list` is the most expensive call this UI makes: the store has no projection, so
// listing re-reads and JSON-parses every session document in full — whole message histories — to build
// four summary fields per row. It must therefore run once per change, not once per *notice* of a change.
// Before this, deleting a session paid for two: the click handler listed immediately, and the change
// notification listed again ~150ms later, re-rendering a sidebar that had already settled.
//
// A trailing debounce collapses them: the click schedules a run, the notification it causes lands inside
// the window and joins it, and both get the same promise. Nothing depends on the notification arriving —
// the click's own call is what guarantees the refresh — so a disconnected SSE degrades to exactly the
// old behaviour rather than a stale list.
let sessionsRefresh = null;
function refreshSessions(delay = 150) {
  if (sessionsRefresh) return sessionsRefresh;
  sessionsRefresh = new Promise(resolve => {
    setTimeout(async () => {
      sessionsRefresh = null;
      const sessions = await apiListSessions();
      renderSessions(sessions);
      resolve(sessions);
    }, delay);
  });
  return sessionsRefresh;
}

async function apiGetSession(id)  { try { return await callTool('session_action', { action: 'get', sessionId: id }); } catch { return null; } }
async function apiSessionBusy(id) { return T.sessionBusy(id); }
async function apiListProviders() { try { return (await callTool('provider', { action: 'list' })).providers.map(p => p.name); } catch { return []; } }

async function refreshProviderSelect() {
  const current  = providerSel.value;
  const providers = await apiListProviders();
  providerSel.innerHTML = '';
  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = p;
    providerSel.appendChild(opt);
  }
  providerSel.value = providers.includes(current) ? current : (providers[0] ?? '');
  localStorage.setItem(LS_PROVIDER, providerSel.value);
}

// ── Tool API ──────────────────────────────────────────────────────────────────

// Typed against the live `ToolContracts` (see matbot-ui.ts): params are checked against the tool's arms
// and the result narrows to the arm they match, so a panel reading a field the tool no longer returns
// is a compile error here rather than a silently blank row in the browser. Declared as a const bound to
// the transport's own signature rather than re-declared with `@template`: re-instantiating those
// generics per call site asks TS to build the union of every tool's params at once, which it refuses
// (TS2590, "union type too complex"). Borrowing the type instantiates nothing.
/** @type {MatbotTransport['callTool']} */
const callTool = T.callTool.bind(T);

// Join an in-progress server run for sessionId. renderedCount is the number of
// non-system messages already in the DOM so incremental appends start from there.
// If the bottom of messages is not visible in the viewport, transform the
// send button into a ▼ down-arrow that scrolls to bottom on click.
function maybeShowScrollDown() {
  if (sending) return;
  updateScrollDownButton();
}

async function renameSession(id, current) {
  const title = window.prompt('Rename session:', current ?? '');
  if (!title || !title.trim()) return;
  try {
    await callTool('session_action', { action: 'rename', sessionId: id, title: title.trim() });
    if (id === currentSessionId && chatHeaderEl) chatTitleEl.textContent = title.trim();
    refreshSessions();
  } catch (e) { alert('Rename failed: ' + e.message); }
}

// The × on a session. On one you own it hides (archives) it — a write. On one shared IN it must not be a
// write at all: the doc belongs to another partition and is read-only here, so removing it from your view
// is un-sharing it from this profile. (The file list gets there by a different route — its × is a real
// delete, which the profiles backend turns into the same unshare.)
async function hideSession(id) {
  const owner = sessionOwners[id];
  try {
    if (owner != null) await callTool('share', { action: 'unshare', namespace: 'sessions', id, target: currentProfileName() });
    else               await callTool('session_action', { action: 'hide', sessionId: id });
    // Drop the row now rather than after the coalesced list returns: the write has already succeeded,
    // so this is showing the truth early, not guessing. Without it the debounce window would read as lag.
    sessionListEl.querySelector('[data-sid="' + CSS.escape(id) + '"]')?.remove();
    const sessions = await refreshSessions();
    if (id === currentSessionId) {
      currentSessionId = sessions[0]?.id ?? null;
      if (currentSessionId) { await openSession(currentSessionId); return; }
      updateShareBtn();
      showEmpty();
      setBusyState(false);
      if (chatHeaderEl) chatTitleEl.textContent = '';
    }
    renderSessions(sessions);
  } catch (e) { alert((owner != null ? 'Unshare failed: ' : 'Hide failed: ') + e.message); }
}

async function apiNewSession() {
  return T.createSession();
}

// ── Workspace files ───────────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** @param {ToolResult<'workspace_action', { action: 'list' }>} files */
function renderFiles(files) {
  const el = document.getElementById('file-list');
  if (!el) return;
  el.innerHTML = '';
  if (!files || !files.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#9ca3af;font-size:12px;padding:4px 10px;';
    empty.textContent = '(empty)';
    el.appendChild(empty);
    return;
  }
  for (const f of files) {
    // `owner` is '' for the shared base/global partition, a profile id otherwise; absent ⇒ owned here.
    const owner = fileOwners[f.name];
    const sharedBy = owner ? 'shared by "' + owner + '"' : 'shared globally';
    const div = document.createElement('div');
    div.className = 'file-item' + (updatedFiles.has(f.name) ? ' updated' : '') + (owner != null ? ' shared-in' : '');
    div.dataset.name = f.name;
    div.title = f.name + (f.size !== undefined ? ' (' + formatSize(f.size) + ')' : '')
      + (owner != null ? ' — ' + sharedBy + ', read-only here' : '');
    div.onclick = () => {
      updatedFiles.delete(f.name);
      div.classList.remove('updated');
      T.openFile('workspace', f.name);
    };
    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = f.name;
    div.appendChild(nameEl);
    if (f.size !== undefined) {
      const sizeEl = document.createElement('span');
      sizeEl.className = 'file-size';
      sizeEl.textContent = formatSize(f.size);
      div.appendChild(sizeEl);
    }
    // A file shared IN from another profile is read-only here — the backend rejects a write to it. Clicking
    // it opens the raw bytes in a new tab, which can carry no banner of its own, so this row is the only
    // place the state can be read: it gets its own always-visible line (outside the hover-only actions)
    // naming the owner, plus a lock and an accent stripe. The share button is withheld too — you can't
    // re-share what you don't own.
    // Shared-in rows get a real second line holding the badge and the (hover-only) actions, so the
    // actions stay right-aligned beside the owner text instead of wrapping onto a third line.
    const line2 = owner != null ? document.createElement('div') : null;
    if (line2) {
      line2.className = 'file-line2';
      div.appendChild(line2);
    }
    if (owner != null) {
      const badge = document.createElement('span');
      badge.className = 'file-ro-badge';
      badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
      const label = document.createElement('span');
      label.textContent = sharedBy + ' · read-only';
      badge.appendChild(label);
      line2.appendChild(badge);
    }
    const actions = document.createElement('div');
    actions.className = 'file-actions';
    if (profilesActive && owner == null) {
      const shareFileBtn = document.createElement('button');
      shareFileBtn.className = 'file-action-btn file-share-btn';
      shareFileBtn.title = 'Share with another profile';
      shareFileBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>';
      shareFileBtn.onclick = (e) => { e.stopPropagation(); openFileShareMenu(shareFileBtn, f.name); };
      actions.appendChild(shareFileBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.className = 'file-action-btn';
    delBtn.textContent = '\u00d7';
    delBtn.title = owner != null ? 'Remove from my view (unshare)' : 'Delete';
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      try {
        await callTool('workspace_action', { action: 'delete', name: f.name });
        loadFiles();
      } catch (err) {
        alert('Delete failed: ' + err.message);
      }
    };
    actions.appendChild(delBtn);
    (line2 ?? div).appendChild(actions);
    el.appendChild(div);
  }
}

async function loadFiles() {
  try {
    const files = await callTool('workspace_action', { action: 'list' });
    // The workspace tool is profile-agnostic — it lists whatever the routed file store returns (shared-in
    // files included, via symlinks) with no ownership. Ownership is a profiles concern, so ask the `share`
    // tool once for the whole `files` namespace's shared-in owners and gate the per-file UI on it.
    fileOwners = {};
    if (profilesActive) {
      try {
        const r = await callTool('share', { action: 'owner', namespace: 'files', id: '*' });
        fileOwners = 'owners' in r ? r.owners : {};
      } catch { fileOwners = {}; }
    }
    renderFiles(files);
  } catch (e) {
    const msg = String(e);
    if (msg.includes('not found') || msg.includes('404')) {
      const el = document.getElementById('file-list');
      if (el) {
        el.innerHTML = '';
        const prompt = document.createElement('div');
        prompt.className = 'plugin-prompt-banner';
        prompt.style.display = 'block';
        prompt.innerHTML = `Workspace plugin not loaded - workspace file management is unavailable.<button style="display:block;margin:6px 10px;padding:4px 12px;font-size:0.86em;color:#fff;background:#d97706;border:none;border-radius:5px;cursor:pointer;font-family:inherit;font-weight:500;">Enable workspace</button>`;
        const btn = prompt.querySelector('button');
        btn.onmouseover = () => { btn.style.background = '#b45309'; };
        btn.onmouseout  = () => { btn.style.background = '#d97706'; };
        btn.onclick = () => {
          submit('Add the plugin named exactly @matatbread/matbot-tool-workspace to enable file management. First run the plugin discover_local action to check whether it is already available locally and add it from there; only if it is not found locally, install it from npm or github by that exact package name. Do not guess or try other name variations.');
        };
        el.appendChild(prompt);
      }
    } else {
      renderFiles([]);
    }
  }
}

// Per-file share picker — mirrors the session share menu (setupShare) but for the `files` namespace, keyed
// by the file's path (its id). Reuses the shared `#share-menu` element (only one menu is open at a time)
// and its outside-click close, registered once in setupShare; the anchoring button's own click stops
// propagation so opening doesn't immediately re-close. Targets are profiles that isolate `files`.
async function openFileShareMenu(anchor, name) {
  const menu = document.getElementById('share-menu');
  if (!menu) return;
  menu.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'sm-title'; loading.textContent = 'Loading profiles…';
  menu.appendChild(loading);
  const r = anchor.getBoundingClientRect();
  menu.style.left  = 'auto';
  menu.style.right = (window.innerWidth - r.right) + 'px';
  menu.style.top   = (r.bottom + 6) + 'px';
  menu.hidden = false;

  let profiles;
  try { profiles = (await callTool('profile_action', { action: 'list' })).profiles; }
  catch { menu.hidden = true; return; }
  const active = currentProfileName();
  const others = profiles.filter(p => p.name !== active);

  menu.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'sm-title';
  title.textContent = others.length ? 'Share this file with:' : 'No other profiles to share into.';
  menu.appendChild(title);

  // Show every profile (the full list), but a file can only be shared into one that isolates `files` — a
  // profile that doesn't read the shared base area, so there is nothing to share into. Those stay visible
  // but disabled with the reason, rather than being dropped from the list.
  for (const p of others) {
    const canShare = (p.isolated || []).includes('files');
    const item   = document.createElement('div');
    item.className = 'pm-item' + (canShare ? '' : ' pm-disabled');
    const nm     = document.createElement('span'); nm.className = 'pm-name';   nm.textContent = p.name;
    const status = document.createElement('span'); status.className = 'sm-status';
    item.appendChild(nm); item.appendChild(status);
    if (canShare) {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        status.textContent = '…'; item.title = '';
        try {
          await callTool('share', { namespace: 'files', id: name, target: p.name });
          status.textContent = '✓';
        } catch (err) {
          status.textContent = '✗'; item.title = String(err && err.message || err);
        }
      });
    } else {
      status.textContent = '—';
      item.title = 'This profile does not isolate "files" — it reads the shared base files, so there is nothing to share into.';
    }
    menu.appendChild(item);
  }
}

function makePluginLabel(name) {
  const container = document.createElement('span');
  container.className = 'plugin-name-label';
  // Split at the last non-alpha char so the trailing word is always visible.
  const idx = name.search(/[^a-zA-Z][a-zA-Z]+$/);
  const prefix = document.createElement('span');
  prefix.className = 'plugin-name-prefix';
  const suffix = document.createElement('span');
  suffix.className = 'plugin-name-suffix';
  if (idx >= 0) {
    prefix.textContent = name.slice(0, idx + 1); // includes the separator
    suffix.textContent = name.slice(idx + 1);
    container.appendChild(prefix);
    container.appendChild(suffix);
  } else {
    prefix.textContent = name;
    container.appendChild(prefix);
  }
  return container;
}

async function loadPlugins() {
  let listResult;
  try {
    listResult = await callTool('plugin', { action: 'list' });
  } catch {
    return;
  }
  let localResult = [];
  try {
    localResult = await callTool('plugin', { action: 'discover_local' });
  } catch { /* discover_local optional */ }
  // Per-tool trigger counts drive the trigger icon on each tool row (blue = has triggers, grey = none).
  // One `list` call, grouped by invoke.tool. If the triggers plugin isn't loaded the call throws and we
  // pass null, so renderPlugins omits the icon entirely rather than showing an inert one.
  let triggerCounts = null;
  try {
    const tr = await callTool('trigger_action', { action: 'list' });
    triggerCounts = new Map();
    for (const t of (Array.isArray(tr?.triggers) ? tr.triggers : [])) {
      const tool = t?.invoke?.tool;
      if (typeof tool === 'string') triggerCounts.set(tool, (triggerCounts.get(tool) ?? 0) + 1);
    }
  } catch { /* triggers plugin not loaded — no icons */ }
  renderPlugins(listResult.loaded ?? [], Array.isArray(localResult) ? localResult : [], listResult.failed ?? [], triggerCounts);
}

// A plugin can run here only if its declared matbotRuntime includes the host runtime. The transport
// reports it ('node' when served over HTTP, 'browser' for the in-process bundle); default 'node'.
// An absent/empty declaration means "unknown" — allow it (the backend's load/rollback gate is the
// real arbiter; we only suppress installs that are guaranteed to fail).
const HOST_RUNTIME = T.hostRuntime || 'node';
function runsHere(p) {
  const rt = p && p.matbotRuntime;
  if (!Array.isArray(rt) || rt.length === 0) return true;
  return rt.includes(HOST_RUNTIME);
}

function renderPlugins(loaded, local, failed, triggerCounts) {
  const el = document.getElementById('plugin-list');
  if (!el) return;
  el.innerHTML = '';

  const loadedNames = new Set(loaded.map(p => p.name));

  // Configured plugins the loader skipped (bad source, wrong runtime, setup() threw). Graceful failure
  // keeps them out of `loaded`, but not silent: show them with a failed badge and the reason, plus a
  // retry (reload) and a remove action. A fixed + reloaded plugin clears itself off the backend list.
  for (const f of failed || []) {
    const det = document.createElement('details');
    det.className = 'plugin-entry plugin-entry-failed';
    const sum = document.createElement('summary');
    sum.title = f.error || 'Failed to load';
    const main = document.createElement('div');
    main.className = 'plugin-summary-main';
    main.appendChild(makePluginLabel(f.name || f.specifier));
    const badges = document.createElement('div');
    badges.className = 'plugin-badges';
    const badge = document.createElement('span');
    badge.className = 'plugin-badge';
    badge.dataset.type = 'failed';
    badge.textContent = 'failed';
    badges.appendChild(badge);
    main.appendChild(badges);
    sum.appendChild(main);
    const actions = document.createElement('div');
    actions.className = 'plugin-actions';
    const retryBtn = document.createElement('button');
    retryBtn.className = 'plugin-action-btn';
    retryBtn.textContent = '↻';
    retryBtn.title = 'Retry load';
    retryBtn.onclick = (e) => {
      e.stopPropagation();
      closeSidebar();
      submit(`Reload the plugin '${f.specifier}'`);
    };
    const removeBtn = document.createElement('button');
    removeBtn.className = 'plugin-action-btn remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove from configuration';
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      closeSidebar();
      submit(`Remove the plugin '${f.specifier}'`);
    };
    actions.appendChild(retryBtn);
    actions.appendChild(removeBtn);
    sum.appendChild(actions);
    det.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'plugin-tool-list';
    const reason = document.createElement('div');
    reason.className = 'plugin-fail-reason';
    reason.textContent = f.error || 'Failed to load.';
    body.appendChild(reason);
    if (f.name && f.specifier && f.name !== f.specifier) {
      const spec = document.createElement('div');
      spec.className = 'plugin-fail-reason';
      spec.textContent = f.specifier;
      body.appendChild(spec);
    }
    det.appendChild(body);
    el.appendChild(det);
  }

  for (const p of loaded) {
    const det = document.createElement('details');
    det.className = 'plugin-entry';
    const sum = document.createElement('summary');
    if (p.description) sum.title = p.description;
    const main = document.createElement('div');
    main.className = 'plugin-summary-main';
    main.appendChild(makePluginLabel(p.name));
    const types = p.types ?? [];
    if (types.length) {
      const badges = document.createElement('div');
      badges.className = 'plugin-badges';
      for (const ty of types) {
        const isService = ty.startsWith('service:');
        const badge = document.createElement('span');
        badge.className = 'plugin-badge';
        badge.dataset.type = isService ? 'service' : ty;
        badge.textContent = isService ? ty.slice('service:'.length) : ty;
        if (isService) badge.title = ty;
        badges.appendChild(badge);
      }
      main.appendChild(badges);
    }
    sum.appendChild(main);
    if (p.specifier) {
      const actions = document.createElement('div');
      actions.className = 'plugin-actions';
      const removeBtn = document.createElement('button');
      removeBtn.className = 'plugin-action-btn remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove plugin';
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        closeSidebar();
        // Direct submit so it queues during a turn instead of being blocked by the input.
        submit(`Remove the plugin '${p.specifier}'`);
      };
      actions.appendChild(removeBtn);
      sum.appendChild(actions);
    }
    det.appendChild(sum);
    const tools = p.tools ?? [];
    if (tools.length) {
      const toolList = document.createElement('div');
      toolList.className = 'plugin-tool-list';
      for (const t of tools) {
        const name = typeof t === 'string' ? t : t.name;
        const desc = typeof t === 'object' && t !== null ? t.description : undefined;
        const row = document.createElement('div');
        row.className = 'plugin-tool-row';
        const label = document.createElement('span');
        label.className = 'plugin-tool-name';
        label.textContent = name;
        if (desc) label.title = desc;
        row.appendChild(label);
        // The trigger icon is only meaningful when the triggers plugin is loaded (else there's nothing
        // to manage). triggerCounts is null in that case; grey vs. blue is driven by the per-tool count.
        if (triggerCounts) row.appendChild(makeTriggerIcon(name, triggerCounts.get(name) ?? 0));
        toolList.appendChild(row);
      }
      det.appendChild(toolList);
    }
    el.appendChild(det);
  }

  for (const p of local) {
    if (loadedNames.has(p.name)) continue;
    const row = document.createElement('div');
    row.className = 'plugin-entry-inactive';
    // This is the node-hosted web frontend, so a plugin whose declared matbotRuntime excludes 'node'
    // can never activate here. Show it struck-through with no add button rather than offering an
    // install that would only fail (and roll back) on the runtime gate.
    const compatible = runsHere(p);
    if (!compatible) row.classList.add('plugin-incompatible');
    const runtimeNote = !compatible ? `requires runtime: ${(p.matbotRuntime ?? []).join(', ')} — cannot run on this host` : '';
    if (p.description || runtimeNote) row.title = [p.description, runtimeNote].filter(Boolean).join(' — ');
    row.appendChild(makePluginLabel(p.name));
    if (compatible) {
      const actions = document.createElement('div');
      actions.className = 'plugin-actions';
      const addBtn = document.createElement('button');
      addBtn.className = 'plugin-action-btn add';
      addBtn.textContent = '+';
      addBtn.title = 'Add plugin';
      addBtn.onclick = (e) => {
        e.stopPropagation();
        closeSidebar();
        // Direct submit so it queues during a turn instead of being blocked by the input.
        submit(`Add the plugin '${p.specifier}'`);
      };
      actions.appendChild(addBtn);
      row.appendChild(actions);
    }
    el.appendChild(row);
  }

  if (!loaded.length && !local.length && !(failed || []).length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#9ca3af;font-size:12px;padding:4px 10px;';
    empty.textContent = '(none)';
    el.appendChild(empty);
  }
}

// ── Skills ──────────────────────────────────────────────────────────────────

async function loadSkills() {
  let result;
  try {
    result = await callTool('skill_action', { action: 'list' });
  } catch {
    // skills plugin not loaded — leave the section empty.
    renderSkills([]);
    return;
  }
  renderSkills(Array.isArray(result.skills) ? result.skills : []);
}

/** @param {ToolResult<'skill_action', { action: 'list' }>['skills']} skills */
function renderSkills(skills) {
  const el = document.getElementById('skill-list');
  if (!el) return;
  el.innerHTML = '';

  // Visible skills first, hidden (withheld from the model) beneath; alphabetical within each band.
  skills = [...skills].sort((a, b) => {
    const ah = a.hidden ? 1 : 0, bh = b.hidden ? 1 : 0;
    if (ah !== bh) return ah - bh;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  for (const s of skills) {
    const row = document.createElement('div');
    row.className = s.hidden ? 'skill-entry skill-entry-hidden' : 'skill-entry';
    row.onclick = () => openSkillEditor(s.name);

    // Skill names are short phrases, not long unbreakable identifiers — place them
    // plainly rather than reusing the plugin-name prefix/suffix split.
    const label = document.createElement('span');
    label.className = 'skill-name-label';
    label.textContent = s.name;
    row.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'plugin-actions';

    const hideBtn = document.createElement('button');
    hideBtn.className = 'plugin-action-btn';
    hideBtn.textContent = s.hidden ? '⊙' : '⊘';
    hideBtn.title = s.hidden ? 'Unhide skill (restore to the model)' : 'Hide skill (withhold from the model)';
    hideBtn.onclick = async (e) => {
      e.stopPropagation();
      try {
        await callTool('skill_action', { action: s.hidden ? 'unhide' : 'hide', name: s.name });
      } catch (err) {
        alert('Failed to update skill: ' + (err?.message ?? err));
        return;
      }
      loadSkills();
    };
    actions.appendChild(hideBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'plugin-action-btn edit';
    editBtn.textContent = '✎';
    editBtn.title = 'Edit skill';
    editBtn.onclick = (e) => { e.stopPropagation(); openSkillEditor(s.name); };
    actions.appendChild(editBtn);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'plugin-action-btn remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Delete skill';
    removeBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete skill "${s.name}"?`)) return;
      try {
        await callTool('skill_action', { action: 'delete', name: s.name });
      } catch (err) {
        alert('Failed to delete skill: ' + (err?.message ?? err));
        return;
      }
      loadSkills();
    };
    actions.appendChild(removeBtn);

    row.appendChild(actions);
    el.appendChild(row);
  }

  if (!skills.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#9ca3af;font-size:12px;padding:4px 10px;';
    empty.textContent = '(none)';
    el.appendChild(empty);
  }
}

const skillEditorOverlay = document.getElementById('skill-editor-overlay');
const skillEditorText    = document.getElementById('skill-editor-text');
const skillEditorTitle   = document.getElementById('skill-editor-title');
const skillEditorError   = document.getElementById('skill-editor-error');
const skillEditorSave    = document.getElementById('skill-editor-save');
const skillEditorRoot    = document.getElementById('skill-editor');
const skillTriggerList    = document.getElementById('skill-trigger-list');
const skillTriggerSuspend = document.getElementById('skill-trigger-suspend');
const skillTriggerCooldown = document.getElementById('skill-trigger-cooldown');
const TRIGGER_KINDS = ['ephemeral', 'contextual', 'retract', 'followup'];
let editingSkillName = null;
let skillEditor = null;   // TinyMDE.Editor, created lazily on first open
// A skill is fired by one or more Triggers whose invoke is skill_action(use, {name}); their
// `conditions` are what the Triggers tab edits. Multiple such triggers are equivalent to a single
// one holding the union of their conditions (conditions OR within a trigger, triggers OR with each
// other), so the editor flattens them: `editingTriggerId` is the primary trigger we update (null
// when the skill has no trigger yet — created on save if conditions are added) and
// `editingTriggerExtraIds` are any redundant duplicates, removed on save to consolidate.
let editingTriggerId = null;
let editingTriggerExtraIds = [];

function setSkillTab(tab) {
  for (const btn of document.querySelectorAll('.skill-tab')) btn.classList.toggle('active', btn.dataset.tab === tab);
  document.getElementById('skill-editor-pane-content').classList.toggle('active', tab === 'content');
  document.getElementById('skill-editor-pane-triggers').classList.toggle('active', tab === 'triggers');
  document.getElementById('skill-editor-pane-metadata').classList.toggle('active', tab === 'metadata');
  skillEditorRoot.classList.toggle('tab-triggers', tab === 'triggers');
  skillEditorRoot.classList.toggle('tab-metadata', tab === 'metadata');
}

// Render the skill's metadata pane: the "system skill" toggle (always), then the read-only derived
// LLM analysis. `knowledge` is null until the background analysis has run and cached it (see
// SkillManager) — show a note rather than empty sections. `catalogue` is the current advertise flag.
function renderSkillMetadata(catalogue, knowledge) {
  const el = document.getElementById('skill-metadata');
  el.innerHTML = '';

  // System-skill toggle — advertise this skill in the system prompt (using its summary). Independent
  // of whether analysis has run; the editor persists it (with content + triggers) on Save.
  const sysRow = document.createElement('label');
  sysRow.className = 'meta-system';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'skill-system-checkbox';
  cb.checked = catalogue === true;
  const sysLbl = document.createElement('span');
  sysLbl.textContent = 'This is a system skill';
  sysRow.append(cb, sysLbl);
  el.appendChild(sysRow);
  const sysHint = document.createElement('div');
  sysHint.className = 'meta-note';
  sysHint.textContent = 'When set, the skill is advertised in the system prompt using the generated summary below.';
  el.appendChild(sysHint);

  if (!knowledge) {
    const note = document.createElement('div');
    note.className = 'meta-note';
    note.textContent = 'No analysis yet. Metadata (summary, entities, tags, classification) is generated in the background after a skill is saved.';
    el.appendChild(note);
    return;
  }

  const section = (label, build) => {
    const wrap = document.createElement('div');
    wrap.className = 'meta-section';
    const lbl = document.createElement('div');
    lbl.className = 'meta-label';
    lbl.textContent = label;
    wrap.appendChild(lbl);
    wrap.appendChild(build());
    el.appendChild(wrap);
  };

  const chips = (items, cls) => {
    if (!Array.isArray(items) || items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'meta-empty';
      empty.textContent = '(none)';
      return empty;
    }
    const row = document.createElement('div');
    row.className = 'meta-chips';
    for (const item of items) {
      const chip = document.createElement('span');
      chip.className = 'meta-chip ' + cls;
      chip.textContent = item;
      row.appendChild(chip);
    }
    return row;
  };

  section('Summary', () => {
    const p = document.createElement('div');
    if (knowledge.summary) {
      p.className = 'meta-summary';
      p.textContent = knowledge.summary;
    } else {
      p.className = 'meta-empty';
      p.textContent = '(none)';
    }
    return p;
  });
  section('Entities', () => chips(knowledge.entities, 'entity'));
  section('Tags', () => chips(knowledge.tags, 'tag'));

  // Procedural/informational split: two independent 0–1 confidences derived by the analysis pass.
  // The skill compiler gates on these (only a primarily-procedural skill compiles to a tool).
  section('Classification', () => {
    const c = knowledge.classification;
    if (!c || (typeof c.procedural !== 'number' && typeof c.informational !== 'number')) {
      const empty = document.createElement('div');
      empty.className = 'meta-empty';
      empty.textContent = '(none)';
      return empty;
    }
    const bar = (name, value, cls) => {
      const v = typeof value === 'number' ? Math.max(0, Math.min(1, value)) : 0;
      const row = document.createElement('div');
      row.className = 'meta-class-row';
      const label = document.createElement('span');
      label.className = 'meta-class-name';
      label.textContent = name;
      const track = document.createElement('div');
      track.className = 'meta-class-track';
      const fill = document.createElement('div');
      fill.className = 'meta-class-fill ' + cls;
      fill.style.width = (v * 100) + '%';
      track.appendChild(fill);
      const val = document.createElement('span');
      val.className = 'meta-class-val';
      val.textContent = v.toFixed(2);
      row.append(label, track, val);
      return row;
    };
    const wrap = document.createElement('div');
    wrap.append(
      bar('Procedural', c.procedural, 'procedural'),
      bar('Informational', c.informational, 'informational'),
    );
    return wrap;
  });
}

// A trigger's conditions say WHEN it is relevant; its cool-down says how often it may ACT on that —
// a rule can be correctly matched turn after turn while firing every time is a spin rather than a
// service (a critique trigger matches the very response it caused). Two integers, both optional:
// blank is unlimited, which stays the default. Shared by the skill editor and the tool-trigger cards.
function makeCooldownFields(cooldown) {
  const wrap = document.createElement('div');
  wrap.className = 'trigger-cooldown';

  const lbl = document.createElement('div');
  lbl.className = 'tt-field-label';
  lbl.textContent = 'Cool-down — how often it may fire, whatever its conditions judge (blank = no limit)';
  wrap.appendChild(lbl);

  const fields = document.createElement('div');
  fields.className = 'cooldown-fields';
  const field = (cls, text, title, min, value) => {
    const l = document.createElement('label');
    l.title = title;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.step = '1';
    input.className = cls;
    input.placeholder = '∞';
    input.value = Number.isInteger(value) ? String(value) : '';
    const span = document.createElement('span');
    span.textContent = text;
    l.append(input, span);
    fields.appendChild(l);
  };
  // A turn is one genuine user message and everything that follows it — a retract redo or a follow-up
  // robo turn belongs to the turn that caused it, so neither hands the trigger a fresh budget.
  // The two minimums differ because the quantities have opposite polarity: `maxPerTurn` counts
  // PERMITTED fires, so 0 would mean "never fires" — which is the Suspend toggle's job, reached
  // silently through a number box — while `quietTurns` counts BLOCKED turns, where 0 is a plain "no
  // delay" and agrees with blank.
  field('cd-max', 'max fires per turn', 'Most times this trigger may fire within one turn, counting both the user and agent surfaces. Blank for no limit; to stop it firing entirely, suspend it instead.', 1, cooldown?.maxPerTurn);
  field('cd-quiet', 'quiet turns after firing', 'Later turns the trigger is held off for after it fires. 1 = never on consecutive turns; 0 or blank = no delay.', 0, cooldown?.quietTurns);
  wrap.appendChild(fields);
  return wrap;
}

// Read a cool-down back out of `scope`, or null when both fields are blank — null is what
// trigger_action's update takes to clear every limit, so emptying the boxes really does mean
// unlimited rather than "leave whatever was stored". A value that isn't a whole number at or above
// the field's minimum THROWS to the modal's error line: silently treating it as blank would save the
// opposite of what was typed (unlimited), and both save paths already surface a throw.
function readCooldown(scope) {
  const num = (cls, min, label) => {
    const raw = scope.querySelector(cls)?.value.trim() ?? '';
    if (raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) {
      throw new Error(`"${label}" must be a whole number of ${min} or more, or blank for no limit.`);
    }
    return n;
  };
  const maxPerTurn = num('.cd-max', 1, 'max fires per turn');
  const quietTurns = num('.cd-quiet', 0, 'quiet turns after firing');
  if (maxPerTurn === undefined && quietTurns === undefined) return null;
  return {
    ...(maxPerTurn !== undefined ? { maxPerTurn } : {}),
    ...(quietTurns !== undefined ? { quietTurns } : {}),
  };
}

// One condition row: a phase <select> + the rubric <textarea>, both disabled (read-only) until ✎ is
// clicked; × removes the row. New rows (no `c`) start editable. Nothing is persisted until Save,
// which replaces the skill's trigger conditions wholesale (conditions have no stable id).
function makeTriggerRow(c) {
  const editable = !c;
  const row = document.createElement('div');
  row.className = 'trigger-row';

  const sel = document.createElement('select');
  sel.className = 'trigger-kind';
  for (const k of TRIGGER_KINDS) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = { 'ephemeral': 'User Ephemeral', 'contextual': 'User Contextual', 'retract': 'Agent Retract', 'followup': 'Agent Follow-up' }[k];
    sel.appendChild(o);
  }
  // ephemeral/contextual = fire on the user message (route knowledge in for this turn / fold it in
  // durably); retract/followup = fire on the assistant response (discard+redo / keep+steer). Most
  // skill triggers route on user input.
  sel.value = c?.kind ?? 'ephemeral';
  sel.disabled = !editable;

  const txt = document.createElement('textarea');
  txt.className = 'trigger-text';
  txt.rows = 2;
  txt.value = c?.rule ?? '';
  txt.disabled = !editable;
  txt.placeholder = '"MATCH if the message is …; DO NOT MATCH if …" — judged against the latest turn';

  const editBtn = document.createElement('button');
  editBtn.className = 'trigger-edit';
  editBtn.title = 'Edit';
  editBtn.textContent = '✎';
  editBtn.classList.toggle('editing', editable);
  editBtn.onclick = () => {
    const enable = txt.disabled;
    txt.disabled = sel.disabled = !enable;
    editBtn.classList.toggle('editing', enable);
    if (enable) txt.focus();
  };

  const delBtn = document.createElement('button');
  delBtn.className = 'trigger-del';
  delBtn.title = 'Remove';
  delBtn.textContent = '×';
  delBtn.onclick = () => row.remove();

  row.append(sel, txt, editBtn, delBtn);
  return row;
}

function renderTriggers(conditions) {
  skillTriggerList.innerHTML = '';
  for (const c of conditions) skillTriggerList.appendChild(makeTriggerRow(c));
}

// The cool-down belongs to the primary trigger (save consolidates a skill's triggers to one), so the
// editor shows a single control rather than one per flattened condition row.
function renderSkillCooldown(cooldown) {
  if (!skillTriggerCooldown) return;
  skillTriggerCooldown.innerHTML = '';
  skillTriggerCooldown.appendChild(makeCooldownFields(cooldown));
}

// Reflect the suspend toggle: check the box and light up the amber "on" styling. A suspended trigger
// keeps its conditions but is excluded from evaluation (the `disable` action), so it stops firing
// without being deleted — the fix for a trigger that matches too eagerly.
function setTriggerSuspend(suspended) {
  if (!skillTriggerSuspend) return;
  skillTriggerSuspend.checked = suspended;
  skillTriggerSuspend.closest('.trigger-suspend')?.classList.toggle('on', suspended);
}

// Collect the live rows into a `conditions` array and reconcile the skill's load-trigger(s): update
// the primary trigger (or create it if absent) when there are conditions, remove it when the last
// one is cleared, and always drop any redundant duplicates so the skill is left with a single
// trigger. Conditions have no stable id, so this is a wholesale replace, not a per-row diff.
async function saveTriggers(name) {
  const conditions = [];
  for (const row of skillTriggerList.querySelectorAll('.trigger-row')) {
    const kind = row.querySelector('.trigger-kind').value;
    const rule = row.querySelector('.trigger-text').value.trim();
    if (!rule) continue; // an empty row is a no-op, not a delete
    conditions.push({ kind, rule });
  }

  // Consolidate: the editor flattened every matching trigger's conditions into the rows above, so
  // the extras are now redundant — remove them regardless of what happens to the primary.
  for (const id of editingTriggerExtraIds) await callTool('trigger_action', { action: 'remove', id });
  editingTriggerExtraIds = [];

  // null clears every limit — the update action's documented way back to unlimited, since an omitted
  // `cooldown` means "leave the stored one alone".
  const cooldown = skillTriggerCooldown ? readCooldown(skillTriggerCooldown) : null;

  if (editingTriggerId) {
    if (conditions.length) {
      await callTool('trigger_action', { action: 'update', id: editingTriggerId, conditions, cooldown });
    } else {
      await callTool('trigger_action', { action: 'remove', id: editingTriggerId });
      editingTriggerId = null;
    }
  } else if (conditions.length) {
    const res = await callTool('trigger_action', {
      action: 'add', conditions, tool: 'skill_action', params: { action: 'use', name },
      ...(cooldown ? { cooldown } : {}),
    });
    editingTriggerId = res?.id ?? null;
  }

  // Apply the suspend toggle to the reconciled primary trigger. `disable`/`enable` only flip whether
  // the trigger is evaluated — the conditions saved above are untouched — so this is orthogonal to
  // the condition edit. Nothing to suspend if the skill has no trigger (all conditions cleared).
  if (editingTriggerId) {
    await callTool('trigger_action', {
      action: skillTriggerSuspend?.checked ? 'disable' : 'enable', id: editingTriggerId,
    });
  }
}

function ensureSkillEditor() {
  if (!skillEditor) {
    skillEditor = new TinyMDE.Editor({ textarea: skillEditorText });
    new TinyMDE.CommandBar({
      element: 'skill-editor-toolbar',
      editor: skillEditor,
      commands: [
        { name: 'h1', action: 'h1', title: 'Level 1 heading', innerHTML: '<span style="font-size:1.3em;font-weight:700">H</span>' },
        { name: 'h2', action: 'h2', title: 'Level 2 heading', innerHTML: '<span style="font-size:1.05em;font-weight:700">H</span>' },
        { name: 'h3', action: 'h3', title: 'Level 3 heading', innerHTML: '<span style="font-size:0.82em;font-weight:700">H</span>' },
        '|', 'bold', 'italic', 'strikethrough', '|', 'code', 'blockquote', '|', 'ul', 'ol', '|', 'insertLink',
      ],
    });
  }
  return skillEditor;
}

async function openSkillEditor(name) {
  editingSkillName = name;
  skillEditorError.textContent = '';
  skillEditorTitle.textContent = name;
  editingTriggerId = null;
  editingTriggerExtraIds = [];
  renderTriggers([]);
  setTriggerSuspend(false);
  renderSkillCooldown(null);
  renderSkillMetadata(false, null);
  setSkillTab('content');
  skillEditorOverlay.classList.add('open');
  // Triggers live in their own store now, keyed by the tool they invoke — find the one that loads
  // this skill. Independent of the markdown editor, so load it even if TinyMDE is absent.
  callTool('trigger_action', { action: 'query', tool: 'skill_action', params: { action: 'use', name } })
    .then((res) => {
      // A skill may have accreted more than one trigger with this same invoke. They're equivalent to
      // one trigger holding the union of their conditions, so flatten every match into the row list
      // and remember the primary (updated on save) vs. the extras (removed on save to consolidate).
      const trigs = Array.isArray(res?.triggers) ? res.triggers : [];
      editingTriggerId = trigs[0]?.id ?? null;
      editingTriggerExtraIds = trigs.slice(1).map((t) => t.id);
      renderTriggers(trigs.flatMap((t) => (Array.isArray(t.conditions) ? t.conditions : [])));
      // Like the conditions, the primary's cool-down is the one that survives consolidation.
      renderSkillCooldown(trigs[0]?.cooldown ?? null);
      // Suspended only when every trigger firing this skill is disabled — since save consolidates them
      // to one, a mixed state resolves to that single primary's state on the next save anyway.
      setTriggerSuspend(trigs.length > 0 && trigs.every((t) => t.enabled === false));
    })
    .catch(() => { /* triggers plugin not loaded — leave the triggers tab empty. */ });
  // Derived analysis, likewise independent of TinyMDE; absent until the background pass has cached it.
  callTool('skill_action', { action: 'metadata', name })
    .then((meta) => renderSkillMetadata(meta?.catalogue ?? false, meta?.knowledge ?? null))
    .catch(() => { /* old skills plugin without the metadata action — leave the note. */ });
  // The editor needs TinyMDE (CDN, http(s) only). On an offline file:// bundle it never loaded —
  // degrade with a message rather than throwing on `new TinyMDE.Editor`.
  if (typeof TinyMDE === 'undefined') {
    skillEditorError.textContent = 'Markdown editor unavailable offline (TinyMDE failed to load).';
    skillEditorSave.disabled = true;
    return;
  }
  const editor = ensureSkillEditor();
  editor.setContent('Loading…');
  skillEditorSave.disabled = true;
  try {
    const result = await callTool('skill_action', { action: 'load', name });
    editor.setContent(result.content ?? '');
  } catch (err) {
    editor.setContent('');
    skillEditorError.textContent = 'Failed to load: ' + (err?.message ?? err);
  }
  skillEditorSave.disabled = false;
  skillEditorOverlay.querySelector('.TinyMDE')?.focus();
}

function closeSkillEditor() {
  skillEditorOverlay.classList.remove('open');
  editingSkillName = null;
}

if (skillEditorOverlay) {
  skillEditorOverlay.addEventListener('click', (e) => {
    if (e.target === skillEditorOverlay) closeSkillEditor();
  });
  document.getElementById('skill-editor-close').onclick  = closeSkillEditor;
  document.getElementById('skill-editor-cancel').onclick = closeSkillEditor;
  for (const btn of document.querySelectorAll('.skill-tab')) btn.onclick = () => setSkillTab(btn.dataset.tab);
  document.getElementById('skill-trigger-add').onclick = () => {
    const row = makeTriggerRow();
    skillTriggerList.appendChild(row);
    row.querySelector('.trigger-text').focus();
  };
  if (skillTriggerSuspend) skillTriggerSuspend.onchange = () => setTriggerSuspend(skillTriggerSuspend.checked);
  skillEditorSave.onclick = async () => {
    if (editingSkillName === null) return;
    skillEditorSave.disabled = true;
    skillEditorError.textContent = '';
    try {
      if (skillEditor) {
        const sysCb = document.getElementById('skill-system-checkbox');
        await callTool('skill_action', {
          action: 'save', name: editingSkillName, content: skillEditor.getContent(),
          ...(sysCb ? { catalogue: sysCb.checked } : {}),
        });
      }
      await saveTriggers(editingSkillName);
    } catch (err) {
      skillEditorError.textContent = 'Failed to save: ' + (err?.message ?? err);
      skillEditorSave.disabled = false;
      return;
    }
    closeSkillEditor();
    loadSkills();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && skillEditorOverlay.classList.contains('open')) closeSkillEditor();
  });
}

// ── Tool-trigger manager ──────────────────────────────────────────────────────
// The trigger icon on every tool row opens this modal, which lists/edits the triggers that invoke that
// tool (via trigger_action's query/add/update/remove keyed on invoke.tool). A skill's load-trigger is
// edited in the skill editor; this is the general surface for every other tool (and works for those too).

// Material "flash on" bolt — inherits currentColor so the .empty class can grey it out.
const BOLT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21z"/></svg>';

const toolTriggerOverlay = document.getElementById('tool-trigger-overlay');
const toolTriggerTitle   = document.getElementById('tool-trigger-title');
const toolTriggerCards   = document.getElementById('tool-trigger-cards');
const toolTriggerError   = document.getElementById('tool-trigger-error');
const toolTriggerSave    = document.getElementById('tool-trigger-save');
let toolTriggerTool = null;
let toolTriggerOriginals = [];   // triggers as loaded, so save can remove the ones whose card was deleted

function makeTriggerIcon(toolName, count) {
  const btn = document.createElement('button');
  btn.className = count > 0 ? 'tool-trigger-icon' : 'tool-trigger-icon empty';
  btn.innerHTML = BOLT_SVG;
  btn.title = count > 0
    ? `${count} trigger${count === 1 ? '' : 's'} — click to manage`
    : 'No triggers — click to add one';
  // The row is otherwise inert; stop propagation so a future row click handler wouldn't also fire.
  btn.onclick = (e) => { e.stopPropagation(); openToolTriggers(toolName); };
  return btn;
}

// One card = one trigger: its enabled toggle, the params passed to the tool on fire (JSON, since params
// are tool-specific and can't be formed), and its OR-ed conditions (reusing the skill editor's row). A
// card with no id is a new trigger; deleting a card drops the trigger on save.
function makeToolTriggerCard(trigger) {
  const card = document.createElement('div');
  card.className = 'tt-card';
  if (trigger?.id) card.dataset.triggerId = trigger.id;

  const head = document.createElement('div');
  head.className = 'tt-card-head';
  const enabledLbl = document.createElement('label');
  enabledLbl.className = 'tt-enabled';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = trigger ? trigger.enabled !== false : true;
  const enabledTxt = document.createElement('span');
  enabledTxt.textContent = 'Enabled';
  enabledLbl.append(cb, enabledTxt);
  const del = document.createElement('button');
  del.className = 'tt-card-del';
  del.textContent = 'Delete trigger';
  del.title = 'Remove this trigger on Save';
  del.onclick = () => card.remove();
  head.append(enabledLbl, del);
  card.appendChild(head);

  const pLbl = document.createElement('label');
  pLbl.className = 'tt-field-label';
  pLbl.textContent = 'Parameters (JSON) — passed to the tool when it fires';
  const params = document.createElement('textarea');
  params.className = 'tt-params';
  params.rows = 2;
  params.spellcheck = false;
  params.placeholder = '{ } — leave blank for none';
  const p = trigger?.invoke?.params;
  params.value = p !== undefined && p !== null ? JSON.stringify(p, null, 2) : '';
  card.append(pLbl, params);

  const cLbl = document.createElement('label');
  cLbl.className = 'tt-field-label';
  cLbl.textContent = 'Conditions — fire when ANY matches';
  const conds = document.createElement('div');
  conds.className = 'tt-conditions';
  const list = Array.isArray(trigger?.conditions) ? trigger.conditions : [];
  if (list.length) for (const c of list) conds.appendChild(makeTriggerRow(c));
  else conds.appendChild(makeTriggerRow());   // start a new trigger with one editable row
  card.append(cLbl, conds);

  card.appendChild(makeCooldownFields(trigger?.cooldown));

  const addCond = document.createElement('button');
  addCond.className = 'tt-add-cond skill-editor-btn';
  addCond.textContent = '+ Add condition';
  addCond.onclick = () => {
    const row = makeTriggerRow();
    conds.appendChild(row);
    row.querySelector('.trigger-text').focus();
  };
  card.appendChild(addCond);
  return card;
}

async function openToolTriggers(toolName) {
  toolTriggerTool = toolName;
  toolTriggerOriginals = [];
  toolTriggerError.textContent = '';
  toolTriggerTitle.textContent = 'Triggers · ';
  const toolSpan = document.createElement('span');
  toolSpan.className = 'tt-tool';
  toolSpan.textContent = toolName;
  toolTriggerTitle.appendChild(toolSpan);
  toolTriggerCards.innerHTML = '';
  toolTriggerSave.disabled = false;
  toolTriggerOverlay.classList.add('open');
  try {
    const res = await callTool('trigger_action', { action: 'query', tool: toolName });
    const trigs = Array.isArray(res?.triggers) ? res.triggers : [];
    toolTriggerOriginals = trigs;
    if (trigs.length) for (const t of trigs) toolTriggerCards.appendChild(makeToolTriggerCard(t));
    else toolTriggerCards.appendChild(makeToolTriggerCard());   // land ready to author the first one
  } catch (err) {
    toolTriggerError.textContent = 'Failed to load triggers: ' + (err?.message ?? err);
  }
}

// Reconcile the cards against what was loaded: update/add cards that have conditions, remove any original
// whose card was deleted or emptied. Always pass `tool` on update so the invoke is rebuilt — that's how
// clearing the params field clears the stored params (tools.ts rebuilds invoke from tool + params).
async function saveToolTriggers() {
  const keptIds = new Set();
  for (const card of toolTriggerCards.querySelectorAll('.tt-card')) {
    const id = card.dataset.triggerId || null;
    const conditions = [];
    for (const row of card.querySelectorAll('.trigger-row')) {
      const kind = row.querySelector('.trigger-kind').value;
      const rule = row.querySelector('.trigger-text').value.trim();
      if (!rule) continue;   // an empty row is a no-op, not a condition
      conditions.push({ kind, rule });
    }
    const raw = card.querySelector('.tt-params').value.trim();
    let params;
    if (raw) {
      try { params = JSON.parse(raw); }
      catch { throw new Error('Parameters must be valid JSON (or left blank).'); }
    }
    const enabled = card.querySelector('.tt-enabled input').checked;
    // null on update clears every limit, so emptying both boxes means unlimited rather than "leave
    // the stored cool-down alone"; on add there is nothing to clear, so it is simply omitted.
    const cooldown = readCooldown(card);

    if (!conditions.length) continue;   // no conditions ⇒ never fires; not persisted (removed below if it had an id)
    if (id) {
      keptIds.add(id);
      await callTool('trigger_action', {
        action: 'update', id, conditions, tool: toolTriggerTool, enabled, cooldown,
        ...(params !== undefined ? { params } : {}),
      });
    } else {
      await callTool('trigger_action', {
        action: 'add', conditions, tool: toolTriggerTool, enabled,
        ...(params !== undefined ? { params } : {}),
        ...(cooldown ? { cooldown } : {}),
      });
    }
  }
  for (const t of toolTriggerOriginals) {
    if (!keptIds.has(t.id)) await callTool('trigger_action', { action: 'remove', id: t.id });
  }
}

function closeToolTriggers() {
  toolTriggerOverlay.classList.remove('open');
  toolTriggerTool = null;
}

if (toolTriggerOverlay) {
  toolTriggerOverlay.addEventListener('click', (e) => {
    if (e.target === toolTriggerOverlay) closeToolTriggers();
  });
  document.getElementById('tool-trigger-close').onclick  = closeToolTriggers;
  document.getElementById('tool-trigger-cancel').onclick = closeToolTriggers;
  document.getElementById('tool-trigger-add').onclick = () => {
    const card = makeToolTriggerCard();
    toolTriggerCards.appendChild(card);
    card.querySelector('.trigger-text')?.focus();
  };
  toolTriggerSave.onclick = async () => {
    if (toolTriggerTool === null) return;
    toolTriggerSave.disabled = true;
    toolTriggerError.textContent = '';
    try {
      await saveToolTriggers();
    } catch (err) {
      toolTriggerError.textContent = 'Failed to save: ' + (err?.message ?? err);
      toolTriggerSave.disabled = false;
      return;
    }
    closeToolTriggers();
    loadPlugins();   // refresh the icon states (counts changed)
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && toolTriggerOverlay.classList.contains('open')) closeToolTriggers();
  });
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  for (const file of files) {
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const CHUNK = 0x8000;
      let bin = '';
      for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      await callTool('workspace_action', { action: 'write', name: file.name, content: btoa(bin), encoding: 'base64' });
    } catch (err) {
      alert('Upload failed for ' + file.name + ': ' + err.message);
    }
  }
  loadFiles();
}

// ── DOM builders ──────────────────────────────────────────────────────────────

function makeThinkingBlock(label, openByDefault) {
  const details = document.createElement('details');
  details.className = 'thinking-block';
  if (openByDefault) details.open = true;
  const summary = document.createElement('summary');
  summary.className = 'thinking-summary';
  summary.textContent = label;
  const content = document.createElement('div');
  content.className = 'thinking-content';
  details.appendChild(summary);
  details.appendChild(content);
  return { details, content };
}

function makeToolBlock(name, input, callId) {
  const det = document.createElement('details');
  det.className = 'tool-block';
  if (callId) det.dataset.callId = callId;
  const sum = document.createElement('summary');
  sum.className = 'tool-header';
  sum.textContent = '\u2699 ' + name;
  det.appendChild(sum);
  const inputStr = input !== undefined && input !== null
    ? (typeof input === 'string' ? input : JSON.stringify(input, null, 2))
    : '';
  if (inputStr && inputStr !== '{}') {
    const pre = document.createElement('pre');
    pre.className = 'tool-args';
    pre.textContent = inputStr;
    det.appendChild(pre);
  }
  return det;
}

function makeToolResultBlock(result, isError) {
  const wrap = document.createElement('div');
  wrap.className = 'tool-result' + (isError ? ' tool-result-error' : '');
  const icon = document.createElement('span');
  icon.className = 'tool-result-icon';
  icon.textContent = isError ? '\u2717' : '\u2713';
  const pre = document.createElement('pre');
  pre.className = 'tool-result-text';
  const s = result === null || result === undefined ? ''
    : typeof result === 'string' ? result
    : JSON.stringify(result, null, 2);
  pre.textContent = s.length > 2000 ? s.slice(0, 2000) + '\n[\u2026 truncated]' : s;
  wrap.appendChild(icon);
  wrap.appendChild(pre);
  return wrap;
}

// Aggregate the token accounting persisted on a session's messages, keyed by the provider billed.
// Accounting entries are anchored on turn heads and are self-describing (each names the turn that
// caused it and the site that produced it), so this filters on the ENTRY's traceId rather than the
// message's: a completion recorded after its turn committed \u2014 a detached trigger classifier, a
// followup hook \u2014 is flushed later and can land on a message belonging to a different turn.
// Mirrors core's usageEntries/usageByProvider; the static client can't import core, so it reduces
// inline. Tolerates sessions written before accounting moved onto the turn head.
function turnActivity(messages) {
  const out = [];
  for (const m of (messages || [])) {
    if (Array.isArray(m.activity)) out.push(...m.activity);
    // Sessions written before accounting moved onto the turn head.
    else if (m.usage && m.providerName) out.push({ kind: 'call', provider: m.providerName, usage: m.usage, traceId: m.traceId });
    for (const c of (m.content || [])) {
      if (c && c.type === 'tool-result' && Array.isArray(c.usage)) {
        for (const r of c.usage) out.push({ kind: 'call', ...r });
      }
    }
  }
  return out;
}

function usageEntries(messages) {
  return turnActivity(messages).filter(e => e.kind === 'call');
}

function usageByProvider(messages, traceId) {
  const map = new Map();
  for (const e of usageEntries(messages)) {
    if (traceId && e.traceId !== traceId) continue;
    const u = e.usage;
    if (!e.provider || !u) continue;
    const cur = map.get(e.provider) || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    cur.inputTokens         += u.inputTokens         || 0;
    cur.outputTokens        += u.outputTokens        || 0;
    cur.cacheReadTokens     += u.cacheReadTokens     || 0;
    cur.cacheCreationTokens += u.cacheCreationTokens || 0;
    map.set(e.provider, cur);
  }
  return [...map].map(([provider, usage]) => ({ provider, usage }));
}

// The turn's wall-clock time: the createdAt of its last message. Messages only acquire a timestamp when
// the pump commits them, so this reads the persisted session (the `done` event's copy, or the reload) —
// never the live delta, which carries none.
// `traceId` undefined ⇒ the last timestamp in the list given, whatever its trace. A visible turn can
// span two traceIds (a retract-and-rerun answers under a fresh one), so the caller slices the span and
// asks for its end rather than naming a trace.
function turnTimestamp(messages, traceId) {
  let at;
  for (const m of (messages || [])) {
    if ((traceId === undefined || m.traceId === traceId) && m.createdAt) at = m.createdAt;
  }
  return at;
}

// Same-day turns show just the clock; older ones need the date to be worth reading at all.
function formatTurnTime(at) {
  const d = new Date(at);
  if (isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const now  = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + time;
}

// The turn's footer: per-provider usage (eliding any zero count) with the turn's time trailing the
// summary. `perProvider` is the output of usageByProvider; with no usage the footer degrades to the
// bare time, so a turn whose provider reported nothing still gets one. Both empty ⇒ null (caller skips).
function makeTurnFooter(perProvider, at) {
  if (!perProvider.length && !at) return null;
  const det = document.createElement('details');
  det.className = 'token-stats';
  const sum = document.createElement('summary');
  sum.appendChild(document.createTextNode('tokens'));
  const timeEl = document.createElement('span');
  timeEl.className = 'turn-time';
  sum.appendChild(timeEl);
  det.appendChild(sum);
  const body = document.createElement('div');
  body.className = 'token-stats-body';
  det.appendChild(body);
  fillTurnFooter(det, perProvider, at);
  return det;
}

// Fill an existing footer in place. Separate from building it because a turn's numbers arrive AFTER the
// footer is drawn \u2014 accounting is flushed when the queue drains, which is later than `done` \u2014 and the
// footer must not visibly change shape when they land. Swapping the element (or, as this did before,
// swapping a bare-time `div` for a `details`) moves the timestamp and restyles it, so the turn twitches
// a second after it finishes. Only the rows and the time text change here; the shell, its classes and
// its open state are untouched.
function fillTurnFooter(det, perProvider, at) {
  const timeEl = det.querySelector(':scope > summary > .turn-time');
  if (timeEl) {
    timeEl.textContent = at ? formatTurnTime(at) : '';
    if (at) timeEl.title = new Date(at).toLocaleString();
  }
  // A footer with nothing in it yet still occupies its final shape; the class is a styling hook only,
  // and must not be used to change the layout, or filling it would move things again.
  det.classList.toggle('is-empty', !perProvider.length);

  const body = det.querySelector(':scope > .token-stats-body');
  if (!body) return;
  body.textContent = '';
  const s = (t, cls) => { const el = document.createElement('span'); if (cls) el.className = cls; el.textContent = t; return el; };
  for (const { provider, usage } of perProvider) {
    const row = document.createElement('div');
    row.className = 'token-stats-row';
    if (perProvider.length > 1) row.appendChild(s(provider, 'token-stats-provider'));
    if (usage.inputTokens > 0) {
      let inLabel = '\u2191 ' + usage.inputTokens.toLocaleString() + ' in';
      if (usage.cacheReadTokens > 0) inLabel += ' (' + usage.cacheReadTokens.toLocaleString() + ' cached)';
      row.appendChild(s(inLabel));
    }
    if (usage.outputTokens > 0)        row.appendChild(s('\u2193 ' + usage.outputTokens.toLocaleString() + ' out'));
    if (usage.cacheCreationTokens > 0) row.appendChild(s('\u2601 ' + usage.cacheCreationTokens.toLocaleString() + ' written'));
    body.appendChild(row);
  }
}

// Attach the footer to each turn already rendered into the DOM, exactly as the live `done` path does —
// appended to the turn's last assistant wrap (the turn's bottom). Used on reload, so historical turns show
// the same accounting as if they had just streamed.
//
// `replace` REBUILDS a footer that is already there, rather than skipping it, and creates none. That is
// not a refinement, and the asymmetry is the point:
//
//   - rebuilding is required because accounting is flushed when the pump's queue drains, which is after
//     the `done` that drew the footer, so the live footer is necessarily built before the numbers exist;
//   - creating nothing is what makes the refresh safe to run on ANY session write. A turn writes the
//     session several times before it ends (persist-at-turn-start, the end-of-turn commit), and an
//     in-flight turn has no footer yet — so it is left alone, rather than having one painted into a wrap
//     that is still streaming, which lands the tokens above text the turn has yet to render.
//
// The presence of a footer therefore *is* the "this turn has finished" signal, already maintained by the
// two paths that draw it. No timing assumption is needed, and none would be sound: the runner clears its
// busy flag before awaiting the flush, so an observer can be told a session is idle while the write is
// still in flight.
// Footers are drawn per VISIBLE turn — a user message and everything up to the next one — not per
// traceId. The two are usually the same and diverge exactly where it matters: a retract-and-rerun
// answers a user turn under a *fresh* traceId, so the turn the reader sees spans two of them, with the
// accounting on the first and the surviving answer on the second. Keying on traceId drew a footer for a
// turn with no answer left (nowhere to put it) and a second, empty one under the answer.
function applyTurnUsageBlocks(messages, replace) {
  const msgs = messages || [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'user') continue;
    let end = i + 1;
    while (end < msgs.length && msgs[end].role !== 'user') end++;
    const span = msgs.slice(i, end);

    // Everything anchored on this head, whichever traceId within the span produced it.
    const entries = (msgs[i].activity || []).length
      ? usageByProvider([msgs[i]])
      : usageByProvider(span, msgs[i].traceId);        // sessions written before the move
    const at = turnTimestamp(span, undefined);
    if (!entries.length && !at) continue;

    // Any wrap belonging to any trace in the span — the answer may carry the redo's traceId.
    const traces = [...new Set(span.map(m => m.traceId).filter(Boolean))];
    const wraps  = traces.flatMap(t =>
      [...messagesEl.querySelectorAll('.message.assistant[data-trace="' + t + '"]')]);
    if (wraps.length === 0) continue;
    // Search ALL of the span's wraps for an existing footer, not just the last: the live path appends
    // to whichever wrap was current at `done`, and a turn can acquire further wraps afterwards (a
    // marker, a robo message). Matching only the last appends a second footer instead of replacing the
    // first, which shows up as a turn with two timestamps.
    const existing = wraps.map(w => w.querySelector(':scope > .token-stats')).find(Boolean);
    if (existing) {
      // Fill in place — never swap the element. The open state survives for free, and nothing moves.
      if (replace) fillTurnFooter(existing, entries, at);
      continue;
    }
    if (replace) continue;                       // an unfinished turn: leave it to `done` to draw
    const footer = makeTurnFooter(entries, at);
    if (!footer) continue;
    // Last in DOM order, which `traces` order does not guarantee.
    wraps.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    wraps[wraps.length - 1].appendChild(footer);
  }
}

// Re-read the open session and rebuild its turn footers — nothing else, so scroll position, open
// thinking blocks and streamed DOM all survive.
//
// This is how accounting reaches a live turn at all: it is flushed when the pump's queue drains, which
// is necessarily after the `done` that drew the footer, because a turn's spend is not final at its own
// end (a followup hook runs post-commit, a detached classifier settles whenever it settles).
//
// Driven by the session write itself, which needs no timing assumption because this only ever REPLACES
// an existing footer (see `applyTurnUsageBlocks`): an in-flight turn has none, so a mid-turn write
// leaves it alone, and the flush's own write is what fills in the numbers. Deliberately not keyed on the
// busy→idle transition — the runner clears its busy flag before awaiting the flush, so idle can be
// broadcast while the write is still in flight, and there would be no second transition to recover on.
//
// `seq` guards ordering rather than a timer: two reads in flight can settle out of order and paint an
// older session over a newer one, and only the last read issued is allowed to paint.
let footerSeq = 0;
async function refreshTurnFooters() {
  const id = currentSessionId;
  if (!id) return;
  const seq = ++footerSeq;
  const session = await apiGetSession(id);
  if (seq !== footerSeq) return;                            // a later read already landed
  if (!session || session.id !== currentSessionId) return;  // or the reader moved on
  applyTurnUsageBlocks(session.messages, true);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function showEmpty() {
  messagesEl.innerHTML =
    '<div class=\"empty-state\">' +
    '<strong>Start a conversation</strong>' +
    '<span>Type a message below to begin.</span>' +
    '</div>';
}

/** @param {ToolResult<'session_action', { action: 'list' }>} sessions */
function renderSessions(sessions) {
  sessionListEl.innerHTML = '';
  for (const s of sessions) {
    const label = (s.title || s.preview || s.id.slice(0, 8)).slice(0, 44);
    const el = document.createElement('div');
    el.className = 'session-item' +
      (s.id === currentSessionId ? ' active' : '') +
      (busySessions.has(s.id) ? ' busy' : '') +
      (!busySessions.has(s.id) && s.id !== currentSessionId && unreadSessions.has(s.id) ? ' unread' : '');
    el.dataset.sid = s.id;

    const labelEl = document.createElement('span');
    labelEl.className = 'session-label';
    labelEl.textContent = label;
    labelEl.title = label;
    labelEl.onclick = () => openSession(s.id);

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'session-action-btn';
    renameBtn.textContent = '\u2710';
    renameBtn.title = 'Rename';
    renameBtn.onclick = e => { e.stopPropagation(); renameSession(s.id, s.title || ''); };

    const owner = sessionOwners[s.id];
    const hideBtn = document.createElement('button');
    hideBtn.className = 'session-action-btn';
    hideBtn.textContent = '\u00d7';
    hideBtn.title = owner != null ? 'Remove from my view (unshare)' : 'Hide';
    hideBtn.onclick = e => { e.stopPropagation(); hideSession(s.id); };

    if (owner == null) actions.appendChild(renameBtn);   // rename is a write — refused on a shared-in session
    actions.appendChild(hideBtn);
    el.appendChild(labelEl);
    el.appendChild(actions);
    sessionListEl.appendChild(el);
  }
}

function makeBubble(className, text) {
  const div = document.createElement('div');
  div.className = 'message ' + className;
  const inner = document.createElement('div');
  inner.className = 'md-body';
  inner.innerHTML = md(text);
  div.appendChild(inner);
  return div;
}

// Scroll the latest message into view (e.g. the user just sent it). Respect the suppression timer
// in case they scrolled away earlier.
function scrollMessagesToBottom() {
  if (!isScrollSuppressed()) {
    programmaticScrollTo(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }
}

function appendUserBubble(text, msgIdx, pending, traceId) {
  messagesEl.querySelector('.empty-state')?.remove();
  if (messagesEl.querySelector('.message')) {
    messagesEl.appendChild(createMsgDivider(msgIdx));
  }
  const div = makeBubble('user' + (pending ? ' pending' : ''), text);
  if (traceId) div.dataset.trace = traceId;
  messagesEl.appendChild(div);
  scrollMessagesToBottom();
  return div;
}

// A machine-authored turn (a followup resubmission). Presented agent-side with the robot badge.
function appendRoboBubble(text, msgIdx, traceId) {
  messagesEl.querySelector('.empty-state')?.remove();
  if (messagesEl.querySelector('.message')) {
    messagesEl.appendChild(createMsgDivider(msgIdx));
  }
  const div = makeBubble('robo', text);
  if (traceId) div.dataset.trace = traceId;
  messagesEl.appendChild(div);
  scrollMessagesToBottom();
  return div;
}

// Render one stored user turn, split by block provenance: contiguous human blocks render as the user
// bubble, contiguous robo blocks (a hook-injected fragment) as an agent-side robo bubble. One stored
// message can therefore become two bubbles, under a single turn divider. Returns the last bubble.
function appendUserTurn(content, msgIdx, traceId) {
  const runs = [];
  for (const c of content) {
    if (c.type !== 'text' || !c.text) continue;
    const robo = c.origin === 'robo';
    const prev = runs[runs.length - 1];
    if (prev && prev.robo === robo) prev.text += '\n' + c.text;
    else runs.push({ robo, text: c.text });
  }
  if (!runs.length) return null;
  messagesEl.querySelector('.empty-state')?.remove();
  if (messagesEl.querySelector('.message')) {
    messagesEl.appendChild(createMsgDivider(msgIdx));
  }
  let last = null;
  for (const run of runs) {
    last = makeBubble(run.robo ? 'robo' : 'user', run.text);
    // Tag with the turn's traceId so a replayed `queued` for this still-running turn adopts the
    // existing bubble (renderTurn) instead of drawing a second one.
    if (traceId) last.dataset.trace = traceId;
    messagesEl.appendChild(last);
  }
  scrollMessagesToBottom();
  return last;
}

function createMsgDivider(msgIdx) {
  const div = document.createElement('div');
  div.className = 'msg-divider';
  if (msgIdx !== undefined) div.dataset.msgIdx = msgIdx;

  const line = document.createElement('div');
  line.className = 'msg-divider-line';
  div.appendChild(line);

  const menu = document.createElement('div');
  menu.className = 'msg-divider-menu';
  for (const [icon, label, action, danger] of /** @type {[string, string, string, boolean][]} */ ([
    ['🔗', 'Copy link', 'copy-link', false],
    ['✂',  'Cut',             'cut',       true],
    ['⎇',  'Fork',            'fork',      false],
    ['🗜', 'Compact',   'compact',   true],
    ['⇉',  'Split',          'split',      false],
  ])) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-divider-btn' + (danger ? ' danger' : '');
    const iconSpan = document.createElement('span');
    iconSpan.className = 'msg-divider-btn-icon';
    iconSpan.textContent = icon;
    const labelSpan = document.createElement('span');
    labelSpan.className = 'msg-divider-btn-label';
    labelSpan.textContent = label;
    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);
    btn.addEventListener('click', (e) => { e.stopPropagation(); handleDividerAction(div, action); });
    menu.appendChild(btn);
  }
  div.appendChild(menu);

  div.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.msg-divider.open').forEach(d => { if (d !== div) d.classList.remove('open'); });
    div.classList.toggle('open');
  });

  return div;
}

async function handleDividerAction(divider, action) {
  divider.classList.remove('open');
  const msgIdx = divider.dataset.msgIdx !== undefined ? parseInt(divider.dataset.msgIdx) : undefined;

  if (action === 'copy-link') {
    const hash = currentSessionId + (msgIdx !== undefined ? '~' + JSON.stringify({ msg: msgIdx }) : '');
    const url = location.origin + location.pathname + '#' + hash;
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(url); copied = true; } catch { /* denied */ }
    }
    if (!copied) {
      // Fallback for plain-HTTP contexts where clipboard API is unavailable.
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { copied = document.execCommand('copy'); } catch { /* */ }
      ta.remove();
    }
    if (copied) {
      const line = divider.querySelector('.msg-divider-line');
      if (line) {
        line.style.cssText = 'background:#6366f1;transition:none';
        setTimeout(() => { line.style.cssText = ''; }, 600);
      }
    } else {
      prompt('Copy this link:', url);
    }
    return;
  }

  if (!currentSessionId || msgIdx === undefined) return;

  try {
    if (action === 'fork') {
      const result = await callTool('session_edit', { action: 'fork', sessionId: currentSessionId, msgIndex: msgIdx });
      if (result?.newSessionId) {
        await openSession(result.newSessionId);
        refreshSessions();
      }
    } else if (action === 'cut') {
      if (!confirm('Delete all messages from this point forward?')) return;
      await callTool('session_edit', { action: 'cut', sessionId: currentSessionId, msgIndex: msgIdx });
      const session = await apiGetSession(currentSessionId);
      if (session) renderSession(session);
    } else if (action === 'split') {
      if (!confirm('Split session at this point? Messages before will be moved to a new session.')) return;
      const result = await callTool('session_edit', { action: 'split', sessionId: currentSessionId, msgIndex: msgIdx });
      // `deferred` is the running turn's own session; this endpoint runs outside any turn (a stub
      // ctx.session), so the edit is always applied inline here and the ids are present.
      if (result && 'newSessionId' in result) {
        // Navigate to the current (trimmed) session
        await openSession(result.currentSessionId);
        refreshSessions();
      }
    } else if (action === 'compact') {
      if (!confirm('Strip thinking blocks and tool calls from messages before this point?')) return;
      await callTool('session_edit', { action: 'compact', sessionId: currentSessionId, msgIndex: msgIdx });
      const session = await apiGetSession(currentSessionId);
      if (session) renderSession(session);
    }
  } catch (e) {
    if (String(e).includes('404')) {
      showEditSessionBanner();
    } else {
      alert(action + ' failed: ' + e.message);
    }
  }
}

function showEditSessionBanner() {
  if (document.getElementById('edit-session-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'edit-session-banner';
  banner.className = 'plugin-prompt-banner';
  banner.style.display = 'flex';
  const span = document.createElement('span');
  span.textContent = 'edit-session plugin not loaded — Cut, Fork, Split, and Compact are unavailable.';
  banner.appendChild(span);
  const btn = document.createElement('button');
  btn.textContent = 'Install edit-session';
  btn.onclick = () => {
    banner.remove();
    submit('Add the plugin named exactly @matatbread/matbot-edit-session, which enables Cut, Fork, Split, and Compact. First run the plugin discover_local action to check whether it is already available locally and add it from there; only if it is not found locally, install it from npm or github by that exact package name. Do not guess or try other name variations.');
  };
  banner.appendChild(btn);
  const inputArea = document.getElementById('input-area');
  inputArea?.parentElement?.insertBefore(banner, inputArea);
}

function flashMessage(el) {
  if (!el) return;
  el.classList.remove('msg-nav-flash');
  void el.offsetWidth; // force reflow to restart animation if already flashing
  el.classList.add('msg-nav-flash');
  setTimeout(() => el.classList.remove('msg-nav-flash'), 1200);
}

function scrollToMsgIdx(msgIdx) {
  // rAF defers until after the browser has laid out the newly-rendered messages.
  requestAnimationFrame(() => {
    const divider = messagesEl.querySelector(`.msg-divider[data-msg-idx="${msgIdx}"]`);
    const target = divider?.nextElementSibling;
    if (!target) return;
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
    flashMessage(target);
  });
}

// anchorAfter: insert the wrap immediately after this node (its turn's user bubble) rather than at
// the container tail. Live, several submissions can be queued — and their user bubbles drawn — before
// any response streams; appending each response at the tail would group all bubbles then all
// responses. Anchoring each turn's wrap to its own user bubble keeps responses interleaved, matching
// the reload (renderSession) order. A joined in-progress turn has no user bubble (it's in committed
// history); passing nothing falls back to tail-append, which is correct there.
function createAssistantWrap(labelText, anchorAfter) {
  messagesEl.querySelector('.empty-state')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'message assistant';
  // Not sure we like the label in the UI — it takes up space and is redundant with the robot badge. Keep it commented out for now.
  // const label = document.createElement('div');
  // label.className = 'msg-label';
  // label.textContent = labelText || 'assistant';
  // wrap.appendChild(label);
  if (anchorAfter && anchorAfter.parentNode === messagesEl) {
    messagesEl.insertBefore(wrap, anchorAfter.nextSibling);
  } else {
    messagesEl.appendChild(wrap);
  }
  return wrap;
}

// Render marker blocks as centered cross-thread notices. Markers are opaque to the LLM; the UI
// is free to interpret known creators. Unknown creators get a generic, non-navigating chip.
function appendMarker(content, traceId) {
  messagesEl.querySelector('.empty-state')?.remove();
  for (const part of content) {
    if (part.type !== 'marker') continue;
    // A retraction supersedes the turn's original response: drop that response from the live view so
    // the thread matches what a refresh shows (the original is popped from the session and survives
    // only inside this marker). Idempotent — a no-op on reload, where the original was never rendered
    // (renderSession doesn't tag assistant wraps with a traceId).
    if (part.creator === 'matbot-retraction' && traceId) {
      messagesEl.querySelectorAll(`.message.assistant[data-trace="${traceId}"]`).forEach(el => el.remove());
    }
    messagesEl.appendChild(renderMarker(part));
  }
}

function renderMarker(part) {
  const note = document.createElement('div');
  note.className = 'marker-note';
  const data = part.data || {};

  const EDIT_SESSION_RELATIONS = {
    'continued-in': { icon: '↪', text: 'Conversation continued in another thread' },
    'split-from':   { icon: '↩', text: 'Earlier messages split to another thread' },
    'forked-from':  { icon: '⎇', text: 'Forked from another thread' },
  };
  const rel = EDIT_SESSION_RELATIONS[data.relation];
  if (part.creator === '@matatbread/matbot-edit-session' && data.peerSessionId && rel) {
    const icon = document.createElement('span');
    icon.className = 'marker-icon';
    icon.textContent = rel.icon;
    note.appendChild(icon);
    const text = document.createElement('span');
    text.textContent = rel.text;
    note.appendChild(text);
    const link = document.createElement('a');
    const hasTarget = typeof data.targetMsg === 'number';
    link.href = '#' + data.peerSessionId + (hasTarget ? '~' + JSON.stringify({ msg: data.targetMsg }) : '');
    link.textContent = 'Open →';
    link.addEventListener('click', (e) => { e.preventDefault(); openSession(data.peerSessionId, hasTarget ? data.targetMsg : undefined); });
    note.appendChild(link);
    return note;
  }

  // A retract-and-rerun: show a collapsed, thinking-styled block titled "Retraction" holding ONLY the
  // final text of the superseded response (no thinking/tool blocks). The response itself was removed
  // from the thread (see appendMarker), so this is the sole, de-emphasised trace of what was said.
  if (part.creator === 'matbot-retraction') {
    const retracted = Array.isArray(data.retracted) ? data.retracted : [];
    const text = retracted
      .flatMap(m => (m.content || []).filter(c => c.type === 'text').map(c => c.text))
      .join('\n\n').trim();
    const wrap = document.createElement('div');
    wrap.className = 'message assistant marker-block retraction';
    const { details, content: body } = makeThinkingBlock('↩️ Retraction', false);
    details.classList.add('retraction-block');
    body.classList.add('md-body');
    body.style.whiteSpace = 'normal';   // thinking-content defaults to pre-wrap; rendered markdown needs normal flow
    body.innerHTML = md(text || '_(no text content)_');
    wrap.appendChild(details);
    return wrap;
  }

  // A hook threw and was skipped — surface it as a warning so a misconfigured hook (e.g. a provider
  // with an unresolved secret) is visible rather than silently degrading.
  if (part.creator === 'matbot-hooks') {
    note.classList.add('marker-warn');
    const icon = document.createElement('span');
    icon.className = 'marker-icon';
    icon.textContent = '⚠️';
    note.appendChild(icon);
    const text = document.createElement('span');
    const who = data.pluginName ? ` (${data.pluginName})` : '';
    text.textContent = `A ${data.channel || 'hook'} hook${who} failed and was skipped: ${data.message || 'unknown error'}`;
    note.appendChild(text);
    return note;
  }

  // Everything else: render like a tool block — a collapsible whose title is the creator and whose
  // body is the marker's JSON data. Generic, so any creator (remember_fact, triggers, future ones)
  // gets a useful surface with no per-creator UI. Wrapped in an assistant-style container so it
  // inherits the same width/alignment a tool block has *inside a turn* — a bare .tool-block dropped
  // at the message-list top level full-bleeds and its overflow:hidden clips the content. The
  // `marker-block` class on the wrapper makes it easy to restyle or suppress later.
  const wrap = document.createElement('div');
  wrap.className = 'message assistant marker-block';
  const det = document.createElement('details');
  det.className = 'tool-block';
  const sum = document.createElement('summary');
  sum.className = 'tool-header';
  sum.textContent = String.fromCodePoint(0x1F4CC) + ' ' + part.creator;
  det.appendChild(sum);
  const pre = document.createElement('pre');
  pre.className = 'tool-args';
  pre.textContent = JSON.stringify(data, null, 2);
  det.appendChild(pre);
  wrap.appendChild(det);
  return wrap;
}

// Populate a wrapper from historical message content parts
function renderContentParts(wrap, content) {
  for (const part of content) {
    switch (part.type) {
      case 'text': {
        if (!part.text) break;
        const div = document.createElement('div');
        div.className = 'msg-text md-body';
        div.innerHTML = md(part.text);
        wrap.appendChild(div);
        break;
      }
      case 'thinking': {
        const { details, content: c } = makeThinkingBlock('\ud83d\udcad Thinking', false);
        c.textContent = part.thinking || '';
        wrap.appendChild(details);
        break;
      }
      case 'reasoning': {
        const { details, content: c } = makeThinkingBlock('\ud83d\udcad Reasoning', false);
        c.textContent = part.reasoning || '';
        wrap.appendChild(details);
        break;
      }
      case 'redacted-thinking': {
        const div = document.createElement('div');
        div.className = 'thinking-redacted';
        div.textContent = '\ud83d\udcad Thinking (redacted)';
        wrap.appendChild(div);
        break;
      }
      case 'tool-call':
        wrap.appendChild(makeToolBlock(part.name, part.input, part.id));
        break;
      case 'tool-result': {
        const toolBlock = part.id ? messagesEl.querySelector('[data-call-id="' + part.id + '"]') : null;
        if (toolBlock) {
          toolBlock.appendChild(makeToolResultBlock(part.result, part.isError));
        } else {
          wrap.appendChild(makeToolResultBlock(part.result, part.isError));
        }
        break;
      }
      case 'refusal': {
        const div = document.createElement('div');
        div.className = 'msg-refusal';
        div.textContent = part.text;
        wrap.appendChild(div);
        break;
      }
      case 'form': {
        const block = document.createElement('div');
        block.className = 'form-block';
        const inputs = {};
        for (const field of part.fields) {
          const labelEl = document.createElement('div');
          labelEl.className = 'form-field-label';
          labelEl.textContent = field.label;
          block.appendChild(labelEl);
          if (field.type === 'select') {
            const sel = document.createElement('select');
            sel.className = 'form-select';
            sel.name = field.name;
            for (const opt of field.options ?? []) {
              const o = document.createElement('option');
              o.value = o.textContent = opt;
              sel.appendChild(o);
            }
            if (field.default) sel.value = field.default;
            inputs[field.name] = sel;
            block.appendChild(sel);
          } else {
            const inp = document.createElement('input');
            inp.type = field.type === 'password' ? 'password' : 'text';
            inp.className = 'form-text-input';
            inp.name = field.name;
            inp.value = field.default ?? '';
            inputs[field.name] = inp;
            block.appendChild(inp);
          }
        }
        const actions = document.createElement('div');
        actions.className = 'form-actions';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'form-submit-btn';
        btn.textContent = part.submitLabel ?? 'Submit';
        btn.onclick = () => {
          const values = {};
          for (const [name, el] of Object.entries(inputs)) values[name] = el.value;
          btn.disabled = true;
          Object.values(inputs).forEach(el => { el.disabled = true; });
          block.closest('.message')?.remove();
          submitFormResponse(currentSessionId, values);
        };
        actions.appendChild(btn);
        block.appendChild(actions);
        wrap.appendChild(block);
        break;
      }
      default: {
        const div = document.createElement('div');
        div.className = 'msg-text';
        div.textContent = JSON.stringify(part);
        wrap.appendChild(div);
        break;
      }
    }
  }
}

// startIdx > 0 appends only messages from that index — used for incremental updates.
// origIdx (index in session.messages including system) is passed to dividers so
// the edit-session plugin tools can reference exact positions.
function renderSession(session, startIdx, scrollTarget) {
  const allMsgs = session.messages;
  if (!startIdx) {
    if (!allMsgs.some(m => m.role !== 'system')) { showEmpty(); return; }
    messagesEl.innerHTML = '';
  }
  let nonSysCount = 0;
  for (let origIdx = 0; origIdx < allMsgs.length; origIdx++) {
    const msg = allMsgs[origIdx];
    if (msg.role === 'system') continue;
    const fi = nonSysCount++;
    if (startIdx && fi < startIdx) continue;
    if (msg.role === 'user') {
      // Stored history is pure committed messages; queued/pending items arrive via the live stream,
      // not from here. Split by block provenance: genuine user blocks → user bubble, robo blocks
      // (a hook-injected fragment) → agent-side robo bubble. A wholly-robo turn (followup resubmit)
      // is just one whose blocks are all robo.
      appendUserTurn(msg.content, origIdx, msg.traceId);
    } else if (msg.role === 'assistant') {
      const wrap = createAssistantWrap('assistant');
      if (msg.traceId) wrap.dataset.trace = msg.traceId;
      renderContentParts(wrap, msg.content);
    } else if (msg.role === 'tool') {
      // Results are attached to their matching .tool-block via data-call-id; no wrapper needed.
      const dummy = document.createDocumentFragment();
      renderContentParts(dummy, msg.content);
    } else if (msg.role === 'marker') {
      appendMarker(msg.content, msg.traceId);
    }
  }
  applyTurnUsageBlocks(allMsgs);
  if (scrollTarget !== undefined) {
    const divider = messagesEl.querySelector(`.msg-divider[data-msg-idx="${scrollTarget}"]`);
    const target  = divider?.nextElementSibling;
    if (target) { target.scrollIntoView({ block: 'start', behavior: 'instant' }); flashMessage(target); return; }
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function openSession(id, scrollTarget) {
  closeSidebar();
  currentSessionId = id;
  void refreshShareState(id);
  unreadSessions.delete(id);
  sessionListEl.querySelector('[data-sid="' + id + '"]')?.classList.remove('unread');
  location.hash = id;
  void refreshSessions();
  const [session, busy] = await Promise.all([apiGetSession(id), apiSessionBusy(id)]);
  if (session) {
    renderSession(session, undefined, scrollTarget);
    if (chatHeaderEl) chatTitleEl.textContent = session.title ?? '';
  }
  setBusyState(busy);
  // One persistent stream for this session; it replays any in-progress turn and carries all future
  // turns. Renders happen via renderTurn() keyed by traceId.
  connectSessionStream(id);
  loadFiles();
  inputEl.focus();
}

// Shared: create a new session and navigate to it (used by click + hash).
async function handleNewSession() {
  closeSidebar();
  try {
    const { id } = await apiNewSession();
    currentSessionId = id;
    void refreshShareState(id);
    location.hash = id;
    showEmpty();
    setBusyState(false); // a brand-new session is idle; clear any Stop carried over from the last view
    if (chatHeaderEl) chatTitleEl.textContent = '';
    await refreshSessions();
    inputEl.focus();
  } catch (e) {
    alert('New session failed: ' + e.message);
  }
}

// Left-click creates a new session in the current tab.
// Right-click / middle-click on the <a href="#new"> opens in a new tab naturally.
newBtn.addEventListener('click', async (e) => {
  if (e.button !== 0) return; // let right-click / middle-click open in new tab
  e.preventDefault();
  await handleNewSession();
});

// ── Form submission ───────────────────────────────────────────────────────────

async function submitFormResponse(sessionId, values) {
  if (!sessionId) return;
  // A form answer is just another submission; it renders over the persistent stream like any turn.
  await postSubmit(sessionId, { type: 'form-response', values });
}

// ── Send ──────────────────────────────────────────────────────────────────────

// ── Per-session event stream (one persistent connection; submits are fire-and-forget) ──────────
//
// A single GET /events/sessions/:id SSE carries ALL turns for the session. Events are demuxed by
// traceId into per-turn queues, each drained by renderTurn(). One connection per session (not per
// submission) is what keeps queued submits off the browser's ~6-socket-per-host limit — the cause
// of both the missing-queued-badge and the prompt-stall bugs.

let streamSessionId = null;       // session the persistent stream is bound to
let streamAc        = null;       // AbortController for the current stream
const turnQueues    = new Map();  // traceId -> { items, wake, done, started }

// Concat policy (the runner merges submissions queued behind a running turn into one turn, answered
// under the first/head submission's traceId). Mirror it in the UI: a submission that arrives while an
// earlier one is still queued-and-unanswered folds its text into that head bubble instead of getting
// its own turn — whose traceId the runner dropped, so it would never receive a response. activeBatchHead
// is the head's traceId; it resets the moment the head turn produces real output (its response has
// started, so the next submission begins a fresh batch). Tracked synchronously here — not via the DOM —
// so the refresh-replay, which delivers all pending `queued` events in one synchronous batch, folds
// correctly without racing the async bubble creation in renderTurn.
let activeBatchHead = null;   // { traceId, concat } | null — the open batch a follower may fold into
const foldedTraces  = new Set();

function queueFor(traceId) {
  let q = turnQueues.get(traceId);
  if (!q) { q = { items: [], wake: null, done: false, started: false }; turnQueues.set(traceId, q); }
  return q;
}

function wake(q) { if (q.wake) { const w = q.wake; q.wake = null; w(); } }

function pushTurnEvent(ev) {
  if (foldedTraces.has(ev.traceId)) return;   // a folded submission's later events (incl. cancelled) are noise

  // Markers can arrive after a turn's terminal event (e.g. a followup hook's, emitted post-commit).
  // If the turn's queue is gone/finished, render directly rather than re-spawning a renderTurn for a
  // done traceId; otherwise let it flow through the queue so it renders inline at the right spot.
  if (ev.type === 'marker') {
    const q = turnQueues.get(ev.traceId);
    if (!q || q.done) { appendMarker(ev.content ?? [], ev.traceId); return; }
  }

  if (ev.type === 'queued') {
    // Fold a follower into the head only when BOTH the head and this submission are concat — mirroring
    // the runner, which absorbs consecutive concat submissions into the head's turn and treats any
    // non-concat (Ctrl+Enter / robo) submission as a boundary that runs as its own turn.
    if (activeBatchHead !== null && activeBatchHead.concat && ev.concatQueue === true && ev.traceId !== activeBatchHead.traceId) {
      const headQ = turnQueues.get(activeBatchHead.traceId);
      if (headQ && !headQ.done) {
        headQ.items.push({ ...ev, type: 'queued-append' });
        wake(headQ);
        foldedTraces.add(ev.traceId);
        return;
      }
    }
    // Only a head still waiting behind a running turn (queued > 0) can absorb later concat
    // submissions: it sits in the runner's queue long enough for them to land behind it. A head that
    // runs immediately (queued === 0) is dequeued and its batch sealed by pump *synchronously* — before
    // any follower's submit POST can reach the queue — so it never merges one. Opening a foldable batch
    // for it would fold a quickly-queued next message into its bubble even though the runner ran it as
    // its own separate turn (visible only as the live/reload mismatch this guards against).
    activeBatchHead = ev.queued > 0 ? { traceId: ev.traceId, concat: ev.concatQueue === true } : null;
  } else if (activeBatchHead !== null && ev.traceId === activeBatchHead.traceId) {
    activeBatchHead = null;   // head turn has started responding → next submission opens a new batch
  }

  const q = queueFor(ev.traceId);
  q.items.push(ev);
  if (ev.type === 'done' || ev.type === 'aborted' || ev.type === 'error' || ev.type === 'cancelled') q.done = true;
  wake(q);
  // First time we see this traceId, spin up its renderer. Every turn — ours or one we joined —
  // is created here from the stream; there is no optimistic/pre-registered path to race against.
  if (!q.started) { q.started = true; void renderTurn(streamSessionId, ev.traceId); }
}

async function* turnEvents(traceId) {
  const q = queueFor(traceId);
  for (;;) {
    while (q.items.length) yield q.items.shift();
    if (q.done) { turnQueues.delete(traceId); return; }
    await new Promise(res => { q.wake = res; });
  }
}

async function connectSessionStream(sid) {
  if (streamAc) streamAc.abort();
  streamAc = new AbortController();
  streamSessionId = sid;
  turnQueues.clear();
  activeBatchHead = null;
  foldedTraces.clear();
  const ac = streamAc;
  // The transport owns the wire (reconnect, parsing); we just demux each turn event. Switching
  // sessions aborts ac (above), which ends the prior stream.
  try {
    for await (const ev of T.sessionEvents(sid, ac.signal)) {
      if (ac.signal.aborted || sid !== currentSessionId) break;
      // A session-scoped side-channel, not a turn-render event (it carries no traceId): a parked
      // web_user_environment tool call asking us to evaluate an expression in the browser. Handle it
      // here, before the per-trace demux, and answer out-of-band. Fire-and-forget so the Worker never
      // stalls the stream; the tool call is parked server-side (with its own timeout) until answerEnv.
      if (ev.type === 'web-env-eval') {
        const callId = ev.callId;
        void runWebEnv(ev.expression).then(out => T.answerEnv(sid, { callId, ...out }));
        continue;
      }
      pushTurnEvent(ev);
    }
  } catch {
    /* aborted or stream torn down */
  }
}

// Read the input box and submit it. The single entry point for *typed* messages; canned/programmatic
// messages (plugin install banners, etc.) call submit() directly so they aren't gated by the input.
// concat = true (Shift+Enter / send button): fold into the running turn's batch — fastest way to
// add more context. concat = false (Ctrl+Enter): a distinct queued turn, run in order — use when the
// next ask depends on this one's tools/state (e.g. install a plugin, then use it).
async function sendMessage(concat = true) {
  if (composerReadOnly) return;                          // shared-in session: writes are rejected by the backend
  const content = inputEl.value.trim();
  if (!content) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  await submit(content, concat);
}

// Submit typed content to the current session, fire-and-forget. The server enqueues it and the
// turn (its 'queued' user bubble + response) renders entirely over the persistent stream — there's
// no optimistic rendering here, so there's a single source of truth.
// concat defaults false: robo/programmatic submits (plugin install/remove banners, etc.) must each be
// their own ordered turn — one's tools/state are a precondition for the next ("add plugin X" then "use
// X", X only visible to a later turn). The human path passes its choice explicitly via sendMessage.
async function submit(content, concat = false) {
  const provider = providerSel.value;
  if (!content || !provider) return;
  if (!currentSessionId) {
    const { id } = await apiNewSession();
    currentSessionId = id;
  }
  // Ensure the persistent event stream is bound to this session before we enqueue, so the turn's
  // events have a consumer (covers the just-created session and the "New session" button path).
  if (streamSessionId !== currentSessionId) connectSessionStream(currentSessionId);
  await postSubmit(currentSessionId, content, concat);
}

// POST a submission and return. The user bubble + response arrive on the stream as a 'queued' event
// then turn events. Only *failures* are surfaced here (the stream can't, since no turn was created):
// a timeout (incl. the socket-exhaustion stall that never errors on its own), network error, or
// non-2xx is shown inline so the message is never silently lost.
async function postSubmit(sid, content, concat = false) {
  const provider = providerSel.value;
  if (!provider) return;
  try {
    await T.submit(sid, { content, provider, concatQueue: concat, mode: currentSteerMode() });
  } catch (e) {
    showSubmitError(content, e.name === 'TimeoutError' ? 'submit timed out (no response)' : (e.message || String(e)));
  }
}

// The submission never reached a turn, so show what was typed plus the failure, inline.
function showSubmitError(content, msg) {
  const text = typeof content === 'string' ? content : '';
  if (text) appendUserBubble(text);
  const div = document.createElement('div');
  div.className = 'msg-error';
  div.textContent = 'send failed: ' + msg;
  messagesEl.appendChild(div);
}

// Render one turn by draining its event queue, keyed by traceId. The user bubble is created from
// the 'queued' event (so it lands in the live delta in stream order); the assistant wrap + loading
// dots are created lazily on first activity. A turn we merely joined (the in-progress run, replayed
// on connect) gets no 'queued' — its user message is already in committed/stored history.
async function renderTurn(sid, traceId) {
  /** @type {Element} */
  let userBubble = null;   // set by the 'queued' event when this turn is a fresh submission
  let userBubbleText = ''; // raw markdown of the bubble; grows as concat'd submissions fold in
  /** @type {Element} */
  let turnWrap   = null;   // assistant wrap, created lazily
  /** @type {Element} */
  let loadingEl  = null;
  let started    = false;
  // The turn's outstanding interactive prompt, if any: `{ dismiss }`. The dialog is drawn in every
  // browser attached to the session but answered in only one, so the others are retired by the
  // server's `prompt-resolved`. Cleared as soon as it settles here, so our own answer's echo is a no-op.
  /** @type {{ dismiss: () => void }} */
  let livePrompt = null;

  // First visible activity for this turn: drop the queued egg-timer and create the assistant wrap
  // with loading dots. Idempotent.
  function markStarted() {
    if (started) return;
    started = true;
    if (userBubble) userBubble.classList.remove('pending');
    turnWrap = createAssistantWrap('assistant', userBubble);
    turnWrap.dataset.trace = traceId;   // so a retraction marker for this turn can drop this wrap live
    loadingEl = document.createElement('div');
    loadingEl.className = 'msg-loading';
    turnWrap.appendChild(loadingEl);
    // The dots sit below the just-appended user bubble, so the bubble's own scroll-to-bottom (which
    // ran before the dots existed) left them under the fold. Re-pin to the bottom now they're in the DOM.
    scrollMessagesToBottom();
  }
  function removeLoading() { markStarted(); if (loadingEl) { loadingEl.remove(); loadingEl = null; } }

  // Per-turn streaming state
  /** @type {Element} */
  let textEl          = null;
  let textAccum       = '';
  let textElFinalised = false;
  let thinkingContent = null;
  let thinkingAccum   = '';
  let currentTool     = null;
  let providerToolPending = false;


  function getOrMakeTextEl() {
    markStarted();
    if (!textEl) {
      textEl = document.createElement('div');
      textEl.className = 'msg-text md-body';
      turnWrap.appendChild(textEl);
    }
    return textEl;
  }

  // Called on the first content event of each turn.  Scrolls the
  // assistant message wrapper to the top of the messages viewport so
  // the user can read the output from the beginning.  Honours the
  // 10-second suppression window set by manual user scrolling.
  function scrollToOutputStart() {
    if (isScrollSuppressed()) return;
    programmaticScrollTo(() => {
      // While the text block fits within the viewport, scroll its bottom
      // into view so the user sees the message filling in from the bottom.
      // Once the content is taller than the container, stop scrolling so
      // the user can read from the top without it being pushed away.
      const el = textEl;
      const avail = window.innerHeight - (chatHeaderEl?.offsetHeight ?? 0)
                    - (document.getElementById('input-area')?.offsetHeight ?? 0);
      if (el && el.offsetHeight <= avail) {
        el.scrollIntoView({ block: 'end', behavior: 'instant' });
      }
      updateScrollDownButton();
    });
  }

  try {
    for await (const ev of turnEvents(traceId)) {
      switch (ev.type) {
        case 'queued': {
          // The submission itself, delivered on the stream. Render its user bubble here (in delta
          // order). queued > 0 ⇒ it's waiting behind a running turn → float the egg-timer; queued
          // === 0 ⇒ it runs immediately → show loading dots. A content event later promotes it.
          if (!userBubble) {
            const text = (ev.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
            // Adopt an already-rendered bubble for this turn rather than draw a second one: on reload /
            // navigate-back the running turn's user message is in committed history (renderSession drew
            // it, tagged with traceId), and the server now also seeds this turn's replay with a `queued`
            // so a late-connecting stream still gets the bubble. Idempotent: whichever arrived first wins.
            const existing = messagesEl.querySelector(`.message[data-trace="${traceId}"]`);
            if (existing) {
              userBubble = existing;
              userBubbleText = existing.querySelector('.md-body')?.textContent ?? text;
            } else if (text) {
              // A robo turn (followup resubmit) arrives all-robo → agent-side bubble. Live submissions
              // are never mixed (a hook-augmented turn only shows its split on reload, from committed
              // history), so an all-or-nothing check here is enough.
              const robo = (ev.content ?? []).some(c => c.type === 'text' && c.origin === 'robo');
              userBubble = robo ? appendRoboBubble(text, undefined, traceId) : appendUserBubble(text, undefined, ev.queued > 0, traceId);
              userBubbleText = text;
            }
          }
          if (ev.queued === 0) markStarted();
          break;
        }

        case 'steer': {
          // A mid-turn steer that interrupted a running turn. Its user bubble arrives here, live only:
          // on reload / late-connect the message is in committed history (renderSession draws it) and
          // the runner also seeds this turn's replay with a `queued`, so this event fires just once, at
          // the interrupt moment. Render like an immediately-running submission — it runs next, right
          // after the interrupted turn commits its partial work.
          if (!userBubble) {
            const text = (ev.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
            const existing = messagesEl.querySelector(`.message[data-trace="${traceId}"]`);
            if (existing) {
              userBubble = existing;
              userBubbleText = existing.querySelector('.md-body')?.textContent ?? text;
            } else if (text) {
              userBubble = appendUserBubble(text, undefined, false, traceId);
              userBubbleText = text;
            }
          }
          markStarted();
          break;
        }

        case 'queued-append': {
          // A later submission the runner folded into this turn (concat policy). Grow the head bubble
          // so the UI matches the single merged user message that gets persisted. Joined with '\n' to
          // match how renderSession concatenates a multi-block user message on reload.
          const text = (ev.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
          if (userBubble && text) {
            userBubbleText = userBubbleText ? `${userBubbleText}\n${text}` : text;
            const inner = userBubble.querySelector('.md-body');
            if (inner) inner.innerHTML = md(userBubbleText);
          }
          break;
        }

        case 'text-delta':
          removeLoading();
          if (textElFinalised) { textEl = null; textAccum = ''; textElFinalised = false; }
          textAccum += ev.delta;
          getOrMakeTextEl().innerHTML = md(textAccum);
          scrollToOutputStart();
          break;

        case 'thinking': {
          removeLoading();
          if (!thinkingContent) {
            const { details, content: c } = makeThinkingBlock('\ud83d\udcad Thinking', true);
            // Insert before text so thinking appears above the response
            turnWrap.insertBefore(details, textEl);
            thinkingContent = c;
          }
          thinkingAccum += ev.delta;
          thinkingContent.textContent = thinkingAccum;
            // If no text content yet, scroll to show the user processing is happening.
            if (!turnWrap.querySelector('.msg-text') && !isScrollSuppressed()) {
              programmaticScrollTo(() => {
                turnWrap.scrollIntoView({ block: 'end', behavior: 'instant' });
              });
            }
          break;
        }

        case 'tool:start': {
          removeLoading();
          if (ev.name === 'provider') providerToolPending = true;
          currentTool = makeToolBlock(ev.name, ev.input, ev.callId);
          currentTool.open = true;
          turnWrap.appendChild(currentTool);
            // If no text content yet, scroll to show the user processing is happening.
            if (!turnWrap.querySelector('.msg-text') && !isScrollSuppressed()) {
              programmaticScrollTo(() => {
                turnWrap.scrollIntoView({ block: 'end', behavior: 'instant' });
              });
            }
          break;
        }

        case 'tool:stdout':
        case 'tool:stderr': {
          if (currentTool) {
            let outEl = currentTool.querySelector('.tool-output');
            if (!outEl) {
              outEl = document.createElement('pre');
              outEl.className = 'tool-output';
              currentTool.appendChild(outEl);
            }
            outEl.textContent += ev.chunk;
            outEl.scrollTop = outEl.scrollHeight;
          }
          break;
        }

        case 'tool:progress': {
          // Locate by callId rather than `currentTool` so a late event can't bleed onto the wrong
          // block. Invert `pct`% of the block (left→right wipe), and surface any message as a floating
          // pill in the block (plus a title, so the full text is on hover when the pill truncates).
          const block = ev.callId ? messagesEl.querySelector('[data-call-id="' + ev.callId + '"]') : currentTool;
          if (block) {
            let bar = block.querySelector(':scope > .tool-progress');
            if (!bar) { bar = document.createElement('div'); bar.className = 'tool-progress'; block.appendChild(bar); }
            bar.style.width = Math.max(0, Math.min(100, ev.pct)) + '%';
            if (ev.message) {
              let pill = block.querySelector(':scope > .tool-progress-pill');
              if (!pill) { pill = document.createElement('div'); pill.className = 'tool-progress-pill'; block.appendChild(pill); }
              pill.textContent = ev.message;
              block.title = ev.message;
            }
          }
          break;
        }

        case 'tool:end': {
          if (currentTool) {
            const bar = currentTool.querySelector(':scope > .tool-progress');
            if (bar) bar.remove();
            const pill = currentTool.querySelector(':scope > .tool-progress-pill');
            if (pill) pill.remove();
            currentTool.removeAttribute('title');
            currentTool.appendChild(makeToolResultBlock(ev.result, ev.isError));
            currentTool.open = false;
          }
          currentTool = null;
          textElFinalised = true;
          textAccum = '';
          if (providerToolPending && !ev.isError) { providerToolPending = false; refreshProviderSelect(); }
          break;
        }

        case 'prompt': {
          removeLoading();
          const field      = ev.field;
          const rawQ       = ev.question ?? '';
          // Buttons come from a structured select/confirm field; failing that, from a
          // legacy trailing [A/B] in the question text. Otherwise it's a free-text input.
          const choiceMatch = field ? null : /\[([^\/\]]+)\/([^\/\]]+)\]\s*$/.exec(rawQ);
          const choices = field
            ? (field.type === 'select'  ? (field.options ?? [])
             : field.type === 'confirm' ? ['yes', 'no']
             : null)
            : (choiceMatch ? [choiceMatch[1], choiceMatch[2]] : null);
          const questionText = field ? field.label
            : (choiceMatch ? rawQ.slice(0, choiceMatch.index).trimEnd() : rawQ);
          const defaultValue = field ? field.default : ev.defaultValue;
          const inputType    = field && field.type === 'password' ? 'password' : 'text';
          // Cancel is the "give up" path (default on); only an explicit cancelable:false suppresses it.
          const cancelable   = !(field && field.cancelable === false);
          const allowOther   = !!(field && field.type === 'select' && field.allowOther);
          const answered = new Promise(resolve => {
            const block = document.createElement('div');
            block.className = 'prompt-block';
            // Settle the dialog: disable every control (incl. the cancel ×) once answered or cancelled.
            const done = () => block.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
            // Retire the dialog without answering — someone else got there first. Resolving with
            // `dismissed` keeps the single settle path below from POSTing an answer nobody asked for.
            livePrompt = { dismiss: () => {
              done();
              block.classList.add('settled');
              const note = document.createElement('div');
              note.className = 'prompt-note';
              note.textContent = 'Answered elsewhere.';
              block.appendChild(note);
              resolve({ dismissed: true });
            } };
            if (cancelable) {
              const x = document.createElement('button');
              x.type = 'button';
              x.className = 'prompt-cancel-x';
              x.title = 'Cancel';
              x.setAttribute('aria-label', 'Cancel');
              x.textContent = '×';
              x.onclick = () => { done(); resolve({ cancelled: true }); };
              block.appendChild(x);
            }
            const q = document.createElement('div');
            q.className = 'prompt-question';
            q.innerHTML = md(questionText);
            block.appendChild(q);
            if (choices) {
              const row = document.createElement('div');
              row.className = 'prompt-choices';
              let defaultBtn = null;
              for (const choice of choices) {
                const btn = document.createElement('button');
                btn.type = 'button';
                const isDefault = choice.toLowerCase() === (defaultValue ?? '').toLowerCase();
                btn.className = 'prompt-choice-btn' + (isDefault ? ' primary' : '');
                const cl = choice.toLowerCase();
                btn.textContent = cl === 'y' || cl === 'yes' ? 'Yes'
                  : cl === 'n' || cl === 'no' ? 'No'
                  : choice;
                btn.onclick = () => { done(); resolve({ answer: choice }); };
                if (isDefault) defaultBtn = btn;
                row.appendChild(btn);
              }
              if (allowOther) {
                const otherBtn = document.createElement('button');
                otherBtn.type = 'button';
                otherBtn.className = 'prompt-choice-btn';
                otherBtn.textContent = 'Other…';
                otherBtn.onclick = () => {
                  row.querySelectorAll('button').forEach(b => { b.disabled = true; });
                  const orow = document.createElement('div');
                  orow.className = 'prompt-row';
                  const inp = document.createElement('textarea');
                  inp.className = 'prompt-input';
                  inp.rows = 2;
                  const sbtn = document.createElement('button');
                  sbtn.type = 'button';
                  sbtn.className = 'prompt-submit';
                  sbtn.textContent = 'Submit';
                  const submitOther = () => {
                    const v = inp.value.trim();
                    if (field.required && !v) return;
                    done();
                    resolve({ answer: v });
                  };
                  sbtn.onclick = submitOther;
                  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitOther(); } });
                  orow.appendChild(inp);
                  orow.appendChild(sbtn);
                  block.appendChild(orow);
                  inp.focus();
                };
                row.appendChild(otherBtn);
              }
              block.appendChild(row);
              turnWrap.appendChild(block);
              // Prompt requires user attention — scroll to show it.
              if (!isScrollSuppressed()) {
                programmaticScrollTo(() => {
                  messagesEl.scrollTop = messagesEl.scrollHeight;
                });
              }
              (defaultBtn ?? row.querySelector('button'))?.focus();
            } else {
              const row = document.createElement('div');
              row.className = 'prompt-row';
              const inp = document.createElement('input');
              inp.type = inputType;
              inp.className = 'prompt-input';
              inp.value = defaultValue ?? '';
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'prompt-submit';
              btn.textContent = 'Submit';
              const submit = () => {
                done();
                resolve({ answer: inp.value.trim() || defaultValue || '' });
              };
              btn.onclick = submit;
              inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
              row.appendChild(inp);
              row.appendChild(btn);
              block.appendChild(row);
              turnWrap.appendChild(block);
              if (!isScrollSuppressed()) {
                programmaticScrollTo(() => {
                  messagesEl.scrollTop = messagesEl.scrollHeight;
                });
              }
              inp.focus();
            }
          });
          // Deliberately NOT awaited: this loop must keep consuming the turn's events while the dialog is
          // up. Parking here stalls everything behind it — including the `prompt-resolved` that retires
          // this very dialog when another browser answers, which is a deadlock, not just a lag.
          void answered.then(result => {
            livePrompt = null;
            if (result.dismissed) return;
            return T.answerPrompt(sid, result.cancelled ? { cancel: true } : { answer: result.answer });
          });
          break;
        }

        case 'prompt-resolved': {
          livePrompt?.dismiss();
          break;
        }

        case 'robo-user': {
          // Machine-authored content folded onto the running turn's user message (a screen hook's
          // `durable` result — e.g. a fired `contextual` trigger). Draw it as an agent-side robo
          // bubble so the live view matches the reload, where appendUserTurn splits the user turn's
          // robo blocks into exactly such a bubble.
          const text = (ev.content ?? [])
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');
          if (text) appendRoboBubble(text, undefined, ev.traceId);
          break;
        }

        case 'marker': {
          // A marker appended to the session this turn (e.g. a hook that threw). Render it inline now;
          // on a later reload it comes back through renderSession's role==='marker' path identically.
          removeLoading();
          appendMarker(ev.content ?? [], ev.traceId);
          break;
        }

        case 'aborted': {
          removeLoading();
          if (ev.reason === 'user-abort' || ev.reason === 'steer') {
            // Partial content already in DOM and saved to store — nothing to re-render. For a steer
            // (mid-turn interrupt) the interrupted turn's work is deliberately kept — the steer bubble
            // and its continuation render after it. Re-rendering from ev.session here would wipe the
            // live steer bubble, which isn't persisted until its own turn runs (persist-at-turn-start).
          } else {
            if (turnWrap) turnWrap.remove();
            if (ev.session) renderSession(ev.session);
          }
          break;
        }

        case 'cancelled': {
          // This queued submission was dropped (Stop pressed before it ran). It never executed and
          // was never persisted, so remove its bubble and (if any) its empty turn entirely.
          if (loadingEl) { loadingEl.remove(); loadingEl = null; }
          if (turnWrap) turnWrap.remove();
          if (userBubble) userBubble.remove();
          break;
        }

        case 'done':
          if (thinkingContent) {
            const det = thinkingContent.closest('details');
            if (det) det.open = false;
          }
          if (ev.session?.title && chatHeaderEl) chatTitleEl.textContent = ev.session.title;
          // Per-provider token accounting for this turn, from the persisted session — so it includes
          // spend by tools that ran their own completions (single_turn, ask_inner_voice, dream_time).
          const perProvider = usageByProvider(ev.session?.messages, traceId);
          const turnFooter  = makeTurnFooter(perProvider, turnTimestamp(ev.session?.messages, traceId));
          if (turnWrap && turnFooter) turnWrap.appendChild(turnFooter);
          loadFiles();
          // Back-fill origIdx on any dividers added without an index this turn.
          if (ev.session) {
            const allDividers = [...messagesEl.querySelectorAll('.msg-divider')];
            const unindexed   = allDividers.filter(d => d.dataset.msgIdx === undefined);
            if (unindexed.length > 0) {
              const indexed  = allDividers.filter(d => d.dataset.msgIdx !== undefined);
              const lastIdx  = indexed.length > 0 ? parseInt(indexed[indexed.length - 1].dataset.msgIdx) : -1;
              const newIdxs  = ev.session.messages
                .map((m, i) => ({ m, i }))
                .filter(({ m, i }) => m.role === 'user' && i > lastIdx)
                .map(({ i }) => i);
              for (let j = 0; j < Math.min(unindexed.length, newIdxs.length); j++) {
                unindexed[j].dataset.msgIdx = newIdxs[j];
              }
            }
          }
          break;

        case 'error': {
          removeLoading();
          const errDiv = document.createElement('div');
          errDiv.className = 'msg-error';
          errDiv.textContent = (ev.error ?? ev.message ?? 'unknown');
          turnWrap.appendChild(errDiv);
          break;
        }
      }
      // NOTE: deliberately NO messagesEl.scrollTop = messagesEl.scrollHeight here.
      // We scrolled once to the output start; continuous bottom-chasing is gone.
    }
  } catch (e) {
    removeLoading();
    const errDiv = document.createElement('div');
    errDiv.className = 'msg-error';
    errDiv.textContent = e.message;
    turnWrap.appendChild(errDiv);
  } finally {
    // Don't markStarted() here — a turn that was only queued then cancelled must not spawn an empty
    // assistant wrap. Just clear any loading dots that are still showing.
    if (loadingEl) { loadingEl.remove(); loadingEl = null; }
    refreshSessions();
    loadFiles();
    // If the output extends below the viewport fold, morph the send button
    // into a ▼ down-arrow so the user can jump to the bottom with one click.
    maybeShowScrollDown();
  }
}

// ── Send / Stop button handlers ───────────────────────────────────────────────
//
// Send has two modes: scroll-down (▼ — jump to bottom) or default (▶ — send/queue). Stop is a
// separate button shown only while a turn is running; it aborts and clears the queue. Send and the
// input stay live during a turn so you can type-ahead and queue.
sendBtn.onclick = () => {
  if (sendBtn.classList.contains('scroll-down-mode')) scrollToBottomAndReset();
  else sendMessage();
};

stopBtn.onclick = () => requestStop();

document.getElementById('sessions-enable-btn').onclick = () => {
  submit('Add the plugin named exactly @matatbread/matbot-sessions to enable persistent conversations. First run the plugin discover_local action to check whether it is already available locally and add it from there; only if it is not found locally, install it from npm or github by that exact package name. Do not guess or try other name variations.');
};

inputEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  // Ctrl/Cmd+Enter → queued (own turn, run in order). Shift+Enter → concat (fold into the running
  // batch). Plain Enter keeps the textarea's newline behaviour.
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); sendMessage(false); }
  else if (e.shiftKey)        { e.preventDefault(); sendMessage(true); }
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
});

// Busy is now authoritative from the server (the per-session 'session-busy' status events), not a
// client-side count. Show/hide the Stop button accordingly; Send + input stay live throughout so
// you can type-ahead and queue. The input is never disabled.
function setStop(visible) {
  stopBtn.style.visibility = visible ? 'visible' : 'hidden';
  if (visible) stopBtn.disabled = false;
}

// Sync every send/stop affordance to a session's busy state. Called from each path that changes which
// session is in view (open/new/hide) and from the live status stream, so the buttons always reflect the
// session on screen — never a stale state carried over from the previously-viewed session.
function setBusyState(busy) {
  sending = busy;
  setStop(busy);
}

function requestStop() {
  const target = currentSessionId;
  if (!target) return;
  stopBtn.disabled = true;
  // Aborts the running turn AND drops everything still queued for the session; the resulting
  // aborted/cancelled events tidy the rendered turns over the persistent stream.
  Promise.resolve(T.abort(target))
    .catch(() => {})
    .finally(() => { stopBtn.disabled = false; });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Configure marked
  if (typeof marked !== 'undefined') {
    marked.use({ breaks: true, gfm: true });
  }

  await initProfiles();

  {
    const MIN = 10, MAX = 22;
    function adjust(delta) {
      const cur = parseFloat(getComputedStyle(document.body).fontSize);
      const next = Math.min(MAX, Math.max(MIN, Math.round(cur) + delta));
      document.documentElement.style.setProperty('--fs', next + 'px');
      localStorage.setItem(LS_FONT_SIZE, String(next));
    }
    document.getElementById('fs-down').addEventListener('click', () => adjust(-1));
    document.getElementById('fs-up').addEventListener('click',   () => adjust(+1));
  };

  // ── Attach scroll listeners for user-scroll detection ─────────
  // 'wheel' / 'touchmove' catch mouse-wheel, trackpad and touch gestures at input time.
  // The 'scroll' event additionally catches scrollbar drags and keyboard paging (PgUp /
  // PgDn / arrows) — which emit no wheel/touch event — by noticing the position landed
  // somewhere we didn't put it (see programmaticScrollTo). 4px absorbs sub-pixel jitter.
  messagesEl.addEventListener('wheel', onUserScroll, { passive: true });
  messagesEl.addEventListener('touchmove', onUserScroll, { passive: true });
  messagesEl.addEventListener('scroll', () => {
    if (Math.abs(messagesEl.scrollTop - expectedScrollTop) > 4) {
      scrollSuppressUntil = Date.now() + 5000;
      updateScrollDownButton();
    }
  });

  // ── Floating scroll-down button ──
  scrollDownBtn = document.getElementById('scroll-down-btn');
  if (scrollDownBtn) {
    scrollDownBtn.onclick = () => {
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
      inputEl.focus();
    };
  }

  const [sessions, providers, aboutMatbot] = await Promise.all([apiListSessions(), apiListProviders(), callTool('about_matbot')]);
  if (aboutMatbot?.version) {
    const versionElt = document.getElementById('matbot-version');
    if (versionElt) {
      versionElt.textContent = 'v'+aboutMatbot.version;
      versionElt.title = aboutMatbot.about;
    }
  }

  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = p;
    providerSel.appendChild(opt);
  }

  const savedProvider = localStorage[LS_PROVIDER];
  if (savedProvider && providers.includes(savedProvider)) {
    providerSel.value = savedProvider;
  }

  providerSel.addEventListener('change', () => {
    localStorage.setItem(LS_PROVIDER, providerSel.value);
  });

  // Subscribe to session busy/idle transitions (the transport owns the wire + reconnect).
  (async function connectStatusStream() {
    for await (const { sessionId, busy } of T.statusEvents(new AbortController().signal)) {
      const item = sessionListEl.querySelector('[data-sid="' + sessionId + '"]');
      if (busy) {
        busySessions.add(sessionId);
        unreadSessions.delete(sessionId);
        if (item) { item.classList.add('busy'); item.classList.remove('unread'); }
      } else {
        busySessions.delete(sessionId);
        if (sessionId !== currentSessionId) {
          unreadSessions.add(sessionId);
          if (item) { item.classList.remove('busy'); item.classList.add('unread'); }
        } else {
          if (item) item.classList.remove('busy');
        }
      }
      // Drive the Stop button + the busy flag for the session currently in view.
      if (sessionId === currentSessionId) setBusyState(busy);
    }
  })();

  // ONE notification stream drives every live panel. Each notification is a self-describing fact —
  // `kind` selects the shape, `namespace`/`id` say what changed — already filtered server-side to what
  // this connection's principal may see. Never treat one as a delta to apply: it carries identity, not
  // state, so the only sound reaction is to re-read what changed (the file row's advisory `detail` is
  // the one exception, and only ever cosmetic).
  //
  // NOTE the `default` fall-through: `kind` is open at runtime — a plugin, or a bridge from another
  // matbot, can publish a kind this build has never heard of — so an unrecognised notification must be
  // ignored, never treated as an error.
  (async function connectNotificationStream() {
    // Panel re-queries are debounced: one plugin load fires many registry notifications, and we want a
    // single re-query per burst rather than one per event.
    const debounced = (fn, ms = 150) => {
      let timer = null;
      return () => { if (timer) return; timer = setTimeout(() => { timer = null; fn(); }, ms); };
    };
    const refreshSkills   = debounced(loadSkills);
    const refreshPlugins  = debounced(loadPlugins);
    const refreshFiles    = debounced(loadFiles);
    // A session appearing or vanishing — a second browser on this profile creating one, a fork, a
    // session shared in from another profile. Not debounced here: it shares the module-level
    // `refreshSessions`, so a change this browser just made coalesces with the refresh its own click
    // already scheduled instead of paying for a second full list.

    for await (const n of T.notifications(new AbortController().signal)) {
      // A notification kind is `<package>#<Interface>` — globally unique, because a bridged instance or a
      // plugin this build has never seen can publish one. plugin-api exports these two as consts for TS
      // consumers; this is a plain script, so they are spelled out.
      switch (n.kind) {
        case '@matatbread/matbot-plugin-api#ItemChange':
          switch (n.namespace) {
            case 'files':    onFileChanged(n, refreshFiles); break;
            case 'skills':   refreshSkills();                break;
            case 'sessions':
              refreshSessions();
              if (n.id === currentSessionId) void refreshTurnFooters();
              break;
            default: break;                                  // a namespace no panel shows
          }
          break;
        // Tool churn refreshes skills (skills are tools, and one may be registered out of band — e.g.
        // the Drive backend restoring matbot-skills at boot); plugin churn refreshes the plugins panel,
        // covering the tool-less plugins the tool registry can't see.
        case '@matatbread/matbot-plugin-api#RegistryChange':
          if (n.registry === 'tools') refreshSkills(); else refreshPlugins();
          break;
        default: break;
      }
    }
  })();

  // A file changed. The workspace panel shows one content namespace, so ignore the rest. An already-
  // listed row updates in place from the advisory `detail` (cosmetic only — size and the updated dot);
  // anything else re-lists, which is also how a first share, a copy, or a delete reaches the list.
  function onFileChanged(n, refreshFiles) {
    if (n.operation === 'deleted') { refreshFiles(); return; }
    const meta = n.detail || {};
    if (meta.namespace !== 'workspace') return;
    const { name } = meta;
    const item = document.getElementById('file-list')?.querySelector('[data-name="' + CSS.escape(name) + '"]');
    updatedFiles.add(name);
    if (!item) { refreshFiles(); return; }
    item.classList.add('updated');
    const sizeEl = item.querySelector('.file-size');
    if (sizeEl && meta.size !== undefined) sizeEl.textContent = formatSize(meta.size);
  }

  renderSessions(sessions);

  // Dismiss open divider menus on any background click.
  document.addEventListener('click', () => {
    document.querySelectorAll('.msg-divider.open').forEach(d => d.classList.remove('open'));
  });

  const rawFragment = decodeURIComponent(location.hash.slice(1));
  const tildeIdx    = rawFragment.indexOf('~');
  const fragmentSid = tildeIdx >= 0 ? rawFragment.slice(0, tildeIdx) : rawFragment;
  const fragmentNav = tildeIdx >= 0 ? (() => { try { return JSON.parse(rawFragment.slice(tildeIdx + 1)); } catch { return null; } })() : null;
  const startId     = (fragmentSid && sessions.some(s => s.id === fragmentSid))
    ? fragmentSid : sessions[0]?.id;
  if (startId === 'new') {
    await handleNewSession();
  } else if (startId) {
    await openSession(startId, fragmentNav?.msg);
  } else {
    showEmpty();
    setBusyState(false);
  }
  loadFiles();
  loadPlugins();
  loadSkills();
}

// ── File drag-drop + upload button ───────────────────────────────────────────

const filesSectionEl = document.querySelector('[data-section="files"]');
if (filesSectionEl) {
  filesSectionEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    filesSectionEl.classList.add('drop-over');
  });
  filesSectionEl.addEventListener('dragleave', (e) => {
    if (!filesSectionEl.contains(e.relatedTarget)) filesSectionEl.classList.remove('drop-over');
  });
  filesSectionEl.addEventListener('drop', (e) => {
    e.preventDefault();
    filesSectionEl.classList.remove('drop-over');
    if (e.dataTransfer?.files.length) uploadFiles(e.dataTransfer.files);
  });
}

document.getElementById('upload-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('upload-input')?.click();
});
document.getElementById('upload-input')?.addEventListener('change', function() {
  if (this.files?.length) { uploadFiles(this.files); this.value = ''; }
});

window.addEventListener('hashchange', async () => {
  // Mirror the load-time parse in initProfiles: a deep-link may carry a leading `#<profile>:` prefix.
  // A profile that differs from the active one is a switch — adopt it and reload (like selectProfile),
  // and the post-reload initProfiles strips it before the session parse. A matching profile is stripped
  // in place; only the `<session>~<params>` remainder drives the session logic below.
  const { profile: hashProfile, rest } = splitHashProfile(location.hash.slice(1), profileNames);
  if (hashProfile !== null && hashProfile !== currentProfileName()) { selectProfile(hashProfile); return; }
  if (hashProfile !== null) history.replaceState(null, '', location.pathname + (rest ? '#' + rest : ''));
  const raw      = rest;
  const ti       = raw.indexOf('~');
  const id       = ti >= 0 ? raw.slice(0, ti) : raw;
  const nav      = ti >= 0 ? (() => { try { return JSON.parse(raw.slice(ti + 1)); } catch { return null; } })() : null;
  if (id === 'new') {
    await handleNewSession();
  } else if (id && id !== currentSessionId) {
    await openSession(id, nav?.msg).catch(console.error);
  } else if (id === currentSessionId && nav?.msg !== undefined) {
    history.replaceState(null, '', location.pathname + '#' + id);
    scrollToMsgIdx(nav.msg);
  }
});

// ── Profile selector ────────────────────────────────────────────────────────────
// Capability-gated on the `profile` storage tool: if it isn't registered (no profile-aware storage
// backend), the whole feature stays hidden and the UI is unchanged. The active profile lives per-browser
// in localStorage; the transport sends it as the x-matbot-principal header so the server routes this
// browser's sessions to that profile's partition. Switching reloads the page — the least-code way to
// re-open every stream/list under the new identity. "Global" (no profile) is the shared base storage.
const PROFILE_LS = 'matbot.profile';

function currentProfileName() { try { return localStorage.getItem(PROFILE_LS) || null; } catch { return null; } }

function selectProfile(name) {
  try { if (name) localStorage.setItem(PROFILE_LS, name); else localStorage.removeItem(PROFILE_LS); } catch { /* ignore */ }
  location.reload();
}

// A deep-link may name a profile ahead of the session: `#<profile>:<session>~<params>`, with every part
// optional so pre-profile links (`#<session>`, `#<session>~<params>`) are untouched. Split off a leading
// profile token, keeping the rest for the existing session-fragment parser. The profile is judged
// heuristically — a colon-prefixed token, or a lone token that names an existing profile (session ids,
// being UUIDs, never do). `validNames` is the current profile set; `raw` is the un-decoded fragment
// (profile names are [\w-]+, so encoding is irrelevant to the split).
function splitHashProfile(raw, validNames) {
  const colon = raw.indexOf(':');
  if (colon >= 0) {
    const cand = raw.slice(0, colon);
    return validNames.has(cand) ? { profile: cand, rest: raw.slice(colon + 1) } : { profile: null, rest: raw };
  }
  if (raw && raw.indexOf('~') < 0 && validNames.has(raw)) return { profile: raw, rest: '' };
  return { profile: null, rest: raw };
}

// Copy `text` to the clipboard, falling back to a hidden textarea + execCommand on plain-HTTP contexts
// where the async clipboard API is unavailable (mirrors the message copy-link path).
async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* denied — fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { /* */ }
  ta.remove();
  return ok;
}

// A checklist of isolatable namespaces for the profile menu. `available` is the backend's observed set (a
// lower bound); `selected` is the profile's current isolated set. Their union is shown, so a namespace the
// profile already isolates appears even if nothing has touched it yet this session. Returns the element and
// a `current()` reading the checked namespaces.
function namespaceChecklist(available, selected) {
  const box  = document.createElement('div');
  box.className = 'pm-ns';
  const all  = [...new Set([...available, ...selected])].sort();
  const cbs  = new Map();
  if (!all.length) {
    const empty = document.createElement('div');
    empty.className = 'pm-ns-empty';
    empty.textContent = 'No namespaces observed yet.';
    box.appendChild(empty);
  }
  for (const ns of all) {
    const lab = document.createElement('label');
    lab.className = 'pm-ns-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = selected.includes(ns);
    cbs.set(ns, cb);
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(ns));
    box.appendChild(lab);
  }
  return { box, current: () => [...cbs].filter(([, cb]) => cb.checked).map(([ns]) => ns) };
}

async function initProfiles() {
  let profiles;
  try { profiles = (await callTool('profile_action', { action: 'list' })).profiles; }
  catch { return; }                                   // tool absent ⇒ no profile-aware storage ⇒ feature off

  profilesActive = true;                               // storage is profile-aware ⇒ the sharing UI can appear
  updateShareBtn();

  const btn   = document.getElementById('profile-btn');
  const menu  = document.getElementById('profile-menu');
  const label = document.getElementById('profile-btn-label');
  if (!btn || !menu || !label) return;

  // Honour a `#<profile>:…` deep-link BEFORE any session/tool call reads the active profile (the transport
  // sends it from localStorage per request). Adopt the named profile, then strip it from the hash so the
  // downstream session-fragment parser in init() sees only `<session>~<params>`. Done here at load — no
  // reload, since nothing has opened under the old identity yet (unlike selectProfile's live switch).
  const validNames = new Set(profiles.map(p => p.name));
  profileNames = validNames;                            // share with the hashchange handler
  const { profile: hashProfile, rest } = splitHashProfile(location.hash.slice(1), validNames);
  if (hashProfile !== null) {
    try { localStorage.setItem(PROFILE_LS, hashProfile); } catch { /* ignore */ }
    history.replaceState(null, '', location.pathname + (rest ? '#' + rest : ''));
  }

  const active = currentProfileName();
  label.textContent = active || 'Global';
  btn.hidden = false;

  const render = (list, namespaces) => {
    menu.innerHTML = '';
    // `p` is a profile { name, isolated } or null for the base/"global" identity (no isolation, not editable).
    const row = (p) => {
      const name = p && p.name;
      const item = document.createElement('div');
      item.className = 'pm-item' + ((name || null) === active ? ' active' : '');
      const nm = document.createElement('span');
      nm.className = 'pm-name';
      nm.textContent = name || 'Global (shared)';
      item.appendChild(nm);
      item.addEventListener('click', () => selectProfile(name));
      if (!name) { menu.appendChild(item); return; }

      // Isolated-namespaces editor: the gear toggles a checklist panel (a menu sibling of the row, so its
      // clicks never bubble into the row's select-and-reload handler). Apply writes the whole set at once.
      const panel = document.createElement('div');
      panel.className = 'pm-ns-panel'; panel.hidden = true;
      const gear = document.createElement('button');
      gear.className = 'pm-ns-btn'; gear.title = 'Edit isolated namespaces'; gear.textContent = '⚙';
      gear.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!panel.hidden) { panel.hidden = true; return; }
        panel.innerHTML = '';
        const { box, current } = namespaceChecklist(namespaces, p.isolated || []);
        const actions = document.createElement('div');
        actions.className = 'pm-ns-actions';
        const apply  = document.createElement('button'); apply.textContent = 'Apply';
        const status = document.createElement('span');   status.className = 'pm-ns-status';
        apply.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const next = current();
          try { await callTool('profile_action', { action: 'set_isolated', name, isolated: next }); }
          catch (err) { status.textContent = String(err); return; }
          p.isolated = next;                            // reflect the persisted set without collapsing the panel
          status.textContent = 'Saved';
        });
        actions.appendChild(apply); actions.appendChild(status);
        panel.appendChild(box); panel.appendChild(actions);
        panel.hidden = false;
      });

      const link = document.createElement('button');
      link.className = 'pm-link'; link.title = 'Copy shareable link'; link.textContent = '\u{1F517}';
      link.addEventListener('click', async (e) => {
        e.stopPropagation();
        const url = location.origin + location.pathname + '#' + encodeURIComponent(name);
        const ok  = await copyToClipboard(url);
        const was = link.textContent;
        link.textContent = ok ? '✓' : '✗';
        setTimeout(() => { link.textContent = was; }, 1200);
      });

      const del = document.createElement('button');
      del.className = 'pm-del'; del.title = 'Delete profile'; del.textContent = '✕';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete profile "' + name + '"? Its stored data is left on disk.')) return;
        try { await callTool('profile_action', { action: 'delete', name }); } catch (err) { alert(String(err)); return; }
        if (currentProfileName() === name) { selectProfile(null); return; }
        refresh();
      });

      item.appendChild(gear); item.appendChild(link); item.appendChild(del);
      menu.appendChild(item);
      menu.appendChild(panel);
    };
    row(null);                                        // the base / "global" identity
    for (const p of list) row(p);

    const newRow = document.createElement('div');
    newRow.className = 'pm-new';
    const input = document.createElement('input');
    input.type = 'text'; input.placeholder = 'New profile name';
    const add = document.createElement('button');
    add.textContent = 'Create';
    newRow.appendChild(input); newRow.appendChild(add);

    // Namespace chooser for the new profile — collapsed, defaulting to `sessions` (the backend's default),
    // so `create` sends the same set unless the user opens it and changes the selection.
    const choose = document.createElement('div');
    choose.className = 'pm-ns-choose';
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'pm-ns-toggle'; toggle.textContent = 'Isolated namespaces ▾';
    const { box: createBox, current: createCurrent } =
      namespaceChecklist(namespaces, namespaces.includes('sessions') ? ['sessions'] : []);
    createBox.hidden = true;
    toggle.addEventListener('click', (e) => { e.stopPropagation(); createBox.hidden = !createBox.hidden; });
    choose.appendChild(toggle); choose.appendChild(createBox);

    const create = async () => {
      const name = input.value.trim();
      if (!name) return;
      try { await callTool('profile_action', { action: 'create', name, isolated: createCurrent() }); }
      catch (err) { alert(String(err)); return; }
      selectProfile(name);                            // switch to the freshly-created profile
    };
    add.addEventListener('click', create);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
    menu.appendChild(newRow);
    menu.appendChild(choose);
  };

  const refresh = async () => {
    let list = [], namespaces = [];
    try {
      const [listed, ns] = await Promise.all([
        callTool('profile_action', { action: 'list' }),
        callTool('profile_action', { action: 'available_namespaces' }),
      ]);
      list = listed.profiles; namespaces = ns;
    } catch { /* keep last */ }
    render(list, namespaces);
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) {
      const r = btn.getBoundingClientRect();
      menu.style.left = r.left + 'px';
      menu.style.top  = (r.bottom + 4) + 'px';
      refresh();
      menu.hidden = false;
    } else {
      menu.hidden = true;
    }
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) menu.hidden = true;
  });

  refresh();                                          // initial render, also pulling the isolatable-namespace set
}

// ── Sharing (chat-header) ─────────────────────────────────────────────────────────
// The share button is capability-gated on the same `profile` tool as the profile selector, and only
// appears once a session is open (there's nothing to share otherwise). Clicking pops a small menu of
// target profiles (those that isolate `sessions`, minus the active one) and POSTs `share` per pick.
function updateShareBtn() {
  if (!shareBtn) return;
  shareBtn.hidden = !(profilesActive && currentSessionId);
}

// Resolve ownership of the open session and reflect it: a session shared IN from another profile can't be
// re-shared (hide the button) and is read-only (show a badge — writes to it are rejected by the backend
// and surface as a turn error). Owned/new sessions clear the badge and show the button. Guarded against a
// late resolve after the user navigated away.
async function refreshShareState(sessionId) {
  const badge = document.getElementById('readonly-badge');
  if (badge) badge.hidden = true;
  setComposerReadOnly(false);                          // optimistic: owned/new until the owner call says otherwise
  updateShareBtn();
  if (!profilesActive || !sessionId) return;
  let owner = null;
  try {
    const r = await callTool('share', { action: 'owner', namespace: 'sessions', id: sessionId });
    owner = 'owner' in r ? r.owner : null;
  } catch { return; }
  if (sessionId !== currentSessionId) return;
  if (owner != null) {                                 // '' = owned by global/base; null = owned by me
    if (shareBtn) shareBtn.hidden = true;
    if (badge) { badge.textContent = 'read-only · ' + (owner || 'global'); badge.hidden = false; }
    setComposerReadOnly(true, owner);
  }
}

// Disable the composer for a shared-in (read-only) session: the textarea is disabled and the send button
// is gated via CSS (a class, not `disabled`, so setStop's busy handling doesn't fight it). The backend
// rejects the write regardless — this just spares the user a doomed submit. `owner` (the partition that
// can modify it; '' = global/base) is named in the placeholder so the user knows who to ask.
function setComposerReadOnly(ro, owner) {
  composerReadOnly = ro;
  const row = document.getElementById('input-row');
  if (row) row.classList.toggle('read-only', ro);
  inputEl.disabled = ro;
  inputEl.placeholder = ro
    ? `This conversation was shared by "${owner || 'global'}" and is read-only.`
    : 'Shift+⬅️ to send, ⬅️ for newline';
}

function setupShare() {
  const menu = document.getElementById('share-menu');
  if (!shareBtn || !menu) return;

  const open = async () => {
    if (!currentSessionId) return;
    menu.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'sm-title'; loading.textContent = 'Loading profiles…';
    menu.appendChild(loading);
    const r = shareBtn.getBoundingClientRect();
    menu.style.left = 'auto';
    menu.style.right = (window.innerWidth - r.right) + 'px';
    menu.style.top   = (r.bottom + 6) + 'px';
    menu.hidden = false;

    let profiles;
    try { profiles = (await callTool('profile_action', { action: 'list' })).profiles; }
    catch { menu.hidden = true; return; }
    const active  = currentProfileName();
    const targets = profiles.filter(p => p.name !== active && (p.isolated || []).includes('sessions'));

    menu.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'sm-title';
    title.textContent = targets.length
      ? 'Share this conversation with:'
      : 'No other profile isolates "sessions" to share into.';
    menu.appendChild(title);

    for (const p of targets) {
      const item   = document.createElement('div');
      item.className = 'pm-item';
      const nm     = document.createElement('span'); nm.className = 'pm-name'; nm.textContent = p.name;
      const status = document.createElement('span'); status.className = 'sm-status';
      item.appendChild(nm); item.appendChild(status);
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        status.textContent = '…'; item.title = '';
        try {
          await callTool('share', { namespace: 'sessions', id: currentSessionId, target: p.name });
          status.textContent = '✓';
        } catch (err) {
          status.textContent = '✗'; item.title = String(err && err.message || err);
        }
      });
      menu.appendChild(item);
    }
  };

  shareBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) open(); else menu.hidden = true;
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== shareBtn && !shareBtn.contains(e.target)) menu.hidden = true;
  });
}

setupShare();

init().catch(console.error);

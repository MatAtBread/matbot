// crypto.randomUUID requires HTTPS; patch it for plain-HTTP local access
if (crypto && typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = function() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
  };
}

// ── State ─────────────────────────────────────────────────────────────────────

// localStorage keys
const LS_FONT_SIZE      = 'fontSize';
const LS_PROVIDER       = 'provider';
const LS_SIDEBAR        = 'sidebarSections';
const LS_SIDEBAR_WIDTH  = 'sidebarWidth';

let currentSessionId = null;
let sending = false;          // current session busy? mirrors the server's 'session-busy' status
const busySessions   = new Set();
const unreadSessions = new Set();
const updatedFiles   = new Set();

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
let programmaticScroll = false; // true while *we* are moving scrollTop (so the
                                // 'scroll' event handler can ignore it)

function isScrollSuppressed() {
  return Date.now() < scrollSuppressUntil;
}

// Call this wrapper before any programmatic scroll so the scroll-listener can
// distinguish user-initiated scrolls from our own.
function programmaticScrollTo(fn) {
  programmaticScroll = true;
  fn();
  // Reset the flag asynchronously — the browser fires 'scroll' synchronously
  // (or at least before the next rAF), so this is safe.
  requestAnimationFrame(() => { programmaticScroll = false; });
}

// Listen for user-initiated scrolls on the messages pane.
// 'wheel' catches mouse wheels and trackpad gestures.
// 'touchmove' catches finger-drags on touch screens.
// Together they cover the vast majority of deliberate user scrolls.
function onUserScroll() {
  if (!programmaticScroll) {
    scrollSuppressUntil = Date.now() + 5000;   // 100ms suppression (temp for testing)
  }
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

// Morph the send button into a ▼ scroll-down button. Stop is now its own button, and the input
// stays enabled while a turn runs (so you can type-ahead and queue), so neither is touched here.
function showScrollDownButton() {
  sendBtn.textContent = '▼';   // ▼
  sendBtn.classList.add('scroll-down-mode');
}

// Scroll to the very bottom of the messages pane and restore the ▶ send button. The Stop button's
// visibility is driven independently by the server's busy status, so we don't reason about it here.
function scrollToBottomAndReset() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  resetSendButton();
  inputEl.focus();
}

// Restore the send button to its normal ▶ state.
function resetSendButton() {
  sendBtn.textContent = '▶';
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
    scrollDownBtn.style.display = 'block';
  }
}



// ── Elements ──────────────────────────────────────────────────────────────────

const messagesEl     = document.getElementById('messages');
const sessionsBanner = document.getElementById('sessions-banner');
const sessionListEl  = document.getElementById('session-list');
const chatHeaderEl   = document.getElementById('chat-header');
const chatTitleEl    = document.getElementById('chat-title');
const inputEl        = document.getElementById('input');
const sendBtn        = document.getElementById('send-btn');
const stopBtn        = document.getElementById('stop-btn');
const newBtn         = document.getElementById('new-btn');
const providerSel    = document.getElementById('provider-select');
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

// ── SSE parser ────────────────────────────────────────────────────────────────

function parseSSEChunk(text) {
  const events    = [];
  const blocks    = text.split('\n\n');
  const remaining = blocks.pop() ?? '';
  for (const block of blocks) {
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (data) {
      try { events.push(JSON.parse(data)); } catch { /* skip malformed */ }
    }
  }
  return { events, remaining };
}

// ── API ───────────────────────────────────────────────────────────────────────

async function apiListSessions() {
  try {
    const sessions = await callTool('session_action', { action: 'list' });
    sessionsBanner.style.display = 'none';
    return sessions;
  } catch (e) {
    if (String(e).includes('404')) sessionsBanner.style.display = 'flex';
    return [];
  }
}
async function apiGetSession(id)  { try { return await callTool('session_action', { action: 'get', sessionId: id }); } catch { return null; } }
async function apiSessionBusy(id) { try { const r = await fetch('/sessions/' + id); return r.ok ? (await r.json()).busy : false; } catch { return false; } }
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

async function callTool(toolName, input) {
  const res = await fetch('/tools/' + toolName, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('HTTP ' + res.status + (data.error ?? ''));
  return data;
}

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
    apiListSessions().then(renderSessions);
  } catch (e) { alert('Rename failed: ' + e.message); }
}

async function hideSession(id) {
  try {
    await callTool('session_action', { action: 'hide', sessionId: id });
    const sessions = await apiListSessions();
    if (id === currentSessionId) {
      currentSessionId = sessions[0]?.id ?? null;
      if (currentSessionId) { await openSession(currentSessionId); return; }
      showEmpty();
      if (chatHeaderEl) chatTitleEl.textContent = '';
    }
    renderSessions(sessions);
  } catch (e) { alert('Hide failed: ' + e.message); }
}

async function apiNewSession() {
  const r = await fetch('/sessions', { method: 'POST' });
  return r.json();
}

// ── Workspace files ───────────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

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
    const div = document.createElement('div');
    div.className = 'file-item' + (updatedFiles.has(f.path) ? ' updated' : '');
    div.dataset.path = f.path;
    div.title = f.path + (f.size !== undefined ? ' (' + formatSize(f.size) + ')' : '');
    div.onclick = () => {
      updatedFiles.delete(f.path);
      div.classList.remove('updated');
      window.open('/workspace/' + f.path, '_blank');
    };
    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = f.path;
    div.appendChild(nameEl);
    if (f.size !== undefined) {
      const sizeEl = document.createElement('span');
      sizeEl.className = 'file-size';
      sizeEl.textContent = formatSize(f.size);
      div.appendChild(sizeEl);
    }
    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'file-action-btn';
    delBtn.textContent = '\u00d7';
    delBtn.title = 'Delete';
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      try {
        await callTool('workspace_action', { action: 'delete', path: f.path });
        loadFiles();
      } catch (err) {
        alert('Delete failed: ' + err.message);
      }
    };
    actions.appendChild(delBtn);
    div.appendChild(actions);
    el.appendChild(div);
  }
}

async function loadFiles() {
  try {
    const data = await callTool('workspace_action', { action: 'list' });
    const files = Array.isArray(data) ? data : (data?.files ?? []);
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
          submit('Please discover local plugins and add the workspace plugin to enable file management.');
        };
        el.appendChild(prompt);
      }
    } else {
      renderFiles([]);
    }
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
  renderPlugins(listResult.loaded ?? [], Array.isArray(localResult) ? localResult : []);
}

function renderPlugins(loaded, local) {
  const el = document.getElementById('plugin-list');
  if (!el) return;
  el.innerHTML = '';

  const loadedNames = new Set(loaded.map(p => p.name));

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
        row.textContent = name;
        if (desc) row.title = desc;
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
    if (p.description) row.title = p.description;
    row.appendChild(makePluginLabel(p.name));
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
    el.appendChild(row);
  }

  if (!loaded.length && !local.length) {
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

function renderSkills(skills) {
  const el = document.getElementById('skill-list');
  if (!el) return;
  el.innerHTML = '';

  skills = [...skills].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  for (const s of skills) {
    const row = document.createElement('div');
    row.className = 'skill-entry';
    row.onclick = () => openSkillEditor(s.name);
    row.appendChild(makePluginLabel(s.name));

    const actions = document.createElement('div');
    actions.className = 'plugin-actions';

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
let editingSkillName = null;
let skillEditor = null; // TinyMDE.Editor, created lazily on first open

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
  skillEditorOverlay.classList.add('open');
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
  skillEditorSave.onclick = async () => {
    if (editingSkillName === null) return;
    skillEditorSave.disabled = true;
    skillEditorError.textContent = '';
    try {
      await callTool('skill_action', { action: 'save', name: editingSkillName, content: skillEditor.getContent() });
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
      await callTool('workspace_action', { action: 'write', path: file.name, content: btoa(bin), encoding: 'base64' });
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

function makeTokenStatsBlock(inputTokens, outputTokens, costUsd, cacheReadTokens, cacheCreationTokens) {
  const det = document.createElement('details');
  det.className = 'token-stats';
  const sum = document.createElement('summary');
  sum.textContent = 'tokens';
  const body = document.createElement('div');
  body.className = 'token-stats-body';
  const s = (t) => { const el = document.createElement('span'); el.textContent = t; return el; };
  let inLabel = '\u2191 ' + inputTokens.toLocaleString() + ' in';
  if (cacheReadTokens > 0) inLabel += ' (' + cacheReadTokens.toLocaleString() + ' cached)';
  body.appendChild(s(inLabel));
  body.appendChild(s('\u2193 ' + outputTokens.toLocaleString() + ' out'));
  if (cacheCreationTokens > 0) body.appendChild(s('\u2601 ' + cacheCreationTokens.toLocaleString() + ' written'));
  if (costUsd > 0) body.appendChild(s('\u2248 $' + costUsd.toFixed(4)));
  det.appendChild(sum);
  det.appendChild(body);
  return det;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function showEmpty() {
  messagesEl.innerHTML =
    '<div class=\"empty-state\">' +
    '<strong>Start a conversation</strong>' +
    '<span>Type a message below to begin.</span>' +
    '</div>';
}

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

    const hideBtn = document.createElement('button');
    hideBtn.className = 'session-action-btn';
    hideBtn.textContent = '\u00d7';
    hideBtn.title = 'Hide';
    hideBtn.onclick = e => { e.stopPropagation(); hideSession(s.id); };

    actions.appendChild(renameBtn);
    actions.appendChild(hideBtn);
    el.appendChild(labelEl);
    el.appendChild(actions);
    sessionListEl.appendChild(el);
  }
}

function appendUserBubble(text, msgIdx, pending) {
  messagesEl.querySelector('.empty-state')?.remove();
  if (messagesEl.querySelector('.message')) {
    messagesEl.appendChild(createMsgDivider(msgIdx));
  }
  const div = document.createElement('div');
  div.className = 'message user' + (pending ? ' pending' : '');
  const inner = document.createElement('div');
  inner.className = 'md-body';
  inner.innerHTML = md(text);
  div.appendChild(inner);
  messagesEl.appendChild(div);
  // Scroll the user's own message into view (they just sent it).
  // Respect the suppression timer in case they scrolled away earlier.
  if (!isScrollSuppressed()) {
    programmaticScrollTo(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }
  return div;
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
  for (const [icon, label, action, danger] of [
    ['🔗', 'Copy link', 'copy-link', false],
    ['✂',  'Cut',             'cut',       true],
    ['⎇',  'Fork',            'fork',      false],
    ['🗜', 'Compact',   'compact',   true],
    ['⇉',  'Split',          'split',      false],
  ]) {
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
        apiListSessions().then(renderSessions);
      }
    } else if (action === 'cut') {
      if (!confirm('Delete all messages from this point forward?')) return;
      await callTool('session_edit', { action: 'cut', sessionId: currentSessionId, msgIndex: msgIdx });
      const session = await apiGetSession(currentSessionId);
      if (session) renderSession(session);
    } else if (action === 'split') {
      if (!confirm('Split session at this point? Messages before will be moved to a new session.')) return;
      const result = await callTool('session_edit', { action: 'split', sessionId: currentSessionId, msgIndex: msgIdx });
      if (result?.newSessionId) {
        // Navigate to the current (trimmed) session
        await openSession(result.currentSessionId);
        apiListSessions().then(renderSessions);
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
    submit('Please discover and install the edit-session plugin');
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

function createAssistantWrap(labelText) {
  messagesEl.querySelector('.empty-state')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'message assistant';
  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = labelText || 'assistant';
  wrap.appendChild(label);
  messagesEl.appendChild(wrap);
  return wrap;
}

// Render marker blocks as centered cross-thread notices. Markers are opaque to the LLM; the UI
// is free to interpret known creators. Unknown creators get a generic, non-navigating chip.
function appendMarker(content) {
  messagesEl.querySelector('.empty-state')?.remove();
  for (const part of content) {
    if (part.type !== 'marker') continue;
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

  const icon = document.createElement('span');
  icon.className = 'marker-icon';
  icon.textContent = '🔖';
  note.appendChild(icon);
  const text = document.createElement('span');
  text.textContent = part.creator + ': ' + JSON.stringify(data);
  note.appendChild(text);
  return note;
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
      const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      // Stored history is pure committed messages; queued/pending items arrive via the live stream,
      // not from here.
      if (text) appendUserBubble(text, origIdx);
    } else if (msg.role === 'assistant') {
      const wrap = createAssistantWrap('assistant');
      renderContentParts(wrap, msg.content);
    } else if (msg.role === 'tool') {
      // Results are attached to their matching .tool-block via data-call-id; no wrapper needed.
      const dummy = document.createDocumentFragment();
      renderContentParts(dummy, msg.content);
    } else if (msg.role === 'marker') {
      appendMarker(msg.content);
    }
  }
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
  unreadSessions.delete(id);
  sessionListEl.querySelector('[data-sid="' + id + '"]')?.classList.remove('unread');
  location.hash = id;
  const [sessions, session, busy] = await Promise.all([apiListSessions(), apiGetSession(id), apiSessionBusy(id)]);
  renderSessions(sessions);
  if (session) {
    renderSession(session, undefined, scrollTarget);
    if (chatHeaderEl) chatTitleEl.textContent = session.title ?? '';
  }
  sending = busy;
  setStop(busy);
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
    location.hash = id;
    showEmpty();
    if (chatHeaderEl) chatTitleEl.textContent = '';
    const sessions = await apiListSessions();
    renderSessions(sessions);
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
// A single GET /sessions/:id/events SSE carries ALL turns for the session. Events are demuxed by
// traceId into per-turn queues, each drained by renderTurn(). One connection per session (not per
// submission) is what keeps queued submits off the browser's ~6-socket-per-host limit — the cause
// of both the missing-queued-badge and the prompt-stall bugs.

let streamSessionId = null;       // session the persistent stream is bound to
let streamAc        = null;       // AbortController for the current stream
const turnQueues    = new Map();  // traceId -> { items, wake, done, started }

function queueFor(traceId) {
  let q = turnQueues.get(traceId);
  if (!q) { q = { items: [], wake: null, done: false, started: false }; turnQueues.set(traceId, q); }
  return q;
}

function pushTurnEvent(ev) {
  const q = queueFor(ev.traceId);
  q.items.push(ev);
  if (ev.type === 'done' || ev.type === 'aborted' || ev.type === 'error' || ev.type === 'cancelled') q.done = true;
  if (q.wake) { const w = q.wake; q.wake = null; w(); }
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
  const ac = streamAc;
  while (!ac.signal.aborted && sid === currentSessionId) {
    try {
      const res = await fetch('/sessions/' + sid + '/events', { signal: ac.signal });
      if (!res.ok || !res.body) break;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ac.signal.aborted || sid !== currentSessionId) { reader.cancel(); break; }
        buf += dec.decode(value, { stream: true });
        const parsed = parseSSEChunk(buf);
        buf = parsed.remaining;
        for (const ev of parsed.events) pushTurnEvent(ev);
      }
    } catch (e) {
      if (ac.signal.aborted) return;
    }
    if (ac.signal.aborted || sid !== currentSessionId) return;
    await new Promise(r => setTimeout(r, 1000)); // reconnect backoff
  }
}

// Read the input box and submit it. The single entry point for *typed* messages; canned/programmatic
// messages (plugin install banners, etc.) call submit() directly so they aren't gated by the input.
async function sendMessage() {
  const content = inputEl.value.trim();
  if (!content) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  await submit(content);
}

// Submit typed content to the current session, fire-and-forget. The server enqueues it and the
// turn (its 'queued' user bubble + response) renders entirely over the persistent stream — there's
// no optimistic rendering here, so there's a single source of truth.
async function submit(content) {
  const provider = providerSel.value;
  if (!content || !provider) return;
  if (!currentSessionId) {
    const { id } = await apiNewSession();
    currentSessionId = id;
  }
  // Ensure the persistent event stream is bound to this session before we enqueue, so the turn's
  // events have a consumer (covers the just-created session and the "New session" button path).
  if (streamSessionId !== currentSessionId) connectSessionStream(currentSessionId);
  await postSubmit(currentSessionId, content);
}

// POST a submission and return. The user bubble + response arrive on the stream as a 'queued' event
// then turn events. Only *failures* are surfaced here (the stream can't, since no turn was created):
// a timeout (incl. the socket-exhaustion stall that never errors on its own), network error, or
// non-2xx is shown inline so the message is never silently lost.
async function postSubmit(sid, content) {
  const provider = providerSel.value;
  if (!provider) return;
  try {
    const res = await fetch('/sessions/' + sid + '/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, provider }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showSubmitError(content, data.error || ('HTTP ' + res.status));
    }
  } catch (e) {
    showSubmitError(content, e.name === 'TimeoutError' ? 'submit timed out (no response)' : String(e));
  }
}

// The submission never reached a turn, so show what was typed plus the failure, inline.
function showSubmitError(content, msg) {
  const text = typeof content === 'string' ? content : '';
  if (text) appendUserBubble(text);
  const div = document.createElement('div');
  div.className = 'msg-error';
  div.textContent = '[send failed: ' + msg + ']';
  messagesEl.appendChild(div);
}

// Render one turn by draining its event queue, keyed by traceId. The user bubble is created from
// the 'queued' event (so it lands in the live delta in stream order); the assistant wrap + loading
// dots are created lazily on first activity. A turn we merely joined (the in-progress run, replayed
// on connect) gets no 'queued' — its user message is already in committed/stored history.
async function renderTurn(sid, traceId) {
  let userBubble = null;   // set by the 'queued' event when this turn is a fresh submission
  let turnWrap   = null;   // assistant wrap, created lazily
  let loadingEl  = null;
  let started    = false;

  // First visible activity for this turn: drop the queued egg-timer and create the assistant wrap
  // with loading dots. Idempotent.
  function markStarted() {
    if (started) return;
    started = true;
    if (userBubble) userBubble.classList.remove('pending');
    turnWrap = createAssistantWrap('assistant');
    loadingEl = document.createElement('div');
    loadingEl.className = 'msg-loading';
    turnWrap.appendChild(loadingEl);
  }
  function removeLoading() { markStarted(); if (loadingEl) { loadingEl.remove(); loadingEl = null; } }

  // Per-turn streaming state
  let textEl          = null;
  let textAccum       = '';
  let textElFinalised = false;
  let thinkingContent = null;
  let thinkingAccum   = '';
  let currentTool     = null;
  let providerToolPending = false;
  let pluginToolPending   = false;
  let turnIn          = 0;
  let turnOut         = 0;
  let turnCost        = 0;
  let turnCacheRead   = 0;
  let turnCacheCreate = 0;


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
            if (text) userBubble = appendUserBubble(text, undefined, ev.queued > 0);
          }
          if (ev.queued === 0) markStarted();
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
          if (ev.name === 'plugin')   pluginToolPending   = true;
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

        case 'tool:end': {
          if (currentTool) {
            currentTool.appendChild(makeToolResultBlock(ev.result, ev.isError));
            currentTool.open = false;
          }
          currentTool = null;
          textElFinalised = true;
          textAccum = '';
          if (providerToolPending && !ev.isError) { providerToolPending = false; refreshProviderSelect(); }
          if (pluginToolPending   && !ev.isError) { pluginToolPending   = false; loadPlugins(); }
          break;
        }

        case 'usage':
          turnIn  += ev.inputTokens;
          turnOut += ev.outputTokens;
          if (ev.costUsd              !== undefined) turnCost        += ev.costUsd;
          if (ev.cacheReadTokens     !== undefined) turnCacheRead   += ev.cacheReadTokens;
          if (ev.cacheCreationTokens !== undefined) turnCacheCreate += ev.cacheCreationTokens;
          break;

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
          const answer = await new Promise(resolve => {
            const block = document.createElement('div');
            block.className = 'prompt-block';
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
                btn.onclick = () => {
                  row.querySelectorAll('button').forEach(b => { b.disabled = true; });
                  resolve(choice);
                };
                if (isDefault) defaultBtn = btn;
                row.appendChild(btn);
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
                inp.disabled = true;
                btn.disabled = true;
                resolve(inp.value.trim() || defaultValue || '');
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
          await fetch('/sessions/' + sid + '/prompt', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ answer }),
          });
          break;
        }

        case 'robo-user': {
          const text = (ev.content ?? [])
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');
          if (text) appendUserBubble(text); // index filled in by 'done' handler below
          break;
        }

        case 'aborted': {
          removeLoading();
          if (ev.reason === 'user-abort') {
            // Partial content already in DOM and saved to store — nothing to re-render.
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
          if (turnWrap && (turnIn > 0 || turnOut > 0)) turnWrap.appendChild(makeTokenStatsBlock(turnIn, turnOut, turnCost, turnCacheRead, turnCacheCreate));
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
          errDiv.textContent = '[error: ' + (ev.error ?? ev.message ?? 'unknown') + ']';
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
    errDiv.textContent = '[error: ' + e.message + ']';
    turnWrap.appendChild(errDiv);
  } finally {
    // Don't markStarted() here — a turn that was only queued then cancelled must not spawn an empty
    // assistant wrap. Just clear any loading dots that are still showing.
    if (loadingEl) { loadingEl.remove(); loadingEl = null; }
    apiListSessions().then(renderSessions);
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
  submit('Discover the local plugins and add the sessions plugin to enable persistent conversations.');
};

inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); sendMessage(); }
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

function requestStop() {
  const target = currentSessionId;
  if (!target) return;
  stopBtn.disabled = true;
  // Server-side this aborts the running turn AND drops everything still queued for the session;
  // the resulting aborted/cancelled events tidy the rendered turns over the persistent stream.
  fetch('/sessions/' + target + '/abort', { method: 'POST' })
    .catch(() => {})
    .finally(() => { stopBtn.disabled = false; });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Configure marked
  if (typeof marked !== 'undefined') {
    marked.use({ breaks: true, gfm: true });
  }

  {
    const MIN = 10, MAX = 22;
    function adjust(delta) {
      const cur = parseFloat(getComputedStyle(document.body).fontSize);
      const next = Math.min(MAX, Math.max(MIN, Math.round(cur) + delta));
      document.documentElement.style.setProperty('--fs', next + 'px');
      localStorage.setItem(LS_FONT_SIZE, next);
    }
    document.getElementById('fs-down').addEventListener('click', () => adjust(-1));
    document.getElementById('fs-up').addEventListener('click',   () => adjust(+1));
  };

  // ── Attach scroll listeners for user-scroll detection ─────────
  // 'wheel' catches mouse wheel + trackpad gestures.
  // 'touchmove' catches finger-drags on touch screens.
  // The 'scroll' event on #messages catches scrollbar dragging and
  // keyboard scrolling (PgUp / PgDn / arrows when messagesEl is focused).
  // We use the programmaticScroll flag to ignore scrolls we triggered.
  messagesEl.addEventListener('wheel', onUserScroll, { passive: true });
  messagesEl.addEventListener('touchmove', onUserScroll, { passive: true });
    messagesEl.addEventListener('scroll', () => {
    if (!programmaticScroll) {
      scrollSuppressUntil = Date.now() + 5000;   // 100ms (testing)
      // Update floating ▼ button visibility.
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

  const [sessions, providers] = await Promise.all([apiListSessions(), apiListProviders()]);

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

  // Subscribe to server-pushed session busy/idle events.
  (function connectStatusStream() {
    const es = new EventSource('/sessions/events');
    es.addEventListener('session-busy', e => {
      const { sessionId, busy } = JSON.parse(e.data);
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
      if (sessionId === currentSessionId) { sending = busy; setStop(busy); }
    });
    es.onerror = () => { es.close(); setTimeout(connectStatusStream, 3000); };
  })();

  // Subscribe to workspace file-change events.
  (function connectFileWatchStream() {
    const es = new EventSource('/workspace/events');
    es.addEventListener('file-changed', e => {
      const event = JSON.parse(e.data);
      const { name } = event;
      const el = document.getElementById('file-list');
      const item = el?.querySelector('[data-path="' + CSS.escape(name) + '"]');
      if (item) {
        updatedFiles.add(name);
        item.classList.add('updated');
        // Update the size display if present.
        const sizeEl = item.querySelector('.file-size');
        if (sizeEl && event.size !== undefined) sizeEl.textContent = formatSize(event.size);
      } else {
        // New file — mark updated before reloading so the dot appears.
        updatedFiles.add(name);
        loadFiles();
      }
    });
    es.onerror = () => { es.close(); setTimeout(connectFileWatchStream, 3000); };
  })();

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
  const raw      = location.hash.slice(1);
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

init().catch(console.error);

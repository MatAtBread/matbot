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

let currentSessionId = null;
let sending = false;
let sendingForSession = null; // session ID that owns the current sending = true state
let stopRequested = false;   // true once the user has clicked stop for the current turn

// ── Elements ──────────────────────────────────────────────────────────────────

const messagesEl     = document.getElementById('messages');
const sessionListEl  = document.getElementById('session-list');
const chatHeaderEl   = document.getElementById('chat-header');
const chatTitleEl    = document.getElementById('chat-title');
const inputEl        = document.getElementById('input');
const sendBtn        = document.getElementById('send-btn');
const newBtn         = document.getElementById('new-btn');
const providerSel    = document.getElementById('provider-select');
const burgerBtn      = document.getElementById('burger');
const sidebarOverlay = document.getElementById('sidebar-overlay');

function closeSidebar() { document.body.classList.remove('sidebar-open'); }
if (burgerBtn)      burgerBtn.onclick      = () => document.body.classList.toggle('sidebar-open');
if (sidebarOverlay) sidebarOverlay.onclick = closeSidebar;

// ── Sidebar section collapse / expand ──────────────────────────────────────────

const SIDEBAR_KEY = 'matbot:sidebar-sections';

function loadSidebarState() {
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    for (const [name, collapsed] of Object.entries(state)) {
      const section = document.querySelector('.sidebar-section[data-section="' + name + '"]');
      if (section && collapsed) section.classList.add('collapsed');
    }
  } catch { /* ignore */ }
}

function saveSidebarState() {
  const state = {};
  for (const el of document.querySelectorAll('.sidebar-section[data-section]')) {
    state[el.dataset.section] = el.classList.contains('collapsed');
  }
  localStorage.setItem(SIDEBAR_KEY, JSON.stringify(state));
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

async function apiListSessions()  { const r = await fetch('/sessions');        return r.ok ? r.json() : []; }
async function apiGetSession(id)  { const r = await fetch('/sessions/'+id);    return r.ok ? r.json() : null; }
async function apiListProviders() { const r = await fetch('/providers');        return r.ok ? r.json() : []; }

// ── Tool API ──────────────────────────────────────────────────────────────────

async function callTool(toolName, input) {
  const res = await fetch('/tools/' + toolName, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'HTTP ' + res.status);
  return data;
}

// Join an in-progress server run for sessionId. renderedCount is the number of
// non-system messages already in the DOM so incremental appends start from there.
async function joinSessionStream(id, renderedCount) {
  let streamRes;
  try { streamRes = await fetch('/sessions/' + id + '/stream'); }
  catch { return; }

  if (!streamRes.ok || !streamRes.body) {
    // Run already finished — append any messages not yet rendered.
    if (id === currentSessionId) {
      const s = await apiGetSession(id);
      if (s) {
        renderSession(s, renderedCount);
        if (chatHeaderEl) chatTitleEl.textContent = s.title || '';
        apiListSessions().then(renderSessions);
      }
    }
    return;
  }

  // Active stream — join it and render events incrementally.
  setSending(true, id);
  const turnWrap = createAssistantWrap('assistant');
  const loadingEl = document.createElement('div');
  loadingEl.className = 'msg-loading';
  turnWrap.appendChild(loadingEl);
  function removeLoading() { loadingEl.remove(); }

  let textEl = null, textAccum = '', thinkingContent = null, thinkingAccum = '', currentTool = null;
  let turnIn = 0, turnOut = 0, turnCost = 0, turnCacheRead = 0, turnCacheCreate = 0;
  function getOrMakeTextEl() {
    if (!textEl) { textEl = document.createElement('div'); textEl.className = 'msg-text md-body'; turnWrap.appendChild(textEl); }
    return textEl;
  }

  try {
    const reader = streamRes.body.getReader();
    const dec    = new TextDecoder();
    let   buf    = '';
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (id !== currentSessionId) { reader.cancel(); break; }
      buf += dec.decode(value, { stream: true });
      const { events, remaining } = parseSSEChunk(buf);
      buf = remaining;
      for (const ev of events) {
        switch (ev.type) {
          case 'text-delta':
            removeLoading();
            textAccum += ev.delta;
            getOrMakeTextEl().innerHTML = md(textAccum);
            break;
          case 'thinking': {
            removeLoading();
            if (!thinkingContent) {
              const { details, content: c } = makeThinkingBlock('\ud83d\udcad Thinking', true);
              turnWrap.insertBefore(details, textEl);
              thinkingContent = c;
            }
            thinkingAccum += ev.delta;
            thinkingContent.textContent = thinkingAccum;
            break;
          }
          case 'tool:start': {
            removeLoading();
            currentTool = makeToolBlock(ev.name, ev.input);
            turnWrap.appendChild(currentTool);
            break;
          }
          case 'tool:stdout':
          case 'tool:stderr': {
            if (currentTool) {
              let outEl = currentTool.querySelector('.tool-output');
              if (!outEl) { outEl = document.createElement('pre'); outEl.className = 'tool-output'; currentTool.appendChild(outEl); }
              outEl.textContent += ev.chunk;
              outEl.scrollTop = outEl.scrollHeight;
            }
            break;
          }
          case 'tool:end': currentTool = null; break;
          case 'usage':
            turnIn  += ev.inputTokens; turnOut += ev.outputTokens;
            if (ev.costUsd              !== undefined) turnCost      += ev.costUsd;
            if (ev.cacheReadTokens     !== undefined) turnCacheRead  += ev.cacheReadTokens;
            if (ev.cacheCreationTokens !== undefined) turnCacheCreate += ev.cacheCreationTokens;
            break;
          case 'done':
            if (thinkingContent) { const det = thinkingContent.closest('details'); if (det) det.open = false; }
            if (ev.session?.title && chatHeaderEl) chatTitleEl.textContent = ev.session.title;
            if (turnIn > 0 || turnOut > 0) turnWrap.appendChild(makeTokenStatsBlock(turnIn, turnOut, turnCost, turnCacheRead, turnCacheCreate));
            loadFiles();
            break outer;
          case 'aborted':
            removeLoading();
            if (ev.reason !== 'user-abort') {
              turnWrap.remove();
              if (ev.session && id === currentSessionId) renderSession(ev.session);
            }
            break outer;
          case 'error': {
            removeLoading();
            const errDiv = document.createElement('div');
            errDiv.className = 'msg-error';
            errDiv.textContent = '[error: ' + (ev.error ?? ev.message ?? 'unknown') + ']';
            turnWrap.appendChild(errDiv);
            break outer;
          }
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }
  } catch (e) {
    removeLoading();
    const errDiv = document.createElement('div');
    errDiv.className = 'msg-error';
    errDiv.textContent = '[error: ' + e.message + ']';
    turnWrap.appendChild(errDiv);
  } finally {
    removeLoading();
    setSending(false, id);
    apiListSessions().then(renderSessions);
    loadFiles();
  }
}

async function renameSession(id, current) {
  const title = window.prompt('Rename session:', current ?? '');
  if (!title || !title.trim()) return;
  try {
    await callTool('session_rename', { sessionId: id, title: title.trim() });
    if (id === currentSessionId && chatHeaderEl) chatTitleEl.textContent = title.trim();
    apiListSessions().then(renderSessions);
  } catch (e) { alert('Rename failed: ' + e.message); }
}

async function hideSession(id) {
  try {
    await callTool('session_hide', { sessionId: id });
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
    div.className = 'file-item';
    div.title = f.path + (f.size !== undefined ? ' (' + formatSize(f.size) + ')' : '');
    div.onclick = () => { window.open('/workspace/' + f.path, '_blank'); };
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
        await callTool('workspace_delete', { path: f.path });
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
    const data = await callTool('workspace_list', {});
    const files = Array.isArray(data) ? data : (data?.files ?? []);
    renderFiles(files);
  } catch (e) {
    console.error('loadFiles failed:', e);
    renderFiles([]);
  }
}

async function* streamSubmit(sessionId, content, provider) {
  const res = await fetch('/sessions/' + sessionId + '/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, provider }),
  });
  if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  let   buf    = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const { events, remaining } = parseSSEChunk(buf);
    buf = remaining;
    for (const ev of events) yield ev;
  }
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

function makeToolBlock(name, input) {
  const wrap = document.createElement('div');
  wrap.className = 'tool-block';
  const header = document.createElement('div');
  header.className = 'tool-header';
  header.textContent = '\u2699 ' + name;
  wrap.appendChild(header);
  const inputStr = input !== undefined && input !== null
    ? (typeof input === 'string' ? input : JSON.stringify(input, null, 2))
    : '';
  if (inputStr && inputStr !== '{}') {
    const det = document.createElement('details');
    det.className = 'tool-args';
    const sum = document.createElement('summary');
    sum.textContent = 'input';
    const pre = document.createElement('pre');
    pre.textContent = inputStr;
    det.appendChild(sum);
    det.appendChild(pre);
    wrap.appendChild(det);
  }
  return wrap;
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
    el.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
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

function appendUserBubble(text) {
  messagesEl.querySelector('.empty-state')?.remove();
  const div = document.createElement('div');
  div.className = 'message user';
  const inner = document.createElement('div');
  inner.className = 'md-body';
  inner.innerHTML = md(text);
  div.appendChild(inner);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
        wrap.appendChild(makeToolBlock(part.name, part.input));
        break;
      case 'tool-result':
        wrap.appendChild(makeToolResultBlock(part.result, part.isError));
        break;
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
function renderSession(session, startIdx) {
  const msgs = session.messages.filter(m => m.role !== 'system');
  if (!startIdx) {
    if (!msgs.length) { showEmpty(); return; }
    messagesEl.innerHTML = '';
  }
  for (const msg of msgs.slice(startIdx ?? 0)) {
    if (msg.role === 'user') {
      const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (text) appendUserBubble(text);
    } else if (msg.role === 'assistant') {
      const wrap = createAssistantWrap('assistant');
      renderContentParts(wrap, msg.content);
    } else if (msg.role === 'tool') {
      const wrap = document.createElement('div');
      wrap.className = 'message tool-turn';
      renderContentParts(wrap, msg.content);
      messagesEl.appendChild(wrap);
    }
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function openSession(id) {
  closeSidebar();
  currentSessionId = id;
  location.hash = id;
  // Reset button state for the incoming session; watchUntilDone will re-lock if it's busy.
  setSending(false, id);
  const [sessions, session] = await Promise.all([apiListSessions(), apiGetSession(id)]);
  renderSessions(sessions);
  if (session) {
    renderSession(session);
    if (chatHeaderEl) chatTitleEl.textContent = session.title ?? '';
    if (session.busy) {
      const renderedCount = session.messages.filter(m => m.role !== 'system').length;
      joinSessionStream(id, renderedCount);
    }
  }
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
  const provider = providerSel.value;
  if (sending || !provider || !sessionId) return;
  setSending(true, sessionId);

  const turnWrap = createAssistantWrap('assistant');
  const loadingEl = document.createElement('div');
  loadingEl.className = 'msg-loading';
  turnWrap.appendChild(loadingEl);
  function removeLoading() { loadingEl.remove(); }

  let textEl = null, textAccum = '', thinkingContent = null, thinkingAccum = '', currentTool = null;
  let turnIn = 0, turnOut = 0, turnCost = 0, turnCacheRead = 0, turnCacheCreate = 0;
  function getOrMakeTextEl() {
    if (!textEl) { textEl = document.createElement('div'); textEl.className = 'msg-text md-body'; turnWrap.appendChild(textEl); }
    return textEl;
  }

  try {
    for await (const ev of streamSubmit(sessionId, { type: 'form-response', values }, provider)) {
      switch (ev.type) {
        case 'text-delta':
          removeLoading();
          textAccum += ev.delta;
          getOrMakeTextEl().innerHTML = md(textAccum);
          break;
        case 'thinking': {
          removeLoading();
          if (!thinkingContent) {
            const { details, content: c } = makeThinkingBlock('\ud83d\udcad Thinking', true);
            turnWrap.insertBefore(details, textEl);
            thinkingContent = c;
          }
          thinkingAccum += ev.delta;
          thinkingContent.textContent = thinkingAccum;
          break;
        }
        case 'tool:start': {
          removeLoading();
          currentTool = makeToolBlock(ev.name, ev.input);
          turnWrap.appendChild(currentTool);
          break;
        }
        case 'tool:stdout':
        case 'tool:stderr': {
          if (currentTool) {
            let outEl = currentTool.querySelector('.tool-output');
            if (!outEl) { outEl = document.createElement('pre'); outEl.className = 'tool-output'; currentTool.appendChild(outEl); }
            outEl.textContent += ev.chunk;
            outEl.scrollTop = outEl.scrollHeight;
          }
          break;
        }
        case 'tool:end': currentTool = null; break;
        case 'usage':
          turnIn         += ev.inputTokens;
          turnOut        += ev.outputTokens;
          if (ev.costUsd              !== undefined) turnCost        += ev.costUsd;
          if (ev.cacheReadTokens     !== undefined) turnCacheRead   += ev.cacheReadTokens;
          if (ev.cacheCreationTokens !== undefined) turnCacheCreate += ev.cacheCreationTokens;
          break;
        case 'done':
          if (thinkingContent) { const det = thinkingContent.closest('details'); if (det) det.open = false; }
          if (ev.session?.title && chatHeaderEl) chatTitleEl.textContent = ev.session.title;
          if (turnIn > 0 || turnOut > 0) turnWrap.appendChild(makeTokenStatsBlock(turnIn, turnOut, turnCost, turnCacheRead, turnCacheCreate));
          loadFiles();
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
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  } catch (e) {
    removeLoading();
    const errDiv = document.createElement('div');
    errDiv.className = 'msg-error';
    errDiv.textContent = '[error: ' + e.message + ']';
    turnWrap.appendChild(errDiv);
  } finally {
    removeLoading();
    setSending(false, sessionId);
    apiListSessions().then(renderSessions);
    loadFiles();
  }
}

// ── Send ──────────────────────────────────────────────────────────────────────

async function sendMessage() {
  const content  = inputEl.value.trim();
  const provider = providerSel.value;
  if (!content || sending || !provider) return;

  if (!currentSessionId) {
    const { id } = await apiNewSession();
    currentSessionId = id;
  }

  const submittingFor = currentSessionId;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  setSending(true, submittingFor);

  appendUserBubble(content);
  const turnWrap = createAssistantWrap('assistant');

  // Loading dots until first content arrives
  const loadingEl = document.createElement('div');
  loadingEl.className = 'msg-loading';
  turnWrap.appendChild(loadingEl);

  function removeLoading() { loadingEl.remove(); }

  // Per-turn streaming state
  let textEl          = null;
  let textAccum       = '';
  let thinkingContent = null;
  let thinkingAccum   = '';
  let currentTool     = null;
  let turnIn          = 0;
  let turnOut         = 0;
  let turnCost        = 0;
  let turnCacheRead   = 0;
  let turnCacheCreate = 0;

  function getOrMakeTextEl() {
    if (!textEl) {
      textEl = document.createElement('div');
      textEl.className = 'msg-text md-body';
      turnWrap.appendChild(textEl);
    }
    return textEl;
  }

  try {
    for await (const ev of streamSubmit(submittingFor, content, provider)) {
      switch (ev.type) {
        case 'text-delta':
          removeLoading();
          textAccum += ev.delta;
          getOrMakeTextEl().innerHTML = md(textAccum);
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
          break;
        }

        case 'tool:start': {
          removeLoading();
          currentTool = makeToolBlock(ev.name, ev.input);
          turnWrap.appendChild(currentTool);
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

        case 'tool:end':
          currentTool = null;
          break;

        case 'usage':
          turnIn  += ev.inputTokens;
          turnOut += ev.outputTokens;
          if (ev.costUsd              !== undefined) turnCost        += ev.costUsd;
          if (ev.cacheReadTokens     !== undefined) turnCacheRead   += ev.cacheReadTokens;
          if (ev.cacheCreationTokens !== undefined) turnCacheCreate += ev.cacheCreationTokens;
          break;

        case 'prompt': {
          removeLoading();
          const rawQ       = ev.question ?? '';
          const choiceMatch = /\[([^\/\]]+)\/([^\/\]]+)\]\s*$/.exec(rawQ);
          const answer = await new Promise(resolve => {
            const block = document.createElement('div');
            block.className = 'prompt-block';
            const q = document.createElement('div');
            q.className = 'prompt-question';
            q.textContent = choiceMatch ? rawQ.slice(0, choiceMatch.index).trimEnd() : rawQ;
            block.appendChild(q);
            if (choiceMatch) {
              const choices = [choiceMatch[1], choiceMatch[2]];
              const row = document.createElement('div');
              row.className = 'prompt-choices';
              let defaultBtn = null;
              for (const choice of choices) {
                const btn = document.createElement('button');
                btn.type = 'button';
                const isDefault = choice.toLowerCase() === (ev.defaultValue ?? '').toLowerCase();
                btn.className = 'prompt-choice-btn' + (isDefault ? ' primary' : '');
                btn.textContent = choice.toLowerCase() === 'y' ? 'Yes'
                  : choice.toLowerCase() === 'n' ? 'No'
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
              messagesEl.scrollTop = messagesEl.scrollHeight;
              (defaultBtn ?? row.querySelector('button'))?.focus();
            } else {
              const row = document.createElement('div');
              row.className = 'prompt-row';
              const inp = document.createElement('input');
              inp.type = 'text';
              inp.className = 'prompt-input';
              inp.value = ev.defaultValue ?? '';
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'prompt-submit';
              btn.textContent = 'Submit';
              const submit = () => {
                inp.disabled = true;
                btn.disabled = true;
                resolve(inp.value.trim() || ev.defaultValue || '');
              };
              btn.onclick = submit;
              inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
              row.appendChild(inp);
              row.appendChild(btn);
              block.appendChild(row);
              turnWrap.appendChild(block);
              messagesEl.scrollTop = messagesEl.scrollHeight;
              inp.focus();
            }
          });
          await fetch('/sessions/' + submittingFor + '/prompt', {
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
          if (text) appendUserBubble(text);
          break;
        }

        case 'aborted': {
          removeLoading();
          if (ev.reason === 'user-abort') {
            // Partial content already in DOM and saved to store — nothing to re-render.
          } else {
            turnWrap.remove();
            if (ev.session) renderSession(ev.session);
          }
          break;
        }

        case 'done':
          if (thinkingContent) {
            const det = thinkingContent.closest('details');
            if (det) det.open = false;
          }
          if (ev.session?.title && chatHeaderEl) chatTitleEl.textContent = ev.session.title;
          if (turnIn > 0 || turnOut > 0) turnWrap.appendChild(makeTokenStatsBlock(turnIn, turnOut, turnCost, turnCacheRead, turnCacheCreate));
          loadFiles();
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
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  } catch (e) {
    removeLoading();
    const errDiv = document.createElement('div');
    errDiv.className = 'msg-error';
    errDiv.textContent = '[error: ' + e.message + ']';
    turnWrap.appendChild(errDiv);
  } finally {
    removeLoading();
    setSending(false, submittingFor);
    apiListSessions().then(renderSessions);
    loadFiles();
  }
}

sendBtn.onclick = () => { if (sending) requestStop(); else sendMessage(); };

inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); sendMessage(); }
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
});

function setSending(val, sessionId) {
  const sid = sessionId ?? currentSessionId;
  if (val) {
    sending = true;
    sendingForSession = sid;
    stopRequested = false;
    sendBtn.textContent = '\u25a0';   // ■ stop square
    sendBtn.classList.add('stop-mode');
    sendBtn.disabled = false;
    inputEl.disabled = true;
  } else {
    // Only clear if the session that set it is still the current one,
    // or if the caller is the current session (prevents session A's completion
    // from clearing session B's in-flight request).
    if (sendingForSession === sid || sid === currentSessionId) {
      sending = false;
      sendingForSession = null;
      stopRequested = false;
      sendBtn.textContent = '\u25b6'; // ▶ send arrow
      sendBtn.classList.remove('stop-mode');
      sendBtn.disabled = false;
      inputEl.disabled = false;
      inputEl.focus();
    }
  }
}

function requestStop() {
  if (!sending || stopRequested || !sendingForSession) return;
  stopRequested = true;
  sendBtn.disabled = true;
  fetch('/sessions/' + sendingForSession + '/abort', { method: 'POST' }).catch(() => {});
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Configure marked
  if (typeof marked !== 'undefined') {
    marked.use({ breaks: true, gfm: true });
  }

  const [sessions, providers] = await Promise.all([apiListSessions(), apiListProviders()]);

  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = p;
    providerSel.appendChild(opt);
  }

  const savedProvider = localStorage.getItem('matbot:provider');
  if (savedProvider && providers.includes(savedProvider)) {
    providerSel.value = savedProvider;
  }

  providerSel.addEventListener('change', () => {
    localStorage.setItem('matbot:provider', providerSel.value);
  });

  renderSessions(sessions);
  const fragmentId = location.hash.slice(1);
  const startId = (fragmentId && sessions.some(s => s.id === fragmentId))
    ? fragmentId : sessions[0]?.id;
  if (startId === 'new') {
    await handleNewSession();
  } else if (startId) {
    await openSession(startId);
  } else {
    showEmpty();
  }
  loadFiles();
}

window.addEventListener('hashchange', async () => {
  const id = location.hash.slice(1);
  if (id === 'new') {
    await handleNewSession();
  } else if (id && id !== currentSessionId) {
    openSession(id).catch(console.error);
  }
});

init().catch(console.error);

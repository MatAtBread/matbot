export const html = () => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
  <title>matbot</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }

    body {
      display: flex;
      height: 100vh;
      height: 100dvh;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      background: #fff;
      color: #111;
      overflow: hidden;
    }

    /* ── Sidebar ───────────────────────────────────────────────── */

    #sidebar {
      width: 240px;
      min-width: 240px;
      border-right: 1px solid #e5e7eb;
      display: flex;
      flex-direction: column;
      background: #f9fafb;
    }
    #sidebar h1 {
      padding: 15px 16px 14px;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: -0.01em;
      border-bottom: 1px solid #e5e7eb;
      flex-shrink: 0;
    }
    #new-btn {
      margin: 10px 12px 6px;
      padding: 8px 12px;
      background: #111;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      text-align: left;
      flex-shrink: 0;
    }
    #new-btn:hover { background: #374151; }
    #session-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px 8px 8px;
    }
    .session-item {
      padding: 5px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      color: #555;
      margin: 1px 0;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .session-item:hover  { background: #f0f0f2; color: #111; }
    .session-item.active { background: #e5e7eb; color: #111; font-weight: 500; }
    .session-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 2px 0;
    }
    .session-actions { display: none; flex-shrink: 0; }
    .session-item:hover .session-actions { display: flex; }
    .session-action-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
      font-size: 14px;
      line-height: 1;
    }
    .session-action-btn[title="Rename"] { color: #6b7280; }
    .session-action-btn[title="Hide"] { color: #ef4444; }
    .session-action-btn:hover { background: #d1d5db; color: #374151; }

    /* ── Main ──────────────────────────────────────────────────── */

    #main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    #chat-header {
      padding: 10px 28px;
      border-bottom: 1px solid #e5e7eb;
      font-size: 13px;
      font-weight: 500;
      color: #374151;
      min-height: 41px;
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }

    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 32px 28px 20px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding-bottom: 60px;
      color: #9ca3af;
      text-align: center;
    }
    .empty-state strong { font-size: 16px; font-weight: 500; color: #6b7280; }

    /* ── Message types ─────────────────────────────────────────── */

    .message { max-width: 700px; }

    /* User: right-aligned dark bubble */
    .message.user {
      align-self: flex-end;
      background: #111;
      color: #fff;
      padding: 10px 14px;
      border-radius: 12px 12px 2px 12px;
      line-height: 1.65;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* Assistant: left-aligned, no background */
    .message.assistant { align-self: flex-start; }

    /* Tool-result messages: left, subtle left border */
    .message.tool-turn {
      align-self: flex-start;
      padding-left: 10px;
      border-left: 2px solid #e5e7eb;
      margin-top: -10px;
    }

    .msg-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #9ca3af;
      margin-bottom: 6px;
    }

    /* Loading dots while waiting for first token */
    .msg-loading::after {
      content: '●●●';
      letter-spacing: 4px;
      font-size: 9px;
      color: #d1d5db;
      animation: blink 1.1s ease-in-out infinite;
    }
    @keyframes blink {
      0%, 100% { opacity: 0.25; }
      50%       { opacity: 1; }
    }

    /* ── Markdown body ─────────────────────────────────────────── */

    .md-body { line-height: 1.7; color: #111; }
    .md-body p { margin: 0 0 0.65em; }
    .md-body p:last-child { margin-bottom: 0; }
    .md-body code {
      font-family: 'SF Mono', 'Cascadia Code', ui-monospace, monospace;
      font-size: 12.5px;
      background: #f3f4f6;
      border: 1px solid #e5e7eb;
      border-radius: 3px;
      padding: 1px 5px;
    }
    .md-body pre {
      background: #f8f9fa;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      padding: 12px 14px;
      overflow-x: auto;
      margin: 0.5em 0 0.65em;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .md-body pre code { background: none; border: none; padding: 0; font-size: 13px; white-space: inherit; }
    .md-body ul, .md-body ol { padding-left: 1.4em; margin: 0.3em 0 0.65em; }
    .md-body li { margin: 0.2em 0; }
    .md-body blockquote {
      border-left: 3px solid #d1d5db;
      padding-left: 12px;
      margin: 0.5em 0;
      color: #6b7280;
    }
    .md-body h1, .md-body h2, .md-body h3 {
      font-weight: 600;
      margin: 0.7em 0 0.35em;
      line-height: 1.3;
    }
    .md-body h1 { font-size: 1.2em; }
    .md-body h2 { font-size: 1.1em; }
    .md-body h3 { font-size: 1em; }
    .md-body a { color: #2563eb; text-decoration: underline; }
    .md-body table { border-collapse: collapse; margin: 0.6em 0; font-size: 13px; width: 100%; }
    .md-body th, .md-body td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; }
    .md-body th { background: #f9fafb; font-weight: 600; }
    .md-body hr { border: none; border-top: 1px solid #e5e7eb; margin: 1em 0; }
    .md-body strong { font-weight: 600; }

    /* ── Thinking / Reasoning blocks ───────────────────────────── */

    .thinking-block {
      background: #f0f4ff;
      border: 1px solid #c7d2fe;
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 8px;
    }
    .thinking-summary {
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      color: #4338ca;
      cursor: pointer;
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .thinking-summary::-webkit-details-marker { display: none; }
    .thinking-summary::before { content: '▶'; font-size: 9px; opacity: 0.6; }
    details[open] > .thinking-summary::before { content: '▼'; }
    .thinking-content {
      padding: 8px 12px 10px;
      font-size: 12.5px;
      line-height: 1.65;
      color: #3730a3;
      white-space: pre-wrap;
      word-break: break-word;
      border-top: 1px solid #c7d2fe;
      max-height: 16vw;
      overflow-y: scroll;
    }
    .thinking-redacted {
      font-size: 12px;
      color: #9ca3af;
      font-style: italic;
      margin-bottom: 6px;
    }

    /* ── Tool blocks ───────────────────────────────────────────── */

    .tool-block {
      background: #0f172a;
      border-radius: 6px;
      overflow: hidden;
      margin: 4px 0 8px;
      font-family: 'SF Mono', 'Cascadia Code', ui-monospace, monospace;
      font-size: 12px;
    }
    .tool-header {
      padding: 6px 12px;
      color: #a78bfa;
      font-weight: 600;
      border-bottom: 1px solid #1e293b;
    }
    .tool-args {
      border-bottom: 1px solid #1e293b;
    }
    .tool-args summary {
      padding: 4px 12px;
      color: #64748b;
      cursor: pointer;
      font-size: 11px;
      list-style: none;
      user-select: none;
    }
    .tool-args summary::-webkit-details-marker { display: none; }
    .tool-args pre {
      margin: 0;
      padding: 6px 12px 8px;
      color: #94a3b8;
      font-size: 11.5px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .tool-output {
      margin: 0;
      padding: 7px 12px;
      color: #94a3b8;
      font-size: 11.5px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 16vw;
      overflow-y: auto;
    }

    /* ── Tool results ──────────────────────────────────────────── */

    .tool-result {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      margin: 2px 0 6px;
    }
    .tool-result-icon {
      flex-shrink: 0;
      font-size: 12px;
      padding-top: 3px;
      color: #16a34a;
    }
    .tool-result-error .tool-result-icon { color: #ef4444; }
    .tool-result-text {
      margin: 0;
      font-family: 'SF Mono', 'Cascadia Code', ui-monospace, monospace;
      font-size: 11.5px;
      color: #374151;
      white-space: pre-wrap;
      word-break: break-word;
      background: #f3f4f6;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      padding: 4px 8px;
      flex: 1;
      max-height: 180px;
      overflow-y: auto;
    }

    /* ── Misc message parts ────────────────────────────────────── */

    .msg-refusal {
      color: #b45309;
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 13px;
      font-style: italic;
    }
    .msg-error { color: #ef4444; font-size: 13px; }

    /* ── Token stats ─────────────────────────────────────────────── */
    .token-stats { margin-top: 6px; }
    .token-stats > summary {
      font-size: 11px;
      color: #9ca3af;
      cursor: pointer;
      user-select: none;
      list-style: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .token-stats > summary::-webkit-details-marker { display: none; }
    .token-stats > summary::before { content: '▶'; font-size: 8px; opacity: 0.5; margin-right: 2px; }
    details.token-stats[open] > summary::before { content: '▼'; }
    .token-stats-body {
      display: flex;
      gap: 12px;
      font-size: 11px;
      color: #6b7280;
      padding: 3px 0 0;
      font-family: 'SF Mono', 'Cascadia Code', ui-monospace, monospace;
    }

    /* ── Input area ────────────────────────────────────────────── */

    #input-area { border-top: 1px solid #e5e7eb; padding: 12px 28px 20px; }
    #input-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
      font-size: 12px;
      color: #9ca3af;
    }
    #provider-select {
      background: transparent;
      border: none;
      font-size: 12px;
      color: #6b7280;
      cursor: pointer;
      outline: none;
      padding: 0;
      max-width: 260px;
    }
    #provider-select:hover { color: #374151; }
    #input-row {
      display: flex;
      gap: 8px;
      align-items: flex-end;
      max-width: 700px;
    }
    #input {
      flex: 1;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      padding: 10px 12px;
      font-family: inherit;
      font-size: 14px;
      line-height: 1.5;
      resize: none;
      overflow-y: hidden;
      max-height: 180px;
      outline: none;
      transition: border-color 0.15s;
    }
    #input:focus    { border-color: #9ca3af; }
    #input:disabled { background: #f9fafb; }
    #send-btn {
      padding: 1px 6px;
      background: #111;
      color: #fff;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 30px;
      font-weight: 500;
      flex-shrink: 0;
      transition: background 0.1s;
    }
    #send-btn:hover    { background: #374151; }
    #send-btn:disabled { background: #d1d5db; cursor: not-allowed; }

    /* ── Form blocks ──────────────────────────────────────────── */

    .form-block {
      background: #f0f9ff;
      border: 1px solid #bae6fd;
      border-radius: 8px;
      padding: 14px 16px;
      max-width: 420px;
      margin-top: 4px;
    }
    .form-field-label {
      font-size: 13px;
      color: #374151;
      font-weight: 500;
      margin-bottom: 8px;
    }
    .form-select {
      border: 1px solid #d1d5db;
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 13px;
      font-family: inherit;
      background: #fff;
      outline: none;
      cursor: pointer;
      min-width: 160px;
    }
    .form-select:focus { border-color: #9ca3af; }
    .form-select:disabled { background: #f9fafb; cursor: not-allowed; }
    .form-text-input {
      border: 1px solid #d1d5db;
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      width: 100%;
      margin-bottom: 8px;
    }
    .form-text-input:focus { border-color: #9ca3af; }
    .form-actions { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
    .form-submit-btn {
      padding: 6px 16px;
      background: #111;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    .form-submit-btn:hover    { background: #374151; }
    .form-submit-btn:disabled { background: #d1d5db; cursor: not-allowed; }

    /* ── Prompt blocks ─────────────────────────────────────────── */

    .prompt-block {
      align-self: flex-start;
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: 8px;
      padding: 12px 14px;
      max-width: 500px;
      margin-top: 4px;
    }
    .prompt-question {
      font-size: 13px;
      color: #374151;
      margin-bottom: 8px;
      white-space: pre-wrap;
    }
    .prompt-row { display: flex; gap: 8px; }
    .prompt-input {
      flex: 1;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
    }
    .prompt-input:focus    { border-color: #9ca3af; }
    .prompt-input:disabled { background: #f9fafb; }
    .prompt-submit {
      padding: 6px 14px;
      background: #111;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      flex-shrink: 0;
    }
    .prompt-submit:hover    { background: #374151; }
    .prompt-submit:disabled { background: #d1d5db; cursor: not-allowed; }
    .prompt-choices { display: flex; gap: 8px; }
    .prompt-choice-btn {
      padding: 6px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      border: 1px solid #d1d5db;
      background: #fff;
      color: #374151;
      transition: background 0.1s, border-color 0.1s;
    }
    .prompt-choice-btn:hover    { background: #f3f4f6; border-color: #9ca3af; }
    .prompt-choice-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .prompt-choice-btn.primary  { background: #111; color: #fff; border-color: #111; }
    .prompt-choice-btn.primary:hover { background: #374151; border-color: #374151; }

    /* ── Scrollbar ─────────────────────────────────────────────── */
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #9ca3af; }

    /* ── Burger button (hidden on desktop) ─────────────────────── */
    #burger {
      display: none;
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px 6px;
      font-size: 20px;
      line-height: 1;
      color: #374151;
      flex-shrink: 0;
      margin-right: 6px;
    }
    #sidebar-overlay { display: none; }

    /* ── Mobile layout ─────────────────────────────────────────── */
    @media (max-width: 640px) {
      #sidebar {
        position: fixed;
        top: 0;
        left: 0;
        height: 100%;
        height: 100dvh;
        z-index: 200;
        transform: translateX(-100%);
        transition: transform 0.2s ease;
        padding-top: env(safe-area-inset-top, 0px);
      }
      body.sidebar-open #sidebar {
        transform: translateX(0);
        box-shadow: 4px 0 20px rgba(0,0,0,0.15);
      }
      #sidebar-overlay {
        position: fixed;
        inset: 0;
        z-index: 199;
        background: rgba(0,0,0,0.3);
      }
      body.sidebar-open #sidebar-overlay { display: block; }
      body {
        position: fixed;
        width: 100%;
      }
      #burger { display: block; }
      #chat-header {
        padding-left: 12px;
        padding-top: max(10px, env(safe-area-inset-top, 0px));
      }
      #messages    { padding-left: 16px; padding-right: 16px; }
      #input-area  {
        padding-left: 16px;
        padding-right: 16px;
        padding-bottom: max(20px, env(safe-area-inset-bottom, 0px));
      }
      .session-actions { display: flex; }
    }
  </style>
</head>
<body>
  <div id="sidebar-overlay"></div>
  <nav id="sidebar">
    <h1>matbot</h1>
    <button id="new-btn">+ New conversation</button>
    <div id="session-list"></div>
  </nav>

  <main id="main">
    <div id="chat-header"><button id="burger" aria-label="Open menu">&#9776;</button><span id="chat-title"></span></div>
    <div id="messages"></div>
    <div id="input-area">
      <div id="input-meta">
        <span>Provider:</span>
        <select id="provider-select"></select>
      </div>
      <div id="input-row">
        <textarea id="input" rows="1" placeholder="Message… (Shift+Enter to send, Enter for newline)"></textarea>
        <button id="send-btn">⮞</button>
      </div>
    </div>
  </main>

  <script src="/app.js"></script>
</body>
</html>`;

export const js = () => `'use strict';

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

// ── Principal ─────────────────────────────────────────────────────────────────

function userId() {
  let id = localStorage.getItem('matbot-uid');
  if (!id) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    id = h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
    localStorage.setItem('matbot-uid', id);
  }
  return id;
}

function webPrincipal() {
  return {
    id: userId(), type: 'user',
    grants: [
      { capability: 'network' },
      { capability: 'filesystem' },
      { capability: 'spawn' },
    ],
    contexts: ['web'],
  };
}

// ── Markdown ──────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

function md(text) {
  if (!text) return '';
  if (typeof marked === 'undefined') return '<p>' + escHtml(text) + '</p>';
  const result = marked.parse(text);
  // Open all links in new tab
  return result.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
}

// ── SSE parser ────────────────────────────────────────────────────────────────

function parseSSEChunk(text) {
  const events    = [];
  const blocks    = text.split('\\n\\n');
  const remaining = blocks.pop() ?? '';
  for (const block of blocks) {
    let data = '';
    for (const line of block.split('\\n')) {
      if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (data) {
      try { events.push(JSON.parse(data)); } catch { /* skip malformed */ }
    }
  }
  return { events, remaining };
}

// ── API ───────────────────────────────────────────────────────────────────────

async function apiListSessions()  { const r = await fetch('/sessions');     return r.ok ? r.json() : []; }
async function apiGetSession(id)  { const r = await fetch('/sessions/'+id); return r.ok ? r.json() : null; }
async function apiListProviders() { const r = await fetch('/providers');    return r.ok ? r.json() : []; }

// ── Tool API ──────────────────────────────────────────────────────────────────

async function callTool(toolName, input) {
  const res = await fetch('/tools/' + toolName, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, principal: webPrincipal() }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  for (const block of text.split('\\n\\n')) {
    for (const line of block.split('\\n')) {
      if (line.startsWith('data: ')) {
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'result') return ev.value;
          if (ev.type === 'error')  throw new Error(ev.message ?? ev.error ?? 'Tool error');
        } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
      }
    }
  }
  throw new Error('No result from tool');
}

// Poll until the server finishes an active turn, then re-render.
function watchUntilDone(id) {
  setSending(true, id);
  const deadline = Date.now() + 300_000;
  const poll = setInterval(async () => {
    if (Date.now() > deadline) { clearInterval(poll); setSending(false, id); return; }
    try {
      const { busy } = await apiIsSessionBusy(id);
      if (!busy) {
        clearInterval(poll);
        if (id === currentSessionId) {
          const s = await apiGetSession(id);
          if (s) {
            renderSession(s);
            if (chatHeaderEl) chatTitleEl.textContent = s.title || '';
          }
        }
        apiListSessions().then(renderSessions);
        setSending(false, id);
      }
    } catch { clearInterval(poll); setSending(false, id); }
  }, 1500);
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

async function apiIsSessionBusy(id) { const r = await fetch('/sessions/'+id+'/busy'); return r.ok ? r.json() : { busy: false }; }

async function apiNewSession() {
  const r = await fetch('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ principal: webPrincipal() }),
  });
  return r.json();
}

async function* streamSubmit(sessionId, content, provider) {
  const res = await fetch('/sessions/' + sessionId + '/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, provider, principal: webPrincipal() }),
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
  header.textContent = '\\u2699 ' + name;
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
  icon.textContent = isError ? '\\u2717' : '\\u2713';
  const pre = document.createElement('pre');
  pre.className = 'tool-result-text';
  const s = result === null || result === undefined ? ''
    : typeof result === 'string' ? result
    : JSON.stringify(result, null, 2);
  pre.textContent = s.length > 2000 ? s.slice(0, 2000) + '\\n[\\u2026 truncated]' : s;
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
  let inLabel = '\\u2191 ' + inputTokens.toLocaleString() + ' in';
  if (cacheReadTokens > 0) inLabel += ' (' + cacheReadTokens.toLocaleString() + ' cached)';
  body.appendChild(s(inLabel));
  body.appendChild(s('\\u2193 ' + outputTokens.toLocaleString() + ' out'));
  if (cacheCreationTokens > 0) body.appendChild(s('\\u2601 ' + cacheCreationTokens.toLocaleString() + ' written'));
  if (costUsd > 0) body.appendChild(s('\\u2248 $' + costUsd.toFixed(4)));
  det.appendChild(sum);
  det.appendChild(body);
  return det;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function showEmpty() {
  messagesEl.innerHTML =
    '<div class="empty-state">' +
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
    renameBtn.textContent = '\\u2710';
    renameBtn.title = 'Rename';
    renameBtn.onclick = e => { e.stopPropagation(); renameSession(s.id, s.title || ''); };

    const hideBtn = document.createElement('button');
    hideBtn.className = 'session-action-btn';
    hideBtn.textContent = '\\u00d7';
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
  div.textContent = text;
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
        const { details, content: c } = makeThinkingBlock('\\ud83d\\udcad Thinking', false);
        c.textContent = part.thinking || '';
        wrap.appendChild(details);
        break;
      }
      case 'reasoning': {
        const { details, content: c } = makeThinkingBlock('\\ud83d\\udcad Reasoning', false);
        c.textContent = part.reasoning || '';
        wrap.appendChild(details);
        break;
      }
      case 'redacted-thinking': {
        const div = document.createElement('div');
        div.className = 'thinking-redacted';
        div.textContent = '\\ud83d\\udcad Thinking (redacted)';
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

function renderSession(session) {
  const msgs = session.messages.filter(m => m.role !== 'system');
  if (!msgs.length) { showEmpty(); return; }
  messagesEl.innerHTML = '';
  for (const msg of msgs) {
    if (msg.role === 'user') {
      const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\\n');
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
    apiIsSessionBusy(id).then(({ busy }) => { if (busy) watchUntilDone(id); });
  }
  inputEl.focus();
}

newBtn.onclick = async () => {
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
};

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
            const { details, content: c } = makeThinkingBlock('\\ud83d\\udcad Thinking', true);
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
            const { details, content: c } = makeThinkingBlock('\\ud83d\\udcad Thinking', true);
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
          const choiceMatch = /\\[([^/\\]]+)\\/([^/\\]]+)\\]\\s*$/.exec(rawQ);
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
            .join('\\n');
          if (text) appendUserBubble(text);
          break;
        }

        case 'aborted': {
          removeLoading();
          turnWrap.remove();
          if (ev.session) renderSession(ev.session);
          break;
        }

        case 'done':
          if (thinkingContent) {
            const det = thinkingContent.closest('details');
            if (det) det.open = false;
          }
          if (ev.session?.title && chatHeaderEl) chatTitleEl.textContent = ev.session.title;
          if (turnIn > 0 || turnOut > 0) turnWrap.appendChild(makeTokenStatsBlock(turnIn, turnOut, turnCost, turnCacheRead, turnCacheCreate));
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
  }
}

sendBtn.onclick = sendMessage;

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
  } else {
    // Only clear if the session that set it is still the current one,
    // or if the caller is the current session (prevents session A's completion
    // from clearing session B's in-flight request).
    if (sendingForSession === sid || sid === currentSessionId) {
      sending = false;
      sendingForSession = null;
    }
  }
  sendBtn.disabled = sending;
  inputEl.disabled = sending;
  // if (!sending) inputEl.focus();
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

  renderSessions(sessions);
  const fragmentId = location.hash.slice(1);
  const startId = (fragmentId && sessions.some(s => s.id === fragmentId))
    ? fragmentId : sessions[0]?.id;
  if (startId) {
    await openSession(startId);
  } else {
    showEmpty();
  }
}

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && id !== currentSessionId) openSession(id).catch(console.error);
});

init().catch(console.error);
`;

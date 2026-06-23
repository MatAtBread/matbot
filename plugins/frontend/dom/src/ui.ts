import type {
  MatbotMachine, Session, PipelineEvent, MessageContent, FormField, PromptFn, Principal,
} from '@matatbread/matbot-plugin-api';
import { createSession, currentPrincipal, PromptCancelledError } from '@matatbread/matbot-core';

const CSS = `
.mb-app { display:flex; flex-direction:column; height:100vh; font:14px/1.5 system-ui,sans-serif; color:#1a1a1a; background:#fafafa; }
.mb-head { display:flex; gap:8px; align-items:center; padding:8px 12px; border-bottom:1px solid #e2e2e2; background:#fff; }
.mb-head .mb-title { font-weight:600; margin-right:auto; }
.mb-head select, .mb-head button { font:inherit; padding:4px 8px; border:1px solid #cfcfcf; border-radius:6px; background:#fff; }
.mb-head option.mb-archived { color:#9a9a9a; }
.mb-msgs { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:12px; }
.mb-row { display:flex; }
.mb-row.user { justify-content:flex-end; }
.mb-bubble { max-width:72ch; padding:8px 12px; border-radius:12px; white-space:pre-wrap; word-break:break-word; }
.mb-row.user  .mb-bubble { background:#2563eb; color:#fff; }
.mb-row.assistant .mb-bubble { background:#fff; border:1px solid #e2e2e2; }
.mb-bubble.mb-md { white-space:normal; }
.mb-bubble.mb-md > :first-child { margin-top:0; }
.mb-bubble.mb-md > :last-child { margin-bottom:0; }
.mb-bubble.mb-md pre { background:#0f172a; color:#e2e8f0; padding:8px 10px; border-radius:8px; overflow-x:auto; }
.mb-bubble.mb-md code { font-family:ui-monospace,monospace; font-size:.92em; }
.mb-bubble.mb-md :not(pre) > code { background:rgba(0,0,0,.06); padding:1px 4px; border-radius:4px; }
.mb-row.user .mb-bubble.mb-md :not(pre) > code { background:rgba(255,255,255,.2); }
.mb-bubble.mb-md a { color:inherit; }
.mb-tool { font-family:ui-monospace,monospace; font-size:12px; background:#0f172a; color:#e2e8f0; border-radius:8px; padding:8px 10px; max-width:72ch; white-space:pre-wrap; }
.mb-tool .mb-tool-name { color:#7dd3fc; }
.mb-err { color:#b91c1c; }
.mb-think { color:#888; font-style:italic; font-size:12px; }
.mb-foot { display:flex; gap:8px; padding:10px 12px; border-top:1px solid #e2e2e2; background:#fff; }
.mb-foot textarea { flex:1; resize:none; font:inherit; padding:8px; border:1px solid #cfcfcf; border-radius:8px; min-height:42px; }
.mb-foot button { font:inherit; padding:0 16px; border:none; border-radius:8px; background:#2563eb; color:#fff; cursor:pointer; }
.mb-foot button.mb-stop { background:#b91c1c; }
.mb-foot button:disabled { opacity:.5; cursor:default; }
.mb-prompt { border:1px solid #f59e0b; background:#fffbeb; border-radius:12px; padding:12px; max-width:72ch; display:flex; flex-direction:column; gap:8px; }
.mb-prompt .mb-q { font-weight:600; }
.mb-prompt .mb-opts { display:flex; flex-wrap:wrap; gap:6px; }
.mb-prompt button, .mb-prompt input { font:inherit; padding:6px 10px; border:1px solid #cfcfcf; border-radius:6px; background:#fff; cursor:pointer; }
.mb-prompt input { cursor:text; }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls)  node.className   = cls;
  if (text) node.textContent = text;
  return node;
}

function textOf(content: MessageContent[]): string {
  return content.filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
                .map(c => c.text).join('');
}

/**
 * A whole matbot chat UI in the DOM. Owns no I/O of its own beyond the runner: it submits turns
 * through `services.run` and renders the `PipelineEvent` stream, exactly as a remote frontend would
 * over SSE — only here the runner is in the same realm, so there is no wire.
 */
export class ChatUI {
  private readonly services: MatbotMachine;
  private readonly root: HTMLElement;
  private msgs!:     HTMLElement;
  private input!:    HTMLTextAreaElement;
  private sendBtn!:  HTMLButtonElement;
  private stopBtn!:  HTMLButtonElement;
  private provider!: HTMLSelectElement;
  private sessionSel!: HTMLSelectElement;

  private sessionId = '';
  private busy      = false;
  private currentAbort: AbortController | undefined;
  private liveAssistant: HTMLElement | undefined;
  private liveText = '';
  private liveTools = new Map<string, HTMLElement>();
  private session: Session | undefined;
  // Markdown renderer, loaded from a CDN only when served over http(s). On file:// it stays
  // undefined and messages render as plain text — keeping the bundle self-contained and offline.
  private renderMd: ((src: string) => string) | undefined;

  constructor(services: MatbotMachine, root: HTMLElement) {
    this.services = services;
    this.root = root;
  }

  async mount(): Promise<void> {
    document.getElementById('mb-loading')?.remove();
    const style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const app  = el('div', 'mb-app');
    const head = el('div', 'mb-head');
    head.appendChild(el('span', 'mb-title', 'matbot · web'));

    this.provider = el('select');
    this.populateProviders();
    this.prevProvider = this.provider.value;
    this.provider.addEventListener('change', () => void this.onProviderChange());
    head.appendChild(this.provider);

    this.sessionSel = el('select');
    this.sessionSel.addEventListener('change', () => void this.selectSession(this.sessionSel.value));
    head.appendChild(this.sessionSel);

    const newBtn = el('button', undefined, '+ New');
    newBtn.addEventListener('click', () => void this.newSession());
    head.appendChild(newBtn);

    this.msgs = el('div', 'mb-msgs');

    const foot = el('div', 'mb-foot');
    this.input = el('textarea');
    this.input.placeholder = 'Message matbot…  (Shift+Enter to send, Enter for newline)';
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); void this.send(); }
    });
    this.sendBtn = el('button', 'mb-send', 'Send');
    this.sendBtn.addEventListener('click', () => void this.send());
    this.stopBtn = el('button', 'mb-stop', 'Stop');
    this.stopBtn.hidden = true;
    this.stopBtn.addEventListener('click', () => this.services.run?.abort(this.sessionId));
    foot.append(this.input, this.sendBtn, this.stopBtn);

    app.append(head, this.msgs, foot);
    this.root.appendChild(app);

    void this.loadMarkdown();

    await this.refreshSessionList();
    const first = this.sessionSel.options[0]?.value;
    if (first) await this.selectSession(first);
    else       await this.newSession();
  }

  private principal(): Principal {
    return currentPrincipal();
  }

  // Markdown is a served-mode nicety, not a bundle dependency: only when running over http(s) do we
  // pull `marked` from a CDN. On file:// (the self-contained, offline case) we never touch the
  // network and messages stay plain text. The specifier is built at runtime so the bundler/loader
  // doesn't try to resolve it. Note: rendered markdown is injected as HTML — acceptable for a
  // single-user local demonstrator; a hardened deployment would sanitise it.
  private async loadMarkdown(): Promise<void> {
    const proto = globalThis.location?.protocol;
    if (proto !== 'http:' && proto !== 'https:') return;
    try {
      const url = 'https://esm.sh/marked@14';
      const mod = await import(/* @vite-ignore */ url) as { marked?: unknown };
      const fn  = mod.marked;
      if (typeof fn === 'function') {
        this.renderMd = (src: string) => String((fn as (s: string) => unknown)(src));
        if (!this.busy) this.renderSession(this.session);   // re-render history now that markdown is available
      }
    } catch { /* offline or blocked — stay plain text */ }
  }

  // ── providers ──────────────────────────────────────────────────────────────
  private prevProvider = '';

  private populateProviders(select?: string): void {
    this.provider.replaceChildren();
    for (const name of this.services.providers.keys()) {
      const o = el('option'); o.value = name; o.textContent = name; this.provider.appendChild(o);
    }
    const add = el('option', undefined, '＋ Add provider…'); add.value = '__add__';
    this.provider.appendChild(add);
    if (select) this.provider.value = select;
  }

  // The bootstrap exposes provider setup via a global bridge (it owns the providers map and the
  // wizard). Selecting "Add provider…" runs it, then we refresh and select the newcomer.
  private async onProviderChange(): Promise<void> {
    if (this.provider.value !== '__add__') { this.prevProvider = this.provider.value; return; }
    this.provider.value = this.prevProvider;
    const api = (globalThis as unknown as { __mbProviders?: { add(): Promise<string> } }).__mbProviders;
    if (api?.add === undefined) return;
    try {
      const name = await api.add();
      this.populateProviders(name);
      this.prevProvider = name;
    } catch { /* cancelled */ }
  }

  private async refreshSessionList(): Promise<void> {
    const store = this.services.sessions;
    if (store === undefined) return;
    const { items } = await store.query({ sort: [{ field: 'updatedAt', dir: 'desc' }], limit: 50 });
    this.sessionSel.replaceChildren();

    const makeOption = (doc: Session): HTMLOptionElement => {
      const o = el('option');
      o.value = doc.id;
      o.textContent = doc.title?.trim() || `(untitled ${doc.id.slice(0, 8)})`;
      return o;
    };

    // Unarchived (active/pinned) first, most-recent first.
    for (const doc of items) if (doc.status !== 'archived') this.sessionSel.appendChild(makeOption(doc));

    // Archived sink to the bottom under a labelled group. Native <select> popups ignore `color` on
    // <option> (esp. on macOS), so the grey class alone is invisible there; the <optgroup> label is
    // always rendered by the OS, which is what actually separates and de-emphasises them.
    const archived = items.filter(doc => doc.status === 'archived');
    if (archived.length > 0) {
      const group = el('optgroup');
      group.label = 'Archived';
      for (const doc of archived) {
        const o = makeOption(doc);
        o.classList.add('mb-archived');
        group.appendChild(o);
      }
      this.sessionSel.appendChild(group);
    }
  }

  private async newSession(): Promise<void> {
    const store = this.services.sessions;
    if (store === undefined) throw new Error('No sessions store available.');
    const session = createSession({ ownerPrincipal: this.principal() });
    await store.set(session.id, session);
    await this.refreshSessionList();
    await this.selectSession(session.id);
  }

  private async selectSession(id: string): Promise<void> {
    this.sessionId = id;
    this.sessionSel.value = id;
    const session = await this.services.sessions?.get(id);
    this.renderSession(session ?? undefined);
  }

  private renderSession(session: Session | undefined): void {
    this.session = session;
    this.msgs.replaceChildren();
    this.liveAssistant = undefined;
    this.liveText = '';
    this.liveTools.clear();
    if (session === undefined) return;
    for (const m of session.messages) {
      if (m.role === 'marker' || m.role === 'system') continue;
      for (const block of m.content) {
        if (block.type === 'text' && block.text.trim()) {
          this.bubble(m.role === 'user' ? 'user' : 'assistant', block.text);
        } else if (block.type === 'tool-call') {
          this.toolBlock(block.id, block.name, block.input);
        } else if (block.type === 'tool-result') {
          this.toolResult(block.id, block.result, block.isError ?? false);
        }
      }
    }
    this.scroll();
  }

  // ── rendering primitives ──────────────────────────────────────────────────
  private addBubble(role: 'user' | 'assistant'): HTMLElement {
    const row = el('div', `mb-row ${role}`);
    const b   = el('div', 'mb-bubble');
    row.appendChild(b);
    this.msgs.appendChild(row);
    return b;
  }

  // Markdown when available (innerHTML + .mb-md), else plain text (textContent, kept readable by the
  // bubble's white-space:pre-wrap). The streaming assistant bubble stays plain until finalised.
  private setContent(el: HTMLElement, text: string): void {
    if (this.renderMd !== undefined) {
      try { el.innerHTML = this.renderMd(text); el.classList.add('mb-md'); return; }
      catch { /* fall back to plain */ }
    }
    el.classList.remove('mb-md');
    el.textContent = text;
  }

  private bubble(role: 'user' | 'assistant', text: string): HTMLElement {
    const b = this.addBubble(role);
    this.setContent(b, text);
    return b;
  }

  private toolBlock(callId: string, name: string, input: unknown): void {
    const box = el('div', 'mb-tool');
    const head = el('span', 'mb-tool-name', `⚙ ${name}`);
    box.append(head, document.createTextNode(` ${safeJson(input)}\n`));
    this.msgs.appendChild(box);
    this.liveTools.set(callId, box);
  }

  private toolResult(callId: string, result: unknown, isError: boolean): void {
    const box = this.liveTools.get(callId);
    const text = `→ ${isError ? '[error] ' : ''}${safeJson(result)}`;
    if (box) box.appendChild(document.createTextNode(text + '\n'));
    else { const b = el('div', 'mb-tool', text); this.msgs.appendChild(b); }
  }

  private scroll(): void { this.msgs.scrollTop = this.msgs.scrollHeight; }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.sendBtn.disabled = busy;
    this.input.disabled   = busy;
    this.stopBtn.hidden   = !busy;
  }

  // ── submit + event loop ────────────────────────────────────────────────────
  private async send(): Promise<void> {
    if (this.busy) return;
    const text = this.input.value.trim();
    if (!text) return;
    const run = this.services.run;
    if (run === undefined) { this.bubble('assistant', '[no session runner available]'); return; }

    this.input.value = '';
    this.bubble('user', text);
    this.scroll();
    this.setBusy(true);
    this.liveAssistant = undefined;
    this.liveText = '';

    const ac = new AbortController();
    this.currentAbort = ac;
    try {
      const view = await run.open({
        sessionId: this.sessionId,
        signal:    ac.signal,
        content:   [{ type: 'text', text }],
        provider:  this.provider.value,
        principal: this.principal(),
        prompt:    this.promptFn,
      });
      for await (const ev of view.events) {
        if (!('traceId' in ev)) continue;          // session-level events (e.g. 'idle') — not this turn
        if (ev.traceId !== view.traceId) continue;
        this.render(ev);
        if (ev.type === 'done' || ev.type === 'aborted' || ev.type === 'error' || ev.type === 'cancelled') break;
      }
    } catch (e) {
      this.bubble('assistant', `[error] ${String(e)}`).classList.add('mb-err');
    } finally {
      this.finalizeLive();
      this.currentAbort = undefined;
      this.setBusy(false);
      await this.refreshSessionList();
      this.sessionSel.value = this.sessionId;
    }
  }

  // Re-render the streamed assistant text as markdown once the turn (or tool break) ends.
  private finalizeLive(): void {
    if (this.liveAssistant !== undefined && this.liveText) this.setContent(this.liveAssistant, this.liveText);
    this.liveAssistant = undefined;
    this.liveText = '';
  }

  private render(ev: PipelineEvent): void {
    switch (ev.type) {
      case 'text-delta':
        if (this.liveAssistant === undefined) { this.liveAssistant = this.addBubble('assistant'); this.liveText = ''; }
        this.liveText += ev.delta;
        this.liveAssistant.textContent = this.liveText;   // plain while streaming; markdown on finalise
        break;
      case 'thinking': break;
      case 'tool:start':
        this.finalizeLive();
        this.toolBlock(ev.callId, ev.name, ev.input);
        break;
      case 'tool:stdout':
      case 'tool:stderr': {
        const box = this.liveTools.get(ev.callId);
        if (box) box.appendChild(document.createTextNode(ev.chunk));
        break;
      }
      case 'tool:end':
        this.toolResult(ev.callId, ev.result, ev.isError);
        break;
      case 'error':
        this.bubble('assistant', `[error] ${ev.error}`).classList.add('mb-err');
        break;
      case 'aborted':
        this.bubble('assistant', `[aborted: ${ev.reason}]`).classList.add('mb-err');
        break;
      default: break;
    }
    this.scroll();
  }

  // ── interactive prompt (ask_user, plugin confirm, store-key) ────────────────
  private readonly promptFn: PromptFn = ((arg: string | FormField, def?: string): Promise<string> => {
    const field: FormField = typeof arg === 'string'
      ? { name: 'q', label: arg, type: 'text', ...(def !== undefined ? { default: def } : {}) }
      : arg;
    return this.renderPrompt(field);
  }) as PromptFn;

  private renderPrompt(field: FormField): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const box = el('div', 'mb-prompt');
      box.appendChild(el('div', 'mb-q', field.label));
      const cancelable = field.cancelable !== false;

      const done = (value: string): void => { box.remove(); resolve(value); };
      const cancel = (): void => { box.remove(); reject(new PromptCancelledError()); };

      if (field.type === 'confirm') {
        const opts = el('div', 'mb-opts');
        const yes = el('button', undefined, 'Yes'); yes.addEventListener('click', () => done('yes'));
        const no  = el('button', undefined, 'No');  no.addEventListener('click', () => done('no'));
        opts.append(yes, no);
        box.appendChild(opts);
      } else if (field.type === 'select') {
        const opts = el('div', 'mb-opts');
        for (const option of field.options ?? []) {
          const b = el('button', undefined, option);
          b.addEventListener('click', () => done(option));
          opts.appendChild(b);
        }
        box.appendChild(opts);
        if (field.allowOther) box.appendChild(this.freeText(done, 'Other…'));
      } else {
        box.appendChild(this.freeText(done, field.type === 'password' ? '••••••' : '', field.type === 'password', field.default));
      }

      if (cancelable) {
        const c = el('button', undefined, 'Cancel');
        c.addEventListener('click', cancel);
        box.appendChild(c);
      }
      this.msgs.appendChild(box);
      this.scroll();
    });
  }

  private freeText(done: (v: string) => void, placeholder: string, password = false, def?: string): HTMLElement {
    const wrap  = el('div', 'mb-opts');
    const input = el('input');
    input.type = password ? 'password' : 'text';
    input.placeholder = placeholder;
    if (def !== undefined) input.value = def;
    const submit = el('button', undefined, 'OK');
    const go = (): void => done(input.value);
    submit.addEventListener('click', go);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    wrap.append(input, submit);
    return wrap;
  }
}

function safeJson(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 600 ? s.slice(0, 600) + '…' : s;
  } catch { return String(v); }
}

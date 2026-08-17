// Types for the web UI, so `tsc` grades this frontend against the SAME `ToolContracts` augmentations
// the tools themselves declare. The UI is plain browser JS by design — no build step, served verbatim —
// so the types arrive by JSDoc annotation and this ambient file rather than by compiling anything.
//
// WHY: every panel here is one `callTool` away from a tool's declared result shape, and nothing
// connected the two. `workspace_action`'s list result renamed `path` to `name`, and the file panel went
// blank — reading a field that no longer exists yields `undefined`, which renders as an empty row
// rather than an error, so the failure looked like "no files" and not like a bug. The contracts already
// exist and are already the single source of truth for the model-facing side; this points the
// human-facing side at the same source.
//
// SCOPE — this gate is about DATA, not the DOM. It grades what crosses the tool boundary: call params,
// result shapes, and the fields the UI reads off them. It deliberately does NOT grade DOM narrowing
// (`getElementById` returning `HTMLElement` where the code wants an `HTMLInputElement`), because the
// ~80 casts that would take are noise against the one class of bug worth catching here, and would make
// the gate expensive enough to be turned off. See the widening block at the bottom.

// Each side-effect import pulls in one package's `declare module` augmentation, so its tools' keys exist
// in `ToolContracts` here. This list is load-bearing: a tool whose package is missing is not *unknown*
// but *unregistered*, and `ToolResultFor` degrades an unregistered key to `unknown` — which type-checks
// and catches nothing. A panel calling a new tool needs its package added here to be covered.
import '@matatbread/matbot-core';                     // about_matbot
import '@matatbread/matbot-tool-plugin';              // plugin, provider
import '@matatbread/matbot-sessions';                 // session_action
import '@matatbread/matbot-edit-session';             // session_edit
import '@matatbread/matbot-skills';                   // skill_action
import '@matatbread/matbot-triggers';                 // trigger_action
import '@matatbread/matbot-tool-workspace';           // workspace_action
import '@matatbread/matbot-storage-profiles';         // profile_action, share

import type { ToolContracts, ToolProxy, ToolResultFor } from '@matatbread/matbot-plugin-api';

declare global {
  type ToolName = keyof ToolContracts;

  /** The params a call to tool `K` may pass — the union of its arms. `ToolProxy[K]` is an overload set
   *  (one signature per arm) ending in the catch-all whose parameter is exactly that union, and
   *  `Parameters` resolves to the last signature, so this is that catch-all's parameter. */
  type ToolArgs<K extends ToolName> = Parameters<ToolProxy[K]>[0];

  /** The result of calling `K` with params `P`, narrowed to the arm `P` matches. */
  type ToolResult<K extends ToolName, P> = ToolResultFor<K, P>;

  /**
   * The contract both transports satisfy — `http-transport.js` (fetch + SSE to the node server) and
   * `browser.js` (in-process). `app.js` is byte-identical in both delivery modes, so this is the one
   * place the two implementations are held to the same shape.
   *
   * The streaming members stay loose on purpose: their payloads are `PipelineEvent`s, and narrowing
   * those would put this gate inside the renderer's event switch — a different job from grading tool
   * calls, and a far larger one.
   */
  interface MatbotTransport {
    hostRuntime: 'node' | 'browser';
    /** Run a tool and resolve its result, narrowed by the params passed. Throws on a tool error. */
    callTool<K extends ToolName, P extends ToolArgs<K>>(name: K, input?: P): Promise<ToolResult<K, P>>;
    createSession(): Promise<{ id: string }>;
    sessionBusy(id: string): Promise<boolean>;
    submit(sessionId: string, body: { content: unknown; provider?: string; concatQueue?: boolean; mode?: string }): Promise<{ queued: boolean; traceId?: string }>;
    sessionEvents(sessionId: string, signal?: AbortSignal): AsyncIterable<any>;
    answerPrompt(sessionId: string, body: unknown): Promise<void>;
    answerEnv(sessionId: string, body: unknown): Promise<void>;
    abort(sessionId: string): Promise<void>;
    statusEvents(signal?: AbortSignal): AsyncIterable<{ sessionId: string; busy: boolean }>;
    notifications(signal?: AbortSignal): AsyncIterable<any>;
    openFile(namespace: string, name: string): void;
  }

  interface Window {
    matbotTransport: MatbotTransport;
  }

  // Loaded from a CDN by index.html, before app.js runs.
  const marked:  any;
  const TinyMDE: any;

  // ── DOM widening ────────────────────────────────────────────────────────────
  //
  // The UI treats every element as "an element" — `getElementById('x').value`, `querySelector(sel).checked`.
  // That is the idiom of the file and not what this gate exists to police (see SCOPE above), so the
  // element properties it reaches for are declared on the base types rather than asserted at ~80 call
  // sites. The cost is real and bounded: a misspelt element property is not caught here. A wrong *tool
  // field* still is, which is the trade being made.
  interface Element {
    value:       any;
    checked:     boolean;
    disabled:    boolean;
    files:       FileList | null;
    placeholder: string;
    dataset:     DOMStringMap;
    style:       CSSStyleDeclaration;
    title:       string;
    onclick:     ((this: Element, ev: MouseEvent) => any) | null;
    offsetHeight: number;
    focus(): void;
  }
  interface EventTarget {
    closest(selectors: string): Element | null;
  }
  interface Event {
    relatedTarget: EventTarget | null;
    dataTransfer:  DataTransfer | null;
  }
  interface Node {
    contains(other: EventTarget | Node | null): boolean;
  }
}

export {};

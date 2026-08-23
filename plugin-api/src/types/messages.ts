import type { HookPoint } from './hooks.js';
import type { ISODate, MimeType } from './primitives.js';
import type { ProviderMeta, TurnEntry, UsageRecord } from './provider.js';

// ── Messages & Session ────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system' | 'marker';

export type MessageContent = (
  // ── prose and reasoning: what the model said ──
  | { type: 'text';              text: string }
  | { type: 'thinking';          thinking: string; signature: string }
  | { type: 'redacted-thinking'; data: string }
  | { type: 'reasoning';         reasoning: string }
  | { type: 'refusal';           text: string }

  // ── inline media: bytes plus a mime type. The first three are also `ModelContent` — the arms a tool
  //    may hand the model to look at (see the `model-content` ToolEvent) — AND the boundary form of
  //    `UserContent`, the arms a person may attach to a submission. `file-ref` is what such an
  //    attachment becomes once `open()` has written it through the `MediaStore`: it is the only media
  //    arm that ever persists, and the runner resolves it back to inline bytes on the outgoing copy
  //    while it fits the residency budget. `image-url` remains unproduced. ──
  | { type: 'image';             data: string; mimeType: MimeType }
  | { type: 'document';          data: string; mimeType: MimeType; name?: string }
  | { type: 'audio';             data: string; mimeType: MimeType }
  | { type: 'image-url';         url: string; detail?: 'low' | 'high' | 'auto' }
  | { type: 'file-ref';          fileId: string; name: string; mimeType: MimeType }

  // ── tool use ──
  | { type: 'tool-call';         id: string; name: string; input: unknown;
      /** Provider-specific round-trip metadata, persisted and re-sent verbatim on replay — see
       *  `ProviderMeta` and the `tool-call` `CompletionEvent`. */
      meta?: ProviderMeta }
  // A tool's own completions (`single_turn`, `dream_time`'s ranker/merger) are no longer recorded here:
  // they are entries on the turn head, tagged `site: { kind: 'tool', callId }`. A tool message is popped
  // wholesale by a retract-and-rerun, which took its accounting out of reach of any reduction over
  // `session.messages` — see `Message.usage`.
  | { type: 'tool-result';       id: string; result: unknown; isError?: boolean }

  // ── frontend-facing: rendered to a person, never sent to the model ──
  | { type: 'form';              fields: FormField[]; submitLabel?: string }
  | { type: 'form-response';     values: Record<string, string> }
  // Durable, opaque annotation — persisted unchanged, elided from every submission. See MarkerData below.
  | { type: 'marker';            creator: string; data: unknown }

  // ── a provider block this build does not know: preserved verbatim rather than dropped ──
  | { type: 'unknown-content';   blockType: string; raw: unknown }
) & {
  /**
   * Authorship provenance, for *presentation only* — orthogonal to the message's `role`, which is
   * the LLM-protocol identity. Absent ⇒ authored per the role (a human for `user`, the model for
   * `assistant`). `'robo'` ⇒ machine-authored by matbot — a `followup` resubmission, or a hook-
   * injected fragment inside a human turn. It is still carried to the model as ordinary
   * role-appropriate content (the model sees a `user` block either way); the flag is OOB metadata
   * that frontends use to present it agent-side (a robot indicator) rather than as the user's words.
   */
  origin?: 'robo';
};

/**
 * A marker is opaque, durable annotation carried in the message stream: links, status,
 * cross-references that are meaningful to a frontend but transparent to the LLM. They are
 * persisted unchanged, elided from provider submission, and deliberately preserved by
 * session compaction (removing one can break things — e.g. a pointer back to an ancestor
 * session). Any code with session access may emit one, normally as its own message.
 *
 * `creator` is the emitting plugin's reference; `data` is anything serialisable. For
 * per-creator type safety, augment `MarkerData` and read/write via `Marker<'your-creator'>`:
 *
 *   declare module '@matatbread/matbot-plugin-api' {
 *     interface MarkerData { 'split-session': { peerSessionId: string } }
 *   }
 *
 * Unregistered creators fall back to `data: unknown`. The base `MessageContent` member stays
 * loose (`creator: string`) so the union and its exhaustive switches are unaffected.
 *
 * One of matbot's five open-registry augmentation points — same technique at each; see
 * docs/DEVELOPING.md *Open-registry augmentation* for the shared shape and the rules that follow from it.
 */
export interface MarkerData {
  /** Emitted by the hook dispatcher when a hook handler threw: the hook was skipped (treated as a
   *  no-op) and this records it once, so a misconfigured/throwing hook degrades visibly instead of
   *  bricking the turn. `channel` is the hook point, `pluginName` the owning plugin if known. */
  'matbot-hooks': { channel: HookPoint; pluginName?: string; message: string };
  /** Emitted by the runner when a provider call was cut short rather than finishing (see the
   *  `truncated` CompletionEvent). Marker-role so the reader and an audit see it while the model does
   *  not — the model's own text is already truncated in the transcript; a block telling it so would
   *  invite it to narrate the cut-off rather than continue past it. */
  'matbot-truncation': { reason: 'max-tokens' | 'stream-end'; raw?: string };
}

export type Marker<K extends string = string> = {
  type:    'marker';
  creator: K;
  data:    K extends keyof MarkerData ? MarkerData[K] : unknown;
};

export interface FormField {
  name:        string;
  label:       string;
  type:        'text' | 'password' | 'select' | 'confirm';
  options?:    string[];
  /** select-only: render an "Other…" affordance that lets the user type a free-form answer instead
   *  of picking an option. The typed value is returned verbatim, on the same channel as a pick —
   *  callers never learn whether the answer was a preset or free text. Ignored for other types. */
  allowOther?: boolean;
  default?:    string;
  required?:   boolean;
  /** Presentation hint only (default true): whether the frontend offers a cancel affordance (the
   *  "give up" path — see `PromptFn`). Set false to render a hard-blocking prompt with no out. The
   *  runner and server never consult this; a frontend with no cancel UI simply can't fire one. */
  cancelable?: boolean;
}

/**
 * Canonical values a `type: 'confirm'` prompt resolves to. The rendered label and buttons are a
 * cosmetic, host-specific concern (and may be localised), so consumers MUST branch on these tokens
 * — never on the displayed string. Compare case-insensitively to tolerate host casing differences.
 */
export const CONFIRM_YES = 'yes';
export const CONFIRM_NO  = 'no';

export interface Message {
  id:            string;
  role:          MessageRole;
  content:       MessageContent[];
  createdAt:     ISODate;
  traceId:       string;
  providerName?: string;
  /**
   * The turn's activity log, anchored here — every provider call it caused, whatever ran it (a round, a
   * tool, a hook), plus every bracket matbot held open that was not a call of its own (a tool span).
   * Each entry is self-describing via its `site` and causal `traceId`. Bookkeeping only: elided from
   * provider submission, and a `flatMap` away from any total or waterfall a consumer wants.
   *
   * Anchored on the turn's **head** (its user message) rather than on the message whose call produced
   * it, because that is the one message a retract-and-rerun keeps: the pop stashes assistant and tool
   * messages inside a retraction marker, where no reduction over `session.messages` will ever find them
   * again, so a retried turn would silently under-report by the attempt it discarded. Locality is not
   * lost — `site` already names the round or tool call, and physical adjacency carried nothing the
   * coordinate does not. See docs/ACCOUNTING-RATIONALE.md.
   */
  activity?:     TurnEntry[];
  metadata?:     Record<string, unknown>;
}

export type SessionStatus = 'active' | 'archived' | 'pinned';

export interface Session {
  id:                    string;
  version:               string;
  // Legacy: persisted sessions may still carry `ownerPrincipalId` / `actorPrincipalId` / `persona`, and
  // `contexts` (a required-but-never-read `string[]`, dropped at 0.4.0 — system context is contributed by
  // SystemContextContributor, not carried on the session). Never read — ownership-at-rest is structural
  // (the storage partition), resolved via the backend, not a field. Left undeclared; old data keeps them
  // harmlessly as excess properties.
  title?:                string;
  status:                SessionStatus;
  messages:              Message[];
  parentSessionId?:      string;
  branchPointMessageId?: string;
  createdAt:             ISODate;
  updatedAt:             ISODate;
}

import type { Session } from '@matatbread/matbot-plugin-api';
import { shapeOf } from './shape.js';

export const SESSION_DATA_CREATOR = '@matatbread/matbot-session-data';

/** At most this many bytes of JSON in one entry. Every entry is part of the session document, which is
 *  written whole at the start and end of each turn. */
export const MAX_ENTRY_BYTES = 65536;

export interface SessionDataInfo {
  id:          string;
  description: string;
  /** The entry's TypeScript type, inferred from its value when it was written. */
  shape:       string;
  /** The size of its JSON, in UTF-8 bytes. */
  bytes:       number;
  createdAt:   string;
}
export interface SessionDataEntry extends SessionDataInfo { data: unknown }

/** An entry is written once and never changed; `drop` is a later marker saying it is gone. */
export type SessionDataMarker = ({ op: 'write' } & SessionDataEntry) | { op: 'drop'; id: string };

declare module '@matatbread/matbot-plugin-api' {
  interface MarkerData { '@matatbread/matbot-session-data': SessionDataMarker }
}

export interface Held {
  /** In the order they were written. */
  entries: Map<string, SessionDataEntry>;
  dropped: Set<string>;
}

// Persisted data, so checked rather than trusted: a hand-edited or foreign marker is skipped.
function parse(data: unknown): SessionDataMarker | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const d = data as Partial<Record<keyof SessionDataEntry | 'op', unknown>>;
  if (typeof d.id !== 'string') return undefined;
  if (d.op === 'drop') return { op: 'drop', id: d.id };
  if (d.op !== 'write' || !('data' in d) || typeof d.description !== 'string'
      || typeof d.bytes !== 'number' || typeof d.createdAt !== 'string') return undefined;
  // The shape is derived again rather than read: it is spliced into a type-check as source, and a stored
  // string is whatever last edited the session file — `any` would pass every read, and worse could rewrite
  // the declarations around it. The value is the entry; its type follows from it.
  return { op: 'write', id: d.id, description: d.description, shape: shapeOf(d.data), bytes: d.bytes, createdAt: d.createdAt, data: d.data };
}

function apply(held: Held, m: SessionDataMarker): void {
  if (m.op === 'drop') { held.entries.delete(m.id); held.dropped.add(m.id); return; }
  const { op: _op, ...entry } = m;
  held.entries.set(m.id, entry);
}

/**
 * What one call has written that its session does not show yet. A tool's markers reach the session when
 * the call that yielded them ends, so a body that writes and then reads (itself, or through another tool
 * it calls) would otherwise find nothing. Keyed on the session OBJECT a call was handed: every call made
 * within one call is handed that same object, and when it ends the runner moves on to a new one holding
 * the markers, so nothing ever has to be cleared and nothing outlives the window it covers. A turn aborted
 * before its markers were kept takes its session object, and so these, with it.
 */
const pending = new WeakMap<Session, SessionDataMarker[]>();

export function remember(session: Session, m: SessionDataMarker): void {
  const list = pending.get(session);
  if (list === undefined) pending.set(session, [m]);
  else list.push(m);
}

/** What `session` holds: its markers in order, then whatever calls on this very session object wrote. */
export function held(session: Session): Held {
  const out: Held = { entries: new Map(), dropped: new Set() };
  for (const msg of session.messages) {
    if (msg.role !== 'marker') continue;
    for (const c of msg.content) {
      if (c.type !== 'marker' || c.creator !== SESSION_DATA_CREATOR) continue;
      const m = parse(c.data);
      if (m !== undefined) apply(out, m);
    }
  }
  for (const m of pending.get(session) ?? []) apply(out, m);
  return out;
}

export function info({ data: _data, ...rest }: SessionDataEntry): SessionDataInfo {
  return rest;
}

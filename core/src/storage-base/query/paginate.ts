import type { Filter, SortSpec } from '@matatbread/matbot-plugin-api';
import { StoreQueryError } from '@matatbread/matbot-plugin-api';

// Everything needed to reproduce the next page deterministically: the query, its sort, the page
// size, and the position. The cursor is opaque and self-contained — a caller pages by sending only
// a previous result's cursor back. The in-memory reference backend carries the literal query and an
// offset; a pushdown backend would carry its own keyset under the same opaque contract.
export interface PageState {
  where?:  Filter;
  sort?:   SortSpec[];
  limit?:  number;
  offset:  number;
}

export function encodeCursor(state: PageState): string {
  return JSON.stringify(state);
}

export function decodeCursor(cursor: string): PageState {
  let parsed: unknown;
  try { parsed = JSON.parse(cursor); } catch { parsed = undefined; }
  const offset = (parsed as { offset?: unknown } | undefined)?.offset;
  if (parsed === null || typeof parsed !== 'object' || typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0)
    throw new StoreQueryError('unreadable cursor — pass back a cursor from a previous result verbatim', '/cursor', 'MALFORMED');
  return parsed as PageState;
}

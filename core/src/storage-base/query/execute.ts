import type { StoreQuery, QueryResult } from '@matatbread/matbot-plugin-api';
import { validateQuery } from './validate.js';
import { compileFilter } from './compile.js';
import { applySort } from './sort.js';
import { encodeCursor, decodeCursor, type PageState } from './paginate.js';

function toQuery(p: PageState): StoreQuery {
  return {
    ...(p.where !== undefined ? { where: p.where } : {}),
    ...(p.sort  !== undefined ? { sort:  p.sort  } : {}),
    ...(p.limit !== undefined ? { limit: p.limit } : {}),
  };
}

// Reference in-memory execution: validate → filter → totally-order → paginate. Backends that load
// all documents into memory (filesystem, IndexedDB, sqlite-as-blob) delegate here; a pushdown
// backend would instead compile the same StoreQuery to its native query language.
//
// A cursor is self-contained: it carries the query, sort, page size, and position, so a caller can
// page by sending only the cursor back. When a cursor is present it fully determines the page —
// any where/sort/limit passed alongside it are ignored — which is what makes consecutive pages a
// disjoint cover (page N re-applies the same sort as page 1, so the total order never shifts). A
// cursor is untrusted input, so its decoded query is validated exactly like a fresh one.
export function executeQuery<T extends { id: string; version: string }>(docs: T[], q: StoreQuery): QueryResult<T> {
  // Validate the caller's RAW query first. The projection below keeps only where/sort/limit, so an
  // unknown top-level key (e.g. `filter` instead of `where`) would otherwise be silently discarded
  // and the query would degrade to match-everything with no feedback to the author.
  validateQuery(q);

  const page: PageState = q.cursor !== undefined
    ? decodeCursor(q.cursor)
    : {
        offset: 0,
        ...(q.where !== undefined ? { where: q.where } : {}),
        ...(q.sort  !== undefined ? { sort:  q.sort  } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      };

  // A cursor is untrusted input, so its decoded query is validated exactly like a fresh one.
  if (q.cursor !== undefined) validateQuery(toQuery(page));

  const predicate = page.where !== undefined ? compileFilter(page.where) : () => true;
  const ordered   = applySort(docs.filter(predicate), page.sort);

  const total = ordered.length;
  const end   = page.limit !== undefined ? page.offset + page.limit : ordered.length;
  const slice = ordered.slice(page.offset, end);
  const next  = page.offset + slice.length;

  // `limit: 0` is the count form: the filter runs, `total` answers, no document is materialised. It
  // gets no cursor — a zero-length page never advances `offset`, so one would page forever on the
  // same empty slice.
  return {
    items: slice,
    total,
    ...(page.limit !== 0 && next < total ? { cursor: encodeCursor({ ...page, offset: next }) } : {}),
  };
}

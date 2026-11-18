import type { Tool, ToolContract, ToolResultOf, ToolContext, Session, Store, Filter, StoreQuery, FieldPath, SessionAppender, SessionRunner } from '@matatbread/matbot-plugin-api';
import { lastActivityAt, StoreQueryError } from '@matatbread/matbot-plugin-api';
import { sessionIndicator, type SessionIndicator } from './read-state.js';
import { compileFilter, applySort, validateQuery, decodeCursor, encodeCursor, type PageState } from '@matatbread/matbot-core/storage-base';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // One arm per action: a caller of `invokeTool(machine, 'session_action', { action: '…' })` gets the
    // matching result narrowed by the `action` it passed (see ToolContract / the multi-action note on ToolContracts).
    // `immutable` is omitted from the query arm: it is a caller-to-store optimisation hint, not a query
    // parameter, and this executor decides it for itself (it hardcodes `immutable: true`, which is always
    // right here — every row is copied into a fresh summary and never written back). Intersecting the whole
    // of StoreQuery published a knob no caller could actually turn.
    session_action:
      | ToolContract<SessionSummary[], { action: 'list'; includeArchived?: boolean }>
      | ToolContract<
          { items: SessionSummary[]; cursor?: string; total?: number },
          { action: 'query' } & Omit<StoreQuery, 'immutable'>
        >
      | ToolContract<Session,                          { action: 'get'; sessionId: string; markRead?: boolean }>
      | ToolContract<{ id: string; title: string;        deferred?: true }, { action: 'rename'; sessionId: string; title: string }>
      | ToolContract<{ id: string; status: 'archived';   deferred?: true }, { action: 'hide'; sessionId: string }>
      | ToolContract<{ id: string; status: 'active';     deferred?: true }, { action: 'unhide'; sessionId: string }>
      // `deferred` while it waits for a turn of that session, which may be this one.
      | ToolContract<{ id: string; messageIds: string[]; deferred?: true; traceId?: string }, { action: 'append'; sessionId?: string; text: string; submit?: 'queue' | 'parallel' | 'interrupt' }>;
  }
}

/** A row of `list`/`query`. `state` is what a session list shows beside it — see {@link SessionIndicator}. */
export interface SessionSummary {
  id:        string;
  title:     string | undefined;
  preview:   string;
  updatedAt: string;
  state?:    SessionIndicator;
}

function sessionPreview(session: Session): string {
  const first = session.messages.find(m => m.role === 'user');
  const text  = first?.content.find(
    (c): c is { type: 'text'; text: string } => c.type === 'text',
  )?.text ?? '';
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function toSummary(s: Session, run: SessionRunner | undefined): SessionSummary {
  const state = sessionIndicator(s, run?.status(s.id));
  return { id: s.id, title: s.title, preview: sessionPreview(s), updatedAt: s.updatedAt, ...(state !== undefined ? { state } : {}) };
}

// Synthesized, lowercased "columns" holding the conversation text per authorship role — matbot's
// pretend fields for the query grammar, since the real text is buried in messages[].content[].
// Only `type:'text'` blocks count; tool calls/results, thinking, images and markers are dropped as noise.
function synthRoles(s: Session): { user: string; assistant: string } {
  let user = '', assistant = '';
  for (const m of s.messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    for (const c of m.content) {
      if (c.type !== 'text') continue;
      if (m.role === 'user') user      += (user      ? '\n' : '') + c.text;
      else                   assistant += (assistant ? '\n' : '') + c.text;
    }
  }
  return { user: user.toLowerCase(), assistant: assistant.toLowerCase() };
}

// Case-insensitive match over the synthesized fields: they are stored lowercased, so lowercase the
// operand of any `stringContains` that targets one (recursing through and/or/not). Real stored fields
// (status/title/…) keep exact semantics — we only touch `user`/`assistant`.
const SYNTH_FIELDS = new Set(['user', 'assistant']);
function oneKey(field: FieldPath): string | undefined {
  const segs = Array.isArray(field) ? field : [field];
  return segs.length === 1 ? segs[0] : undefined;
}
function lowerSynthOperands(f: Filter): Filter {
  switch (f.op) {
    case 'and':
    case 'or':  return { op: f.op, clauses: f.clauses.map(lowerSynthOperands) };
    case 'not': return { op: 'not', clause: lowerSynthOperands(f.clause) };
    case 'stringContains':
      return SYNTH_FIELDS.has(oneKey(f.field) ?? '') ? { ...f, value: f.value.toLowerCase() } : f;
    default:    return f;
  }
}

/** What the tool reads off the machine, late-bound so it follows a swap or an unload. Every member is
 *  optional: a caller with no runner has no turns to defer behind, and one with no appender cannot append. */
export interface SessionToolEnv {
  /** The runner whose turns hold the sessions in `store`, and so their one writer (`services.run`). */
  run?:        () => SessionRunner | undefined;
  appender?:   () => SessionAppender | undefined;
  /** A background job's process: its sessions are the parent's, written by none of its pumps. */
  isSubAgent?: () => boolean;
}

export function makeSessionTools(store: Store<Session>, env: SessionToolEnv = {}): readonly Tool[] {
  return [makeSessionActionTool(store, env)];
}

// A background job's store is its parent's medium, but no turn in the parent passes through it: a write
// from here would land under a running turn there unseen and be undone by its write-back. An append goes
// through the parent; everything else is refused rather than raced.
const CONCURRENT = 'Concurrent modification — please retry.';

const JOB_CANNOT_EDIT =
  'A background job cannot rename, hide or unhide a session — it would race the turns of the process that ' +
  'owns it. Use "append" to say something in a conversation instead.';

type FieldEdit = { title: string } | { status: Session['status'] } | { readAt: string };

// A title or status edit is metadata, not conversational activity: keep updatedAt on the last message
// (the lastActivityAt invariant) so it doesn't float the session up a recency-sorted list.
function withEdit(session: Session, edit: FieldEdit): Session {
  return { ...session, ...edit, version: crypto.randomUUID(), updatedAt: lastActivityAt(session) };
}

// Read up to `readAt` — never back: a reader shown an older copy than one already marked does not undo it.
const readTo = (readAt: string) => (session: Session): FieldEdit | undefined =>
  session.readAt !== undefined && session.readAt >= readAt ? undefined : { readAt };

// The precise per-action contract. JSON Schema can't express "title required only for rename"
// without an awkward oneOf, so the schema stays loose and the description carries this TypeScript
// discriminated union — which LLMs read accurately — as the source of truth. The executor enforces it.
type SessionInput =
  | { action: 'list';   includeArchived?: boolean }
  | ({ action: 'query' } & Omit<StoreQuery, 'immutable'>)
  | { action: 'get';    sessionId: string; markRead?: boolean }
  | { action: 'rename'; sessionId: string; title: string }
  | { action: 'hide';   sessionId: string }
  | { action: 'unhide'; sessionId: string }
  | { action: 'append'; sessionId?: string; text: string; submit?: 'queue' | 'parallel' | 'interrupt' };

const SUBMIT_MODES: readonly unknown[] = ['queue', 'parallel', 'interrupt'];

function makeSessionActionTool(store: Store<Session>, env: SessionToolEnv): Tool<ToolResultOf<'session_action'>> {
  const isSubAgent = env.isSubAgent ?? (() => false);
  // A string is the refusal to report; otherwise what the result adds.
  //
  // A session a turn is running in belongs to that turn until it commits: the runner writes its in-memory
  // copy back unconditionally at turn end, so a CAS landing mid-turn succeeds and is then silently undone.
  // So the edit is the runner's to make (`SessionRunner.write`), which waits for that turn if there is one.
  // Setting a field composes with any other write, so a lost compare-and-swap reads again and re-applies.
  // `edit` may depend on what the write finds: `undefined` from it is nothing to write.
  const editFields = async (
    sessionId: string, edit: FieldEdit | ((session: Session) => FieldEdit | undefined),
  ): Promise<string | { deferred?: true }> => {
    if (isSubAgent()) return JOB_CANNOT_EDIT;
    if (!(await store.get(sessionId))) return `Session "${sessionId}" not found.`;
    let outcome: string | undefined = CONCURRENT;
    const attempt = async (): Promise<boolean> => {
      const session = await store.get(sessionId);
      if (!session) { outcome = `Session "${sessionId}" not found.`; return true; }
      const change = typeof edit === 'function' ? edit(session) : edit;
      if (change === undefined) { outcome = undefined; return true; }
      if (!(await store.cas(sessionId, session.version, withEdit(session, change))).ok) return false;
      outcome = undefined;
      return true;
    };
    const run = env.run?.();
    // No runner, no turns to wait for: one attempt, a lost compare-and-swap reported for the caller to retry.
    if (run === undefined) { await attempt(); return outcome ?? {}; }
    const write = run.write(sessionId, attempt, `[session_action] edit of session "${sessionId}" lost to repeated concurrent writes.`);
    if (write.deferred) return { deferred: true };
    await write.done;
    return outcome ?? {};
  };

  return {
    name: 'session_action',
    description:
      'Manage conversation sessions. A session is a stored conversation — a chronological list of ' +
      'messages identified by a unique ID, with a title and a status (active or archived). This tool ' +
      'covers the lifecycle: list sessions, search their contents (query), fetch one in full (get), ' +
      'rename one, hide (archive) one, unhide (unarchive) one, or append a message to one.\n\n' +
      'Each "list"/"query" row may carry "state": "prompting" (a turn is waiting on an answer from a person), ' +
      '"running" (a turn is running or queued) or "unread" (it has messages nobody has been shown). "get" with ' +
      '"markRead": true records that what it returns has been shown — for a frontend displaying the ' +
      'session; reading a session for your own purposes is not showing it to anyone.\n\n' +
      '"append" posts "text" into a conversation as a message from the assistant, without starting a turn. ' +
      'With no "sessionId" it goes to the conversation the run reports to — for a background job, the one ' +
      'the job was created with; in an ordinary turn, the one this call is made from. A job\'s own session ' +
      'is a throwaway nobody reads, so it is never the target; a run with no conversation to report to ' +
      'must name one. ' +
      'Use it when the user should be able to follow up on what you say: it becomes part of ' +
      'that conversation, so a later question there has it as context. It lands once no turn is running in ' +
      'that conversation — at once if none is — and while it waits the result says "deferred": true (always, ' +
      'for this conversation). A bare notification that needs no follow-up is telegram_send\'s job; ' +
      'append is the one that keeps context.\n\n' +
      'With "submit", "text" is not said but ASKED: it is posted as a request to that conversation, which ' +
      'answers it as it would a person\'s message, with its own tools, and the result carries the answering ' +
      'turn\'s "traceId". "submit" says what happens if a turn is running there when it arrives (with none, ' +
      'all three answer at once), and only you know which you need, because it turns on whether your request ' +
      'depends on messages appended before it: ' +
      '"queue" waits for that turn to end and is answered with everything appended meanwhile in front of it — ' +
      'use it when the request is about what you (or turns you started) appended; ' +
      '"parallel" answers at once, beside that turn, on a copy holding neither that turn\'s work nor anything ' +
      'appended while it runs — use it only for a request that stands alone; ' +
      '"interrupt" stops that turn, keeping what it finished, and answers this next, after the appends — ' +
      'made from that very turn, it ends the turn making the call. Use it when what you ' +
      'found needs that conversation to act or decide, e.g. "The email 123 from virginmedia.com announces a ' +
      'planned outage on Friday. What mitigation should we put in place?" — not for a report, which needs ' +
      'no answer. Write it to stand alone: the conversation sees your words, not your working.\n\n' +
      'A rename, hide or unhide of a session with a turn running in it — including the one this call is ' +
      'made from — is applied once that turn ends, and the result says "deferred": true. Do not re-issue it.\n\n' +
      '"list" and "query" return lightweight summaries — each item\'s "preview" is just the session\'s ' +
      'first user message truncated to 60 characters (empty if it has no text), a display label, not a ' +
      'summary of the conversation. To read a session\'s contents, use "get".\n\n' +
      '"query" searches with the store query grammar. Two synthesized string fields hold the conversation ' +
      'text and are matched case-insensitively: "user" (everything the user said) and "assistant" ' +
      '(everything the assistant said) — e.g. sessions where the user mentioned invoices: ' +
      '{ where: { op: "stringContains", field: "user", value: "invoice" } }. Search both sides by OR-ing ' +
      'a clause on each field. The stored fields "status", "title", "createdAt" and "updatedAt" are also ' +
      'queryable (eq/neq/in/lt/lte/gt/gte/exists), combinable with and/or/not. Optional "sort" (stored ' +
      'fields only, e.g. [{ field: "updatedAt", dir: "desc" }]), "limit" (the search early-exits once this ' +
      'many match), and "cursor" (from a previous result) paginate. To COUNT matching sessions rather than ' +
      'read them, query with "limit": 0 — the result is just { total } with no items.',
    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action:          { type: 'string', enum: ['list', 'query', 'get', 'rename', 'hide', 'unhide', 'append'], description: 'The operation to perform.' },
        sessionId:       { type: 'string', description: 'ID of the target session. Required for get/rename/hide/unhide. For append it is optional, and when given it wins outright; when omitted the default is the conversation the run reports to — never a background job\'s own session, which is a throwaway.' },
        text:            { type: 'string', description: 'append only: the message to post.' },
        submit:          { type: 'string', enum: ['queue', 'parallel', 'interrupt'], description: 'append only: post "text" as a request the conversation answers, rather than as a message from you, and say how it meets a turn running there: "queue" (after it, and after everything appended meanwhile), "parallel" (at once, beside it, without what was appended) or "interrupt" (stop it, then this). Omit to post a message without starting a turn.' },
        title:           { type: 'string', description: 'New title — required for action "rename".' },
        markRead:        { type: 'boolean', description: 'get only: record that the returned session has been shown to its reader. Default false.' },
        includeArchived: { type: 'boolean', description: 'list only: include archived sessions. Default false.' },
        where:           { type: 'object', description: 'query only: a store-query Filter over "user"/"assistant" (session text) and stored fields. See description.' },
        sort:            { type: 'array',  description: 'query only: SortSpec[] over stored fields, e.g. [{ "field": "updatedAt", "dir": "desc" }].' },
        limit:           { type: 'number', description: 'query only: max results — the search early-exits once this many match. 0 counts instead: no items, just "total" (it cannot early-exit, so it reads every session).' },
        cursor:          { type: 'string', description: 'query only: opaque cursor from a previous query result, for the next page.' },
      },
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = input as Partial<SessionInput> & { action?: string };

        switch (args.action) {
          case 'list': {
            const { includeArchived } = args as Extract<SessionInput, { action: 'list' }>;
            // `immutable`: this path reads four summary fields and never edits a document, so the store
            // may hand back shared instances — which is what lets it skip re-parsing every session body
            // on a sidebar refresh (see FilesystemStore's parse cache).
            const { items } = await store.query(
              includeArchived
                ? { immutable: true }
                : { immutable: true, where: { op: 'neq', field: 'status', value: 'archived' } },
            );
            const sorted = items.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            const run = env.run?.();
            yield { type: 'result', value: sorted.map(s => toSummary(s, run)) };
            return;
          }

          case 'query': {
            const { where, sort, limit, cursor } = args as Extract<SessionInput, { action: 'query' }>;

            // A cursor fully determines its page (its `where` was already normalized when encoded);
            // otherwise take the caller's clauses, lowercasing synth-field operands for case-insensitivity.
            let page: PageState;
            try {
              // Validate what the CALLER passed, before the destructure above discards the rest of it.
              // This grammar is flat — every key beside `action` is a query key — so an unknown one
              // (`filter`, the SQL-ism LLMs reach for) was simply dropped: the query degraded to
              // match-everything and the caller got every session back with no error. That silent miss is
              // the whole reason `validateQuery` rejects unknown top-level keys, and projecting first is
              // exactly what hid them from it. The store tools avoid this by handing the caller's `query`
              // object straight to the store; the flat grammar has to do it here.
              const { action: _action, ...envelope } = args as Record<string, unknown>;
              validateQuery(envelope as unknown as StoreQuery);

              if (cursor !== undefined) {
                page = decodeCursor(cursor);
                validateQuery({
                  ...(page.where !== undefined ? { where: page.where } : {}),
                  ...(page.sort  !== undefined ? { sort:  page.sort  } : {}),
                  ...(page.limit !== undefined ? { limit: page.limit } : {}),
                });
              } else {
                const q: StoreQuery = {
                  ...(where !== undefined ? { where: lowerSynthOperands(where) } : {}),
                  ...(sort  !== undefined ? { sort  } : {}),
                  ...(limit !== undefined ? { limit } : {}),
                };
                validateQuery(q);
                page = {
                  offset: 0,
                  ...(q.where !== undefined ? { where: q.where } : {}),
                  ...(q.sort  !== undefined ? { sort:  q.sort  } : {}),
                  ...(q.limit !== undefined ? { limit: q.limit } : {}),
                };
              }
            } catch (e) {
              if (e instanceof StoreQueryError) { yield { type: 'error', message: `${e.message} (at ${e.pointer})` }; return; }
              throw e;
            }

            const { items } = await store.query({ immutable: true });   // read-only: summarised, never edited
            const ordered   = applySort(items, page.sort);   // stored-field ordering, before any text synthesis
            const match     = page.where !== undefined ? compileFilter(page.where) : () => true;

            // `limit: 0` is the count form, and it is the one query that cannot early-exit: an exact
            // total means every session is synthesized and tested. That is the expensive query here,
            // deliberately — the alternative is a page the caller only measures, which costs the model
            // far more to read than it costs us to scan.
            const counting = page.limit === 0;

            // The for-loop with the early break: synthesize + test one session at a time and stop the
            // moment the page is full, so a low `limit` over hundreds of sessions never searches the tail.
            const rows: SessionSummary[] = [];
            const run = env.run?.();
            let matched = 0;
            for (const s of ordered) {
              if (!counting && page.limit !== undefined && rows.length >= page.limit) break;
              if (!match({ ...s, ...synthRoles(s) })) continue;
              if (matched++ >= page.offset && !counting) rows.push(toSummary(s, run));
            }

            // Optimistic cursor: emitted whenever the page filled, so the next page may be empty — the
            // price of early-exit (we don't scan on to confirm a further match exists). `total` is omitted
            // for the same reason: we never counted the tail — except when counting, where it is the answer.
            const nextPage = (!counting && page.limit !== undefined && rows.length >= page.limit)
              ? { cursor: encodeCursor({ ...page, offset: page.offset + page.limit }) }
              : {};
            yield { type: 'result', value: { items: rows, ...(counting ? { total: matched } : {}), ...nextPage } };
            return;
          }

          case 'get': {
            const { sessionId, markRead } = args as Extract<SessionInput, { action: 'get' }>;
            if (!sessionId) { yield { type: 'error', message: 'action "get" requires "sessionId".' }; return; }
            // Pure committed history. Pending submissions and the in-progress response are the live
            // "delta" delivered over the runner's event stream, never overlaid onto stored state.
            const session = await store.get(sessionId);
            if (!session) { yield { type: 'error', message: `Session "${sessionId}" not found.` }; return; }
            // Read up to what this call returns, not to whatever is there when the write lands: it waits for
            // a running turn, whose reply nobody has been shown. Not awaited — the reader has its answer, and
            // a mark that cannot land leaves the session unread, which is the truth.
            if (markRead === true && !isSubAgent()) void editFields(sessionId, readTo(lastActivityAt(session)));
            yield { type: 'result', value: session };
            return;
          }

          case 'rename': {
            const { sessionId, title } = args as Extract<SessionInput, { action: 'rename' }>;
            if (!sessionId) { yield { type: 'error', message: 'action "rename" requires "sessionId".' }; return; }
            if (title === undefined) { yield { type: 'error', message: 'action "rename" requires "title".' }; return; }
            const outcome = await editFields(sessionId, { title });
            if (typeof outcome === 'string') { yield { type: 'error', message: outcome }; return; }
            yield { type: 'result', value: { id: sessionId, title, ...outcome } };
            return;
          }

          case 'hide': {
            const { sessionId } = args as Extract<SessionInput, { action: 'hide' }>;
            if (!sessionId) { yield { type: 'error', message: 'action "hide" requires "sessionId".' }; return; }
            const outcome = await editFields(sessionId, { status: 'archived' });
            if (typeof outcome === 'string') { yield { type: 'error', message: outcome }; return; }
            yield { type: 'result', value: { id: sessionId, status: 'archived', ...outcome } };
            return;
          }

          case 'unhide': {
            const { sessionId } = args as Extract<SessionInput, { action: 'unhide' }>;
            if (!sessionId) { yield { type: 'error', message: 'action "unhide" requires "sessionId".' }; return; }
            const outcome = await editFields(sessionId, { status: 'active' });
            if (typeof outcome === 'string') { yield { type: 'error', message: outcome }; return; }
            yield { type: 'result', value: { id: sessionId, status: 'active', ...outcome } };
            return;
          }

          case 'append': {
            const { sessionId, text, submit } = args as Extract<SessionInput, { action: 'append' }>;
            if (typeof text !== 'string' || text.trim() === '') { yield { type: 'error', message: 'action "append" requires "text".' }; return; }
            if (submit !== undefined && !SUBMIT_MODES.includes(submit)) {
              yield { type: 'error', message: `"submit" is one of ${SUBMIT_MODES.map(m => `"${m}"`).join(', ')}, or omitted to post a message without starting a turn; got ${JSON.stringify(submit)}.`, failure: 'invalid' };
              return;
            }
            const appender = ctx.appender ?? env.appender?.();
            if (appender === undefined) { yield { type: 'error', message: 'Nothing here can append to a session.' }; return; }
            // A background job's own session — in its own process, or an ephemeral run's here — is a throwaway
            // one nobody will read, so there the default is the conversation the run reports to, which its
            // appender knows, or none at all.
            const throwaway = isSubAgent() || ctx.appender !== undefined;
            const target = sessionId ?? appender.defaultSessionId ?? (throwaway ? undefined : ctx.session.id);
            if (target === undefined) {
              yield { type: 'error', message: 'This run reports to no conversation, so name the session to append to ("sessionId").' };
              return;
            }
            try {
              const content = [{ type: 'text' as const, text, origin: 'robo' as const }];
              const { sessionId: id, messageIds, deferred, traceId } = await appender.append(target, [
                submit === undefined ? { role: 'assistant', content } : { role: 'user', content, mode: submit },
              ]);
              yield { type: 'result', value: { id, messageIds, ...(deferred ? { deferred } : {}), ...(traceId !== undefined ? { traceId } : {}) } };
            } catch (e) {
              yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            return;
          }

          default:
            yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: list, query, get, rename, hide, unhide, append.` };
        }
      },
    },
  };
}

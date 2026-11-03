import * as path from 'node:path';
import { refusalMessage } from '@matatbread/matbot-plugin-api';
import type { ImportCaller, PermissionDecision, PermissionRequest, PermissionSnapshot } from '@matatbread/matbot-plugin-api';
import { caseInsensitiveAt, directoryOf, realResolve, type Access } from './paths.js';

/**
 * The question a path is put as. Gate `fs-read` or `fs-write` (qualified by the consumer as
 * `tool_function.fs-read`), subject `<function> <realpath>` — the same shape as the import gate's, so one
 * policy files and reports both.
 *
 * Standing answers, narrowest first: this path, this path for ANY function, everything in its directory,
 * and that directory for any function. The file for any function is what excludes one file from a directory
 * granted (`deny:tool_function.fs-read`: `* /home/me/project/.env` inside `* /home/me/project/`), and it
 * comes before the function's own directory so that, at the same depth, the file is the narrower answer.
 * Subjects are a hierarchy at `path.sep` (`PermissionRequest.separators`), so a directory
 * answer covers everything below it, whatever directory a later request is in. A body reaching ABOVE a
 * granted directory is asked again. The realpath keeps that sound: a symlink inside a granted tree that
 * points out of it is asked about at its target. The `*` form is also how an installation configures a
 * directory for every function, allow or deny, under `default_settings:`
 * (`'tool_function.fs-read': { '*': ['* /home/me/project/'] }`, `'deny:tool_function.fs-read': { '*': ['* /home/me/.ssh/'] }`).
 * The most specific answer wins, so a configured deny carves a subtree out of a broader grant, and an allow
 * of one directory reopens it inside a broader deny. "For this session" is how a piece of work reaches a
 * directory without granting it for ever.
 */
export function fsRequest(caller: Pick<ImportCaller, 'fn' | 'who'>, access: Access, op: string, real: string): PermissionRequest {
  const dir  = directoryOf(real);
  const verb = access === 'read' ? 'read' : 'write to';
  const { fn, who } = caller;
  // A subject ending at the separator covers everything below it, so an answer for the root — even for
  // "this path", `/` itself — would be an answer for every path: path gating switched off, from a prompt
  // about one file. That is removing this plugin, and is said so rather than offered.
  const atRoot = dir === path.parse(real).root;
  return {
    gate:     `fs-${access}`,
    subject:  `${fn} ${real}`,
    label:    `Allow ${who} to ${verb} **${real}** (\`fs.${op}\`)?` +
              (access === 'write' ? ' Writing includes creating, changing and deleting.' : ''),
    fallback: false,
    standing: [
      { subject: `${fn} ${real}`, label: `${who} to ${verb} ${real}` },
      { subject: `* ${real}`,     label: `ANY function to ${verb} ${real}` },
      ...(atRoot ? [] : [
        { subject: `${fn} ${dir}`,  label: `${who} to ${verb} anything in ${dir}` },
        { subject: `* ${dir}`,      label: `ANY function to ${verb} anything in ${dir}` },
      ]),
    ],
    separators: [path.sep],
  };
}

/**
 * What one invocation has learnt, shared by every module it imports (`node:fs` and `node:fs/promises` are
 * two imports and one body). `snapshot` is what its synchronous calls consult; `memo` holds the answers it
 * obtained, so a body reading one file in a loop is asked once — and a refused one is not asked again on
 * every pass; `queue` serialises the questions, so a `Promise.all` over a directory asks one at a time and
 * each later one sees an "Always … in this directory" given to an earlier one instead of prompting too.
 */
export interface Decisions {
  snapshot: PermissionSnapshot;
  readonly memo: Map<string, PermissionDecision>;
  queue: Promise<unknown>;
}

const perCaller = new WeakMap<ImportCaller, Promise<Decisions>>();

/** The invocation's {@link Decisions}, made at its first import — which is async, so the snapshot its
 *  synchronous calls need is taken there, before the body holds the module. */
export function decisionsFor(caller: ImportCaller): Promise<Decisions> {
  let got = perCaller.get(caller);
  if (got === undefined) {
    got = caller.snapshot().then(snapshot => ({ snapshot, memo: new Map(), queue: Promise.resolve() }));
    perCaller.set(caller, got);
  }
  return got;
}

const keyOf = (req: PermissionRequest): string => `${req.gate}\0${req.subject}`;

export function refusal(message: string): Error {
  return Object.assign(new Error(message), { code: 'EACCES' });
}

/**
 * On a volume that ignores case, a standing DENIAL of the path spelled in lower case. A subject is the name
 * as stored on disk, which is what an answer given at a prompt names; one typed into the configuration in
 * another case would otherwise never match, and on such a volume it names the same file. Lower case is
 * the one other spelling a policy that compares strings can be asked about, so a denial written that way
 * holds for every spelling — of a file that does not exist yet, too, which has no stored name to resolve
 * to. Only a denial: folding an ALLOW would let one spelling stand for another.
 */
function foldedDenial(st: Decisions, caller: ImportCaller, access: Access, op: string, real: string): PermissionDecision | undefined {
  const lower = real.toLowerCase();
  if (lower === real || !caseInsensitiveAt(real)) return undefined;
  const d = st.snapshot(fsRequest(caller, access, op, lower));
  return !d.allowed && d.source !== 'fallback' ? d : undefined;
}

/** The root itself: see {@link fsRequest}. */
function refuseRoot(real: string, op: string, arg: string): void {
  if (real !== path.parse(real).root) return;
  throw refusal(`fs.${op} of "${arg}": the filesystem root is not asked about, since any answer for it would be an answer ` +
                'for every path. To stop gating the paths a function body touches, remove the gate-fs-node plugin.');
}

/** Ask, prompting if nothing standing decides. For an asynchronous operation. */
export async function admit(st: Decisions, caller: ImportCaller, access: Access, op: string, arg: string): Promise<void> {
  const real = realResolve(arg);
  refuseRoot(real, op, arg);
  const denied = foldedDenial(st, caller, access, op, real);
  if (denied !== undefined) throw refusal(refusalMessage(denied, `fs.${op} of "${arg}"`));
  const req = fsRequest(caller, access, op, real);
  const key = keyOf(req);
  let decision = st.memo.get(key);
  if (decision === undefined) {
    const asking = st.queue.then(async () => {
      const earlier = st.memo.get(key);
      if (earlier !== undefined) return earlier;
      const d = await caller.gate(req);
      // A human answered, and may have answered "Always…": the synchronous calls see it from here on.
      if (d.source === 'user') st.snapshot = await caller.snapshot();
      st.memo.set(key, d);
      return d;
    });
    st.queue = asking.catch(() => {});
    decision = await asking;
  }
  if (!decision.allowed) throw refusal(refusalMessage(decision, `fs.${op} of "${arg}"`));
}

/** Consult what was decided in advance, never asking. For a synchronous operation, which cannot. */
export function admitSync(st: Decisions, caller: ImportCaller, access: Access, op: string, arg: string): void {
  const real = realResolve(arg);
  refuseRoot(real, op, arg);
  const req = fsRequest(caller, access, op, real);
  const decision = foldedDenial(st, caller, access, op, real) ?? st.memo.get(keyOf(req)) ?? st.snapshot(req);
  if (decision.allowed) return;
  if (decision.source === 'fallback') {
    const async = op.endsWith('Sync') ? `fs.promises.${op.slice(0, -'Sync'.length)}` : 'the fs.promises form';
    throw refusal(
      `fs.${op} of "${arg}": not permitted for ${caller.who}. A synchronous call cannot ask for permission, ` +
      `and no standing answer allows ${access === 'read' ? 'reading' : 'writing to'} it. Use ${async} (or the ` +
      `callback form) to be asked, or have a standing answer given for tool_function.fs-${access}.`,
    );
  }
  throw refusal(refusalMessage(decision, `fs.${op} of "${arg}"`));
}

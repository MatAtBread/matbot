import type { Tool, ToolExecutor, ToolContext, ToolContract, ToolResultOf, MatbotPluginSpec, MatbotMachine, MimeType } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, tryCurrentPrincipal, ItemChangeKind, collectBytes, decodeBase64, encodeBase64 } from '@matatbread/matbot-plugin-api';

// Set in setup(); announces this tool's own writes and deletes. A file store's `watch` may also see a
// write (the filesystem one does) — a duplicate notification is harmless, since a consumer re-queries
// rather than applying a delta — but a DELETE is announced here or nowhere: the filesystem watch cannot
// express one, and a backend need not implement watch at all. No-op before setup.
let announceFile: (id: string, operation: 'saved' | 'deleted', name: string) => void = () => {};

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // One arm per action: a caller of `invokeTool(machine, 'workspace_action', { action: '…' })` gets the
    // matching result narrowed by the `action` it passed (see ToolContract / the multi-action note on ToolContracts).
    workspace_action:
      | ToolContract<string,                                { action: 'read';   name: string; encoding?: 'utf8' | 'base64' }>              // file contents (utf8 or base64)
      | ToolContract<{ name: string; mimeType: string; bytes: number }, { action: 'show'; name: string }>                                  // what was put in front of the model — metadata only; the bytes went to its eyes, not here
      | ToolContract<{ name: string; bytes: number; fileId: string }, { action: 'write'; name: string; content: string; encoding?: 'utf8' | 'base64' }>  // stored name, byte count and the store id it was minted under
      | ToolContract<Array<{ name: string; size: number }>, { action: 'list';   prefix?: string }>                                         // matching files
      | ToolContract<{ name: string },                      { action: 'delete'; name: string }>;                                          // the removed name
  }
}

const WORKSPACE_NS = 'workspace';

/**
 * Ceiling on one `show`. Tool media rides the outgoing copy for the REST OF THE TURN — it is re-sent on
 * every subsequent round — so the cost of showing something is paid once per round, not once. A refusal
 * here is visible (the model is told, and can pick something smaller); the alternative is invisible and
 * arrives as a bill.
 *
 * 8MB, the same number as `MEDIA_RESIDENCY_BYTES`, because it is the same question denominated the same
 * way: how many bytes may ride the outgoing copy. Reusing it rather than inventing a second number is
 * deliberate — and like that one, it is a first guess. One knob; measure before adding a second.
 */
const SHOW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Which inline arm a stored file goes to the model as, or null if it must not go at all.
 *
 * Two refusals only, and neither is about capability: SVG is XML and `text/*` is prose or markup, and
 * for both `read` hands over the source, which is the more useful answer. Everything else — including a
 * type `MIME_MAP` never learned — is routed on the assumption that the endpoint takes it, and left to
 * the endpoint to reject.
 *
 * That way round because we hold no per-model mime capability table, so refusing here is guessing on the
 * model's behalf, and the guess was wrong in the obvious case: `MIME_MAP` had no audio extension at all,
 * so every workspace `.mp3` typed as `application/octet-stream`, `show` refused it, and the tool that
 * advertises audio sent the model to `read` — which hands back base64 it cannot hear. Being wrong the
 * other way is cheap: tool media is wire-only and dies with the turn.
 *
 * Contrast core's `armFor`, which MUST refuse an undecodable `image/*`. Not an inconsistency — a
 * different blast radius. There the refusal protects a PERSISTED `file-ref`, which resolves into every
 * subsequent outgoing copy and so fails every later turn too; here the worst case is one turn.
 */
function showArm(mimeType: string): 'image' | 'audio' | 'document' | null {
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  if (base === 'image/svg+xml')     return null;
  if (base.startsWith('text/'))     return null;
  if (base.startsWith('image/'))    return 'image';
  if (base.startsWith('audio/'))    return 'audio';
  return 'document';
}

const MIME_MAP: Record<string, string> = {
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv':  'text/csv; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.m4a':  'audio/mp4',
  '.aac':  'audio/aac',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.pdf':  'application/pdf',
  '.zip':  'application/zip',
  '.sh':   'application/x-sh',
};

// Normalises to a flat store name. "." and empty segments drop out, so "./notes.md" and "notes.md"
// address the same file rather than two — names are stored verbatim, so leaving "." in forks the
// namespace on write. Returns null if a ".." segment would escape the workspace, "" for the root.
function normalise(input: string): string | null {
  const parts = input.replace(/\\/g, '/').split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) return null;
  return parts.join('/');
}

// A single file must resolve to a non-empty name; the root addresses no file.
function safeName(input: string): string | null {
  return normalise(input) || null;
}

function mimeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot !== -1 ? name.slice(dot).toLowerCase() : '';
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

// The precise per-action contract. JSON Schema can't express "content is required only for write"
// without an awkward oneOf the providers honour inconsistently, so the schema stays loose and the
// description below carries this TypeScript discriminated union — which LLMs read accurately — as
// the source of truth. The executor enforces it.
type WorkspaceInput =
  | { action: 'read';   name: string; encoding?: 'utf8' | 'base64' }
  | { action: 'show';   name: string }
  | { action: 'write';  name: string; content: string; encoding?: 'utf8' | 'base64' }
  | { action: 'list';   prefix?: string }
  | { action: 'delete'; name: string };

const workspaceExecutor: ToolExecutor<ToolResultOf<'workspace_action'>> = {
  async *execute(input: unknown, ctx: ToolContext) {
    const args = input as Partial<WorkspaceInput> & { action?: string };
    if (!ctx.files) { yield { type: 'error', message: 'No file store is configured for this session.' }; return; }

    switch (args.action) {
      case 'read': {
        const { name: inputName, encoding = 'utf8' } = args as Extract<WorkspaceInput, { action: 'read' }>;
        if (!inputName) { yield { type: 'error', message: 'action "read" requires "name".' }; return; }
        const safe = safeName(inputName);
        if (!safe) { yield { type: 'error', message: `Invalid name "${inputName}": it must name a file inside the workspace.` }; return; }

        const handle = await ctx.files.getByName(safe, WORKSPACE_NS);
        if (!handle) { yield { type: 'error', message: `File not found: "${safe}"` }; return; }

        let bytes: Uint8Array;
        try {
          bytes = await collectBytes(handle.stream(ctx.signal));
        } catch (e) {
          yield { type: 'error', message: String(e) };
          return;
        }

        yield {
          type:  'result',
          value: encoding === 'base64' ? encodeBase64(bytes) : new TextDecoder().decode(bytes),
        };
        return;
      }

      // The pull half of matbot's media model: the model asks to LOOK at a stored file, and the bytes go
      // to its eyes rather than into the transcript. `read` cannot do this and never could — its result
      // is a string, so base64 there is 4/3 of the file persisted into the session document and re-sent
      // every round thereafter, for something the model still cannot see.
      case 'show': {
        const { name: inputName } = args as Extract<WorkspaceInput, { action: 'show' }>;
        if (!inputName) { yield { type: 'error', message: 'action "show" requires "name".' }; return; }
        const safe = safeName(inputName);
        if (!safe) { yield { type: 'error', message: `Invalid name "${inputName}": it must name a file inside the workspace.` }; return; }

        const handle = await ctx.files.getByName(safe, WORKSPACE_NS);
        if (!handle) { yield { type: 'error', message: `File not found: "${safe}"` }; return; }

        const arm = showArm(handle.mimeType);
        if (arm === null) {
          yield { type: 'error', message:
            `"${safe}" is ${handle.mimeType}, which is better read than shown. Use action "read" ` +
            `instead — for text, markup and SVG it gives you the source, which is what you want.` };
          return;
        }
        // Refused BEFORE the read: the size is on the handle, so there is no reason to pull 40MB into
        // memory to discover it was too big.
        if (handle.size > SHOW_MAX_BYTES) {
          yield { type: 'error', message:
            `"${safe}" is ${(handle.size / (1024 * 1024)).toFixed(1)}MB, over the ` +
            `${SHOW_MAX_BYTES / (1024 * 1024)}MB limit for one shown file. Shown media is re-sent on ` +
            `every subsequent round of this turn, so a large file is expensive repeatedly. Show a ` +
            `smaller version, or read it another way.` };
          return;
        }

        let bytes: Uint8Array;
        try {
          bytes = await collectBytes(handle.stream(ctx.signal));
        } catch (e) {
          yield { type: 'error', message: String(e) };
          return;
        }

        // No magic-byte check here, unlike the submission boundary. There, a bad file persists as a
        // `file-ref` and fails EVERY later turn; here the media is wire-only and turn-scoped, so a
        // provider that rejects it costs this turn and nothing after it.
        const data = encodeBase64(bytes);
        yield { type: 'model-content', content: [arm === 'document'
          ? { type: 'document', data, mimeType: handle.mimeType as MimeType, name: safe }
          : { type: arm,        data, mimeType: handle.mimeType as MimeType }] };

        // Metadata only. The transcript records that the file was shown, never the bytes it showed —
        // which is what keeps a session from accumulating base64 as the model looks at things.
        yield { type: 'result', value: { name: safe, mimeType: handle.mimeType, bytes: handle.size } };
        return;
      }

      case 'write': {
        const { name: inputName, content, encoding = 'utf8' } = args as Extract<WorkspaceInput, { action: 'write' }>;
        if (!inputName) { yield { type: 'error', message: 'action "write" requires "name".' }; return; }
        if (content === undefined) { yield { type: 'error', message: 'action "write" requires "content".' }; return; }
        const safe = safeName(inputName);
        if (!safe) { yield { type: 'error', message: `Invalid name "${inputName}": it must name a file inside the workspace.` }; return; }

        const bytes = encoding === 'base64'
          ? decodeBase64(content)
          : new TextEncoder().encode(content);

        async function* makeStream(): AsyncIterable<Uint8Array> { yield bytes; }

        let handle;
        try {
          handle = await ctx.files.put(safe, mimeFromName(safe), makeStream(), { namespace: WORKSPACE_NS, allowed: true });
        } catch (e) {
          yield { type: 'error', message: String(e) };
          return;
        }

        announceFile(handle.id, 'saved', safe);
        // `fileId` too: a caller that just uploaded had no way to address what it wrote except by
        // guessing the name back, which is not the same question once a backend partitions or renames.
        yield { type: 'result', value: { name: safe, bytes: handle.size, fileId: handle.id } };
        return;
      }

      case 'list': {
        const { prefix: inputPrefix } = args as Extract<WorkspaceInput, { action: 'list' }>;
        const dir = inputPrefix === undefined ? '' : normalise(inputPrefix);
        if (dir === null) { yield { type: 'error', message: `Invalid prefix "${inputPrefix}": it must not escape the workspace.` }; return; }
        const prefix = dir ? `${dir}/` : '';

        const files: Array<{ name: string; size: number }> = [];
        try {
          for await (const handle of ctx.files.list({ namespace: WORKSPACE_NS })) {
            const name = handle.name;
            if (prefix && !name.startsWith(prefix)) continue;
            files.push({ name, size: handle.size });
          }
        } catch (e) {
          yield { type: 'error', message: String(e) };
          return;
        }

        yield { type: 'result', value: files };
        return;
      }

      case 'delete': {
        const { name: inputName } = args as Extract<WorkspaceInput, { action: 'delete' }>;
        if (!inputName) { yield { type: 'error', message: 'action "delete" requires "name".' }; return; }
        const safe = safeName(inputName);
        if (!safe) { yield { type: 'error', message: `Invalid name "${inputName}": it must name a file inside the workspace.` }; return; }

        const handle = await ctx.files.getByName(safe, WORKSPACE_NS);
        if (!handle) { yield { type: 'error', message: `File not found: "${safe}"` }; return; }

        await ctx.files.delete(handle.id);
        announceFile(handle.id, 'deleted', safe);
        yield { type: 'result', value: { name: safe } };
        return;
      }

      default:
        yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: read, write, list, delete.` };
    }
  },
};

const workspaceTool: Tool<ToolResultOf<'workspace_action'>> = {
  name: 'workspace_action',
  description:
    'Read, show, write, list, and delete files in **matbot\'s cloud file storage** — the user\'s own files, kept ' +
    'in matbot\'s managed store (think a cloud drive, NOT the local disk), that the user has priority access ' +
    'to and direct visibility over (it backs the Workspace panel in the UI). PREFER this tool over shell/bash ' +
    'or any raw filesystem access whenever the user speaks of "a file", "the workspace", saving or reading ' +
    'output, uploads, downloads, generated artifacts (reports, charts, exports), or working notes and to-do ' +
    'lists — those live in this cloud store, visible to the user, not on the host disk. It is a scratch-and- ' +
    'transfer area, NOT a code workspace: files here are not executable. These files are publicly viewable; ' +
    'if a tool is available to mint a shareable link for a stored file, prefer it over guessing a URL. To ' +
    'share one of these files with another storage profile, use the share tool with namespace "files" and id ' +
    'set to the file\'s name.\n\n' +
    'A file is addressed by `name`, and a name is one flat string — there are no directories here, so ' +
    'there is nothing to create, change into or walk. A "/" inside a name is an ordinary character that ' +
    'names happen to share ("charts/data.csv"), which is why `list` always returns every matching file ' +
    'and its `prefix` selects by whole segments: "charts" matches "charts/data.csv", "char" matches ' +
    'nothing, and omitting it lists the whole workspace. Listed names are complete names, ready to pass ' +
    'straight back as `name`.\n\n' +
    'TO LOOK AT AN IMAGE OR PDF STORED HERE, USE `show` — it puts the file in front of your own eyes, so ' +
    'you can see a photo, a screenshot, a chart or a scanned page and answer questions about what is in ' +
    'it. That is the ONLY way to see one: `read` returns text, so reading an image gives you base64 you ' +
    'cannot look at, and there is no need to fetch, convert or copy the file anywhere first. `show` takes ' +
    'images, PDFs, audio and any other binary format — whether a given model can decode one is its own ' +
    'business, and one it cannot take degrades to a note saying the file was there. For text, markup and ' +
    'SVG use `read`, which gives you the source.\n' +
    "Use encoding 'base64' with read/write to MOVE binary bytes (copying a file, storing something you " +
    "generated) — it is not a way to see a picture; 'utf8' (the default) is for text.",
  inputSchema: {
    type:       'object',
    required:   ['action'],
    properties: {
      action:    { type: 'string', enum: ['read', 'show', 'write', 'list', 'delete'], description: 'The operation to perform. "show" displays a stored image, PDF, audio or other binary file to you so you can see/hear it; "read" returns file contents as text.' },
      name:      { type: 'string', description: 'read/show/write/delete only: the whole name of one file (e.g. "report.md", "charts/data.csv").' },
      prefix:    { type: 'string', description: 'list only: restrict the listing to names beginning with these segments (e.g. "charts"). Omit it to list the whole workspace.' },
      content:   { type: 'string', description: 'File contents — required for action "write".' },
      encoding:  { type: 'string', enum: ['utf8', 'base64'], default: 'utf8', description: "Used by read/write only. 'base64' moves binary bytes in or out; it does NOT let you see an image — use action \"show\" for that. 'utf8' (default) for text." },
    },
  },
  executor: workspaceExecutor,
};

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools: [workspaceTool],
  async setup(services: MatbotMachine) {
    announceFile = (id, operation, name) => {
      const principal = tryCurrentPrincipal();
      services.Notifier.notify({
        kind: ItemChangeKind, source: 'workspace', operation, namespace: 'files', id,
        // Advisory, and the file store's own watch supplies the same two fields when it has one: the
        // content namespace + name a frontend needs to place the row it is being told about. Without it a
        // consumer can only re-list, which is correct but loses the in-place update on backends that
        // cannot watch (sqlite, Drive) — i.e. exactly where this announcement is the only signal.
        detail: { namespace: WORKSPACE_NS, name },
        ...(principal !== undefined ? { principal } : {}),
      });
    };
  },
};

import type { Tool, ToolExecutor, ToolContext, ToolContract, ToolResultOf, MatbotPluginSpec, MatbotMachine } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, tryCurrentPrincipal, ItemChangeKind } from '@matatbread/matbot-plugin-api';

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
      | ToolContract<{ name: string; bytes: number; fileId: string }, { action: 'write'; name: string; content: string; encoding?: 'utf8' | 'base64' }>  // stored name, byte count and the store id it was minted under
      | ToolContract<Array<{ name: string; size: number }>, { action: 'list';   prefix?: string }>                                         // matching files
      | ToolContract<{ name: string },                      { action: 'delete'; name: string }>;                                          // the removed name
  }
}

const WORKSPACE_NS = 'workspace';

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

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

async function collectStream(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) { chunks.push(chunk); total += chunk.byteLength; }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

// The precise per-action contract. JSON Schema can't express "content is required only for write"
// without an awkward oneOf the providers honour inconsistently, so the schema stays loose and the
// description below carries this TypeScript discriminated union — which LLMs read accurately — as
// the source of truth. The executor enforces it.
type WorkspaceInput =
  | { action: 'read';   name: string; encoding?: 'utf8' | 'base64' }
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
          bytes = await collectStream(handle.stream(ctx.signal));
        } catch (e) {
          yield { type: 'error', message: String(e) };
          return;
        }

        yield {
          type:  'result',
          value: encoding === 'base64' ? uint8ToBase64(bytes) : new TextDecoder().decode(bytes),
        };
        return;
      }

      case 'write': {
        const { name: inputName, content, encoding = 'utf8' } = args as Extract<WorkspaceInput, { action: 'write' }>;
        if (!inputName) { yield { type: 'error', message: 'action "write" requires "name".' }; return; }
        if (content === undefined) { yield { type: 'error', message: 'action "write" requires "content".' }; return; }
        const safe = safeName(inputName);
        if (!safe) { yield { type: 'error', message: `Invalid name "${inputName}": it must name a file inside the workspace.` }; return; }

        const bytes = encoding === 'base64'
          ? base64ToUint8(content)
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
    'Read, write, list, and delete files in **matbot\'s cloud file storage** — the user\'s own files, kept ' +
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
    'straight back as `name`.\n' +
    "Use encoding 'base64' for binary files (images, PDFs, zips); 'utf8' (the default) for text.",
  inputSchema: {
    type:       'object',
    required:   ['action'],
    properties: {
      action:    { type: 'string', enum: ['read', 'write', 'list', 'delete'], description: 'The operation to perform.' },
      name:      { type: 'string', description: 'read/write/delete only: the whole name of one file (e.g. "report.md", "charts/data.csv").' },
      prefix:    { type: 'string', description: 'list only: restrict the listing to names beginning with these segments (e.g. "charts"). Omit it to list the whole workspace.' },
      content:   { type: 'string', description: 'File contents — required for action "write".' },
      encoding:  { type: 'string', enum: ['utf8', 'base64'], default: 'utf8', description: "Used by read/write. 'base64' for binary files, 'utf8' (default) for text." },
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

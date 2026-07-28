import type { Tool, ToolExecutor, ToolContext, ToolContract, ToolResultOf, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // One arm per action: a caller of `invokeTool(machine, 'workspace_action', { action: '…' })` gets the
    // matching result narrowed by the `action` it passed (see ToolContract / the multi-action note on ToolContracts).
    workspace_action:
      | ToolContract<string,                                { action: 'read';   path: string; encoding?: 'utf8' | 'base64' }>              // file contents (utf8 or base64)
      | ToolContract<{ path: string; bytes: number },       { action: 'write';  path: string; content: string; encoding?: 'utf8' | 'base64' }>  // stored path and byte count
      | ToolContract<Array<{ path: string; size: number }>, { action: 'list';   path?: string; recursive?: boolean }>                     // matching files
      | ToolContract<{ path: string },                      { action: 'delete'; path: string }>;                                          // the removed path
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

// Returns a normalised relative path if safe, null if it contains traversal.
function safePath(input: string): string | null {
  const parts = input.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some(p => p === '..')) return null;
  return parts.join('/');
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
  | { action: 'read';   path: string; encoding?: 'utf8' | 'base64' }
  | { action: 'write';  path: string; content: string; encoding?: 'utf8' | 'base64' }
  | { action: 'list';   path?: string; recursive?: boolean }
  | { action: 'delete'; path: string };

const workspaceExecutor: ToolExecutor<ToolResultOf<'workspace_action'>> = {
  async *execute(input: unknown, ctx: ToolContext) {
    const args = input as Partial<WorkspaceInput> & { action?: string };
    if (!ctx.files) { yield { type: 'error', message: 'No file store is configured for this session.' }; return; }

    switch (args.action) {
      case 'read': {
        const { path: inputPath, encoding = 'utf8' } = args as Extract<WorkspaceInput, { action: 'read' }>;
        if (!inputPath) { yield { type: 'error', message: 'action "read" requires "path".' }; return; }
        const safe = safePath(inputPath);
        if (!safe) { yield { type: 'error', message: 'Path escapes the workspace directory.' }; return; }

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
        const { path: inputPath, content, encoding = 'utf8' } = args as Extract<WorkspaceInput, { action: 'write' }>;
        if (!inputPath) { yield { type: 'error', message: 'action "write" requires "path".' }; return; }
        if (content === undefined) { yield { type: 'error', message: 'action "write" requires "content".' }; return; }
        const safe = safePath(inputPath);
        if (!safe) { yield { type: 'error', message: 'Path escapes the workspace directory.' }; return; }

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

        yield { type: 'result', value: { path: safe, bytes: handle.size } };
        return;
      }

      case 'list': {
        const { path: inputPath, recursive = false } = args as Extract<WorkspaceInput, { action: 'list' }>;
        const prefix = inputPath ? `${safePath(inputPath) ?? ''}/` : '';

        const files: Array<{ path: string; size: number }> = [];
        try {
          for await (const handle of ctx.files.list({ namespace: WORKSPACE_NS })) {
            const name = handle.name;
            if (prefix && !name.startsWith(prefix)) continue;
            const rel = prefix ? name.slice(prefix.length) : name;
            if (!recursive && rel.includes('/')) continue;
            files.push({ path: name, size: handle.size });
          }
        } catch (e) {
          yield { type: 'error', message: String(e) };
          return;
        }

        yield { type: 'result', value: files };
        return;
      }

      case 'delete': {
        const { path: inputPath } = args as Extract<WorkspaceInput, { action: 'delete' }>;
        if (!inputPath) { yield { type: 'error', message: 'action "delete" requires "path".' }; return; }
        const safe = safePath(inputPath);
        if (!safe) { yield { type: 'error', message: 'Path escapes the workspace directory.' }; return; }

        const handle = await ctx.files.getByName(safe, WORKSPACE_NS);
        if (!handle) { yield { type: 'error', message: `File not found: "${safe}"` }; return; }

        await ctx.files.delete(handle.id);
        yield { type: 'result', value: { path: safe } };
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
    'set to the file\'s path.\n\n' +
    'For `list`, `path` is a filename prefix, not a directory — "." and "/" match nothing.\n' +
    "Use encoding 'base64' for binary files (images, PDFs, zips); 'utf8' (the default) for text.",
  inputSchema: {
    type:       'object',
    required:   ['action'],
    properties: {
      action:    { type: 'string', enum: ['read', 'write', 'list', 'delete'], description: 'The operation to perform.' },
      path:      { type: 'string', description: 'File path relative to the workspace root (e.g. "report.md", "charts/data.csv"). Required for read/write/delete; optional subdirectory filter for list.' },
      content:   { type: 'string', description: 'File contents — required for action "write".' },
      encoding:  { type: 'string', enum: ['utf8', 'base64'], default: 'utf8', description: "Used by read/write. 'base64' for binary files, 'utf8' (default) for text." },
      recursive: { type: 'boolean', default: false, description: 'list only: include files in subdirectories.' },
    },
  },
  executor: workspaceExecutor,
};

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools: [workspaceTool],
};

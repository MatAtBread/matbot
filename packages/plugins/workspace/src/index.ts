import type { Tool, ToolEvent, ToolContext, MatbotPlugin } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

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

interface ReadInput   { path: string; encoding?: 'utf8' | 'base64' }
interface WriteInput  { path: string; content: string; encoding?: 'utf8' | 'base64' }
interface ListInput   { path?: string; recursive?: boolean }
interface DeleteInput { path: string }

const workspaceReadTool: Tool = {
  name: 'workspace_read',
  description:
    'Read a file from the session workspace. ' +
    'When the web frontend is running, workspace files are also accessible as static links ' +
    'at /workspace/<path> on the current HTTP host (use a relative URL) — you can share these URLs directly with the user.',
  inputSchema: {
    type:       'object',
    required:   ['path'],
    properties: {
      path:     { type: 'string', description: 'Path of the file to read, relative to the workspace root.' },
      encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8', description: 'utf8 for text files, base64 for binary.' },
    },
  },
  executor: {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { path: inputPath, encoding = 'utf8' } = input as ReadInput;
      if (!ctx.files) { yield { type: 'error', message: 'No file store is configured for this session.' }; return; }

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
    },
  },
};

const workspaceWriteTool: Tool = {
  name: 'workspace_write',
  description:
    'Write a file to the session workspace. ' +
    'Parent directories are created automatically. ' +
    'Once written, the file is immediately accessible as a static link at /workspace/<path> on the HTTP server ' +
    'when the web frontend is running — provide this URL to the user so they can download or view the file.',  inputSchema: {
    type:       'object',
    required:   ['path', 'content'],
    properties: {
      path:     { type: 'string', description: 'Destination path relative to the workspace root (e.g. "report.md", "charts/data.csv").' },
      content:  { type: 'string', description: 'File content to write.' },
      encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8', description: 'utf8 for text, base64 for binary content.' },
    },
  },
  executor: {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { path: inputPath, content, encoding = 'utf8' } = input as WriteInput;
      if (!ctx.files) { yield { type: 'error', message: 'No file store is configured for this session.' }; return; }

      const safe = safePath(inputPath);
      if (!safe) { yield { type: 'error', message: 'Path escapes the workspace directory.' }; return; }

      const bytes = encoding === 'base64'
        ? base64ToUint8(content)
        : new TextEncoder().encode(content);

      async function* makeStream(): AsyncIterable<Uint8Array> { yield bytes; }

      let handle;
      try {
        handle = await ctx.files.put(safe, mimeFromName(safe), makeStream(), { namespace: WORKSPACE_NS });
      } catch (e) {
        yield { type: 'error', message: String(e) };
        return;
      }

      yield { type: 'result', value: { path: safe, bytes: handle.size } };
    },
  },
};

const workspaceListTool: Tool = {
  name: 'workspace_list',
  description:
    'List files in the session workspace. ' +
    'Returns each file\'s relative path and size in bytes. ' +
    'Files are accessible at /workspace/<path> on the HTTP server when the web frontend is running.',  inputSchema: {
    type:       'object',
    properties: {
      path:      { type: 'string', description: 'Subdirectory to list, relative to workspace root. Defaults to the workspace root.' },
      recursive: { type: 'boolean', default: false, description: 'Whether to list files in subdirectories.' },
    },
  },
  executor: {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { path: inputPath, recursive = false } = input as ListInput;
      if (!ctx.files) { yield { type: 'error', message: 'No file store is configured for this session.' }; return; }

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
    },
  },
};

const workspaceDeleteTool: Tool = {
  name: 'workspace_delete',
  description: 'Delete a file from the session workspace.',  inputSchema: {
    type:       'object',
    required:   ['path'],
    properties: {
      path: { type: 'string', description: 'Path of the file to delete, relative to the workspace root.' },
    },
  },
  executor: {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { path: inputPath } = input as DeleteInput;
      if (!ctx.files) { yield { type: 'error', message: 'No file store is configured for this session.' }; return; }

      const safe = safePath(inputPath);
      if (!safe) { yield { type: 'error', message: 'Path escapes the workspace directory.' }; return; }

      const handle = await ctx.files.getByName(safe, WORKSPACE_NS);
      if (!handle) { yield { type: 'error', message: `File not found: "${safe}"` }; return; }

      await ctx.files.delete(handle.id);
      yield { type: 'result', value: { path: safe } };
    },
  },
};

export const plugin: MatbotPlugin = {
  name:       'workspace',
  apiVersion: PLUGIN_API_VERSION,
  tools: [workspaceReadTool, workspaceWriteTool, workspaceListTool, workspaceDeleteTool],
};

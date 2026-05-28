import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { join, relative, resolve, dirname } from 'node:path';
import type { Tool, ToolEvent, ToolContext, MatbotPlugin } from '@matbot/plugin-api';
import { PLUGIN_API_VERSION } from '@matbot/plugin-api';

// Returns the resolved absolute path if it is within workdir, null if it escapes.
function safePath(workdir: string, input: string): string | null {
  const full = resolve(join(workdir, input));
  const rel  = relative(resolve(workdir), full);
  return rel.startsWith('..') ? null : full;
}

async function listDir(
  dir:       string,
  base:      string,
  recursive: boolean,
): Promise<Array<{ path: string; size: number }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: Array<{ path: string; size: number }> = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (recursive) {
        results.push(...await listDir(join(dir, entry.name), rel, true));
      }
    } else {
      const info = await stat(join(dir, entry.name));
      results.push({ path: rel, size: info.size });
    }
  }
  return results;
}

interface ReadInput  { path: string; encoding?: 'utf8' | 'base64' }
interface WriteInput { path: string; content: string; encoding?: 'utf8' | 'base64' }
interface ListInput  { path?: string; recursive?: boolean }

const workspaceReadTool: Tool = {
  name: 'workspace_read',
  description:
    'Read a file from the session workspace directory. ' +
    'When the web frontend is running, workspace files are also accessible as static links ' +
    'at /workspace/<path> on the HTTP server — you can share these URLs directly with the user.',
  requires:    ['filesystem'],
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
      if (!ctx.workdir) { yield { type: 'error', message: 'No workspace directory is configured for this session.' }; return; }

      const full = safePath(ctx.workdir, inputPath);
      if (!full) { yield { type: 'error', message: 'Path escapes the workspace directory.' }; return; }

      let data: Buffer;
      try {
        data = await readFile(full);
      } catch (e) {
        yield { type: 'error', message: String(e) };
        return;
      }

      yield { type: 'result', value: encoding === 'base64' ? data.toString('base64') : data.toString('utf8') };
    },
  },
};

const workspaceWriteTool: Tool = {
  name: 'workspace_write',
  description:
    'Write a file to the session workspace directory. ' +
    'Parent directories are created automatically. ' +
    'Once written, the file is immediately accessible as a static link at /workspace/<path> on the HTTP server ' +
    'when the web frontend is running — provide this URL to the user so they can download or view the file.',
  requires:    ['filesystem'],
  inputSchema: {
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
      if (!ctx.workdir) { yield { type: 'error', message: 'No workspace directory is configured for this session.' }; return; }

      const full = safePath(ctx.workdir, inputPath);
      if (!full) { yield { type: 'error', message: 'Path escapes the workspace directory.' }; return; }

      const data = encoding === 'base64'
        ? Buffer.from(content, 'base64')
        : Buffer.from(content, 'utf8');

      try {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, data);
      } catch (e) {
        yield { type: 'error', message: String(e) };
        return;
      }

      yield { type: 'result', value: { path: inputPath, bytes: data.byteLength } };
    },
  },
};

const workspaceListTool: Tool = {
  name: 'workspace_list',
  description:
    'List files in the session workspace directory. ' +
    'Returns each file\'s relative path and size in bytes. ' +
    'Files are accessible at /workspace/<path> on the HTTP server when the web frontend is running.',
  requires:    ['filesystem'],
  inputSchema: {
    type:       'object',
    properties: {
      path:      { type: 'string', description: 'Subdirectory to list, relative to workspace root. Defaults to the workspace root.' },
      recursive: { type: 'boolean', default: false, description: 'Whether to list files in subdirectories.' },
    },
  },
  executor: {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { path: inputPath = '', recursive = false } = input as ListInput;
      if (!ctx.workdir) { yield { type: 'error', message: 'No workspace directory is configured for this session.' }; return; }

      const full = safePath(ctx.workdir, inputPath);
      if (!full) { yield { type: 'error', message: 'Path escapes the workspace directory.' }; return; }

      let files: Array<{ path: string; size: number }>;
      try {
        files = await listDir(full, inputPath, recursive);
      } catch (e) {
        yield { type: 'error', message: String(e) };
        return;
      }

      yield { type: 'result', value: files };
    },
  },
};

export const plugin: MatbotPlugin = {
  name:       'workspace',
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Read, write, and list files in the session workspace directory. ' +
      'When the web frontend is running, all workspace files are also served as static ' +
      'read-only downloads at /workspace/<path> on the HTTP server, so you can give the user ' +
      'a direct link to any file you write there.',
  },
  tools: [workspaceReadTool, workspaceWriteTool, workspaceListTool],
};

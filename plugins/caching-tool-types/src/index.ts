import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_API_VERSION, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, PluginSettings } from '@matatbread/matbot-plugin-api';
import {
  ToolTypeIndexImpl, buildToolTypes, collectToolTypeRoots, filterToolTypesData,
  type ToolTypesData, type ToolTypesFill, type ToolTypesInputs,
} from '@matatbread/matbot-tool-types';

// tool-types, plus persistence. Its index already holds a build in memory and rebuilds after a tool
// registry change; this supplies the build it asks for on a miss, from the last one any process with the
// same inputs saved, and saves the ones it has to make. The build is ~2 s of blocked event loop on a
// one-CPU host, paid on every process's first tool call otherwise.
//
// What is stored is the build over every scanned tool, narrowed to the live ones on the way out, so a tool
// registered or removed — every `mcp__*` tool arriving after boot — is a filter, not a rebuild.
//
// A stored build is used only when everything it depends on is unchanged, cheapest check first:
//   1. the key — the roots in Program order (so the plugin set, and which of two clashing declarations
//      wins), the synthetic contracts, the principal, and the generator's own source;
//   2. every file the build read, by size and mtime, and by content only where an mtime moved (an image
//      build or a copy resets mtimes without changing a byte).
// Anything else is a miss, which builds exactly as tool-types would and saves the result.
//
// Several snapshots are kept, one per key, because one process can need more than one: a build asked
// for before the last plugin has loaded scans fewer roots than one asked for after, and with a single slot
// each overwrote the other, so every restart missed twice.
//
// What is stored is executable — each validator is source for `new Function` — so the settings medium
// must be trusted like plugin source.

const KEEP   = 4;                               // snapshots kept, most recently used first
const RECENT = 'recent';                          // the kept snapshots' keys
const snapshotKey = (key: string): string => `snapshot:${key}`;

interface Stamp { size: number; mtimeMs: number; sha256: string }

interface Snapshot {
  key:    string;
  stamps: Record<string, Stamp>;
  data:   ToolTypesData;
}

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

// The code that turns inputs into a build: tool-types' source, and this file's (which decides what a
// snapshot holds). Fixed for the life of the process, so hashed once.
let generator: string | undefined;
function generatorHash(): string {
  if (generator !== undefined) return generator;
  const toolTypesSrc = dirname(fileURLToPath(import.meta.resolve('@matatbread/matbot-tool-types')));
  const h = createHash('sha256');
  for (const name of readdirSync(toolTypesSrc).filter(n => n.endsWith('.ts')).sort()) {
    h.update(name).update(readFileSync(join(toolTypesSrc, name)));
  }
  h.update(readFileSync(fileURLToPath(import.meta.url)));
  return generator = h.digest('hex');
}

function keyOf(inputs: ToolTypesInputs, roots: readonly string[]): string {
  const principal = tryCurrentPrincipal();
  return sha256(JSON.stringify([
    generatorHash(),
    roots,
    Object.entries(inputs.syntheticContracts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    principal !== undefined ? [principal.type, principal.id] : null,
  ]));
}

function stamp(file: string): Stamp {
  const bytes = readFileSync(file);
  return { size: bytes.length, mtimeMs: statSync(file).mtimeMs, sha256: sha256(bytes) };
}

function unchanged(stamps: Readonly<Record<string, Stamp>>): boolean {
  for (const [file, was] of Object.entries(stamps)) {
    let now;
    try { now = statSync(file); } catch { return false; }
    if (now.size !== was.size) return false;
    if (now.mtimeMs === was.mtimeMs) continue;
    if (sha256(readFileSync(file)) !== was.sha256) return false;
  }
  return true;
}

export function cachingFill(settings: PluginSettings, build: ToolTypesFill = buildToolTypes): ToolTypesFill {
  // Snapshots read or saved by this process, so a tool added or removed later costs no settings read, only
  // the filter. The files are still checked each time: a hot-reloaded plugin keeps its root path, so an
  // edit to it shows only as a changed file.
  const held = new Map<string, Snapshot>();
  // Saves are chained so two never interleave their read-modify-write of the index.
  let saving: Promise<void> = Promise.resolve();

  const save = (snapshot: Snapshot): void => {
    saving = saving.then(async () => {
      const recent = (await settings.get<string[]>(RECENT)) ?? [];
      const next = [snapshot.key, ...recent.filter(k => k !== snapshot.key)];
      await settings.set(snapshotKey(snapshot.key), snapshot);
      await settings.set(RECENT, next.slice(0, KEEP));
      for (const gone of next.slice(KEEP)) await settings.delete(snapshotKey(gone));
    }).catch((e: unknown) => {
      console.warn(`[caching-tool-types] could not save the build: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  return async ({ liveToolNames, ...inputs }) => {
    const out = (data: ToolTypesData): ToolTypesData =>
      liveToolNames === undefined ? data : filterToolTypesData(data, liveToolNames);

    const found = await collectToolTypeRoots(inputs.projectRoot, inputs.pluginEntryUrls);
    if (!found) return build({ ...inputs, ...(liveToolNames !== undefined ? { liveToolNames } : {}) });
    const key = keyOf(inputs, found.roots);

    const stored = held.get(key) ?? await settings.get<Snapshot>(snapshotKey(key));
    if (stored !== undefined && unchanged(stored.stamps)) {
      held.set(key, stored);
      return out(stored.data);
    }
    held.delete(key);

    const data = await build(inputs);
    if (!data) return data;
    // Stamped straight after the build, so an edit landing later is seen as one next time rather than
    // absorbed into this snapshot. The write itself is not waited for: the build is already the caller's.
    const snapshot: Snapshot = { key, stamps: Object.fromEntries(data.files.map(f => [f, stamp(f)])), data };
    held.set(key, snapshot);
    save(snapshot);
    return out(data);
  };
}

export function createCachingToolTypesPlugin(): MatbotPluginSpec {
  let impl: ToolTypeIndexImpl | undefined;
  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: { description: 'Node-only ToolTypeIndex service: @matatbread/matbot-tool-types, with its build kept in plugin settings so a process whose plugins and tools are unchanged skips the TypeScript build. Load it instead of tool-types, not beside it.' },

    async setup(services) {
      impl = new ToolTypeIndexImpl(services, cachingFill(services.settings()));
      await services.register('ToolTypeIndex', impl);
    },

    async teardown() { impl?.close(); },
  };
}

export const plugin: MatbotPluginSpec = createCachingToolTypesPlugin();

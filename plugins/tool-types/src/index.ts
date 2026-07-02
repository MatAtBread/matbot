import type TS from 'typescript';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotMachine, MatbotPluginSpec, ToolTypeIndex } from '@matatbread/matbot-plugin-api';
import { buildMatbotToolsDts } from './build-dts.js';

export { buildMatbotToolsDts, type MatbotToolsDts } from './build-dts.js';

interface Contribution { result?: string; params?: string }

/**
 * Derives (via {@link buildMatbotToolsDts}) and caches the `.d.ts` of what the loaded tools' calls resolve
 * to, invalidating on any tool-registry change. Runtime-defined tools with no on-disk source register their
 * types through {@link contribute}; those are merged in as a second augmentation block using inline import
 * types (no top-level import, so it never collides with the derived block's own imports).
 */
class ToolTypeIndexImpl implements ToolTypeIndex {
  private readonly machine: MatbotMachine;
  private readonly ac = new AbortController();
  private readonly contributions = new Map<string, Contribution>();
  private cache: string | null = null;   // null ⇒ (re)build needed
  private dirty = true;

  constructor(machine: MatbotMachine) {
    this.machine = machine;
    void this.watchTools();
  }

  private async watchTools(): Promise<void> {
    try { for await (const _ev of this.machine.tools.watch(this.ac.signal)) this.dirty = true; }
    catch { /* signal aborted on teardown */ }
  }

  close(): void { this.ac.abort(); }

  async dts(): Promise<string> {
    if (this.dirty || this.cache === null) {
      const root  = this.machine.configPath !== undefined ? dirname(this.machine.configPath) : '.';
      const built = await buildMatbotToolsDts(root);
      this.cache  = built?.dts ?? '';
      this.dirty  = false;
    }
    return this.merge(this.cache);
  }

  contribute(name: string, types: Contribution): void { this.contributions.set(name, types); }
  retract(name: string): void { this.contributions.delete(name); }

  /** `declare const tool` typed from the live tool set: each result is `ToolResultOf<'name'>` (resolved via
   *  the ToolResults augmentations in the dts prefix); params stay loose (`any`) — a first cut that catches
   *  result-shape mistakes, the main source of guess-and-iterate. */
  private toolProxy(): string {
    const methods = this.machine.tools.list().map(t =>
      `  ${JSON.stringify(t.name)}(params?: any): Promise<import('@matatbread/matbot-plugin-api').ToolResultOf<${JSON.stringify(t.name)}>>;`).join('\n');
    return `declare const tool: {\n${methods}\n};`;
  }

  async check(snippet: string): Promise<string[]> {
    const ts   = (await import('typescript')).default;
    const root = this.machine.configPath !== undefined ? dirname(this.machine.configPath) : '.';
    const prefix = `${await this.dts()}\n${this.toolProxy()}\n`;
    const source = `${prefix}${snippet}\nexport {};\n`;           // trailing export ⇒ this file is a module
    const virtual = `${root}/__mb_toolcheck_${crypto.randomUUID()}.ts`;

    // Anchor `@matatbread/matbot-plugin-api` — it isn't a bare-resolvable dep of the project root, so map it
    // to the monorepo source (or the installed package). Without this the imports fail and every type
    // collapses to `any`, silently passing bad snippets.
    const monorepoApi = join(root, 'plugin-api', 'src', 'index.ts');
    let apiIndex: string | undefined = existsSync(monorepoApi) ? monorepoApi : undefined;
    if (apiIndex === undefined) {
      try { apiIndex = createRequire(join(root, '_')).resolve('@matatbread/matbot-plugin-api'); } catch { /* unresolved */ }
    }

    const options: TS.CompilerOptions = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true, baseUrl: root,
      ...(apiIndex !== undefined ? { paths: { '@matatbread/matbot-plugin-api': [apiIndex] } } : {}),
    };
    const host = ts.createCompilerHost(options);
    const getSF = host.getSourceFile.bind(host);
    host.getSourceFile = (f, lang, onErr, create) =>
      f === virtual ? ts.createSourceFile(f, source, lang, true) : getSF(f, lang, onErr, create);
    const fileExists = host.fileExists.bind(host); host.fileExists = f => f === virtual || fileExists(f);
    const readFile   = host.readFile.bind(host);   host.readFile   = f => (f === virtual ? source : readFile(f));

    const program = ts.createProgram([virtual], options, host);
    const sf = program.getSourceFile(virtual);
    if (sf === undefined) return [];

    const prefixLen   = prefix.length;
    const prefixLines = prefix.split('\n').length - 1;
    const out: string[] = [];
    for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
      if (typeof d.start !== 'number' || d.start < prefixLen) continue;   // only the caller's snippet
      const { line } = sf.getLineAndCharacterOfPosition(d.start);
      out.push(`line ${line - prefixLines + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    }
    return out;
  }

  private merge(derived: string): string {
    if (this.contributions.size === 0) return derived;
    const arms = [...this.contributions].map(([name, t]) =>
      `    ${name}: import('@matatbread/matbot-plugin-api').ToolResult<${t.result ?? 'unknown'}, ${t.params ?? 'unknown'}>;`).join('\n');
    return `${derived}\ndeclare module '@matatbread/matbot-plugin-api' {\n  interface ToolResults {\n${arms}\n  }\n}\n`;
  }
}

export function createToolTypesPlugin(): MatbotPluginSpec {
  let impl: ToolTypeIndexImpl | undefined;
  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: { description: 'Node-only ToolTypeIndex service: derives a .d.ts of the loaded tools\' result/service types so tool-call code generators and composers (skills_compiler, function-tools) can type what `tool` calls resolve to.' },

    async setup(services) {
      impl = new ToolTypeIndexImpl(services);
      await services.register('ToolTypeIndex', impl);
    },

    async teardown() { impl?.close(); },
  };
}

export const plugin: MatbotPluginSpec = createToolTypesPlugin();

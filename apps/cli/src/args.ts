import type { Principal }   from '@matatbread/matbot-core';
import { systemPrincipal } from '@matatbread/matbot-core';
import process             from 'node:process';
import type { MatbotConfig } from './config.js';
import { versionBanner }   from './banner.js';
import { findDuplicateSingletons, describeDuplicateSingleton } from './plugins/singletons.js';

export interface CliOpts {
  provider?:   string;
  session?:    string;
  system?:     string;
  config:      string;
  promptFile?: string;
  ephemeral:   boolean;
  principal?:  string;
  /** `--dump-tools [path]`: serialize the live tool registry to this file and exit (default tools-dump.json). */
  dumpTools?:  string;
}

export function parseArgs(argv: string[]): { opts: CliOpts; prompt: string | undefined } {
  const args = argv.slice(2);
  const opts: CliOpts = { config: './matbot.yaml', ephemeral: false };
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case '--provider':    { const v = args[++i]; if (v !== undefined) opts.provider   = v; } break;
      case '--session':     { const v = args[++i]; if (v !== undefined) opts.session    = v; } break;
      case '--system':      { const v = args[++i]; if (v !== undefined) opts.system     = v; } break;
      case '--config':      { const v = args[++i]; if (v !== undefined) opts.config     = v; } break;
      case '--prompt-file': { const v = args[++i]; if (v !== undefined) opts.promptFile = v; } break;
      case '--principal':   { const v = args[++i]; if (v !== undefined) opts.principal  = v; } break;
      case '--ephemeral':   opts.ephemeral = true; break;
      case '--dump-tools':  {
        const v = args[i + 1];
        if (v !== undefined && !v.startsWith('-')) { opts.dumpTools = v; i++; }
        else opts.dumpTools = 'tools-dump.json';
      } break;
      case '--help': printHelp(); process.exit(0);
      case '--version': case '-v':
        // No config is read here, so only the CLI's own install is probed — a plugin's copy is boot's to find.
        process.stdout.write([versionBanner(), ...findDuplicateSingletons({ plugins: [] }).map(d => `⚠ ${describeDuplicateSingleton(d)}`)].join('\n') + '\n');
        process.exit(0);
      default:
        if (!arg.startsWith('-')) positional.push(arg);
    }
  }

  return { opts, prompt: positional.length ? positional.join(' ') : undefined };
}

// A principal supplied as a CLI flag or env var: either a bare id (type "user") or the JSON
// `{"id","type"}` that spawners (e.g. the background plugin) write to MATBOT_PRINCIPAL.
function parsePrincipalArg(raw: string): Principal | undefined {
  const s = raw.trim();
  if (s === '') return undefined;
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s) as { id?: unknown; type?: unknown };
      if (typeof o.id === 'string' && o.id !== '' &&
          (o.type === 'user' || o.type === 'agent' || o.type === 'system')) {
        return { id: o.id, type: o.type };
      }
    } catch { /* fall through to invalid */ }
    return undefined;
  }
  return { id: s, type: 'user' };
}

// The process boot identity, resolved once at the entry. Precedence, most specific first:
//   --principal flag  →  MATBOT_PRINCIPAL env  →  config principal:  →  system.
// The env slot is the cross-process transport: a parent (pod/sandbox, or the background plugin
// delegating its creator) sets it; the child re-establishes that identity here.
export function resolveBootPrincipal(opts: CliOpts, config: MatbotConfig): Principal {
  if (opts.principal !== undefined) {
    const p = parsePrincipalArg(opts.principal);
    if (p === undefined) throw new Error(`Invalid --principal "${opts.principal}". Use an id (e.g. "alice") or JSON {"id","type"}.`);
    return p;
  }
  const env = process.env['MATBOT_PRINCIPAL'];
  if (env !== undefined && env.trim() !== '') {
    const p = parsePrincipalArg(env);
    if (p === undefined) throw new Error(`Invalid MATBOT_PRINCIPAL "${env}". Use an id or JSON {"id","type"}.`);
    return p;
  }
  if (config.principal !== undefined) return config.principal;
  return systemPrincipal();
}

function printHelp(): void {
  process.stderr.write(`
matbot — AI CLI

Usage:
  matbot [options] [prompt]
  matbot start [options]      Headless server mode: load plugins and wait for a frontend
  matbot install <package>    Install a plugin package and add it to matbot.yaml

Options:
  --provider    <name>      Provider key from matbot.yaml (default: first in file)
  --session     <id>|create Resume an existing session, or "create" to start a new persistent one
  --system      <text>      System prompt injected at session start
  --config      <path>      Config file path (default: ./matbot.yaml)
  --prompt-file <path>      Read prompt from file; run single turn and exit
  --ephemeral               Force ephemeral even when --session is given
  --dump-tools  [path]      Serialize the live tool registry (wire descriptions with folded TS
                            contracts + inputSchema) to a JSON file and exit (default tools-dump.json)
  --principal   <id|json>   Boot identity: an id (type "user") or JSON {"id","type"}.
                            Overrides MATBOT_PRINCIPAL and config principal:.
  --help                    Show this help
  --version, -v             Print the CLI + resolved core/plugin-api versions and exit

Sessions are ephemeral by default (discarded on exit). Use --session create to persist,
or --session <id> to resume a previously persisted session.

If [prompt] and --prompt-file are both omitted, starts an interactive REPL.
`.trimStart());
}

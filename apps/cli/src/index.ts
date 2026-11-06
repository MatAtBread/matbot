#!/usr/bin/env node
import { readFile }      from 'node:fs/promises';
import process           from 'node:process';
import path              from 'node:path';
import { parseArgs }     from './args.js';
import { bootMachine, loadCliConfig } from './boot.js';
import { converse }      from './conversation.js';
import { dumpTools }     from './dump-tools.js';
import { installCommand } from './install.js';
import { installConsolePrefix, stamp, yellow } from './terminal.js';
import { teardownPlugins } from '@matatbread/matbot-core';

installConsolePrefix();

async function main(): Promise<void> {
  if (process.argv[2] === 'install') {
    await installCommand(process.argv.slice(3));
    return;
  }
  const serverMode = process.argv[2] === 'start';

  const { opts, prompt: parsedPrompt } = parseArgs(process.argv);
  const { config, configPath } = await loadCliConfig(opts);

  // Merge prompt sources: CLI flag/arg > config file
  const prompt = opts.promptFile !== undefined
    ? await readFile(path.resolve(opts.promptFile), 'utf8')
    : (parsedPrompt ?? config.prompt);

  // Guard: stdin config without a prompt would consume stdin then hang on REPL
  if (opts.config === '-' && prompt === undefined) {
    throw new Error('--config - requires a prompt: field in the config or a positional prompt argument.');
  }

  const machine = await bootMachine(opts, config, configPath);

  // Here so every plugin + core tool is registered and the type index is populated; exits before the
  // server/REPL.
  if (opts.dumpTools !== undefined) {
    await dumpTools(machine.services, opts.dumpTools);
    process.exit(0);
  }

  if (serverMode) {
    process.stderr.write(yellow(`${stamp()} [matbot] server running — press Ctrl+C to stop\n`));
    const shutdown = (): void => {
      process.stderr.write(yellow('\n[matbot] shutting down…\n'));
      teardownPlugins()
      .then(async () => { await machine.services.StorageBackend?.close?.(); process.exit(0); })
      .catch(() => process.exit(1));
    };
    process.once('SIGINT',  shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  await converse(opts, config, machine, prompt);
}

main().catch(e => {
  process.stderr.write(yellow(`Fatal: ${String(e)}\n`));
  process.exit(1);
});

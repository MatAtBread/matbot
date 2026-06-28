#!/usr/bin/env node
// Installed entrypoint (`matbot`). The repl/start npm scripts pass `--import ./register.js` on the
// node command line, but a published bin can't inject node flags into its own invocation — so we do
// the equivalent in-process: importing register.js (a static import, fully evaluated first) installs
// the ts-hooks module-customization hook, then we load the CLI. register.js resolves ts-hooks.js and
// the host-shared singleton dirs relative to itself, so this works wherever npm installs the package.
import './register.js';
await import('./src/index.js');

// `node --import @matatbread/matbot-host-node/register app.ts` — what an application needs before it can
// import matbot's packages, which are published as TypeScript source. See typescript-hooks.js.
//
// In-thread, through `registerHooks()`: `register()` runs hooks on a thread of their own, which since Node
// 24.12 costs a round trip for every resolve and load, and is deprecated (DEP0205).
import { registerHooks } from 'node:module';
import { typescriptHooks } from './typescript-hooks.js';

registerHooks(typescriptHooks());

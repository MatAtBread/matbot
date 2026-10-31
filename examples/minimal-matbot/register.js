// matbot's packages are published as TypeScript source, importing each other as `./x.js` where the file
// on disk is `./x.ts`. Node strips types natively but does neither of the other two things that needs:
// it does not try `.ts` for a `.js` import, and it refuses to strip anything under node_modules, which
// is where these packages live once installed. These two hooks do both.
//
// They are written out here only to keep this example to `core` and nothing else, and to show how little
// it takes. Most applications should not copy them: `node --import @matatbread/matbot-host-node/register`
// registers the same two (with the edge cases handled), and an application that wants host-node's carriers
// or plugin loading has it as a dependency already. Not every one does — an embedder whose
// `loadPlugin` hands back provider plugins implemented in its own code needs nothing else from host-node,
// and may prefer a copy like this one to the dependency.
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (e?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js') || !context.parentURL?.endsWith('.ts')) throw e;
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context);
    const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'));
    return { format: 'module', source, shortCircuit: true };
  },
});

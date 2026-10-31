// The two Node module hooks that loading matbot's packages needs. They are published as TypeScript source
// importing `./x.js` where the file on disk is `./x.ts`, and Node, which strips types itself, does neither
// half of that: it does not try `.ts` for a `.js` import, and it refuses to strip anything under
// node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), which is where every package lives once
// installed. `register.js` beside this registers them; a host composing hooks of its own takes them here.
//
// Plain JavaScript with declarations beside it, for the same reason as cache-layout.js: this IS the type
// stripper, so it cannot itself be a `.ts`.
//
// Which of the two is tried first depends on who is importing. From a `.ts` file, `./x.js` is TypeScript's
// spelling of the sibling `./x.ts`, so that is tried first — matbot's own source is hundreds of such imports,
// and failing a `.js` lookup before each is a measurable share of a boot. From anything else the `.js` is
// tried first, so a package that ships compiled output is never shadowed by source it also ships.
// `require()` passes through untouched: CommonJS has its own rules, and a `.ts` it loads is not an ES
// module by fiat. A query string (a reload's cache-buster) is not part of the file name.
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const isRequire = context => context.conditions?.includes('require') ?? false;
const TS_FILE   = /^file:[^?#]*\.[cm]?ts(?:[?#].*)?$/;

export function typescriptHooks() {
  return {
    resolve(specifier, context, nextResolve) {
      if (isRequire(context) || !specifier.endsWith('.js')) return nextResolve(specifier, context);
      const ts = specifier.slice(0, -3) + '.ts';
      if (TS_FILE.test(context.parentURL ?? '')) {
        try { return nextResolve(ts, context); }
        catch { return nextResolve(specifier, context); }
      }
      try {
        return nextResolve(specifier, context);
      } catch (e) {
        if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
        try { return nextResolve(ts, context); }
        catch { throw e; }
      }
    },
    load(url, context, nextLoad) {
      if (isRequire(context) || !TS_FILE.test(url)) return nextLoad(url, context);
      const source = readFileSync(fileURLToPath(url.replace(/[?#].*$/, '')), 'utf8');
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url }), shortCircuit: true };
    },
  };
}

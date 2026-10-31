import type { Tool, ToolEvent, ToolResultOf, ToolContext } from '@matatbread/matbot-core';
import { storeSecret }     from '@matatbread/matbot-core';
import { listPlugins }     from './plugin/list.js';
import { discoverPlugins } from './plugin/discover.js';
import { addPlugin }       from './plugin/add.js';
import { removePlugin }    from './plugin/remove.js';
import { reloadPlugin }    from './plugin/reload.js';

type PluginInput =
  | { action: 'list' }
  | { action: 'add';            specifier: string }
  | { action: 'remove';         specifier: string }
  | { action: 'reload';         specifier: string; refresh?: boolean }
  | { action: 'store-key';      key: string }
  | { action: 'discover_local' };

// The config file is the CLI's, handed over when the tool is built: what this tool edits is how the CLI
// chooses to persist its plugin list, not something a tool call carries.
async function* executePlugin(configPath: string, input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent<ToolResultOf<'plugin'>>> {
  const req = input as PluginInput;
  switch (req.action) {
    case 'list':           yield* listPlugins(configPath); return;
    case 'discover_local': yield* discoverPlugins(configPath); return;
    case 'add':            yield* addPlugin(configPath, req.specifier, ctx); return;
    case 'remove':         yield* removePlugin(configPath, req.specifier, ctx); return;
    case 'reload':         yield* reloadPlugin(configPath, req.specifier, req.refresh ?? true, ctx); return;
    case 'store-key': {
      const stored = await storeSecret(ctx, req.key);
      yield 'error' in stored ? { type: 'error', message: stored.error } : { type: 'result', value: stored };
      return;
    }
  }
}

export function createPluginTool(configPath: string): Tool<ToolResultOf<'plugin'>> {
  return {
    name:        'plugin',
    description:
      'Manage matbot plugins — the units that contribute tools, providers, storage, hooks, and ' +
      'frontends to the running process. List or discover them, install or remove one, reload one ' +
      'to pick up code changes without restarting, or supply a secret a plugin or provider ' +
      'reported missing.\n\n' +
      'A `specifier` (for add/remove/reload) takes exactly one of THREE routes — local, npm, or http — ' +
      'each a set of spellings for the same mechanism. Pass a concrete string, not a fuzzy name (run ' +
      '`discover_local` first to find the exact specifier). If the user gives you a specifier, pass it ' +
      'through VERBATIM — never reformat it (especially a github: one):\n' +
      '```ts\n' +
      'type Specifier =\n' +
      '  // LOCAL — anything the disk already answers, PREFERRED over the registry. A path (resolved\n' +
      '  //   against the project dir; a package.json MUST exist at/above it — the leading "./" is\n' +
      '  //   optional), or a bare package NAME that a local package declares: in a source checkout\n' +
      '  //   "@matatbread/matbot-edit-session" is `plugins/edit-session`, and is used in place rather\n' +
      '  //   than installing a published copy of code already here.\n' +
      '  | "./<dir>" | "../<dir>" | "/<abs-dir>" | "file:///<abs-dir>" | "<dir>/<subdir>"\n' +
      '  | "<name>" | "@<scope>/<name>"            // when a local package declares that name\n' +
      '  // NPM — a package NAME nothing local claims (the registry, via your .npmrc: npmjs, verdaccio,\n' +
      '  //   private). Its manifest is read first and must declare matbotRuntime including "node". NAME\n' +
      '  //   ONLY: a "@<version>", a .tgz or a git URL is refused — which copy the project carries is its\n' +
      '  //   own decision; the user installs it with their package manager, then you add it by name.\n' +
      '  //   "npm:<name>" asks for the same; it is refused if something local also answers to the name.\n' +
      '  | "<name>" | "@<scope>/<name>"            // e.g. "@matatbread/matbot-persist-ki-bge"\n' +
      '  | "npm:<name>" | "npm:@<scope>/<name>"\n' +
      '  // HTTP — raw source, fetched & cached into .plugins/. MUST resolve a package.json: the URL is\n' +
      '  //   one, OR points at a directory containing one, OR is a code entry with one as its DIRECT\n' +
      '  //   SIBLING. "github:" is shorthand for this same route — use it for matbot source plugins,\n' +
      '  //   including one in a repo subdir; its "#<ref>" (branch/tag/commit) comes LAST, after "/<subdir>".\n' +
      '  | "https://<host>/<path>/" | "https://<host>/<path>/package.json"\n' +
      '  | "https://<host>/<path>/<entry>.ts"\n' +
      '  | "github:<owner>/<repo>" | "github:<owner>/<repo>/<subdir>"\n' +
      '  | "github:<owner>/<repo>#<ref>" | "github:<owner>/<repo>/<subdir>#<ref>";\n' +
      '```\n' +
      'Raw-source (HTTP/github) installs are packages: a package.json must resolve (the URL itself, a ' +
      'directory containing one, or — for a code-entry URL — its direct sibling), it must declare a "name", ' +
      'and its `matbotRuntime` must include "node"; the install is refused otherwise. ' +
      'Cached code lives read-only under `.plugins/`.\n\n' +
      'DEPENDENCY RESOLUTION BY SOURCE — decisive when a plugin depends on OTHER packages:\n' +
      '  • An npm name installs through the package manager, which resolves the FULL dependency tree. A ' +
      'package the project already has installed is configured as it is.\n' +
      '  • A local plugin (a path, or a name it declares) whose directory has no node_modules and no lockfile ' +
      'INSTALLS the `dependencies` its own package.json declares (npm, transitives included, listed in the ' +
      'install approval). One the author has installed into is used as it is when complete, and otherwise ' +
      'refused, naming what is missing — tell the user, do not install into it yourself. A manifest using ' +
      'workspace:/catalog:/link:/file: ranges is left alone — those mean something already resolves it, which ' +
      'is true of any plugin inside this repo.\n' +
      '  • HTTP/github fetches ONE package\'s files and INSTALLS the `dependencies` its package.json ' +
      'declares into its cache directory (npm, transitives included, listed in the add approval; a reload ' +
      'that brings a new one asks before loading it). ' +
      'Its relative, root-relative and absolute-URL imports are all fetched on demand, so a third-party ' +
      'dependency written as a URL ("https://esm.sh/ms@2.1.3") works too. A BARE import it does not declare ' +
      'means the host\'s own copy, so it must already be present. A URL import is fetched at exactly that URL, ' +
      'and a fetched plugin\'s own file is never imported by its URL (import it by its package name). ' +
      'A dependency it declares but nothing satisfies is reported ' +
      'at boot; an import that resolves nowhere fails naming both the specifier and the file that imported ' +
      'it, and is a genuine unmet dependency — install it, add it to `plugins:` if it is itself a matbot ' +
      'plugin, or express it as a URL. Do not retry name variations. ESM only on this route.\n\n' +
      'What `add` RECORDS in matbot.yaml is the canonical package **name** whenever that name resolves to ' +
      'the same place — so adding "./plugins/foo" configures "@scope/foo", the form that also works in an ' +
      'installed deployment. A path is kept only when nothing else resolves it. Pass whatever specifier you ' +
      'have; the tool normalises.\n\n' +
      'For remove/reload, prefer the plugin\'s canonical package.json **name** (the stable identity shown ' +
      'as `name` by `list`) — the exact matbot.yaml entry also works, but the resolved `specifier` shown ' +
      'under `loaded` may be a file: URL and is NOT the handle. A plugin name is unique, so addressing by ' +
      'name is unambiguous; `add` refuses a second plugin with a name already installed. To run another ' +
      'version of an installed npm plugin, the user installs it with their package manager and you `reload` it.\n\n' +
      'Every refusal of `add` comes before anything is asked or changed, and says what to do instead — follow ' +
      'it; do not retry other spellings of the same specifier.\n\n' +
      '`remove` deletes what a github/http plugin has in the .plugins cache (its source and the dependencies ' +
      'installed into it). What `add` changed in the PROJECT — an npm package it installed, or the node_modules ' +
      'and lockfile it created in a local plugin — is offered back, and only that: a package the project already ' +
      'declared, or one installed before matbot recorded installs, is left alone, with the command to remove it.',
    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action: {
          type:        'string',
          enum:        ['list', 'add', 'remove', 'reload', 'discover_local', 'store-key'],
          description: 'list: show configured plugins. add: install and register a plugin. remove: deregister, delete a github/http plugin\'s cached copy, and offer back what add installed into the project. reload: unload and re-import (picks up code changes without restarting; for a remote plugin re-downloads the latest upstream source by default — see refresh). The user is asked first when the code has changed since it was loaded. discover_local: scan plugins and the .plugins cache for installable plugins (each result reports its source). store-key: supply a secret (e.g. an API key) that a plugin or provider reported missing — you provide only the key name; the value is entered out-of-band. Leaving that value blank removes the named key instead.',
        },
        refresh: {
          type:        'boolean',
          description: 'reload only. Default true: re-download a remote (github/http) plugin\'s latest upstream source, evicting its .plugins cache. Set false to re-run against the cached copy (reset state, or work offline). No effect on local/npm plugins.',
        },
        specifier: {
          type:        'string',
          description: 'For remove/reload: the plugin\'s canonical package.json name (preferred — the `name` from `list`), ' +
                       'or its exact matbot.yaml entry. For add: a load specifier taking exactly one of three routes — ' +
                       'local (a path, or a bare name a local package declares — preferred over the registry), npm (a ' +
                       'package name nothing local claims, or an explicit "npm:<name>" — never a version, .tgz or git ' +
                       'URL), or http (an HTTP(S) URL or "github:<owner>/<repo>[/<subdir>][#<ref>]"). ' +
                       'An http package.json must resolve and declare a "name". See the tool description for the full grammar.',
        },
        key: {
          type:        'string',
          description: 'Name of the secret to store, e.g. SKILL_RANK_API_KEY (required for store-key). The vault decides which names it can hold — the default one persists to a .env file and takes environment-variable names only (a letter or underscore, then letters, digits or underscores), so prefer that shape; a name it cannot store is rejected with an error stating its rule. The value is prompted for separately and never enters the conversation; entering a blank value removes the key.',
        },
      },
    },
    executor: { execute: (input, ctx) => executePlugin(configPath, input, ctx) },
  };
}

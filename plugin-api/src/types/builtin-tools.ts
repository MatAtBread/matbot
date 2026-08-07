import type { PluginSource, Runtime } from '../plugin.js';
import type { ModelParameters } from './provider.js';
import type { ToolContract } from './tools.js';

/*
 * Call contracts for the two builtin admin tools that have BOTH a node and a browser implementation —
 * `plugin` (@matatbread/matbot-tool-plugin, @matatbread/matbot-browser) and `provider` (likewise).
 *
 * They live here, rather than beside either implementation, for two reasons.
 *
 * ONE DECLARATION, NOT TWO IDENTICAL ONES. A `ToolContracts` key is registered by declaration merging,
 * which requires every declaration of it to have the same type. Two implementations of one tool name
 * therefore cannot each describe themselves: the moment their shapes differ it is a TS2717, and since
 * the dts scan reads the checker rather than the Program's diagnostics, that error was invisible — one
 * declaration won on file order and its shape was emitted as the contract for whichever implementation
 * was actually loaded. Both tools now name the alias below, so the two declarations are the same
 * symbol and cannot drift; `buildMatbotToolsDts` reports it loudly if any pair ever does again.
 *
 * NAMED SHAPES ARE AUGMENTABLE. These were inline object literals, which closed the one extension point
 * the rest of the API leans on: a host that overrides a builtin tool and returns a superset had no way
 * to say so (declaring its own arm is TS2717; declaring nothing inherits a shape it does not return).
 * Naming them applies the open-registry technique in DEVELOPING.md one level down — a host augments the
 * shape and never touches `ToolContracts`:
 *
 *   declare module '@matatbread/matbot-plugin-api' {
 *     interface LoadedPluginSummary { managedBy?: 'personal' | 'shipped' }
 *   }
 *
 * Where the two runtimes genuinely differ, the shared shape carries the superset and the divergent
 * member is optional — absence is the honest encoding of "this runtime has nothing to report". Each
 * implementation's `inputSchema` is unchanged and still the enforcement point, per the multi-action
 * tool rule: loose schema, executor enforces.
 */

/** A tool as reported by `plugin`'s `list`/`builtinTools` — the name and blurb, not the schema. */
export interface ToolSummary {
  name:        string;
  description: string;
}

/**
 * A plugin the loader could not bring up — an incompatible runtime, an import that rejected, a module
 * that is not plugin-shaped, or a `setup()` throw. Recorded rather than discarded so the failure is
 * *graceful but not silent*: `plugin list` and the web plugins panel show which configured plugins
 * failed and why, instead of the failure vanishing into a boot-time console line. `error` is
 * pre-stringified (sidesteps the `unknown` catch-var); `name` is present only when it was known before
 * the failure.
 */
export interface FailedPlugin {
  specifier: string;
  name?:     string;
  error:     string;
}

/** One entry in `plugin list`'s `loaded`. */
export interface LoadedPluginSummary {
  name:       string;
  apiVersion: string;
  /** package.json `version`, read by the resolver at load. Absent ⇒ unreadable (no package.json, or a
   *  remote whose version isn't baked). */
  version?:   string;
  /** The stable URL the loader imported, minus any reload cache-bust stamp. Absent on a host that
   *  constructed the plugin by hand, and on runtimes with no meaningful URL to report. */
  resolvedUrl?: string;
  /** Every channel the plugin contributes through (`tools`, `hooks`, `storage`, registered service
   *  keys, …) — reflected from the registries, not declared. */
  types:      string[];
  tools:      ToolSummary[];
  specifier:  string;
  description?: string;
  matbotRuntime?: readonly Runtime[];
}

export interface PluginListResult {
  loaded:        LoadedPluginSummary[];
  configured:    string[];
  failed?:       FailedPlugin[] | undefined;
  /** Tools registered by the host rather than by any plugin. */
  builtinTools?: ToolSummary[] | undefined;
}

/** One installable plugin found by `plugin discover_local`. */
export interface DiscoveredPlugin {
  specifier:    string;
  name:         string;
  description:  string;
  version?:     string;
  /** `type` categorises the origin; `uri` is the concrete location as a scheme-qualified URI — `file://…`
   *  on disk, the `https://…` it was fetched from for a cached remote. Optional because it is the one
   *  member with no browser analogue: a baked-but-idle plugin was inlined into the artifact and has no
   *  location to name. Absent ⇒ nothing to resolve it back to, not "unknown origin". */
  source?:      { type: PluginSource; uri: string };
  matbotRuntime?: readonly Runtime[];
  /** Which config section already references this specifier, or `null` if none does. */
  configuredVia: 'plugins' | 'providers' | null;
}

/** Result of the mutating `plugin` actions. `installationMessage` is the loaded plugin's own greeting. */
export interface PluginActionResult {
  message:              string;
  installationMessage?: string;
}

/**
 * The `plugin` tool's contract. Both implementations declare `plugin: PluginToolContract`.
 *
 * `reload`'s `refresh` is node-only in effect (it re-downloads a remote plugin's upstream source);
 * the browser resolves every specifier through its import map and ignores the flag.
 */
export type PluginToolContract =
  | ToolContract<PluginListResult,    { action: 'list' }>
  | ToolContract<DiscoveredPlugin[],  { action: 'discover_local' }>
  | ToolContract<PluginActionResult,  { action: 'add';       specifier: string }>
  | ToolContract<PluginActionResult,  { action: 'remove';    specifier: string }>
  | ToolContract<PluginActionResult,  { action: 'reload';    specifier: string; refresh?: boolean }>
  | ToolContract<PluginActionResult,  { action: 'store-key'; key: string }>;

/** One configured provider profile as reported by `provider list`. */
export interface ProviderSummary {
  name:           string;
  /** The adapter's module specifier — the `module:` key in matbot.yaml. */
  module:         string;
  model:          string;
  /** Whether a credential is on file. Never the credential itself. */
  hasCredentials: boolean;
  endpoint?:      string;
  parameters?:    ModelParameters;
  maxRounds?:     number;
}

/** An adapter a `provider add` could name, offered by runtimes that can enumerate them. */
export interface AvailableProvider {
  label:          string;
  module:         string;
  endpointHint?:  string;
  modelHint?:     string;
  /** Needs no endpoint/model/API key (e.g. a self-contained local adapter): the browser wizard hides
   *  those fields and submits just a name, using `modelHint` as the model. */
  selfContained?: boolean;
}

export interface ProviderListResult {
  providers: ProviderSummary[];
  /** The adapters this runtime can offer. Present in the browser, where the set was baked into the
   *  artifact and is therefore knowable; absent on node, which discovers adapters through
   *  `plugin discover_local` instead of enumerating them here. */
  adapters?: AvailableProvider[];
}

export interface ProviderActionResult {
  message: string;
}

/**
 * The `provider` tool's contract. Both implementations declare `provider: ProviderToolContract`.
 *
 * `add` is the superset of the two: `model` is optional because a self-contained browser adapter
 * supplies its own, while node's executor requires one; `credentialKey`/`credentialEnvVar` name where
 * node's vault should hold the secret, and the browser (which prompts and stores under its own key)
 * ignores them.
 */
export type ProviderToolContract =
  | ToolContract<ProviderListResult,   { action: 'list' }>
  | ToolContract<ProviderActionResult, {
      action:            'add';
      name:              string;
      module:            string;
      model?:            string;
      endpoint?:         string;
      credentialKey?:    string;
      credentialEnvVar?: string;
      parameters?:       ModelParameters;
      maxRounds?:        number;
    }>
  | ToolContract<ProviderActionResult, { action: 'remove'; name: string }>;

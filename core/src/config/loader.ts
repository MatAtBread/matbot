import type { ModelParameters, Principal, ProviderConfig } from '@matatbread/matbot-plugin-api';
import { parseYaml, type YamlMap, type YamlValue } from './yaml.js';

export interface MatbotConfig {
  /** Ordered list of plugin specifiers to load at startup (npm names or URL paths) */
  plugins:    readonly string[];
  providers:  Map<string, ProviderConfig>;
  /** If set, run this prompt as a single non-interactive turn then exit. */
  prompt?:           string;
  /** If true, do not persist the session. */
  ephemeral?:        boolean;
  /** Provider key to use when none is specified on the CLI. Falls back to the first provider. */
  defaultProvider?:  string;
  /** Install-default boot identity. The lowest-precedence source for the entry's principal
   *  (a `--principal` flag or `MATBOT_PRINCIPAL` env override it); absent ⇒ the system principal. */
  principal?:        Principal;
  /**
   * Install-supplied floor for plugin settings, keyed by plugin NAME (the settings namespace), read
   * by {@link installSettingsDefaults}. Read-only: matbot never writes it back, so a default cannot
   * be destroyed by a plugin or provider update, and it applies to every principal because it is
   * config rather than data. A stored value always wins; `delete` reverts to the default here.
   */
  defaultSettings?:  ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  /**
   * Longest a `tool_function` body may run synchronously — without awaiting — before it is stopped
   * (`function_timeout_ms`). Absent ⇒ the host's default. `0` ⇒ no limit at all, for testing: bodies run
   * directly, and a loop that never awaits freezes the process.
   */
  functionTimeoutMs?: number;
}

function asString(v: YamlValue | undefined, label: string): string {
  if (typeof v === 'string') return v;
  throw new Error(`Config: expected string for "${label}", got ${v === undefined ? 'undefined' : typeof v}`);
}

function asRecord(v: YamlValue | undefined, label: string): YamlMap {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as YamlMap;
  throw new Error(`Config: expected mapping for "${label}", got ${v === undefined ? 'undefined' : typeof v}`);
}

function asNumber(v: YamlValue | undefined, label: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  throw new Error(`Config: expected number for "${label}", got ${v === undefined ? 'undefined' : typeof v}`);
}

function toModelParameters(raw: YamlMap): ModelParameters {
  const params: ModelParameters = {};
  for (const [k, v] of Object.entries(raw)) {
    params[k] = v as ModelParameters[string];
  }
  return params;
}

function toProviderConfig(name: string, raw: YamlMap): ProviderConfig {
  const module_ = asString(raw['module'], `providers.${name}.module`);
  const model   = asString(raw['model'],  `providers.${name}.model`);

  const credsRaw   = raw['credentials'];
  const credentials: Record<string, string> = {};
  if (credsRaw !== undefined) {
    const credsMap = asRecord(credsRaw, `providers.${name}.credentials`);
    for (const [k, v] of Object.entries(credsMap)) {
      credentials[k] = asString(v, `providers.${name}.credentials.${k}`);
    }
  }

  const config: ProviderConfig = { name, module: module_, model, credentials };

  if (raw['endpoint'] !== undefined) {
    config.endpoint = asString(raw['endpoint'], `providers.${name}.endpoint`);
  }
  if (raw['maxRounds'] !== undefined) {
    const rounds = asNumber(raw['maxRounds'], `providers.${name}.maxRounds`);
    // Rejected at the boundary rather than clamped: 0 or a fraction is a typo, and silently treating it
    // as "no turn may do anything" would look like the provider was broken.
    if (!Number.isInteger(rounds) || rounds < 1) {
      throw new Error(`Config: "providers.${name}.maxRounds" must be a positive integer, got ${rounds}`);
    }
    config.maxRounds = rounds;
  }
  if (raw['parameters'] !== undefined) {
    config.parameters = toModelParameters(asRecord(raw['parameters'], `providers.${name}.parameters`));
  }

  return config;
}

/**
 * Parse a config document, optionally over a `base` one it `extends:`.
 *
 * **The merge is per TOP-LEVEL KEY, and the derived document REPLACES rather than extends.** A child
 * declaring `plugins:` supplies the whole list — the base's entries are not appended — and the same
 * holds for `providers:` and `default_settings:`. There is no deep merge and no per-entry merge: the
 * unit is the section.
 *
 * That is deliberately stated rather than deliberately chosen. Section-replacement is what the one-line
 * spread has always done, and a caller reading "extends" reasonably expects the other reading, so the
 * semantics are pinned by test (config-extends.test.ts) — change them on purpose, not by editing this
 * line. Note also that `extends:` does not today give you a shared base: the CLI chdirs to the base's
 * directory and rewrites `configPath`, so the base becomes the project (`.data`, `.env`, and every yaml
 * write land there). See CLAUDE.md, *Default plugin settings*.
 */
export function parseConfig(
  text:  string,
  base?: string,
): MatbotConfig {
  const derived = parseYaml(text);
  const doc: YamlMap = base !== undefined
    ? { ...parseYaml(base), ...derived }
    : derived;

  // plugins: optional ordered list of specifiers
  const pluginsRaw = doc['plugins'];
  const plugins: string[] = [];
  if (pluginsRaw !== undefined && pluginsRaw !== null) {
    if (!Array.isArray(pluginsRaw)) {
      throw new Error('Config: "plugins" must be a sequence (list)');
    }
    for (let i = 0; i < pluginsRaw.length; i++) {
      plugins.push(asString(pluginsRaw[i], `plugins[${i}]`));
    }
  }

  const providersRaw = doc['providers'];
  const providers    = new Map<string, ProviderConfig>();

  if (providersRaw !== undefined && providersRaw !== null) {
    const providersMap = asRecord(providersRaw, 'providers');
    for (const [name, raw] of Object.entries(providersMap)) {
      providers.set(name, toProviderConfig(name, asRecord(raw, `providers.${name}`)));
    }
  }

  // Keyed by plugin name, not by the specifier written in `plugins:` — the name IS the settings
  // namespace, and the same plugin can be reached by several specifiers (a local path, the package
  // name, a version range). A key naming no loaded plugin is warned about at boot by the host: it is
  // otherwise the one silent failure mode here, and reads as "I set the default and nothing happened".
  const defaultSettingsRaw = doc['default_settings'];
  const defaultSettings    = new Map<string, Readonly<Record<string, unknown>>>();
  if (defaultSettingsRaw !== undefined && defaultSettingsRaw !== null) {
    for (const [name, raw] of Object.entries(asRecord(defaultSettingsRaw, 'default_settings'))) {
      defaultSettings.set(name, { ...asRecord(raw, `default_settings.${name}`) });
    }
  }

  const functionTimeoutRaw = doc['function_timeout_ms'];
  let functionTimeoutMs: number | undefined;
  if (functionTimeoutRaw !== undefined && functionTimeoutRaw !== null) {
    functionTimeoutMs = asNumber(functionTimeoutRaw, 'function_timeout_ms');
    // Refused rather than clamped, like maxRounds: a negative or fractional limit is a typo, and `0` already
    // means something of its own.
    if (!Number.isInteger(functionTimeoutMs) || functionTimeoutMs < 0) {
      throw new Error(`Config: "function_timeout_ms" must be a non-negative integer (milliseconds; 0 removes the limit), got ${functionTimeoutMs}`);
    }
  }

  const prompt           = typeof doc['prompt']            === 'string' ? doc['prompt']            : undefined;
  const ephemeral        = doc['ephemeral'] === true ? true : undefined;
  const defaultProvider  = typeof doc['default_provider'] === 'string' ? doc['default_provider']  : undefined;
  const principal        = toPrincipal(doc['principal']);

  return {
    plugins,
    providers,
    ...(prompt           !== undefined ? { prompt           } : {}),
    ...(ephemeral        !== undefined ? { ephemeral        } : {}),
    ...(defaultProvider  !== undefined ? { defaultProvider  } : {}),
    ...(principal        !== undefined ? { principal        } : {}),
    ...(defaultSettings.size > 0       ? { defaultSettings  } : {}),
    ...(functionTimeoutMs !== undefined ? { functionTimeoutMs } : {}),
  };
}

// principal: either a bare string id (type defaults to 'user') or a mapping { id, type? }.
function toPrincipal(v: YamlValue | undefined): Principal | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return { id: v, type: 'user' };
  if (typeof v === 'object' && !Array.isArray(v)) {
    const id   = (v as YamlMap)['id'];
    const type = (v as YamlMap)['type'];
    if (typeof id === 'string' && id !== '') {
      return { id, type: type === 'agent' || type === 'system' ? type : 'user' };
    }
  }
  throw new Error('Config: "principal" must be a string id or a mapping with a string "id" (and optional "type").');
}

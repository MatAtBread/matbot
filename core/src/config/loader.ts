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

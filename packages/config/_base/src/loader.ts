import { readFile } from 'node:fs/promises';
import type { ModelParameters, ProviderConfig } from '@matbot/plugin-api';
import { parseYaml, type YamlMap, type YamlValue } from './yaml.js';

export interface MatbotConfig {
  /** Ordered list of plugin specifiers to load at startup (npm names or URL paths) */
  plugins:   readonly string[];
  providers: Map<string, ProviderConfig>;
}

function asString(v: YamlValue | undefined, label: string): string {
  if (typeof v === 'string') return v;
  throw new Error(`Config: expected string for "${label}", got ${v === undefined ? 'undefined' : typeof v}`);
}

function asRecord(v: YamlValue | undefined, label: string): YamlMap {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as YamlMap;
  throw new Error(`Config: expected mapping for "${label}", got ${v === undefined ? 'undefined' : typeof v}`);
}

function toModelParameters(raw: YamlMap): ModelParameters {
  const params: ModelParameters = {};
  for (const [k, v] of Object.entries(raw)) {
    params[k] = v as ModelParameters[string];
  }
  return params;
}

function toProviderConfig(name: string, raw: YamlMap): ProviderConfig {
  const type  = asString(raw['type'],  `providers.${name}.type`);
  const model = asString(raw['model'], `providers.${name}.model`);

  const credsRaw   = raw['credentials'];
  const credentials: Record<string, string> = {};
  if (credsRaw !== undefined) {
    const credsMap = asRecord(credsRaw, `providers.${name}.credentials`);
    for (const [k, v] of Object.entries(credsMap)) {
      credentials[k] = asString(v, `providers.${name}.credentials.${k}`);
    }
  }

  const config: ProviderConfig = { name, type, model, credentials };

  if (raw['endpoint'] !== undefined) {
    config.endpoint = asString(raw['endpoint'], `providers.${name}.endpoint`);
  }
  if (raw['fallback'] !== undefined) {
    config.fallback = asString(raw['fallback'], `providers.${name}.fallback`);
  }
  if (raw['parameters'] !== undefined) {
    config.parameters = toModelParameters(asRecord(raw['parameters'], `providers.${name}.parameters`));
  }

  return config;
}

export function parseConfig(
  text: string,
  env: Record<string, string | undefined> = {},
): MatbotConfig {
  const doc = parseYaml(text, env);

  // plugins: optional ordered list of specifiers
  const pluginsRaw = doc['plugins'];
  const plugins: string[] = [];
  if (pluginsRaw !== undefined) {
    if (!Array.isArray(pluginsRaw)) {
      throw new Error('Config: "plugins" must be a sequence (list)');
    }
    for (let i = 0; i < pluginsRaw.length; i++) {
      plugins.push(asString(pluginsRaw[i], `plugins[${i}]`));
    }
  }

  const providersRaw = doc['providers'];
  const providers    = new Map<string, ProviderConfig>();

  if (providersRaw !== undefined) {
    const providersMap = asRecord(providersRaw, 'providers');
    for (const [name, raw] of Object.entries(providersMap)) {
      providers.set(name, toProviderConfig(name, asRecord(raw, `providers.${name}`)));
    }
  }

  return { plugins, providers };
}

/** Load and parse a YAML config file, substituting ${env:VAR} from process.env. */
export async function loadConfig(
  path: string,
  env: Record<string, string | undefined> = {},
): Promise<MatbotConfig> {
  const text = await readFile(path, 'utf8');
  return parseConfig(text, env);
}

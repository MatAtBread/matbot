import type { ProviderConfig, MatbotPluginSpec } from '@matatbread/matbot-core';
import { checkProviderModel }      from '@matatbread/matbot-core';
import { EnvFileVault }            from '@matatbread/matbot-host-node';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface }         from 'node:readline/promises';
import { createRequire }           from 'node:module';
import process                     from 'node:process';
import path                        from 'node:path';
import { readDotEnv, type MatbotConfig } from './config.js';
import { askPrompt, endInput, yellow }   from './terminal.js';

interface ProviderPackage { type: string; name: string; dir: string; }

// The provider adapters the CLI ships with (its dependencies). Resolved through the module graph
// rather than a directory scan, so discovery works identically when installed (node_modules) and in
// the monorepo (workspace symlinks). A user can `plugin add` other providers after setup.
// Listing a name here is not enough: it must also be a dependency of this package, or nothing links
// it into the CLI's node_modules and the resolve below silently skips it.
const BUNDLED_PROVIDERS = [
  '@matatbread/matbot-provider-anthropic',
  '@matatbread/matbot-provider-openai-compat',
  '@matatbread/matbot-provider-google',
  '@matatbread/matbot-provider-customer-services',
  '@matatbread/matbot-provider-chatjimmy'
];

async function discoverProviders(): Promise<ProviderPackage[]> {
  const require = createRequire(import.meta.url);
  const results: ProviderPackage[] = [];
  for (const name of BUNDLED_PROVIDERS) {
    let dir: string;
    try {
      // package root is two levels up from the entry (…/<pkg>/src/index.ts)
      dir = path.dirname(path.dirname(require.resolve(name)));
    } catch { continue; }  // not installed
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
      const type = name.slice('@matatbread/matbot-provider-'.length);
      results.push({ type, name: (pkg['name'] as string) ?? name, dir });
    } catch { /* unreadable package.json */ }
  }
  return results;
}

async function testEndpointReachable(url: string): Promise<string | false> {
  try {
    const { status, statusText } = (await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) }));
    return (status == 401 || status == 403) ? `Endpoint reachable but returned ${statusText} (check credentials)` : false;
  } catch (ex: any) {
    return `Endpoint failed (${ex?.message ?? String(ex)})`;
  }
}

/** First run, or a config with no providers: ask for one, write `configPath`, and return what was written. */
export async function runSetupWizard(configPath: string): Promise<MatbotConfig> {
  const rl  = createInterface({ input: process.stdin, output: process.stderr });
  const ask = async (question: string): Promise<string> => {
    try { return (await rl.question(askPrompt(`${question}: `))).trim(); } finally { endInput(); }
  };

  try {
    process.stderr.write(yellow('\nNo providers configured. Let\'s set one up.\n\n'));

    const discovered = await discoverProviders();
    if (discovered.length === 0) {
      throw new Error('No provider packages found. Cannot continue setup.');
    }

    process.stderr.write(yellow('Available provider types:\n'));
    for (let i = 0; i < discovered.length; i++) {
      process.stderr.write(yellow(`  ${i + 1}. ${discovered[i]!.type}  (${discovered[i]!.name})\n`));
    }
    process.stderr.write(yellow('\n'));

    let chosen!: ProviderPackage;
    for (;;) {
      const choice = await ask(`Choose a type [1-${discovered.length}]`);
      const n = parseInt(choice, 10);
      if (n >= 1 && n <= discovered.length) { chosen = discovered[n - 1]!; break; }
      process.stderr.write(yellow(`Please enter a number between 1 and ${discovered.length}.\n`));
    }

    let providerName = '';
    for (;;) {
      providerName = await ask(`Provider name (how this LLM key is named in ${configPath} and presented to you)`);
      if (providerName) break;
      process.stderr.write(yellow('Provider name is required.\n'));
    }

    let model = '';
    for (;;) {
      model = await ask('Model name');
      if (model) break;
      process.stderr.write(yellow('Model name is required.\n'));
    }

    // Blank is the adapter's own default, and is left out of the profile: written as `endpoint:` it reads
    // back as a value, and an empty one is a URL nothing can fetch.
    let endpoint = '';
    for (;;) {
      endpoint = await ask('Endpoint URL (blank for the adapter\'s default)');
      if (!endpoint || /^https?:$/.test(URL.parse(endpoint)?.protocol ?? '')) break;
      process.stderr.write(yellow('An endpoint is an http:// or https:// URL.\n'));
    }
    let apiKey = await ask('API key');

    if (endpoint) {
      process.stderr.write(yellow(`\nTesting ${endpoint}… `));
      const reachable = await testEndpointReachable(endpoint);
      if (!reachable) {
        process.stderr.write(yellow('reachable\n'));
      } else {
        process.stderr.write(yellow(reachable + '\n'));
        const cont = await ask('Continue with this endpoint anyway? [y/N]');
        if (cont.toLowerCase() !== 'y') {
          process.stderr.write(yellow('Setup cancelled.\n'));
          process.exit(1);
        }
      }
    }
    const configDir = path.dirname(configPath);
    const varName   = `MATBOT_API_KEY_${providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

    // What was typed at the API key prompt may be the NAME of a key the .env already holds rather
    // than a secret, and nothing here can tell the two apart — which is what createSecret is for.
    // Writing .env by hand bypassed it, so naming an existing key minted a synthetic
    // MATBOT_API_KEY_* whose value was that key's name.
    const wizardVault = new EnvFileVault(
      path.join(configDir, '.env'),
      { ...await readDotEnv(configDir), ...process.env },
    );
    // Written to .env, which the boot vault reads after this.
    const keyName = apiKey ? await wizardVault.createSecret(varName, apiKey) : undefined;

    // The model was typed before the endpoint and key it can be checked with, so it is checked here. An
    // unlisted name may still be right (an alias, a deployment), so Enter keeps it.
    const spec = (await import(chosen.name).catch(() => undefined) as { plugin?: MatbotPluginSpec } | undefined)?.plugin;
    for (;;) {
      const cfg: ProviderConfig = {
        name: providerName, module: chosen.name, model,
        ...(endpoint ? { endpoint } : {}),
        ...(keyName !== undefined ? { credentials: { apiKey: `\${${keyName}}` } } : {}),
      };
      const adapter = spec?.provider?.(cfg);
      if (adapter?.models === undefined) break;
      const check = await checkProviderModel(adapter, cfg, wizardVault);
      if (check.kind === 'unchecked') process.stderr.write(yellow(`Could not list the endpoint's models (${check.reason}); "${model}" is not checked.\n`));
      if (check.kind !== 'unlisted') break;
      process.stderr.write(yellow(`"${model}" is not among the ${check.count} models this endpoint lists.`
        + (check.closest.length > 0 ? ` Closest: ${check.closest.join(', ')}.` : '') + '\n'));
      const again = await ask(`Model name (Enter keeps "${model}")`);
      if (!again || again === model) break;
      model = again;
    }

    // Reference the provider by package name — the location-independent form. It resolves via
    // node_modules when matbot is installed, and in a source checkout via resolvePluginSpecifiers'
    // CLI-anchored fallback (the bundled adapters are the CLI's own dependencies, not the config
    // dir's), so the written config is portable either way.
    const moduleSpec = chosen.name;

    const yaml = [
      'providers:',
      `  ${providerName}:`,
      `    module: ${moduleSpec}`,
      ...(endpoint ? [`    endpoint: ${endpoint}`] : []),
      `    model: ${model}`,
      ...(keyName !== undefined ? ['    credentials:', `      apiKey: \${${keyName}}`] : []),
    ].join('\n') + '\n';

    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, yaml, 'utf8');
    process.stderr.write(yellow(`\nConfiguration written to ${configPath}\n\n`));

    return {
      plugins:   [],
      providers: new Map([[providerName, {
        name:        providerName,
        module:      moduleSpec,
        model,
        // The placeholder, not the typed string: this run must resolve the same key the written
        // config names, or a reference would be posted to the endpoint as if it were the secret.
        ...(keyName !== undefined ? { credentials: { apiKey: `\${${keyName}}` } } : {}),
        ...(endpoint ? { endpoint } : {}),
      }]]),
    };
  } finally {
    rl.close();
  }
}

// The provider adapter catalogue + draft shapes now live in @matatbread/matbot-browser (shared with the
// google-drive synced provider tool); imported for local use and re-exported so this module's importers
// are unchanged.
import type { AvailableProvider, ProviderDraft } from '@matatbread/matbot-browser';
import type { MatbotPluginSpec, ProviderAdapter, ProviderConfig } from '@matatbread/matbot-plugin-api';
export type { AvailableProvider, ProviderDraft };

const CSS = `
.mb-setup-overlay { position:fixed; inset:0; display:flex; align-items:center; justify-content:center;
  background:#0f172a; font:14px/1.5 system-ui,sans-serif; color:#1a1a1a; z-index:9999; }
.mb-setup-card { background:#fff; border-radius:14px; padding:24px; width:min(440px,92vw);
  box-shadow:0 10px 40px rgba(0,0,0,.4); display:flex; flex-direction:column; gap:12px; }
.mb-setup-card h2 { margin:0; font-size:18px; }
.mb-setup-card p.sub { margin:0 0 4px; color:#666; font-size:13px; }
.mb-setup-card label { display:flex; flex-direction:column; gap:4px; font-weight:600; font-size:13px; }
.mb-setup-card input, .mb-setup-card select { font:inherit; padding:8px; border:1px solid #cfcfcf; border-radius:8px; font-weight:400; }
.mb-setup-card .row { display:flex; gap:10px; margin-top:6px; }
.mb-setup-card button { font:inherit; padding:9px 16px; border:none; border-radius:8px; cursor:pointer; }
.mb-setup-card button.save { background:#2563eb; color:#fff; flex:1; }
.mb-setup-card button.cancel { background:#eee; }
.mb-setup-card .err { color:#b91c1c; font-size:13px; min-height:1em; }
`;

let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
  stylesInjected = true;
}

// Imported by package name, which resolves through the bundle's import map as the boot load will, so this
// is the same module instance the provider later runs in. Only for a self-contained adapter: an endpoint
// adapter could list nothing before the URL and key it would list with have been typed.
const adapters = new Map<string, Promise<ProviderAdapter | undefined>>();
function adapterFor(a: AvailableProvider, config: ProviderConfig): Promise<ProviderAdapter | undefined> {
  let p = adapters.get(a.module);
  if (!p) {
    p = (import(/* @vite-ignore */ a.module) as Promise<Record<string, unknown>>).then(mod => {
      const spec = (mod['plugin'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['plugin']) as MatbotPluginSpec | undefined;
      return spec?.provider?.(config);
    });
    p.catch(() => adapters.delete(a.module));
    adapters.set(a.module, p);
  }
  return p;
}

function field(labelText: string, input: HTMLElement): HTMLLabelElement {
  const l = document.createElement('label');
  l.textContent = labelText;
  l.appendChild(input);
  return l;
}

/**
 * Render the provider setup form and resolve with the user's entries. Shown at first startup when no
 * provider is configured (not cancelable then), and reusable later to add another (cancelable).
 */
export function runProviderSetup(
  available: AvailableProvider[],
  opts: { title?: string; cancelable?: boolean } = {},
): Promise<ProviderDraft> {
  ensureStyles();
  return new Promise<ProviderDraft>((resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.className = 'mb-setup-overlay';
    const card = document.createElement('div');
    card.className = 'mb-setup-card';

    const h = document.createElement('h2');
    h.textContent = opts.title ?? 'Configure your LLM provider';
    const sub = document.createElement('p');
    sub.className = 'sub';
    sub.textContent = 'matbot runs entirely in your browser and calls the model directly. Enter any OpenAI- or Anthropic-compatible endpoint (DeepSeek, Azure, a local server, …).';

    const name = document.createElement('input');
    name.placeholder = 'e.g. deepseek';

    const type = document.createElement('select');
    available.forEach((a, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = a.label;
      type.appendChild(o);
    });

    const endpoint = document.createElement('input');
    const model    = document.createElement('input');
    // Replaces the text input when the adapter can list its models (ProviderAdapter.models).
    const modelList = document.createElement('select');
    modelList.hidden = true;
    const apiKey   = document.createElement('input');
    apiKey.type = 'password';
    apiKey.placeholder = 'sk-…';

    const endpointField = field('Endpoint URL', endpoint);
    const modelField    = field('Model', model);
    modelField.appendChild(modelList);
    const apiKeyField   = field('API key', apiKey);

    const showModels = (ids: string[] | undefined, hint: string | undefined): void => {
      modelList.replaceChildren(...(ids ?? ['Loading models…']).map(id => {
        const o = document.createElement('option');
        o.value = o.textContent = id;
        return o;
      }));
      modelList.disabled = ids === undefined;
      if (ids !== undefined && hint !== undefined && ids.includes(hint)) modelList.value = hint;
      model.hidden = true;
      modelList.hidden = false;
      modelField.style.display = '';
    };
    const showModelInput = (): void => {
      model.hidden = false;
      modelList.hidden = true;
      modelField.style.display = '';
    };

    let shown = 0;
    const applyHints = (): void => {
      const a = available[Number(type.value)];
      // A self-contained adapter (e.g. a local demo LLM) needs no endpoint/key — hide them, and the model
      // too unless the adapter can list the models it runs.
      const sc = !!a?.selfContained;
      for (const f of [endpointField, modelField, apiKeyField]) f.style.display = sc ? 'none' : '';
      endpoint.placeholder = a?.endpointHint ?? 'https://…';
      model.placeholder    = a?.modelHint ?? 'model-name';
      model.hidden     = false;
      modelList.hidden = true;
      if (!a || !sc) return;

      const asked  = ++shown;
      const config: ProviderConfig = { name: name.value.trim(), module: a.module, model: a.modelHint ?? '' };
      void adapterFor(a, config).then(async adapter => {
        if (asked !== shown || !adapter?.models) return;
        showModels(undefined, a.modelHint);
        try {
          const ids = await adapter.models(config);
          if (asked !== shown) return;
          // By name, numerically, so a family's sizes sit together in order (Qwen3-0.6B … Qwen3-14B).
          const byName = [...ids].sort(new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare);
          if (byName.length > 0) showModels(byName, a.modelHint); else showModelInput();
        } catch (e) {
          console.warn(`[matbot] could not list the models of ${a.label}:`, e);
          if (asked === shown) showModelInput();
        }
      }, (e: unknown) => console.warn(`[matbot] could not load ${a.module}:`, e));
    };
    type.addEventListener('change', applyHints);
    applyHints();

    const err = document.createElement('div');
    err.className = 'err';

    const row  = document.createElement('div');
    row.className = 'row';
    const save = document.createElement('button');
    save.className = 'save';
    save.textContent = 'Save & start';

    const submit = (): void => {
      const a = available[Number(type.value)];
      const sc = !!a?.selfContained;
      // A list still loading picks nothing, so a self-contained adapter falls back to its hint.
      const picked = modelField.style.display === 'none' ? ''
        : !modelList.hidden ? (modelList.disabled ? '' : modelList.value)
        : model.value.trim();
      const draft: ProviderDraft = {
        name:     name.value.trim(),
        module:   a?.module ?? '',
        endpoint: sc ? '' : endpoint.value.trim(),
        model:    sc ? (picked || a?.modelHint || a?.label || '') : picked,
        apiKey:   sc ? '' : apiKey.value.trim(),
      };
      if (!draft.name)   { err.textContent = 'A name is required.';     return; }
      if (!draft.module) { err.textContent = 'Pick an adapter type.';   return; }
      if (!sc) {
        if (!draft.endpoint) { err.textContent = 'An endpoint URL is required.'; return; }
        if (!draft.model)  { err.textContent = 'A model name is required.'; return; }
        if (!draft.apiKey) { err.textContent = 'An API key is required.';  return; }
      }
      overlay.remove();
      resolve(draft);
    };
    save.addEventListener('click', submit);
    apiKey.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    row.appendChild(save);

    if (opts.cancelable) {
      const cancel = document.createElement('button');
      cancel.className = 'cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => { overlay.remove(); reject(new Error('setup cancelled')); });
      row.appendChild(cancel);
    }

    card.append(
      h, sub,
      field('Name', name),
      field('Adapter', type),
      endpointField,
      modelField,
      apiKeyField,
      err, row,
    );
    overlay.appendChild(card);
    (document.getElementById('matbot-root') ?? document.body).appendChild(overlay);
    name.focus();
  });
}

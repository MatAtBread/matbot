import type { Tool, ToolContract, ToolResultOf } from '@matatbread/matbot-plugin-api';
import { resident } from './adapter.js';
import { appConfig, closestModels, gpuFeatures, library, toolModels } from './webllm.js';

export interface WebLLMModelSummary {
  id:             string;
  /** GPU memory the model needs, in MB, as WebLLM records it — at its default context window. */
  vramMB?:        number;
  /** WebLLM's mark for a model that suits phones and low-memory GPUs. */
  lowResource?:   true;
  /** The context window WebLLM sets for it, where it overrides the model's own. */
  contextWindow?: number;
  /** GPU features it needs. Absent when it needs none. */
  requires?:      string[];
  /** Whether this page's GPU has every feature it needs. Absent when there is no GPU adapter to ask. */
  runsHere?:      boolean;
  /** Already downloaded into this origin's cache, so using it costs no download. */
  downloaded:     boolean;
  /** The model this provider has loaded (or is loading) right now. */
  loaded?:        true;
}

// What `list` returns. Detail costs context, and a small model's window is the scarcest thing here — every
// model as a full row is most of an 8k window — so full rows are given only for what a call selected, and
// otherwise the bare ids, which already carry family, size and quantisation.
export interface WebLLMModelList {
  /** Full rows for the models the call selected (`query`, `downloaded`). Absent when it selected nothing. */
  matched?: WebLLMModelSummary[];
  /** Every model's id, smallest first: given when the call selected nothing, or its selection matched nothing. */
  others?:  string[];
  total:    number;
  /** What happened and how to narrow — for the model reading this, not for a program. */
  hint:     string;
}

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    webllm_models:
      | ToolContract<WebLLMModelList,                  { action: 'list'; query?: string; downloaded?: boolean }>
      | ToolContract<{ model: string; deleted: true }, { action: 'delete'; model: string }>;
  }
}

type Input =
  | { action: 'list'; query?: string; downloaded?: boolean }
  | { action: 'delete'; model: string };

export const webllmModelsTool: Tool<ToolResultOf<'webllm_models'>> = {
  name: 'webllm_models',
  description:
    'The models the WebLLM provider can run in this browser that can call tools: the Qwen3, Qwen2.5 and Hermes '
    + 'families. Others would answer in prose instead of using tools, so they are not listed. Every model runs '
    + 'on this device\'s GPU, and downloads (once, often gigabytes) the first time it is used. A model\'s id '
    + 'names its family, size and quantisation, e.g. "Qwen3-4B-q4f16_1-MLC" or "Hermes-3-Llama-3.2-3B-q4f16_1-MLC".\n\n'
    + '"list" with no other input returns every id, smallest first. Both inputs below are optional; give either '
    + 'to get full details for the models they select: "vramMB" (GPU memory needed), whether it "runsHere" '
    + '(this GPU has the features it needs), and whether it is "downloaded" or "loaded".\n'
    + '- "query": words that all appear in the model id, e.g. "qwen3", "4b" or "qwen3 4b". It searches ids only, '
    + 'so words like "webllm" or "model" match nothing. If nothing matches, every id is returned instead.\n'
    + '- "downloaded": true selects the models already on this device.\n'
    + '"q4f16" builds are smaller and faster where the GPU supports them, "q4f32" the fallback. To switch a '
    + 'profile to a model, use the provider tool\'s "update" with the id.\n\n'
    + '"delete" removes a downloaded model from this device to free its storage; it downloads again if used.',
  inputSchema: {
    type:       'object',
    required:   ['action'],
    properties: {
      action:     { type: 'string', enum: ['list', 'delete'] },
      query:      { type: 'string', description: 'list, optional: words that must all appear in the model id, case-insensitively.' },
      downloaded: { type: 'boolean', description: 'list, optional: true to select just the models already downloaded.' },
      model:      { type: 'string', description: 'delete only: the model id.' },
    },
  },
  executor: {
    async *execute(rawInput) {
      const input  = rawInput as Input;
      const now    = resident();
      const lib    = await library(now.library);
      const config = appConfig(lib, now.cache);
      const models = [...toolModels(lib)].sort((a, b) =>
        (a.vram_required_MB ?? Infinity) - (b.vram_required_MB ?? Infinity) || a.model_id.localeCompare(b.model_id));
      const total  = models.length;

      switch (input.action) {
        case 'list': {
          const words = (input.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
          const onlyDownloaded = input.downloaded === true;
          const ids = models.map(r => r.model_id);
          if (words.length === 0 && !onlyDownloaded) {
            yield { type: 'result', value: { others: ids, total,
              hint: 'Ids only. Call again with "query" (words from an id, e.g. "qwen3 4b") for the details of those models.' } };
            return;
          }

          const byName = models.filter(r => words.every(w => r.model_id.toLowerCase().includes(w)));
          const cached = await Promise.all(byName.map(r => lib.hasModelInCache(r.model_id, config).catch(() => false)));
          const picked = byName.map((r, i) => ({ r, downloaded: cached[i] === true })).filter(x => !onlyDownloaded || x.downloaded);
          const asked  = [words.length > 0 ? `id containing ${words.map(w => `"${w}"`).join(' and ')}` : '', onlyDownloaded ? 'already downloaded' : '']
            .filter(Boolean).join(', ');
          if (picked.length === 0) {
            yield { type: 'result', value: { matched: [], others: ids, total,
              hint: `No model matched (${asked}), so "others" lists every id. Query with words that appear in one, e.g. a family and size like "qwen3 4b".` } };
            return;
          }

          const have = await gpuFeatures();
          const matched = picked.map(({ r, downloaded }): WebLLMModelSummary => {
            const requires = r.required_features ?? [];
            return {
              id: r.model_id,
              ...(r.vram_required_MB !== undefined ? { vramMB: Math.round(r.vram_required_MB) } : {}),
              ...(r.low_resource_required ? { lowResource: true as const } : {}),
              ...(r.overrides?.context_window_size !== undefined ? { contextWindow: r.overrides.context_window_size } : {}),
              ...(requires.length > 0 ? { requires } : {}),
              ...(have ? { runsHere: requires.every(f => have.has(f)) } : {}),
              downloaded,
              ...(r.model_id === now.model ? { loaded: true as const } : {}),
            };
          });
          yield { type: 'result', value: { matched, total, hint: `${matched.length} of ${total} models matched (${asked}).` } };
          return;
        }
        case 'delete': {
          if (!input.model) { yield { type: 'error', message: 'action "delete" requires "model".' }; return; }
          if (!models.some(r => r.model_id === input.model)) {
            const near = closestModels(input.model, models);
            yield { type: 'error', message: `"${input.model}" is not a WebLLM model id.${near.length > 0 ? ` Closest: ${near.join(', ')}.` : ''}` };
            return;
          }
          await lib.deleteModelAllInfoInCache(input.model, config);
          yield { type: 'result', value: { model: input.model, deleted: true } };
          return;
        }
        default:
          yield { type: 'error', message: `Unknown action "${(input as { action?: unknown }).action}". Use "list" or "delete".` };
      }
    },
  },
};

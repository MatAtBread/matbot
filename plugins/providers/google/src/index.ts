import type { MatbotPluginSpec, ProviderConfig } from '@matatbread/matbot-plugin-api';
import { OpenAICompatAdapter } from '@matatbread/matbot-provider-openai-compat';
import { GoogleAdapter } from './adapter.js';

export { GoogleAdapter } from './adapter.js';

/**
 * Google Gemini provider. One `module:`, two wire formats, chosen by the endpoint **path** (not host —
 * a proxy or gateway may rewrite the host but keeps the path):
 *
 *   - `…/models/{model}:generateContent` (or a bare base like `…/v1beta`) → the native Gemini adapter
 *     (`GoogleAdapter`): first-class thought-signature round-tripping and the correct home for Gemini's
 *     explicit caching / features. This is the default when no path signals OpenAI-compat.
 *   - `…/chat/completions` / `…/openai/…` → Gemini's OpenAI-compatible endpoint, served by the shared
 *     `OpenAICompatAdapter` in `gemini` mode (signatures via `extra_content.google.thought_signature`,
 *     signature-less foreign tool calls elided). Kept so an OpenAI-compat gateway still works here.
 *
 * Both modes share matbot's neutral session encoding; both round-trip Gemini 3 thought signatures and
 * elide signature-less cross-provider tool calls. The model and API key come from the provider block's
 * own `model:` / `credentials.apiKey` fields — the native adapter interpolates the model into the URL
 * path and sends the key as `x-goog-api-key`; neither is a placeholder in the endpoint string.
 *
 *   providers:
 *     gemini:
 *       module: '@matatbread/matbot-provider-google'
 *       endpoint: https://generativelanguage.googleapis.com/v1beta   # native
 *       model: gemini-3.1-flash-lite
 *       credentials: { apiKey: ${GOOGLE_LLM_API_KEY} }
 */
function isOpenAICompatPath(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  let path: string;
  try { path = new URL(endpoint).pathname; } catch { path = endpoint; }
  return path.includes('/chat/completions') || path.includes('/openai/');
}

export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
  provider: (config: ProviderConfig) =>
    isOpenAICompatPath(config.endpoint)
      ? new OpenAICompatAdapter('google-gemini', { gemini: true })
      : new GoogleAdapter(),
};

// OpenAI AgentModel adapter — the runner-side model call.
// BYO-AI: the API key is the customer's own, supplied via config. Never hardcoded,
// never logged. See AGENTS.md ("Secrets never leave") and contracts/adapters.ts.

import { resolveModel } from '../../config/model-tiers.ts';
import type { AgentModel } from '../../contracts/adapters.ts';
import type { Completion, ModelTier } from '../../contracts/types.ts';
import { fetchWithRetry, type RetryFetchOptions } from '../shared/retry-fetch.ts';

const DEFAULT_MODEL = 'gpt-5-codex';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_BASE_URL = 'https://api.openai.com';

export interface OpenAIAgentModelConfig {
  /** Customer-supplied OpenAI API key. Required. */
  apiKey: string;
  /** OpenAI model id to call. Defaults to a current Codex model. */
  model?: string;
  /** Tier recorded on the returned Completion. */
  modelTier?: ModelTier;
  maxTokens?: number;
  /** Override for testing / alternate endpoints (e.g. a proxy). */
  baseUrl?: string;
  /** Override for testing; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Retry/backoff tuning for transient 429/503 responses and network errors. */
  retry?: RetryFetchOptions;
}

interface OpenAIChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface OpenAIChatChoice {
  message: { content: string | null };
}

interface OpenAIChatCompletionResponse {
  choices: OpenAIChatChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export function createOpenAIAgentModel(config: OpenAIAgentModelConfig): AgentModel {
  if (!config.apiKey) {
    throw new Error('OpenAIAgentModel: apiKey is required');
  }

  const {
    apiKey,
    modelTier = 'standard',
    maxTokens = DEFAULT_MAX_TOKENS,
    baseUrl = DEFAULT_BASE_URL,
    fetch: fetchImpl = fetch,
    retry,
  } = config;

  // Tier -> model, with an explicitly configured model still winning
  // (src/config/model-tiers.ts).
  const model = resolveModel('openai', modelTier, config.model) ?? DEFAULT_MODEL;

  return {
    async invoke(stepPrompt: string, context: Record<string, unknown>): Promise<Completion> {
      const messages: OpenAIChatMessage[] = [];
      if (Object.keys(context).length > 0) {
        messages.push({ role: 'system', content: JSON.stringify(context) });
      }
      messages.push({ role: 'user', content: stepPrompt });

      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        messages,
      };

      const response = await fetchWithRetry(
        fetchImpl,
        `${baseUrl}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        },
        retry,
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `OpenAI AgentModel: request failed with ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`,
        );
      }

      const payload = (await response.json()) as OpenAIChatCompletionResponse;
      const text = payload.choices
        .map((choice) => choice.message.content ?? '')
        .join('');

      const completion: Completion = { text, modelTier };
      if (payload.usage) {
        completion.usage = {
          inputTokens: payload.usage.prompt_tokens,
          outputTokens: payload.usage.completion_tokens,
        };
      }
      return completion;
    },
  };
}

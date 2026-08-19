// Claude AgentModel adapter — the runner-side model call.
// BYO-AI: the API key is the customer's own, supplied via config. Never hardcoded,
// never logged. See AGENTS.md ("Secrets never leave") and contracts/adapters.ts.

import type { AgentModel } from '../../contracts/adapters.ts';
import type { Completion, ModelTier } from '../../contracts/types.ts';
import { fetchWithRetry, type RetryFetchOptions } from '../shared/retry-fetch.ts';

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
// Anthropic's beta flag for authenticating with a Claude Code OAuth/subscription token
// (e.g. CLAUDE_CODE_OAUTH_TOKEN) instead of an API key.
const OAUTH_BETA = 'oauth-2025-04-20';

export interface ClaudeAgentModelConfig {
  /**
   * Customer's Claude Code OAuth/subscription token (e.g. CLAUDE_CODE_OAUTH_TOKEN).
   * Resolution order is oauthToken -> apiKey -> block: if both are set, oauthToken wins.
   */
  oauthToken?: string;
  /** Customer-supplied Anthropic API key. Used when oauthToken is not set. */
  apiKey?: string;
  /** Claude model id to call. Defaults to a current Claude model. */
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

type ResolvedCredential = { mode: 'oauth'; token: string } | { mode: 'api-key'; token: string };

// The artifact's decided credential model: OAuth/subscription first, then API key, then a
// clear block error (AGENTS.md, build order step 5). Never silently fall back.
function resolveCredential(config: Pick<ClaudeAgentModelConfig, 'oauthToken' | 'apiKey'>): ResolvedCredential {
  if (config.oauthToken) {
    return { mode: 'oauth', token: config.oauthToken };
  }
  if (config.apiKey) {
    return { mode: 'api-key', token: config.apiKey };
  }
  throw new Error(
    'ClaudeAgentModel: no credential configured — set oauthToken (OAuth/subscription, e.g. CLAUDE_CODE_OAUTH_TOKEN) or apiKey (ANTHROPIC_API_KEY)',
  );
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicMessagesResponse {
  content: AnthropicContentBlock[];
  usage?: { input_tokens: number; output_tokens: number };
}

export function createClaudeAgentModel(config: ClaudeAgentModelConfig): AgentModel {
  const credential = resolveCredential(config);

  const {
    model = DEFAULT_MODEL,
    modelTier = 'standard',
    maxTokens = DEFAULT_MAX_TOKENS,
    baseUrl = DEFAULT_BASE_URL,
    fetch: fetchImpl = fetch,
    retry,
  } = config;

  return {
    async invoke(stepPrompt: string, context: Record<string, unknown>): Promise<Completion> {
      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: stepPrompt }],
      };
      if (Object.keys(context).length > 0) {
        body.system = JSON.stringify(context);
      }

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
      };
      if (credential.mode === 'oauth') {
        headers.authorization = `Bearer ${credential.token}`;
        headers['anthropic-beta'] = OAUTH_BETA;
      } else {
        headers['x-api-key'] = credential.token;
      }

      const response = await fetchWithRetry(
        fetchImpl,
        `${baseUrl}/v1/messages`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        },
        retry,
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `Claude AgentModel: request failed with ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`,
        );
      }

      const payload = (await response.json()) as AnthropicMessagesResponse;
      const text = payload.content
        .filter((block): block is AnthropicContentBlock & { text: string } => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');

      const completion: Completion = { text, modelTier };
      if (payload.usage) {
        completion.usage = {
          inputTokens: payload.usage.input_tokens,
          outputTokens: payload.usage.output_tokens,
        };
      }
      return completion;
    },
  };
}

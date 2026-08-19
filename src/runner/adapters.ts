// The thin runner's own adapter composition — deliberately narrower than
// src/adapters/registry.ts (the control plane's composition root). The runner only ever
// builds a VCSHost, an AgentModel, and a CodingExecutor (action.yml's vcs-host-config /
// agent-model-config / coding-executor-config inputs) — never a TaskBackend, CIRunner,
// KnowledgeSource, or Notifier, all of which are control-plane-only concerns. Keeping a
// separate factory here means the runner (and its standalone distribution, see
// src/packaging/build-runner-dist.ts) never has to carry the Jira/Notion/GitHub Actions/
// notifier adapters it will never call.

import type { AgentModel, CodingExecutor, VCSHost } from '../contracts/adapters.ts';
import { createClaudeCodeExecutor, type ClaudeCodeExecutorConfig } from '../adapters/claude-code/coding-executor.ts';
import { createClaudeAgentModel, type ClaudeAgentModelConfig } from '../adapters/claude/agent-model.ts';
import type { GitHubClientConfig } from '../adapters/github/rest.ts';
import { GitHubVCSHost } from '../adapters/github/vcs-host.ts';
import { createOpenAIAgentModel, type OpenAIAgentModelConfig } from '../adapters/openai/agent-model.ts';

export type VCSHostConfig = { provider: 'github' } & GitHubClientConfig;

export type CodingExecutorConfig = { provider: 'claude-code' } & ClaudeCodeExecutorConfig;

export type AgentModelConfig =
  | ({ provider: 'claude' } & ClaudeAgentModelConfig)
  | ({ provider: 'openai' } & OpenAIAgentModelConfig);

function unknownProvider(seam: string, provider: string): never {
  throw new Error(`runner adapters: unknown ${seam} provider "${provider}"`);
}

export function createVCSHost(config: VCSHostConfig): VCSHost {
  switch (config.provider) {
    case 'github':
      return new GitHubVCSHost(config);
    default:
      return unknownProvider('vcsHost', (config as { provider: string }).provider);
  }
}

export function createCodingExecutor(config: CodingExecutorConfig): CodingExecutor {
  switch (config.provider) {
    case 'claude-code':
      return createClaudeCodeExecutor();
    default:
      return unknownProvider('codingExecutor', (config as { provider: string }).provider);
  }
}

export function createAgentModel(config: AgentModelConfig): AgentModel {
  switch (config.provider) {
    case 'claude':
      return createClaudeAgentModel(config);
    case 'openai':
      return createOpenAIAgentModel(config);
    default:
      return unknownProvider('agentModel', (config as { provider: string }).provider);
  }
}

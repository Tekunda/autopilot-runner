// The thin runner's own adapter composition — deliberately narrower than
// src/adapters/registry.ts (the control plane's composition root). The runner only ever
// builds a VCSHost and a CodingExecutor (action.yml's vcs-host-config /
// coding-executor-config inputs) — never a TaskBackend, CIRunner, KnowledgeSource, or
// Notifier, all of which are control-plane-only concerns. Keeping a separate factory here
// means the runner (and its standalone distribution, see src/packaging/build-runner-dist.ts)
// never has to carry the Jira/Notion/GitHub Actions/notifier adapters it will never call.

import type { CodingExecutor, VCSHost } from '../contracts/adapters.ts';
import { createClaudeCodeExecutor, type ClaudeCodeExecutorConfig } from '../adapters/claude-code/coding-executor.ts';
import { createCodexExecutor, type CodexExecutorConfig } from '../adapters/codex/coding-executor.ts';
import type { GitHubClientConfig } from '../adapters/github/rest.ts';
import { GitHubVCSHost } from '../adapters/github/vcs-host.ts';
import type { ExecutorCredential } from '../gates/visual/judge.ts';

export type VCSHostConfig = { provider: 'github' } & GitHubClientConfig;

export type CodingExecutorConfig =
  | ({ provider: 'claude-code' } & ClaudeCodeExecutorConfig)
  | ({ provider: 'codex' } & CodexExecutorConfig);

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

// The tenant's model credential for a runner-side AI call (the Visual-QA vision judge), taken
// from the SAME coding-executor-config the reviewer/architect vendor Action steps authenticate
// with -- never a separate ANTHROPIC_API_KEY the heavy stage would otherwise have to be wired.
// A claude-code executor carries either an OAuth/subscription token (preferred) or a raw API
// key; a codex executor's key is an OpenAI key the Anthropic judge cannot use, so it yields no
// credential and the judge fails closed for lack of one.
export function executorCredential(config: CodingExecutorConfig): ExecutorCredential | undefined {
  if (config.provider === 'claude-code') {
    if (config.oauthToken) return { mode: 'oauth', oauthToken: config.oauthToken };
    if (config.apiKey) return { mode: 'apiKey', apiKey: config.apiKey };
  }
  return undefined;
}

export function createCodingExecutor(config: CodingExecutorConfig): CodingExecutor {
  switch (config.provider) {
    case 'claude-code':
      if (!config.oauthToken && !config.apiKey) throw new Error('runner adapters: claude-code requires oauthToken or apiKey');
      return createClaudeCodeExecutor();
    case 'codex':
      if (!config.apiKey) throw new Error('runner adapters: codex requires apiKey');
      return createCodexExecutor();
    default:
      return unknownProvider('codingExecutor', (config as { provider: string }).provider);
  }
}

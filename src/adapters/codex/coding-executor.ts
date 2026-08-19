import type { CodingExecutor } from '../../contracts/adapters.ts';
import { createActionCodingExecutor } from '../claude-code/coding-executor.ts';

// Credentials and model selection are consumed by openai/codex-action in action.yml.
// This adapter only translates the deterministic git contract shared by vendor Actions.
export interface CodexExecutorConfig {
  apiKey?: string;
  responsesApiEndpoint?: string;
  model?: string;
  effort?: string;
}

export function createCodexExecutor(): CodingExecutor {
  return createActionCodingExecutor();
}

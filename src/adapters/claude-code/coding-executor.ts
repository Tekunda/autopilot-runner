// claude-code CodingExecutor adapter -- the default, ship-first CodingExecutor provider
// (src/contracts/adapters.ts). The actual coding work (editing, committing, producing a
// branch) happens in `anthropics/claude-code-action`, run as its own `uses:` step in the
// runner workflow against an already-checked-out customer repo -- never in this process,
// never in our adapters (AGENTS.md, "split plane"). This adapter only translates the
// stage's prompt into that step's inputs (prepare) and that step's raw outputs back into
// an ExecutorResult (finalize); both are pure functions, no I/O, no credentials. Opening
// the PR from the resulting branch is the runner's own job via VCSHost, deterministically
// -- never this adapter's (AGENTS.md, "deterministic control, LLM only for judgment").
//
// prepare() folds an explicit git instruction into the prompt naming the exact branch to
// push to (input.branchName, computed deterministically by src/runner/prepare-stage.ts):
// claude-code-action has no dedicated "target branch" input in `workflow_dispatch`/prompt
// mode, and doesn't auto-branch there either -- action.yml grants the agent Bash via
// `claude_args` so it can act on this instruction itself (issue #113).

import { createHash } from 'node:crypto';

import type { CodingExecutor } from '../../contracts/adapters.ts';
import type { CodingActionInputs, CodingActionOutput, ExecutorResult } from '../../contracts/types.ts';

// Documents the JSON shape of action.yml's `coding-executor-config` input for this
// provider -- neither field is read by this module. The vendor Action step
// (anthropics/claude-code-action, run as its own `uses:` step in the runner
// workflow) reads them directly off action.yml's own inputs; this adapter does no
// I/O and needs no credentials of its own.
export interface ClaudeCodeExecutorConfig {
  /** Customer's Claude Code OAuth/subscription token, e.g. CLAUDE_CODE_OAUTH_TOKEN. */
  oauthToken?: string;
  /** Customer-supplied Anthropic API key, used when oauthToken is not set. */
  apiKey?: string;
}

function digestFor(...parts: string[]): string {
  return `sha256:${createHash('sha256').update(parts.join(' ')).digest('hex')}`;
}

function promptWithBranchInstruction(input: { prompt: string; branchName: string; baseRef: string }): string {
  return [
    input.prompt,
    '',
    `When you are done, use git directly to commit your changes and push them to a new ` +
      `branch named exactly "${input.branchName}", created from the current branch ` +
      `(${input.baseRef}). Do not commit or push directly to ${input.baseRef}. If you made ` +
      `no changes, do not create the branch and do not push anything.`,
  ].join('\n');
}

// No config is read here: prepare()/finalize() are pure functions of their own
// arguments. ClaudeCodeExecutorConfig still exists as the documented shape of
// action.yml's `coding-executor-config` JSON input (see registry.ts).
export function createClaudeCodeExecutor(): CodingExecutor {
  return {
    async prepare(input): Promise<CodingActionInputs> {
      return { prompt: promptWithBranchInstruction(input) };
    },

    async finalize(output: CodingActionOutput): Promise<ExecutorResult> {
      // No commit was made -- a valid no-op, not a phantom PR (issue #70's settled
      // execution boundary), so this is `fail`, never `error`.
      if (!output.branchName) {
        return { outcome: 'fail', checks: [], logDigest: digestFor(output.repoId, output.stage, 'no-changes') };
      }

      if (output.conclusion !== 'success') {
        return {
          outcome: 'error',
          checks: [],
          logDigest: digestFor(output.repoId, output.stage, output.conclusion),
        };
      }

      return {
        outcome: 'pass',
        checks: [],
        branchName: output.branchName,
        logDigest: digestFor(output.repoId, output.stage, output.branchName),
      };
    },
  };
}

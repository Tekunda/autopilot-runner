// claude-code CodingExecutor adapter -- the default, ship-first CodingExecutor provider
// (src/contracts/adapters.ts). The actual coding work (editing the checkout) happens in
// the selected vendor Action, run as its own `uses:` step in the
// runner workflow against an already-checked-out customer repo -- never in this process,
// never in our adapters (AGENTS.md, "split plane"). This adapter only translates the
// stage's prompt into that step's inputs (prepare) and that step's raw outputs back into
// an ExecutorResult (finalize); both are pure functions, no I/O, no credentials. Opening
// the PR from the resulting branch is the runner's own job via VCSHost, deterministically
// -- never this adapter's (AGENTS.md, "deterministic control, LLM only for judgment").
//
// prepare() tells the agent to leave git control to action.yml, which deterministically
// commits and pushes the exact branch computed by src/runner/prepare-stage.ts. This keeps
// branch control out of both Claude and Codex (issue #113).

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
    `This is a BUILD/FIX stage: you must IMPLEMENT the task by creating and editing files ` +
      `in the current checkout. First explore the repository to learn its existing structure ` +
      `and conventions (use Glob/Grep/Read), then make the changes with Edit/Write. Keep going ` +
      `until the task is fully implemented -- do not stop after only exploring. Producing no ` +
      `file changes is a FAILURE unless the task is already fully implemented in the current ` +
      `tree; if you believe it already is, say so explicitly.`,
    '',
    `Make changes only in the current checkout. Do not create or switch branches, commit, or ` +
      `push. The runner will publish your changes to "${input.branchName}" from ` +
      `${input.baseRef} after you finish.`,
  ].join('\n');
}

// No config is read here: prepare()/finalize() are pure functions of their own
// arguments. ClaudeCodeExecutorConfig still exists as the documented shape of
// action.yml's `coding-executor-config` JSON input (see registry.ts).
export function createActionCodingExecutor(): CodingExecutor {
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

export const createClaudeCodeExecutor = createActionCodingExecutor;

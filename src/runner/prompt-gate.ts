// Runs a licensed pack gate's JIT prompt (issue #129) generically: the runner holds no
// pack-specific logic at all, only this one gate-agnostic executor. It feeds the grant's
// signed `prompt` -- plus the PR's changed files' own content, gathered here since
// AgentModel.invoke() is a plain text completion with no filesystem/tool access of its own
// -- to the tenant's AgentModel, then parses the pass/fail verdict from a fixed response
// contract every pack prompt is instructed to follow. No pack id, threshold, or algorithm
// is known to this file; it only understands GATE_RESULT.

import { readFile as defaultReadFile } from 'node:fs/promises';

import type { AgentModel } from '../contracts/adapters.ts';
import type { GateSpec } from '../contracts/types.ts';
import type { GateContext, GateResult } from '../gates/types.ts';

export interface PromptGateDeps {
  /** Injectable file reader for tests; defaults to reading the file from disk. */
  readFile?: (path: string) => Promise<string>;
}

export type PromptGateSpec = Extract<GateSpec, { kind: 'prompt' }>;

const RESULT_LINE_RE = /^GATE_RESULT:\s*(\{.*\})\s*$/m;

// Appended to every JIT prompt so the response contract lives once, here, rather than being
// repeated (and potentially drifting) inside each pack's own stored prompt text.
const RESULT_INSTRUCTIONS =
  '\n\nRespond with your analysis, then end your response with exactly one line, on its ' +
  'own, of the exact form:\n' +
  'GATE_RESULT: {"status":"pass"|"fail","findings":["one finding per string"]}\n' +
  '`findings` is optional -- omit it, or use an empty array, when there is nothing to ' +
  'report. Emit nothing after that line.';

async function gatherChangedFileContents(
  changedFiles: string[],
  readFile: (path: string) => Promise<string>,
): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];
  for (const path of changedFiles) {
    try {
      files.push({ path, content: await readFile(path) });
    } catch {
      // Deleted, binary, or outside the checkout -- nothing to include.
    }
  }
  return files;
}

// A missing or malformed verdict fails closed (never a silent pass) -- consistent with
// AGENTS.md's "never fabricate ... a test that skips ... instead of asserting is a bug".
function parseVerdict(text: string, id: string): GateResult {
  const match = RESULT_LINE_RE.exec(text);
  if (!match) {
    return { id, status: 'fail', findings: ['gate prompt response carried no GATE_RESULT verdict'] };
  }

  try {
    const parsed = JSON.parse(match[1]) as { status?: unknown; findings?: unknown };
    if (parsed.status !== 'pass' && parsed.status !== 'fail') {
      throw new Error(`unrecognized status: ${String(parsed.status)}`);
    }
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.filter((f): f is string => typeof f === 'string')
      : [];
    return { id, status: parsed.status, ...(findings.length ? { findings } : {}) };
  } catch {
    return { id, status: 'fail', findings: ['gate prompt response carried a malformed GATE_RESULT verdict'] };
  }
}

export async function runPromptGateSpec(
  spec: PromptGateSpec,
  ctx: GateContext,
  agentModel: AgentModel,
  deps: PromptGateDeps = {},
): Promise<GateResult> {
  const readFile = deps.readFile ?? ((path: string) => defaultReadFile(path, 'utf8'));
  const changedFiles = await gatherChangedFileContents(ctx.changedFiles, readFile);

  const completion = await agentModel.invoke(spec.prompt + RESULT_INSTRUCTIONS, {
    repoId: ctx.repoId,
    prNumber: ctx.prNumber,
    branch: ctx.branch,
    baseRef: ctx.baseRef,
    changedFiles,
  });

  return parseVerdict(completion.text, spec.id);
}

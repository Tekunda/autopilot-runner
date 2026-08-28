// Shared command-exec seam for gates that shell out to deterministic tooling
// against the customer PR checkout (ctx.workspaceRoot) -- the `cve` gate's
// `npm audit` and the H3 command gates (yarn lint / build / seo:check) both run
// through here rather than each hand-rolling `execFile`. Never the LLM: gates
// are deterministic control (AGENTS.md). A non-zero exit is a normal result the
// caller judges (exit code -> pass/fail), NOT a rejection -- only a process that
// could not be spawned or that blew its time/output budget rejects.

import { execFile } from 'node:child_process';

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  // Cap on captured stdout/stderr; overrunning it rejects (the child is killed).
  maxBuffer?: number;
  // Wall-clock cap; overrunning it kills the child and rejects.
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  opts: RunCommandOptions = {},
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        encoding: 'utf8',
        ...(opts.env ? { env: opts.env } : {}),
      },
      (error, stdout, stderr) => {
        // A non-zero exit surfaces on `error` with a NUMERIC `code`; recover it as a
        // result the caller judges rather than a failure. A spawn error (ENOENT),
        // a timeout (killed), or a maxBuffer overrun carries no numeric code -- that
        // is a genuine tooling failure, so reject.
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
          if (typeof code === 'number') {
            resolve({ exitCode: code, stdout, stderr });
            return;
          }
          reject(error);
          return;
        }
        resolve({ exitCode: 0, stdout, stderr });
      },
    );
  });
}

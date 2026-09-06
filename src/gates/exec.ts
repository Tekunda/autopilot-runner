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

export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * WHY runCommand rejected -- the complete set of shapes `execFile` can hand back, named.
 *
 * The distinction a caller actually needs is not "did it error" but **did the child process ever
 * start and do work**. Everything below the `spawn`/`unknown` line RAN: it exited non-zero (which
 * never rejects at all), or it ran out of time, drowned the capture buffer, or died on a signal.
 * Those are observations ABOUT the work. `spawn` alone means nothing was observed.
 *
 * Collapsing the two is what let a 10-minute `yarn build` timeout be reported as "could not run:
 * Command failed", which reads as a missing binary and sends an operator hunting for one.
 *
 *   - `spawn`          the process never started: `code` is a string errno (`ENOENT` a missing
 *                      binary or a missing cwd, `EACCES` a non-executable file, `ENOTDIR` a cwd
 *                      that is a file, plus `EPERM`/`E2BIG`/`EMFILE`/`ENFILE`/`ENOMEM`/`EAGAIN`).
 *                      `ENOTDIR` arrives as a SYNCHRONOUS throw from execFile rather than through
 *                      the callback; the Promise executor turns that into the same rejection.
 *   - `timeout`        `timeoutMs` elapsed and node killed the child: `killed === true`,
 *                      `signal === 'SIGTERM'`, `code === null`. Node's own kill is the only thing
 *                      that sets `killed`, and execFile only kills on the timeout. This arm is
 *                      ALSO reached for a timeout node itself never reported -- see runCommand's
 *                      `overranBudget`, which synthesises the rejection node withheld.
 *   - `output-overrun` the child wrote past `maxBuffer` and node killed it:
 *                      `code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`. Checked FIRST so the order
 *                      of these arms cannot matter if a future node also sets `killed` here.
 *   - `signal`         the child was killed by something ELSE -- `signal` is set, `killed` is
 *                      false, `code` is null. The OOM killer's SIGKILL and a SIGSEGV land here.
 *   - `unknown`        anything else, including a non-Error throw and node's own `ERR_*` argument
 *                      errors (whose codes carry underscores, so they cannot be mistaken for an
 *                      errno). By construction this is "we cannot establish that it started", so
 *                      callers group it with `spawn`.
 *
 * A non-zero exit is NOT here: it resolves, and never reaches this function.
 */
export type CommandFailureKind = 'spawn' | 'timeout' | 'output-overrun' | 'signal' | 'unknown';

/** An errno as node spells it: `E` then capitals/digits, no underscore (`E2BIG` has a digit). */
const ERRNO = /^E[A-Z0-9]+$/;

export function classifyCommandFailure(error: unknown): CommandFailureKind {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const err = error as { code?: unknown; killed?: unknown; signal?: unknown };
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output-overrun';
  if (err.killed === true) return 'timeout';
  if (typeof err.signal === 'string' && err.signal !== '') return 'signal';
  if (typeof err.code === 'string' && ERRNO.test(err.code)) return 'spawn';
  return 'unknown';
}

/**
 * The rejection node WITHHELD from a command that outlived its own timeout.
 *
 * `execFile`'s kill is not a guarantee that the callback reports one. It destroys the child's
 * stdio and sends `killSignal` (SIGTERM by default), and a child that TRAPS that signal and exits
 * cleanly comes back `code === 0, signal === null, killed` unset -- so node's own `exithandler`
 * sees an ordinary success and calls back with NO error at all. `sh -c 'trap "exit 0" TERM; sleep
 * 3'` under a 300 ms budget resolves `{exitCode: 0}` after three seconds. A command gate then
 * publishes `pass` on truncated output for a command that burned its entire budget -- green, and
 * banked as coverage, which is what suppresses the fix loop. That is the same silent-green class
 * the honest-verdict rules exist to close, so the elapsed clock is checked rather than trusted to
 * node's error.
 *
 * Built to be indistinguishable to `classifyCommandFailure`, which keys `timeout` off `killed`:
 * this is node's timeout observed one layer up, not a sixth kind. It therefore inherits the
 * `timeout` verdict (`fail`, because the command DID run) and the timeout wording, both of which
 * are already the right answers here.
 */
function budgetOverrunError(command: string, args: string[], timeoutMs: number, exitCode: number): Error {
  return Object.assign(
    new Error(
      `Command failed: ${[command, ...args].join(' ')} -- it was killed after its ${timeoutMs} ms budget ` +
        `elapsed, then handled the signal and exited ${exitCode}, so the child process reported no error of its own`,
    ),
    { killed: true, signal: 'SIGTERM', code: null },
  );
}

export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  opts: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Taken BEFORE execFile, so it starts at or before node's own timer does. A child node killed
  // therefore always reads back at `>= timeoutMs`, which is why the comparison is `>=` and carries
  // no slack: the two mistakes are not symmetric. Missing a real timeout publishes GREEN and banks
  // coverage; calling one early can only mis-word a command that consumed 100% of its wall clock,
  // which is a `fail` either way and worth surfacing on its own. `0` is execFile's "no timeout at
  // all", so it disables this check rather than tripping it on every command.
  const startedAt = Date.now();
  const overranBudget = (): boolean => timeoutMs > 0 && Date.now() - startedAt >= timeoutMs;
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        timeout: timeoutMs,
        encoding: 'utf8',
        ...(opts.env ? { env: opts.env } : {}),
      },
      (error, stdout, stderr) => {
        // A non-zero exit surfaces on `error` with a NUMERIC `code`; recover it as a
        // result the caller judges rather than a failure. A spawn error (ENOENT),
        // a timeout (killed), or a maxBuffer overrun carries no numeric code -- that
        // is a genuine tooling failure, so reject. The rejection is NOT one fact:
        // classifyCommandFailure above names which of them it was, because "never
        // started" and "ran for ten minutes and was killed" are opposite answers to
        // the only question a gate asks -- did this command look at the diff.
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
          if (typeof code === 'number') {
            if (overranBudget()) {
              reject(budgetOverrunError(command, args, timeoutMs, code));
              return;
            }
            resolve({ exitCode: code, stdout, stderr });
            return;
          }
          reject(error);
          return;
        }
        // The exit code is genuine and the output is not: node destroyed the stdio pipes when it
        // killed the child, so what was captured is whatever had arrived by then. Resolving either
        // one is a report about a run that never finished, so both exits check the clock.
        if (overranBudget()) {
          reject(budgetOverrunError(command, args, timeoutMs, 0));
          return;
        }
        resolve({ exitCode: 0, stdout, stderr });
      },
    );
  });
}

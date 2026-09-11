// Shared settled-navigation for the two browser-driven gates (Visual-QA's ScreenshotBrowser and
// layout-rules' LayoutBrowser). Both must render a page to its FINISHED frame before they measure
// it -- but "finished" is not the same as "network idle". A perfectly-rendered page can hold a
// lingering connection open forever (an analytics socket, an SSE stream, a long-poll), so
// `waitUntil: 'networkidle'` never fires and Playwright throws a TimeoutError -- failing the gate
// on a page that is fully on screen. Observed live on a tenant's marketing site, where
// networkidle would not settle within 45s though the page was completely rendered.
//
// settledGoto separates "the page loaded" (a hard requirement -- only a genuinely dead server fails
// it, which legitimately throws) from "the network went quiet" (a BEST-EFFORT nicety -- a lingering
// connection just means it never happens, which must NOT throw). It then adds a brief fixed settle
// so fonts/hydration/layout land in the measured frame even when idle never fired.

import fs from 'node:fs';

// Minimal structural slice of the Playwright page we call -- declared locally (mirroring how
// visual/browser.ts and layout/browser.ts type their page) so this helper needs no playwright
// import and typechecks in the control plane without the dependency installed.
export interface SettledGotoPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForLoadState(state: string, opts?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
}

export interface SettledGotoOptions {
  // Per-navigation timeout for the `load` phase (the DOM + resources). A page that never loads
  // inside this window is a real failure and throws. Defaults to 30s.
  timeout?: number;
  // Fixed post-load settle for fonts/hydration/layout, so the measured/screenshotted frame is the
  // finished one even when networkidle never fired. Defaults to 1s.
  settleMs?: number;
}

// Navigate to `url` and return once the page is loaded and given a brief chance to settle. Throws
// only if the `load` navigation itself fails (dead server / bad URL); a network that never goes
// idle is tolerated, not fatal.
export async function settledGoto(page: SettledGotoPage, url: string, opts: SettledGotoOptions = {}): Promise<void> {
  const timeout = opts.timeout ?? 30_000;
  const settleMs = opts.settleMs ?? 1_000;
  // Cap the best-effort idle wait so a lingering connection can't burn the whole navigation budget.
  const idleTimeout = Math.min(timeout, 15_000);

  // Hard requirement: the DOM and its resources must load. Only a genuinely dead server times out
  // here, and that SHOULD throw -- the gate can't measure a page that never loaded.
  await page.goto(url, { waitUntil: 'load', timeout });
  // Best-effort settle: prefer to measure once the network is quiet, but a page holding a lingering
  // connection open never reaches networkidle -- swallow that timeout instead of failing the gate.
  await page.waitForLoadState('networkidle', { timeout: idleTimeout }).catch(() => {});
  // Fixed settle so fonts/hydration/layout are in the finished frame even when idle never fired.
  await page.waitForTimeout(settleMs);
}

// Chromium launch options shared by both browser-driven gates (Visual-QA's ScreenshotBrowser and
// layout-rules' LayoutBrowser). The heavy gate stage runs inside the prebaked Playwright container
// AS ROOT (uid 0), where chrome-headless-shell refuses to start under root without --no-sandbox. So
// this flag is NECESSARY, but it is NOT SUFFICIENT: a launch can still fail for other reasons even
// with it applied. We have observed a launch die WITH --no-sandbox set, the browser log showing an
// ICU-data file-descriptor failure ("Invalid file descriptor to ICU data received") and a SIGTRAP,
// surfacing to Playwright as "Target page, context or browser has been closed". That is runner
// process state, not a missing flag. These are the default factories (vision-gate.ts /
// layout-gate.ts fall back to them), so a developer running the gate locally hits the same path --
// there --no-sandbox is simply harmless (own-tenant pages, and on macOS a near no-op), so passing
// it unconditionally is correct and is the standard Chromium flag for containerized CI. Shared so
// the two call sites cannot drift: dropping it from one silently breaks that gate in-container.
// When a launch DOES still fail, route it through launchWithDiagnostics (below) to capture the
// ephemeral process state the crash otherwise hides.
export const CHROMIUM_LAUNCH_OPTIONS: { headless: boolean; args: string[] } = {
  headless: true,
  args: ['--no-sandbox'],
};

// Best-effort snapshot of the runner process state at the moment of a Chromium launch failure.
// The container launch crash is opaque: Playwright throws "Target page, context or browser has
// been closed" and the underlying browser log points at an ICU-data file-descriptor failure
// ("Invalid file descriptor to ICU data received") + SIGTRAP, which we cannot reproduce outside
// the real runner. This captures the ephemeral state that would explain it (open fds, fd limits,
// what the low fds point at, the baked browser's icudtl.dat + shell sizes). MUST NOT throw: it
// runs on the failure path, so any error here is swallowed and reported inline as `unavailable`.
export function collectLaunchDiagnostics(): string {
  const parts: string[] = [];
  try {
    try {
      parts.push(`open_fds=${fs.readdirSync('/proc/self/fd').length}`);
    } catch (e) {
      parts.push(`open_fds=?(${(e as Error).message})`);
    }

    try {
      const limits = fs.readFileSync('/proc/self/limits', 'utf8');
      const line = limits.split('\n').find((l) => l.startsWith('Max open files'));
      // The columns are: name, soft, hard, units -- collapse runs of spaces to split cleanly.
      const cols = line ? line.trim().split(/\s+/) : [];
      const soft = cols[cols.length - 2];
      const hard = cols[cols.length - 1];
      parts.push(`limits(open files)=${soft}/${hard}`);
    } catch (e) {
      parts.push(`limits(open files)=?(${(e as Error).message})`);
    }

    const fdTargets: string[] = [];
    for (let n = 0; n <= 6; n++) {
      let target: string;
      try {
        target = fs.readlinkSync('/proc/self/fd/' + n);
      } catch {
        target = '?';
      }
      fdTargets.push(`fd${n}=${target}`);
    }
    parts.push(fdTargets.join(' '));

    parts.push(`node=${process.version}`);
    parts.push(`uid=${process.getuid?.()}`);
    parts.push(`PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`);

    try {
      const root = '/ms-playwright';
      const entries = fs.readdirSync(root);
      const shellDir = entries.find((e) => e.startsWith('chromium_headless_shell-'));
      if (!shellDir) {
        parts.push('ms-playwright: no chromium_headless_shell-* dir');
      } else {
        const base = `${root}/${shellDir}/chrome-headless-shell-linux64`;
        const icu = `${base}/icudtl.dat`;
        try {
          const st = fs.statSync(icu);
          parts.push(`icudtl=${icu} exists size=${st.size}`);
        } catch {
          parts.push(`icudtl=${icu} MISSING`);
        }
        try {
          const st = fs.statSync(`${base}/chrome-headless-shell`);
          parts.push(`shell size=${st.size}`);
        } catch {
          parts.push('shell MISSING');
        }
      }
    } catch (e) {
      parts.push(`ms-playwright: absent (${(e as Error).message})`);
    }

    return parts.join('; ');
  } catch (e) {
    return `unavailable: ${(e as Error).message}`;
  }
}

// Run a Chromium launch and, ONLY if it fails, attach the runner process-state snapshot to the
// error before rethrowing (and log it, since a swallowed gate error can otherwise strand the state
// in a container we can't inspect). The happy path is byte-for-byte unchanged: on success the
// launched value is returned as-is with no logging and no side effects. This exists because the
// container launch crash ("Target page, context or browser has been closed", ICU-data fd failure +
// SIGTRAP) is not reproducible off the real runner, so the only way to learn its cause is to
// capture the state at the moment it happens.
export async function launchWithDiagnostics<T>(launch: () => Promise<T>): Promise<T> {
  try {
    return await launch();
  } catch (err) {
    const diag = collectLaunchDiagnostics();
    console.error('[render-launch-failed] ' + diag);
    if (err instanceof Error) {
      err.message = err.message + '\n[launch-diagnostics] ' + diag;
      throw err;
    }
    throw new Error(String(err) + '\n[launch-diagnostics] ' + diag);
  }
}

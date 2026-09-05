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

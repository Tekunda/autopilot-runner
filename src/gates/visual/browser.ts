// The headless-browser seam the Visual-QA gate renders through (docs/ci-gate-refit-plan.md
// P5). A ScreenshotBrowser turns a served URL + viewport into a PNG the vision judge scores.
// It is an INTERFACE first: the gate depends only on this, so it is unit-testable with a fake
// browser and needs no real Chromium in the loop. The default implementation is Playwright,
// launched runner-side in the dedicated heavy stage -- the only stage with a browser (the fast
// deterministic gate path has none). See createVisualQaGate for how the two are wired.

import { settledGoto } from '../browser-nav.ts';

export interface Viewport {
  width: number;
  height: number;
  // Optional readable label (e.g. "desktop", "mobile") surfaced in findings.
  name?: string;
}

// A rendered screenshot in the exact shape the Claude vision API's image block wants: base64
// bytes plus their media type, so the judge can attach it without re-encoding.
export interface Screenshot {
  base64: string;
  mediaType: 'image/png';
}

// Renders a URL at a viewport and returns a PNG screenshot. One instance per heavy-stage run;
// close() releases the underlying browser process. Injected in tests; the default is Playwright.
export interface ScreenshotBrowser {
  screenshot(url: string, viewport: Viewport): Promise<Screenshot>;
  close(): Promise<void>;
}

// Minimal structural slice of the `playwright` module we actually call -- declared locally so
// this file typechecks in the control plane WITHOUT playwright installed. The real dependency
// is installed only in the runner's heavy stage (see action.yml). The dynamic import below uses
// a non-literal specifier so TypeScript does not try to resolve the module at build time.
interface PlaywrightPage {
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForLoadState(state: string, opts?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array>;
  close(): Promise<void>;
}
interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
interface PlaywrightModule {
  chromium: { launch(opts?: { headless?: boolean }): Promise<PlaywrightBrowser> };
}

export interface PlaywrightBrowserOptions {
  // Per-navigation timeout for the `load` phase (DOM + resources). Only a page that never loads at
  // all trips this; a page that loads but never goes network-idle is settled best-effort, not failed
  // (see settledGoto). A page still not loaded at the cap renders whatever is on screen.
  navigationTimeoutMs?: number;
}

// The default ScreenshotBrowser: headless Chromium via Playwright. Loaded through a non-literal
// dynamic import so the control-plane build needs no playwright dependency; the heavy stage
// installs it (`npx playwright install --with-deps chromium`, see action.yml) before this runs.
export async function createPlaywrightBrowser(opts: PlaywrightBrowserOptions = {}): Promise<ScreenshotBrowser> {
  const specifier = 'playwright';
  const { chromium } = (await import(specifier)) as unknown as PlaywrightModule;
  const browser = await chromium.launch({ headless: true });
  const timeout = opts.navigationTimeoutMs ?? 30_000;
  return {
    async screenshot(url: string, viewport: Viewport): Promise<Screenshot> {
      const page = await browser.newPage();
      try {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        // Load the page, then settle it: wait for `load`, best-effort for networkidle, then a brief
        // fixed pause so the judge scores the FINISHED render -- CSS/fonts/images loaded, hydration
        // done -- never a mid-load frame. This is the §11 "settled build" constraint at the
        // screenshot level: a heavy gate must judge a stable page, not one still assembling itself.
        // Crucially, a page that renders fully but holds a lingering connection open (so networkidle
        // never fires) is still judged, not failed -- see settledGoto.
        await settledGoto(page, url, { timeout });
        const bytes = await page.screenshot({ fullPage: true });
        return { base64: Buffer.from(bytes).toString('base64'), mediaType: 'image/png' };
      } finally {
        await page.close();
      }
    },
    async close(): Promise<void> {
      await browser.close();
    },
  };
}

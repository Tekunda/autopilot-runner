// The headless-browser seam the layout-rules gate measures through (the false-green post-mortem).
// It mirrors the Visual-QA ScreenshotBrowser (src/gates/visual/browser.ts) but does ONLY geometry:
// it navigates a served URL at a viewport, runs a tiny in-page routine that returns raw
// getBoundingClientRect numbers for the rule's DOM queries, and hands them back for the PURE
// evaluator (rules.ts) to judge. No screenshot, no model, no thresholds in-page -- the browser
// measures, the evaluator decides. It is an INTERFACE first, so the gate is unit-testable with a
// fake browser and needs no real Chromium in the loop. The default implementation is Playwright,
// launched runner-side in the dedicated heavy stage -- the only stage with a browser.

import { settledGoto } from '../browser-nav.ts';
import type { Box, MatchGeometry, MeasureSpec, RawMeasurements } from './rules.ts';

export interface Viewport {
  width: number;
  height: number;
  // Optional readable label (e.g. "desktop", "mobile") surfaced in findings.
  name?: string;
}

// Navigates a URL at a viewport, runs the MeasureSpec's DOM queries, and returns their raw
// rectangles (aligned by index with the spec). One instance per heavy-stage run; close() releases
// the underlying browser process. Injected in tests; the default is Playwright.
export interface LayoutBrowser {
  measure(url: string, viewport: Viewport, spec: MeasureSpec): Promise<RawMeasurements>;
  close(): Promise<void>;
}

// Minimal structural slice of the `playwright` module we actually call -- declared locally so this
// file typechecks in the control plane WITHOUT playwright installed. The real dependency is
// installed only in the runner's heavy stage. The dynamic import below uses a non-literal specifier
// so TypeScript does not try to resolve the module at build time.
interface PlaywrightPage {
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForLoadState(state: string, opts?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  close(): Promise<void>;
}
interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
interface PlaywrightModule {
  chromium: { launch(opts?: { headless?: boolean }): Promise<PlaywrightBrowser> };
}

export interface PlaywrightLayoutBrowserOptions {
  // Per-navigation timeout for the `load` phase (DOM + resources). Only a page that never loads at
  // all trips this; a page that loads but never goes network-idle is settled best-effort, not failed
  // (see settledGoto). A page still not loaded at the cap is measured as-is.
  navigationTimeoutMs?: number;
}

// Just enough of the DOM to write the in-page routine WITHOUT pulling the `dom` lib into the
// control-plane tsconfig (which targets Node): the routine runs in the browser, where the real DOM
// provides these, but this file must still typecheck standalone.
export interface DomElement {
  getBoundingClientRect(): { top: number; left: number; width: number; height: number };
  children: ArrayLike<DomElement>;
  parentElement: DomElement | null;
  closest(selector: string): DomElement | null;
}
export interface DomDocument {
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

// The in-page routine, serialized and run inside the page by Playwright's evaluate(). It takes the
// MeasureSpec and returns ONLY raw getBoundingClientRect numbers -- no thresholds, no rule logic.
// Self-contained (it references nothing from this module's scope, since it executes in the browser
// context) so Playwright can serialize it across the page boundary. The `doc` it reads is a
// parameter defaulting to the live `globalThis.document`: in the browser it is left unset and binds
// to the real DOM, while a unit test passes a plain-object projection implementing the same tiny
// DomDocument interface -- so this exact routine, including the ancestor invariant below, is
// testable without Chromium (see browser.test.ts). Exported for that reason only.
export function measureInPage(
  spec: MeasureSpec,
  doc: DomDocument = (globalThis as unknown as { document: DomDocument }).document,
): RawMeasurements {
  const rectOf = (el: DomElement): Box => {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  };
  return spec.map((query) => ({
    matches: Array.from(doc.querySelectorAll(query.selector)).map((el) => {
      const match: MatchGeometry = { box: rectOf(el) };
      if (query.children) {
        match.children = Array.from(el.children).map(rectOf);
      }
      if (query.ancestorSelector) {
        // Strictly an ANCESTOR: start the closest() search from the parent so `of === within` (or an
        // element that also matches `within`) never measures itself as its own ancestor.
        const ancestor = el.parentElement ? el.parentElement.closest(query.ancestorSelector) : null;
        match.ancestor = ancestor ? rectOf(ancestor) : null;
      }
      return match;
    }),
  }));
}

// The default LayoutBrowser: headless Chromium via Playwright. Loaded through a non-literal dynamic
// import so the control-plane build needs no playwright dependency; the heavy stage installs it
// before this runs.
export async function createPlaywrightLayoutBrowser(
  opts: PlaywrightLayoutBrowserOptions = {},
): Promise<LayoutBrowser> {
  const specifier = 'playwright';
  const { chromium } = (await import(specifier)) as unknown as PlaywrightModule;
  const browser = await chromium.launch({ headless: true });
  const timeout = opts.navigationTimeoutMs ?? 30_000;
  return {
    async measure(url: string, viewport: Viewport, spec: MeasureSpec): Promise<RawMeasurements> {
      const page = await browser.newPage();
      try {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        // Load the page, then settle it: wait for `load`, best-effort for networkidle, then a brief
        // fixed pause so the geometry reflects the FINISHED render -- CSS/fonts/images loaded,
        // hydration done -- never a mid-load frame. A page that renders fully but holds a lingering
        // connection open (so networkidle never fires) is still measured, not skipped -- see settledGoto.
        await settledGoto(page, url, { timeout });
        return await page.evaluate(measureInPage, spec);
      } finally {
        await page.close();
      }
    },
    async close(): Promise<void> {
      await browser.close();
    },
  };
}

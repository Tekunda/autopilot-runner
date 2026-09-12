// A process-wide, promise-memoizing capture cache that owns ONE headless browser and renders each
// (url, viewport-dimensions) at most once per heavy-stage site run. Both vision gates (visual-qa and
// design-review) run concurrently against the SAME served site and derive the SAME route set, so
// without sharing they each launch a browser and render every (route, viewport) twice -- double the
// navigate/settle/capture cost and double the render-flakiness surface. Routing both gates through
// one SharedCapture renders each page once; the sibling gate awaits the same in-flight render and
// consumes the identical PNG bytes. Only the RENDER is shared -- each gate still makes its own judge
// call with its own rubric profile, so the two verdicts stay fully independent.
//
// Mirrors the defaultVisionLimiter singleton (vision-concurrency.ts): one process-wide instance,
// created lazily, reset between sites. Sites serve-and-gate SEQUENTIALLY, so one instance suffices
// and close() both frees the browser process and clears the base64 map between sites.

import { createPlaywrightBrowser, type Screenshot, type ScreenshotBrowser, type Viewport } from './browser.ts';

// The screenshot seam both vision gates render through. Same screenshot() shape as ScreenshotBrowser
// so the gate's call site is unchanged; close() releases the owned browser (if one was created).
export interface SharedCapture {
  screenshot(url: string, viewport: Viewport): Promise<Screenshot>;
  close(): Promise<void>;
}

// The cache KEY is url + render DIMENSIONS. viewport.name is a cosmetic label only (it never changes
// the rendered pixels), so it is excluded -- two configured viewports with identical WxH but
// different names collapse to one render, which is correct (same pixels). DEFAULT_SWEEP dims are all
// distinct, so the sweep is unaffected.
function captureKey(url: string, viewport: Viewport): string {
  return `${url} ${viewport.width}x${viewport.height}`;
}

// `deps.createBrowser` overrides the lazily-created browser (tests inject a fake; production uses the
// real Playwright browser). A SharedCapture wrapping an already-constructed browser is built by
// passing a factory that returns it.
export function createSharedCapture(deps: { createBrowser?: () => Promise<ScreenshotBrowser> } = {}): SharedCapture {
  const createBrowser = deps.createBrowser ?? createPlaywrightBrowser;
  // One browser for the cache's lifetime, created on first screenshot. Stored as the PROMISE so two
  // concurrent first callers share a single launch rather than racing two.
  let browserPromise: Promise<ScreenshotBrowser> | undefined;
  const renders = new Map<string, Promise<Screenshot>>();

  return {
    screenshot(url: string, viewport: Viewport): Promise<Screenshot> {
      const key = captureKey(url, viewport);
      const existing = renders.get(key);
      if (existing) return existing;
      // Store the in-flight render PROMISE synchronously, BEFORE any await, so a concurrent caller
      // for the same key (the gates run under Promise.all) finds it and awaits the same render
      // instead of starting a second one. This is the core dedupe and must stay synchronous.
      const render = (browserPromise ??= createBrowser()).then((browser) => browser.screenshot(url, viewport));
      // A REJECTED render stays cached: both gates then get the identical "could not verify" for a
      // page that will not render -- same failure, no double-rendering of a hung page (fail-closed
      // semantics preserved; only the failure is shared).
      renders.set(key, render);
      return render;
    },
    async close(): Promise<void> {
      renders.clear();
      const pending = browserPromise;
      // Reset so a later screenshot re-creates the browser -- the cache is reusable across sites.
      browserPromise = undefined;
      if (pending) await (await pending).close();
    },
  };
}

// The production singleton, mirroring defaultVisionLimiter. Both vision gates reach it directly; the
// heavy stage (serve-and-gate.ts) owns its lifecycle, closing it in each served site's teardown.
export const defaultSharedCapture = createSharedCapture();

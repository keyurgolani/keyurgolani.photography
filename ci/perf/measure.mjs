// @ts-check
/**
 * One cold load of a page and its LCP and TBT, for the A/B perf job (ab.mjs). Taken from the loader lane's local perf
 * tool: a fresh browser context per load, so it's a first visit and Home's intro plays, with the cache off, and every
 * request off 127.0.0.1 aborted. LCP is the last `largest-contentful-paint` entry. TBT is the sum of each top-document
 * `longtask` past 50 ms, from FCP to load + 5 s (stats.mjs reduceLoad()). An LCP element inside Home's badge or a
 * portrait frame is marked ` (portrait)`. Nothing touches the page before the read, since input ends LCP. For
 * reference, not gated: the bytes the load transferred, the document's and every resource's transferSize summed (all
 * same-origin on 127.0.0.1, so none reads 0 for want of Timing-Allow-Origin), and when Home's copy-tone sampler started
 * its fetch: the one fetch() of /media Home makes (components/badgePlace.ts canvasSampler()), matched by its resource
 * timing's `fetch` initiator, so its URL and its cache key stay the rung's own.
 */

import { reduceLoad } from './stats.mjs';

/**
 * @typedef {{
 *   viewport: { width: number, height: number }, deviceScaleFactor: number, isMobile: boolean, hasTouch: boolean,
 *   cpu: number, network: { latency: number, downloadThroughput: number, uploadThroughput: number } | null,
 * }} Profile
 */

/** A phone at 4x CPU on a 150 ms, 1.6 Mbps link, the lab profile the other lanes use, and an unthrottled desktop. */
export const PROFILES = /** @type {Record<'phone' | 'desktop', Profile>} */ ({
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, cpu: 4, network: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 } },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, cpu: 1, network: null },
});

/** How long after `load` the long tasks still count, and the page is left alone. */
const SETTLE_MS = 5000;

/**
 * @param {import('@playwright/test').Browser} browser
 * @param {string} url on 127.0.0.1
 * @param {Profile} profile
 */
export async function measureLoad(browser, url, profile) {
  if (new URL(url).hostname !== '127.0.0.1') throw new Error(`Loopback only, not ${url}.`);
  const context = await browser.newContext({ viewport: profile.viewport, deviceScaleFactor: profile.deviceScaleFactor, isMobile: profile.isMobile, hasTouch: profile.hasTouch, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    await page.route((target) => target.hostname !== '127.0.0.1', (route) => route.abort());
    await page.addInitScript(() => {
      /** @type {{ lcp: { t: number, el: string | null, url: string }[], longtasks: { t: number, d: number }[], fcp: number | null }} */
      const store = { lcp: [], longtasks: [], fcp: null };
      Object.assign(window, { __perf: store });
      // Room for every request a Home load makes, so the bytes miss none.
      performance.setResourceTimingBufferSize(2000);
      new PerformanceObserver((list) => {
        for (const entry of /** @type {any[]} */ (list.getEntries())) {
          const el = entry.element;
          store.lcp.push({ t: entry.startTime, el: el ? el.tagName.toLowerCase() + (el.getAttribute('alt') ? `[alt=${el.getAttribute('alt').slice(0, 40)}]` : '') + (el.closest('[data-home-badge], [class*="portrait"]') ? ' (portrait)' : '') : null, url: entry.url ? new URL(entry.url).pathname : '' });
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) store.longtasks.push({ t: entry.startTime, d: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (entry.name === 'first-contentful-paint') store.fcp = entry.startTime;
      }).observe({ type: 'paint', buffered: true });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (profile.network) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...profile.network });
    if (profile.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
    await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
    const loadAt = await page.evaluate(() => performance.timing.loadEventStart - performance.timing.navigationStart);
    await page.waitForTimeout(SETTLE_MS);
    /** @type {import('./stats.mjs').PageEntries} */
    const perf = await page.evaluate(() => {
      const resources = /** @type {PerformanceResourceTiming[]} */ (performance.getEntriesByType('resource'));
      const documents = /** @type {PerformanceResourceTiming[]} */ (performance.getEntriesByType('navigation'));
      const bytes = [...documents, ...resources].reduce((sum, entry) => sum + (entry.transferSize || 0), 0);
      const tone = resources.find((entry) => entry.initiatorType === 'fetch' && new URL(entry.name).pathname.startsWith('/media/'));
      return { .../** @type {any} */ (window).__perf, bytes, toneFetch: tone ? tone.startTime : null };
    });
    return reduceLoad(perf, loadAt, SETTLE_MS);
  } finally {
    await context.close();
  }
}

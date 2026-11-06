// @ts-check
/**
 * One cold load of a page and its LCP and TBT, for the A/B perf job (ab.mjs). Taken from the loader lane's local perf
 * tool: a fresh browser context per load, so it's a first visit and Home's intro plays, with the cache off, and every
 * request off 127.0.0.1 aborted. LCP is the last `largest-contentful-paint` entry. TBT is the sum of each top-document
 * `longtask` past 50 ms, from FCP to load + 5 s. Nothing touches the page before the read, since input ends LCP.
 */

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
      new PerformanceObserver((list) => {
        for (const entry of /** @type {any[]} */ (list.getEntries())) {
          const el = entry.element;
          store.lcp.push({ t: entry.startTime, el: el ? el.tagName.toLowerCase() + (el.getAttribute('alt') ? `[alt=${el.getAttribute('alt').slice(0, 40)}]` : '') : null, url: entry.url ? new URL(entry.url).pathname : '' });
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
    /** @type {{ lcp: { t: number, el: string | null, url: string }[], longtasks: { t: number, d: number }[], fcp: number | null }} */
    const perf = await page.evaluate(() => /** @type {any} */ (window).__perf);
    const fcp = perf.fcp ?? 0;
    const tbt = perf.longtasks.filter((task) => task.t >= fcp && task.t <= loadAt + SETTLE_MS).reduce((sum, task) => sum + Math.max(0, task.d - 50), 0);
    const last = perf.lcp.at(-1) ?? null;
    return { lcp: last ? Math.round(last.t) : null, tbt: Math.round(tbt), fcp: Math.round(fcp), load: loadAt, longtasks: perf.longtasks.length, lcpElement: last?.el ?? null, lcpUrl: last?.url ?? null };
  } finally {
    await context.close();
  }
}

import { waitForHydration } from '../support/hydration';
import { expect, test } from '../support/test';

test.skip(({ isMobile }) => isMobile, 'The desktop project covers it. SiteNav runs on both in nav.spec.ts.');

// The raw next start HTML, before any script runs: each visitor route sends
// SiteNav and its content, on the dark theme.

const NAV = /<nav[^>]*aria-label="Primary"/;

for (const [path, content] of [
    // Home's main carries the chrome's state, immersive from the first byte, and a wrapper inside it the playback's.
    ['/', /<main[^>]*data-interface-state="immersive"[^>]*>[\s\S]*?<div[^>]*data-playback=/],
    ['/gallery', /<h1[^>]*>Gallery<\/h1>/],
    ['/about', /<h1[^>]*>Keyur Golani<\/h1>[\s\S]*aka ISerialClicker/],
] as const) {
    test(`the server HTML for ${path} holds SiteNav and the page content`, async ({ request }) => {
        const response = await request.get(path);
        expect(response.status()).toBe(200);
        const html = await response.text();
        expect(html).toMatch(/<html[^>]*data-theme="dark"/);
        expect(html).toMatch(NAV);
        expect(html).toMatch(content);
    });
}

test('an unknown path returns 404 with SiteNav and the not-found page', async ({ request }) => {
    const response = await request.get('/does-not-exist');
    expect(response.status()).toBe(404);
    const html = await response.text();
    expect(html).toMatch(NAV);
    expect(html).toMatch(/<h1[^>]*>Page not found<\/h1>/);
    expect(html).toContain('This link may be out of date, or the work it pointed to is no longer published.');
    expect(html).toMatch(/<a[^>]*href="\/gallery"[^>]*>Browse the work<\/a>/);
});

test('the fonts come from the site, headings take the serif at 400, and the legacy Gallery h1 keeps 700', async ({ page }) => {
    const fontHosts = new Set<string>();
    page.on('request', (request) => {
        if (request.resourceType() === 'font') fontHosts.add(new URL(request.url()).host);
    });
    /** The first family in `--font-serif`, the name next/font gave Newsreader. */
    const serifFamily = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-serif').split(',')[0].trim());
    const familyOf = (name: string) => page.getByRole('heading', { level: 1, name }).evaluate((el) => getComputedStyle(el).fontFamily.split(',')[0].trim());

    await page.goto('/does-not-exist');
    await waitForHydration(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toHaveCSS('font-weight', '400');
    expect(await familyOf('Page not found')).toBe(await serifFamily());

    await page.goto('/gallery');
    await waitForHydration(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Gallery' })).toHaveCSS('font-weight', '700');
    expect(await familyOf('Gallery')).toBe(await serifFamily());
    await page.evaluate(() => document.fonts.ready);
    expect([...fontHosts]).toEqual([new URL(page.url()).host]);
});

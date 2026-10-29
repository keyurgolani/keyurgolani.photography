import { artist } from '../../data/artist';
import { STAND_IN_PORTRAIT } from '../support/aboutPortrait';
import { waitForHydration } from '../support/hydration';
import { expect, test } from '../support/test';

test.skip(({ isMobile }) => isMobile, 'The desktop project covers it. SiteNav runs on both in nav.spec.ts.');

// The raw next start HTML, before any script runs: each visitor route sends
// SiteNav and its content, on the dark theme.

const NAV = /<nav[^>]*aria-label="Primary"/;

/** The text as React writes it into HTML, escaped for a RegExp. */
const escape = (text: string) =>
    text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const { profile } = artist;
/** About's portrait, the stand-in the server reads from its site config folder, with its alt, the caption's name and alias, then the statement h1. React may split adjacent text with comments. */
const ABOUT = new RegExp(
    [
        `<figure[^>]*data-testid="about-portrait"`,
        `<img[^>]*alt="${escape(STAND_IN_PORTRAIT.alt)}"`,
        `<figcaption[^>]*>${escape(profile.name)}`,
        escape(profile.alias ?? ''),
        `</figcaption>`,
        `<h1[^>]*>${escape(profile.statementHeading)}</h1>`,
    ].join('[\\s\\S]*'),
);

for (const [path, content] of [
    // Home's main carries the chrome's state, immersive from the first byte, and a wrapper inside it the playback's.
    ['/', /<main[^>]*data-interface-state="immersive"[^>]*>[\s\S]*?<div[^>]*data-playback=/],
    ['/gallery', /<h1[^>]*>Gallery<\/h1>/],
    ['/about', ABOUT],
] as const) {
    test(`the server HTML for ${path} holds SiteNav and the page content`, async ({ request }) => {
        const response = await request.get(path);
        expect(response.status()).toBe(200);
        const html = await response.text();
        expect(html).toMatch(/<html[^>]*data-theme="black"/);
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
    expect(html).toMatch(/<a[^>]*href="\/work"[^>]*>Browse the work<\/a>/);
});

test('before the cutover /work answers 307 to /gallery, which serves the legacy page', async ({ request }) => {
    const work = await request.get('/work', { maxRedirects: 0 });
    expect(work.status()).toBe(307);
    expect(work.headers()['location']).toBe('/gallery');
    const gallery = await request.get('/gallery', { maxRedirects: 0 });
    expect(gallery.status()).toBe(200);
    expect(await gallery.text()).toMatch(/<h1[^>]*>Gallery<\/h1>/);
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

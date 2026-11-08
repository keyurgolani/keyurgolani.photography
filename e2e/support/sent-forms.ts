import type { Page, Route } from '@playwright/test';
import { expect } from './test';

/** Every request to the Inbox page itself, which is where its forms post, a server action or the plain way. */
const INBOX_PAGE = /\/curation\/inbox(?:[?#]|$)/;

/**
 * Watches the page for a form being sent: each `submit` event, by the form's name, and each POST to the Inbox, which
 * it stops before it reaches the server, so a key that sends a form by mistake writes nothing, even on a red run.
 * Call it once the page has hydrated. `stop()` lets posts through again; the submit events are still counted, by
 * `forms()`, until the page loads another document.
 */
export async function watchSends(page: Page) {
    const posts: string[] = [];
    const hold = async (route: Route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        posts.push(route.request().url());
        await route.abort();
    };
    await page.route(INBOX_PAGE, hold);
    await page.evaluate(() => {
        const seen: string[] = [];
        (window as unknown as { sentForms: string[] }).sentForms = seen;
        document.addEventListener(
            'submit',
            (event) => {
                const form = event.target as HTMLFormElement;
                seen.push(form.getAttribute('aria-label') ?? (form.id || 'a form'));
            },
            true,
        );
    });
    /** The forms sent since the watch began, or null once the page has loaded another document. */
    const forms = () => page.evaluate(() => (window as unknown as { sentForms?: string[] }).sentForms ?? null);
    return {
        forms,
        /** Runs `act`, a key on a control, and checks that it sent no form, posted nothing and left the page where it was. */
        async nothingSent(label: string, act: () => Promise<void>) {
            const url = page.url();
            await act();
            // A key sends a form at once, by its `submit` event, and the post follows: this gives the post time to start.
            await page.waitForTimeout(400);
            expect(await forms(), `${label}: no form sent, on the same page`).toEqual([]);
            expect(posts, `${label}: nothing posted`).toEqual([]);
            expect(page.url(), `${label}: the page stayed where it was`).toBe(url);
        },
        stop: () => page.unroute(INBOX_PAGE, hold),
    };
}

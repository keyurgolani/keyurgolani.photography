import type { Page, Route } from '@playwright/test';

export interface HeldPost {
    /** Settles once the page has sent the POST, which is then held. */
    sent: Promise<void>;
    /** Lets the held POST go on to the server, and stops holding. */
    release: () => Promise<void>;
}

/**
 * Holds the page's next POST to `pathname` until `release()`, so a test can
 * look at a control while its action is pending. Every other request, and
 * every POST after that one, goes on as usual.
 */
export async function holdNextPost(page: Page, pathname: string): Promise<HeldPost> {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let arrived!: () => void;
    const sent = new Promise<void>((resolve) => (arrived = resolve));
    let taken = false;
    let passed: Promise<void> = Promise.resolve();
    const matches = (url: URL) => url.pathname === pathname;
    const handler = async (route: Route) => {
        if (taken || route.request().method() !== 'POST') return route.fallback();
        taken = true;
        passed = gate.then(() => route.continue());
        arrived();
        await passed;
    };
    await page.route(matches, handler);
    return {
        sent,
        release: async () => {
            open();
            await passed;
            await page.unroute(matches, handler);
        },
    };
}

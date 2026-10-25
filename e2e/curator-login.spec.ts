import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { READY_TIMEOUT } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// #14's 14-2: the curator's `Secure` session cookie over plain http on
// loopback, as the owner's SSH tunnel serves it. The curator listens on
// 127.0.0.1 only. For each name the tunnel answers to, `localhost` and
// `127.0.0.1`, the browser has to keep the cookie the login sets and send
// it back, and logout has to end it, a replayed copy included. A browser
// that drops a `Secure` cookie on http would fail here; the fix is never to
// drop `Secure`.

test.describe.configure({ mode: 'serial' });

const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;

let catalog: TestCatalog | undefined;
let curator: CuratorServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    catalog = await createTestCatalog({
        seed: 21,
        withAssets: true,
        photos: [{ id: 'ph_00000000-0000-4000-8000-000000000001' }],
        series: [{ slug: 'login-fixture', title: 'Login fixture', photoIds: ['ph_00000000-0000-4000-8000-000000000001'] }],
    });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
    // E2E_CURATOR_PORT pins a port per worker, for a machine that hands out ranges.
    const base = Number(process.env.E2E_CURATOR_PORT);
    curator = await startCuratorServer(catalog.root, Number.isInteger(base) && base > 0 ? base + test.info().parallelIndex : undefined);
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await curator?.stop();
    await catalog?.cleanup();
});

const server = () => {
    if (!curator) throw new Error('The curator server did not start');
    return curator;
};
const portOf = () => new URL(server().origin).port;

for (const name of ['localhost', '127.0.0.1']) {
    test(`keeps and sends the Secure session cookie on http://${name}`, async ({ browser }) => {
        const origin = `http://${name}:${portOf()}`;
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
            // Without a session, the curator sends the page to its login.
            await page.goto(`${origin}/curation`);
            await expect(page).toHaveURL(`${origin}/curation/login`);
            await expect(page.getByRole('heading', { name: 'Curator login' })).toBeVisible();

            // A wrong passphrase sets nothing.
            await waitForHydration(page);
            await page.getByLabel('Passphrase').fill('not the passphrase');
            await page.getByRole('button', { name: 'Sign in' }).click();
            await expect(page.getByRole('alert')).toContainText("That didn't sign you in.");
            expect((await context.cookies()).filter((cookie) => cookie.name === 'curator_session')).toEqual([]);

            await signIn(page, origin, server().passphrase);
            await expect(page.getByRole('heading', { name: 'Curation' })).toBeVisible();

            // The browser kept the cookie, with every attribute the curator set.
            const kept = (await context.cookies(origin)).filter((cookie) => cookie.name === 'curator_session');
            expect(kept).toHaveLength(1);
            const [cookie] = kept;
            expect(cookie.domain).toBe(name);
            expect(cookie.path).toBe('/');
            expect(cookie.secure).toBe(true);
            expect(cookie.httpOnly).toBe(true);
            expect(cookie.sameSite).toBe('Strict');
            const lifetime = cookie.expires - Date.now() / 1000;
            expect(lifetime).toBeGreaterThan(43200 - 300);
            expect(lifetime).toBeLessThanOrEqual(43200 + 5);
            expect(await page.evaluate(() => document.cookie)).not.toContain('curator_session');

            // And sends it: a fresh load of /curation is served, not sent to the login.
            const sent = page.waitForRequest((request) => request.url() === `${origin}/curation`);
            const response = await page.goto(`${origin}/curation`);
            expect(response?.status()).toBe(200);
            expect((await (await sent).allHeaders()).cookie ?? '').toContain('curator_session=');
            await expect(page).toHaveURL(`${origin}/curation`);
            await expect(page.getByText("you're signed in")).toBeVisible();

            // Logout ends the session and clears the cookie.
            await waitForHydration(page);
            await page.getByRole('button', { name: 'Sign out' }).click();
            await expect(page).toHaveURL(`${origin}/curation/login`);
            expect((await context.cookies(origin)).filter((entry) => entry.name === 'curator_session')).toEqual([]);

            // A copy of the cookie, put back after logout, counts for nothing.
            await context.addCookies([cookie]);
            await page.goto(`${origin}/curation`);
            await expect(page).toHaveURL(`${origin}/curation/login`);
        } finally {
            await context.close();
        }
    });
}

test('keeps a session on one name to that name, as cookies are kept by host', async ({ browser }) => {
    const port = portOf();
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await signIn(page, `http://127.0.0.1:${port}`, server().passphrase);
        await page.goto(`http://localhost:${port}/curation`);
        await expect(page).toHaveURL(`http://localhost:${port}/curation/login`);
    } finally {
        await context.close();
    }
});

import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { READY_TIMEOUT } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { expectNoA11yViolations } from './support/a11y';
import { holdNextPost } from './support/holdPost';
import { waitForHydration } from './support/hydration';
import { checkSurface } from './support/surface';
import { expect, test } from './support/test';
import type { Page } from '@playwright/test';

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
const passphrase = (page: Page) => page.getByLabel('Passphrase');

/** The login's controls for checkSurface(): the wordmark, the field and the button. */
const loginControls = (page: Page) => [page.getByRole('banner').getByRole('link'), passphrase(page), page.getByRole('main').getByRole('button')];

/**
 * Waits until the Sign in button is enabled and no transition is running on
 * it, so axe reads the colours it rests at. It is disabled until the page
 * hydrates, and it fades between its states.
 */
async function buttonAtRest(page: Page): Promise<void> {
    const button = page.getByRole('main').getByRole('button');
    await expect(button).toBeEnabled();
    await button.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
}

for (const name of ['localhost', '127.0.0.1']) {
    test(`keeps and sends the Secure session cookie on http://${name}`, async ({ browser, browserName }) => {
        // Playwright's Linux WebKit drops a Secure cookie set over plain http (localhost and 127.0.0.1), so the
        // sign-in comes back to the login (CI on #87 b26906cc). Chromium and Firefox keep it, and real
        // Safari is unverified. Kept as an expected failure, not a skip: if WebKit starts keeping the
        // cookie, this flips and says so. docs/curator.md tells the owner to use Chrome or Firefox.
        test.fail(browserName === 'webkit', 'WebKit on Linux drops Secure cookies over plain http, on localhost and 127.0.0.1');
        const origin = `http://${name}:${portOf()}`;
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
            // Without a session, the curator sends the page to its login.
            await page.goto(`${origin}/curation`);
            await expect(page).toHaveURL(`${origin}/curation/login`);
            await expect(page.getByRole('heading', { name: 'Sign in to curation' })).toBeVisible();

            // A wrong passphrase sets nothing, and the field says why it's back.
            await waitForHydration(page);
            await page.getByLabel('Passphrase').fill('not the passphrase');
            await page.getByRole('button', { name: 'Sign in' }).click();
            await expect(page).toHaveURL(`${origin}/curation/login?failed=1`);
            await expect(passphrase(page)).toHaveAccessibleDescription("That didn't sign you in. Check the passphrase and try again.");
            await expect(passphrase(page)).toHaveAttribute('aria-invalid', 'true');
            await expect(passphrase(page)).toBeFocused();
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

            // Logout ends the session and clears the cookie, and the login page says so.
            await waitForHydration(page);
            await page.getByRole('button', { name: 'Sign out' }).click();
            await expect(page).toHaveURL(`${origin}/curation/login?signed-out=1`);
            await expect(page.getByRole('status')).toHaveText("You're signed out.");
            expect((await context.cookies(origin)).filter((entry) => entry.name === 'curator_session')).toEqual([]);

            // A copy of the cookie, put back after logout, counts for nothing, and the page says the session ended.
            await context.addCookies([cookie]);
            await page.goto(`${origin}/curation`);
            await expect(page).toHaveURL(`${origin}/curation/login?ended=1`);
            await expect(page.getByRole('status')).toHaveText('Your session ended. Sign in again.');
            await expect(passphrase(page)).toHaveAccessibleDescription('Your session ended. Sign in again.');
        } finally {
            await context.close();
        }
    });
}

test('keeps a session on one name to that name, as cookies are kept by host', async ({ browser, browserName }) => {
    // It signs in on http://127.0.0.1 first, where Linux WebKit drops the Secure cookie (see above).
    test.fail(browserName === 'webkit', 'WebKit on Linux drops Secure cookies over plain http, on localhost and 127.0.0.1');
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

test('passes the automated and keyboard checks, at rest and with a refusal', async ({ page }) => {
    const origin = server().origin;
    await page.goto(`${origin}/curation/login`);
    await buttonAtRest(page);
    await checkSurface(page, { controls: loginControls(page) });
    // The hidden username for password managers is out of reach and out of the tree.
    await expect(page.locator('input[name="username"]')).toBeHidden();
    // Playwright counts a password field as a textbox, so the passphrase is the only one.
    await expect(page.getByRole('textbox')).toHaveCount(1);
    await expect(page.getByRole('textbox')).toHaveAccessibleName('Passphrase');

    // Enter in the field submits, and so does Space on the button.
    await passphrase(page).fill('not the passphrase');
    await passphrase(page).press('Enter');
    await expect(page).toHaveURL(`${origin}/curation/login?failed=1`);
    await buttonAtRest(page);
    await checkSurface(page, { controls: loginControls(page) });
    await page.goto(`${origin}/curation/login`);
    await waitForHydration(page);
    await passphrase(page).fill('still not the passphrase');
    await page.getByRole('button', { name: 'Sign in' }).focus();
    await page.keyboard.press('Space');
    await expect(page).toHaveURL(`${origin}/curation/login?failed=1`);
    await expect(passphrase(page)).toHaveAccessibleDescription(/^That didn't sign you in\./);
    await page.goto(`${origin}/curation/login`);
    await waitForHydration(page);
    await passphrase(page).fill('not it either');
    await page.getByRole('button', { name: 'Sign in' }).focus();
    // While the sign-in is on its way, the button says so and keeps the focus Enter sent it with (#1's contract).
    const held = await holdNextPost(page, '/api/curation/login');
    await page.keyboard.press('Enter');
    await held.sent;
    const button = page.getByRole('main').getByRole('button');
    await expect(button).toHaveText('Signing in…');
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toBeFocused();
    await held.release();
    await expect(page).toHaveURL(`${origin}/curation/login?failed=1`);

    // Enter on the wordmark leads to the site, as the Inbox's does.
    await page.getByRole('banner').getByRole('link', { name: 'Portfolio curation' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin}/`);
});

// Last in this serial file: the lock holds for 15 minutes, and every test above shares this server.
test('during the lock, says only that it is on, how long it has left and the restart, for the right passphrase too', async ({ browser }) => {
    const origin = server().origin;
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        // The tries the tests above made count too, so this stops as soon as the lock is on.
        for (let i = 0; i < 5; i++) {
            await page.goto(`${origin}/curation/login`);
            if (await page.getByText('Sign-in is paused').isVisible()) break;
            await waitForHydration(page);
            await passphrase(page).fill(`wrong ${i}`);
            await passphrase(page).press('Enter');
            await page.waitForURL(`${origin}/curation/login?failed=1`);
        }
        for (const [label, value] of [
            ['wrong', 'not the passphrase'],
            ['right', server().passphrase],
        ] as const) {
            await page.goto(`${origin}/curation/login`);
            await expect(page.locator('#curator-login-notice'), `${label}, before`).toContainText('Sign-in is paused');
            await waitForHydration(page);
            await passphrase(page).fill(value);
            await page.getByRole('button', { name: 'Sign in' }).click();
            await expect(page, label).toHaveURL(`${origin}/curation/login?failed=1`);
            const notice = page.locator('#curator-login-notice');
            await expect(notice, label).toContainText(/^Sign-in is paused for about (?:1[0-5] more minutes|one more minute), after five wrong passphrases\./);
            await expect(notice, label).toContainText('Restarting curator on the server also ends it.');
            await expect(page.getByText('Check the passphrase'), label).toHaveCount(0);
            await expect(passphrase(page), label).not.toHaveAttribute('aria-invalid', 'true');
            await expect(passphrase(page), label).toHaveAccessibleDescription(/^Sign-in is paused/);
            expect((await context.cookies(origin)).filter((cookie) => cookie.name === 'curator_session'), label).toEqual([]);
        }
        await buttonAtRest(page);
        await expectNoA11yViolations(page);
    } finally {
        await context.close();
    }
});

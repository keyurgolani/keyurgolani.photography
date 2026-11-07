// A one-off CI probe, never merged: the Inbox row checkbox as WebKit draws it and hit-tests it, and
// Chromium for reference, on the e2e's curator fixture, against #1's 44 px target rule. It records the runner's OS and
// Playwright's WebKit build with the figures, so they say what they came from. Temp dirs live under TMPDIR, outside
// the checkout; the server listens on 127.0.0.1 only and is stopped before the end.
//
//   PROBE_DRY=1 npx tsx e2e/probes/inbox-checkbox-webkit.ts <out.json>   the same measure in Chromium only, both ways in
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium, devices, webkit, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { makeCuratorSecrets } from '../../test/helpers/curatorSecrets';
import { startCatalogServer } from '../support/catalogServer';
import { createInboxFixture, openInboxItems } from '../support/curation-inbox';

const out = process.argv[2];
if (!out) throw new Error('usage: inbox-checkbox-webkit.ts <out.json>');
// The output folder first, so a run that fails later still uploads what it wrote: at least the reason.
fs.mkdirSync(path.dirname(out), { recursive: true });
process.env.E2E_EMPTY_LIBRARY = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-library-'));
if (!process.env.E2E_SITE_CONFIG_DIR) throw new Error('E2E_SITE_CONFIG_DIR must be set');

type Box = { x: number; y: number; width: number; height: number };

async function drawnBox(page: Page, clip: Box): Promise<Box | null> {
    const shot = async () => sharp(await page.screenshot({ clip, animations: 'disabled', scale: 'css' })).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    const shown = await shot();
    await page.evaluate(() => {
        const box = document.querySelector('input[type="checkbox"][form]') as HTMLInputElement;
        box.style.visibility = 'hidden';
    });
    const hidden = await shot();
    await page.evaluate(() => {
        const box = document.querySelector('input[type="checkbox"][form]') as HTMLInputElement;
        box.style.visibility = '';
    });
    const { width, height, channels } = shown.info;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y += 1)
        for (let x = 0; x < width; x += 1) {
            const i = (y * width + x) * channels;
            let diff = 0;
            for (let c = 0; c < 3; c += 1) diff = Math.max(diff, Math.abs(shown.data[i + c] - hidden.data[i + c]));
            if (diff > 8) {
                minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
            }
        }
    if (maxX < 0) return null;
    return { x: clip.x + minX, y: clip.y + minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Why WebKit's session is injected, recorded with its figures. */
const INJECTED = "Playwright's Linux WebKit drops a Secure cookie set over plain http on 127.0.0.1 (e2e/curator-login.spec.ts marks it test.fail), so the probe signs in once from Node and adds the session cookie to WebKit's context without Secure. The product's cookie stays Secure.";

/**
 * Signs in once from Node, as the login form posts, with the Origin the curator checks, and returns the session
 * cookie's value. The probe's own way past Linux WebKit's dropped Secure cookie; the server is unchanged.
 */
async function sessionFromNode(origin: string, passphrase: string): Promise<string> {
    const response = await fetch(`${origin}/api/curation/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ passphrase }),
    });
    const cookie = response.headers.getSetCookie().map((line) => line.split(';')[0]).find((pair) => pair.startsWith('curator_session='));
    if (response.status !== 303 || !cookie) throw new Error(`Signing in from Node answered ${response.status}${cookie ? '' : ' with no session cookie'}`);
    return cookie.slice('curator_session='.length);
}

async function measure(browser: Browser, name: string, options: BrowserContextOptions, origin: string, passphrase: string, signIn: 'form' | 'injected') {
    const context = await browser.newContext({ ...options, colorScheme: 'dark' });
    const page = await context.newPage();
    if (signIn === 'injected') {
        // On 127.0.0.1 only, HttpOnly and SameSite=Strict as the curator sets it, without Secure (INJECTED says why).
        await context.addCookies([{ name: 'curator_session', value: await sessionFromNode(origin, passphrase), domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Strict' }]);
    } else {
        await page.goto(`${origin}/curation/login`);
        await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
        await page.getByLabel('Passphrase').fill(passphrase);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.waitForURL(`${origin}/curation`);
    }
    await page.goto(`${origin}/curation/inbox`);
    if (new URL(page.url()).pathname !== '/curation/inbox') throw new Error(`${name}: the Inbox sent the page to ${page.url()}, so the session didn't hold`);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    const box = page.locator('#inbox-list input[type="checkbox"][form]').first();
    await box.scrollIntoViewIfNeeded();
    // No named function inside a callback the page runs: tsx's keepNames wraps one in __name, which the page lacks.
    const facts = await box.evaluate((input) => {
        const label = input.closest('label') as HTMLElement;
        const i = input.getBoundingClientRect();
        const l = label.getBoundingClientRect();
        const cs = getComputedStyle(input);
        return { input: { x: i.x, y: i.y, width: i.width, height: i.height }, label: { x: l.x, y: l.y, width: l.width, height: l.height }, computed: { width: cs.width, height: cs.height, appearance: cs.appearance || (cs as unknown as Record<string, string>).webkitAppearance, margin: cs.margin } };
    });
    const playwrightBox = await box.boundingBox();
    // Hit test every point of the input's own 44 px box: what's under it, and whether that point toggles the box.
    const hits = await box.evaluate((input) => {
        const label = input.closest('label') as HTMLElement;
        const b = input.getBoundingClientRect();
        let onInput = 0, onLabel = 0, other = 0, total = 0;
        for (let y = b.top + 0.5; y < b.bottom; y += 1)
            for (let x = b.left + 0.5; x < b.right; x += 1) {
                total += 1;
                const el = document.elementFromPoint(x, y);
                if (el === input) onInput += 1;
                else if (el && label.contains(el)) onLabel += 1;
                else other += 1;
            }
        return { total, onInput, onLabelOnly: onLabel, other };
    });
    // Where the box is now, read again before each press and before the crop, in case a press scrolled the page.
    const rectNow = () => box.evaluate((input) => {
        const label = input.closest('label') as HTMLElement;
        const i = input.getBoundingClientRect();
        const l = label.getBoundingClientRect();
        return { input: { x: i.x, y: i.y, width: i.width, height: i.height }, label: { x: l.x, y: l.y, width: l.width, height: l.height } };
    });
    const corners = [
        ['top-left', (r: Box) => [r.x + 1, r.y + 1]],
        ['top-right', (r: Box) => [r.x + r.width - 1, r.y + 1]],
        ['bottom-left', (r: Box) => [r.x + 1, r.y + r.height - 1]],
        ['bottom-right', (r: Box) => [r.x + r.width - 1, r.y + r.height - 1]],
        ['centre', (r: Box) => [r.x + r.width / 2, r.y + r.height / 2]],
    ] as const;
    const toggles: Record<string, boolean> = {};
    // For a press that toggled nothing: what was under it, and the page's scroll and zoom then.
    const pressedOn: Record<string, string> = {};
    // Where each press left the page: a press can open the row's item too, on a phone.
    const urls: Record<string, string> = {};
    const fresh = async () => {
        await page.goto(`${origin}/curation/inbox`);
        await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
        await box.scrollIntoViewIfNeeded();
        let rect = await rectNow();
        for (let settle = 0; settle < 20; settle += 1) {
            await page.waitForTimeout(100);
            const again = await rectNow();
            if (again.input.x === rect.input.x && again.input.y === rect.input.y) break;
            rect = again;
        }
        return rect;
    };
    // Each press on a fresh load of the list, so what one press did (a toggle, or opening the item) never moves the next.
    for (const [where, at] of corners) {
        const [x, y] = at((await fresh()).input);
        const before = await box.isChecked();
        if (options.hasTouch) await page.touchscreen.tap(x, y);
        else await page.mouse.click(x, y);
        // A tap's click lands a moment after the touch: wait for it, up to a second.
        const deadline = Date.now() + 1000;
        while ((await box.isVisible()) && (await box.isChecked()) === before && Date.now() < deadline) await page.waitForTimeout(50);
        await page.waitForTimeout(300);
        toggles[where] = (await box.isVisible()) && (await box.isChecked()) !== before;
        const now = new URL(page.url());
        urls[where] = `${now.pathname}${now.search}${now.hash}`;
        if (!toggles[where]) pressedOn[where] = await page.evaluate(([px, py]) => {
            const el = document.elementFromPoint(px, py);
            return el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} at ${window.scrollX},${window.scrollY} scale ${window.visualViewport?.scale ?? 1}` : 'nothing';
        }, [x, y] as const);
    }
    const at = (await fresh()).label;
    // No focus ring or hover in the drawn measurement: only the box itself.
    await box.evaluate((input) => (input as HTMLInputElement).blur());
    if (!options.hasTouch) await page.mouse.move(1, 1);
    const visible = at.width > 0 && at.height > 0;
    const drawn = visible ? await drawnBox(page, { x: Math.max(0, at.x), y: Math.max(0, at.y), width: at.width, height: at.height }) : null;
    if (visible) await page.screenshot({ path: path.join(path.dirname(out), `v2-f4-webkit-${name}.png`), clip: { x: Math.max(0, at.x - 4), y: Math.max(0, at.y - 4), width: at.width + 200, height: at.height + 8 } });
    await context.close();
    return { project: name, browser: browser.browserType().name(), version: browser.version(), signIn, ...(signIn === 'injected' ? { signInWhy: INJECTED } : {}), layoutBox: facts.input, playwrightBoundingBox: playwrightBox, labelBox: facts.label, computed: facts.computed, drawnBox: drawn, hitTestOverInputBox: hits, togglesAtInputBoxEdges: toggles, pressedOnWhenUntoggled: pressedOn, urlAfterPress: urls };
}

const require = createRequire(import.meta.url);
const playwrightDir = path.dirname(require.resolve('playwright-core/package.json'));
const browsers = JSON.parse(fs.readFileSync(path.join(playwrightDir, 'browsers.json'), 'utf8')) as { browsers: { name: string; revision: string; browserVersion?: string }[] };
const runner = {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.version,
    playwright: (require('playwright-core/package.json') as { version: string }).version,
    webkitBuild: browsers.browsers.find((entry) => entry.name === 'webkit') ?? null,
    webkitExecutable: webkit.executablePath().split(path.sep).find((part) => /^webkit-\d+$/.test(part)) ?? webkit.executablePath(),
};

const dry = process.env.PROBE_DRY === '1';
// #1's rule: every standalone control at least 44 by 44 CSS px. `meets44` reads each box against it.
const meets44 = (box: { width: number; height: number } | null) => box !== null && box.width >= 44 - 0.01 && box.height >= 44 - 0.01;
const results: Awaited<ReturnType<typeof measure>>[] = [];
const write = (extra: Record<string, unknown>) => {
    const judged = results.map((result) => ({ ...result, target44: { layoutBox: meets44(result.layoutBox), labelBox: meets44(result.labelBox), drawnBox: meets44(result.drawnBox) } }));
    fs.writeFileSync(out, `${JSON.stringify({ measuredAt: new Date().toISOString(), threshold: 44, dry, runner, results: judged, ...extra }, null, 2)}\n`);
    return judged;
};

try {
    const fixture = await createInboxFixture();
    await openInboxItems(fixture);
    const secrets = await makeCuratorSecrets();
    const server = await startCatalogServer(fixture.root, undefined, { library: fixture.library, curator: true, env: secrets.env });
    try {
        const desktop = (preset: string) => ({ ...devices[preset], viewport: { width: 1280, height: 800 } });
        if (dry) {
            // Chromium only, both ways in, and the phone's touch path: everything the WebKit run does but launch WebKit.
            const cr = await chromium.launch();
            try {
                results.push(await measure(cr, 'chromium-desktop-1280-injected', desktop('Desktop Chrome'), server.origin, secrets.passphrase, 'injected'));
                results.push(await measure(cr, 'chromium-iphone13-injected', { ...devices['iPhone 13'] }, server.origin, secrets.passphrase, 'injected'));
                results.push(await measure(cr, 'chromium-desktop-1280-form', desktop('Desktop Chrome'), server.origin, secrets.passphrase, 'form'));
            } finally {
                await cr.close();
            }
        } else {
            const wk = await webkit.launch();
            try {
                results.push(await measure(wk, 'webkit-desktop-1280', desktop('Desktop Safari'), server.origin, secrets.passphrase, 'injected'));
                results.push(await measure(wk, 'mobile-webkit-iphone13', { ...devices['iPhone 13'] }, server.origin, secrets.passphrase, 'injected'));
            } finally {
                await wk.close();
            }
            const cr = await chromium.launch();
            try {
                results.push(await measure(cr, 'chromium-desktop-1280', desktop('Desktop Chrome'), server.origin, secrets.passphrase, 'form'));
            } finally {
                await cr.close();
            }
        }
    } finally {
        await server.stop();
        fixture.watcher.stop();
    }
} catch (error) {
    // What was measured before the failure, and why it stopped, so the artifact always says something.
    write({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    throw error;
}
console.log(JSON.stringify({ runner, results: write({}) }, null, 2));

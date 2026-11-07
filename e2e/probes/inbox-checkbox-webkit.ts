// A one-off CI probe, never merged: the Inbox row checkbox as WebKit draws it and hit-tests it, and
// Chromium for reference, on the e2e's curator fixture, against #1's 44 px target rule. It records the runner's OS and
// Playwright's WebKit build with the figures, so they say what they came from. Temp dirs live under TMPDIR, outside
// the checkout; the server listens on 127.0.0.1 only and is stopped before the end.
//
//   PROBE_DRY=1 npx tsx e2e/probes/inbox-checkbox-webkit.ts <out.json>   fixture, server and one request, then stop
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
if (!out) throw new Error('usage: measure-webkit.ts <out.json>');
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

async function measure(browser: Browser, name: string, options: BrowserContextOptions, origin: string, passphrase: string) {
    const context = await browser.newContext({ ...options, colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto(`${origin}/curation/login`);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    await page.getByLabel('Passphrase').fill(passphrase);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(`${origin}/curation`);
    await page.goto(`${origin}/curation/inbox`);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    const box = page.locator('#inbox-list input[type="checkbox"][form]').first();
    await box.scrollIntoViewIfNeeded();
    const facts = await box.evaluate((input) => {
        const label = input.closest('label') as HTMLElement;
        const r = (el: Element) => {
            const b = el.getBoundingClientRect();
            return { x: b.x, y: b.y, width: b.width, height: b.height };
        };
        const cs = getComputedStyle(input);
        return { input: r(input), label: r(label), computed: { width: cs.width, height: cs.height, appearance: cs.appearance || (cs as unknown as Record<string, string>).webkitAppearance, margin: cs.margin } };
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
    const ib = facts.input;
    const corners = [
        ['top-left', ib.x + 1, ib.y + 1],
        ['top-right', ib.x + ib.width - 1, ib.y + 1],
        ['bottom-left', ib.x + 1, ib.y + ib.height - 1],
        ['bottom-right', ib.x + ib.width - 1, ib.y + ib.height - 1],
        ['centre', ib.x + ib.width / 2, ib.y + ib.height / 2],
    ] as const;
    const toggles: Record<string, boolean> = {};
    for (const [where, x, y] of corners) {
        const before = await box.isChecked();
        if (options.hasTouch) await page.touchscreen.tap(x, y);
        else await page.mouse.click(x, y);
        toggles[where] = (await box.isChecked()) !== before;
    }
    if (await box.isChecked()) await box.uncheck();
    // No focus ring or hover in the drawn measurement: only the box itself.
    await box.evaluate((input) => (input as HTMLInputElement).blur());
    if (!options.hasTouch) await page.mouse.move(1, 1);
    const drawn = await drawnBox(page, { x: Math.max(0, facts.label.x), y: Math.max(0, facts.label.y), width: facts.label.width, height: facts.label.height });
    await page.screenshot({ path: path.join(path.dirname(out), `v2-f4-webkit-${name}.png`), clip: { x: Math.max(0, facts.label.x - 4), y: Math.max(0, facts.label.y - 4), width: facts.label.width + 200, height: facts.label.height + 8 } });
    await context.close();
    return { project: name, browser: browser.browserType().name(), version: browser.version(), layoutBox: facts.input, playwrightBoundingBox: playwrightBox, labelBox: facts.label, computed: facts.computed, drawnBox: drawn, hitTestOverInputBox: hits, togglesAtInputBoxEdges: toggles };
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
    webkitExecutable: path.basename(path.dirname(path.dirname(webkit.executablePath()))),
};

const fixture = await createInboxFixture();
await openInboxItems(fixture);
const secrets = await makeCuratorSecrets();
const server = await startCatalogServer(fixture.root, undefined, { library: fixture.library, curator: true, env: secrets.env });
const results = [];
try {
    if (process.env.PROBE_DRY === '1') {
        // Everything up to the measure: the fixture, the server, and the login page it serves.
        const login = await fetch(`${server.origin}/curation/login`);
        console.log(`dry run: ${server.origin} answered /curation/login with ${login.status}; stopping before the measure`);
        if (login.status !== 200) throw new Error(`The curator server answered ${login.status}`);
    } else {
        const wk = await webkit.launch();
        try {
            results.push(await measure(wk, 'webkit-desktop-1280', { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 } }, server.origin, secrets.passphrase));
            results.push(await measure(wk, 'mobile-webkit-iphone13', { ...devices['iPhone 13'] }, server.origin, secrets.passphrase));
        } finally {
            await wk.close();
        }
        const cr = await chromium.launch();
        try {
            results.push(await measure(cr, 'chromium-desktop-1280', { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }, server.origin, secrets.passphrase));
        } finally {
            await cr.close();
        }
    }
} finally {
    await server.stop();
    fixture.watcher.stop();
}
if (process.env.PROBE_DRY !== '1') {
    // #1's rule: every standalone control at least 44 by 44 CSS px. `meets44` reads the target, the box a click toggles.
    const meets44 = (box: { width: number; height: number } | null) => box !== null && box.width >= 44 - 0.01 && box.height >= 44 - 0.01;
    const judged = results.map((result) => ({ ...result, target44: { layoutBox: meets44(result.layoutBox), labelBox: meets44(result.labelBox), drawnBox: meets44(result.drawnBox) } }));
    fs.writeFileSync(out, `${JSON.stringify({ measuredAt: new Date().toISOString(), threshold: 44, runner, results: judged }, null, 2)}\n`);
    console.log(JSON.stringify({ runner, results: judged }, null, 2));
}

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import sharp from 'sharp';
import { makeCuratorSecrets, type TestCuratorSecrets } from '../../test/helpers/curatorSecrets';
import { HOME_OPENING, HOME_SERIES } from '../support/catalog-home';
import { createInboxFixture, openInboxItems, type InboxFixture } from '../support/curation-inbox';
import { publishHomeFixture } from '../support/homeFixture';
import { routePhotoFixtures } from '../support/test';

// Black is today's site, exactly (the owner's ruling, 2026-10-28). This renders the same pages from two builds, the
// base (PARITY_BASE_DIR: next before the themes) with today's toggle's stored `dark` and the head with `black` stored,
// on the same fixtures, a dark device and reduced motion, and diffs every pixel. A pixel may differ only inside the
// theme control's box (the control replaced the toggle, both builds' boxes ±2 px). Home with its chrome may differ by a
// raster step, at most 1 in any channel and on average at most 0.5 per channel in every 120 px band: the scrim blends
// in a different raster path once the chrome shows, with the same values (the round 2 design review). A second table
// pins the ruling on owner question 4: the head with today's stored `dark` paints Black too. The curator's header gains
// the control where the base had none, so the head's curator shots take it out of the layout and get the raster bound.
// Home's intro can't be repeated by the base itself, so it gets the base's own spread (Pair.noisy).
// At 1440x900 and 390x844, each at 1x and 2x. The visitor pages, the 404 and the error page; the legacy Gallery and its
// lightbox; the curator signed out and in, and its 503.

const BASE = process.env.PARITY_BASE_DIR;
const HEAD = process.cwd();
const OUT = path.join(HEAD, 'test-results', 'parity');
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } } as const;
const SCALES = [1, 2] as const;
// Rows go to a file as they're measured: a failed test restarts the worker, which would drop rows held in memory.
// build.ts, the global setup, starts it empty.
const ROWS = path.join(OUT, 'black-parity.rows');
const record = (row: string) => fs.appendFileSync(ROWS, `${row}\n`);

// One worker, in order, and soft checks, so one page's difference never skips the others.
test.skip(!BASE, 'Set PARITY_BASE_DIR to a built checkout of the base; CI\'s Themes job does.');

// --- Servers -----------------------------------------------------------------------------------------------------

const pinned = (process.env.PARITY_PORTS ?? '').split(',').map(Number).filter(Boolean);

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });
}

interface Server {
    origin: string;
    stop: () => Promise<void>;
}

/** `next start` from `tree`'s build on 127.0.0.1, with `env`, answering `status` on `ready`. */
async function serve(tree: string, port: number, env: Record<string, string>, ready: string, status = 200): Promise<Server> {
    const kept = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PHOTOGRAPHY_') && !name.startsWith('CURAT') && name !== 'SITE_URL'));
    const child: ChildProcess = spawn(process.execPath, [path.join(tree, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: tree,
        env: { ...kept, NODE_ENV: 'production', ALLOW_PROVISIONAL_COPY: '1', NEXT_TELEMETRY_DISABLED: '1', ...env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    const kill = (signal: NodeJS.Signals) => {
        try {
            if (child.pid) process.kill(-child.pid, signal);
        } catch {
            // Gone already.
        }
    };
    process.once('exit', () => kill('SIGKILL'));
    const stop = () =>
        new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const force = setTimeout(() => kill('SIGKILL'), 5000);
            child.once('exit', () => {
                clearTimeout(force);
                resolve();
            });
            kill('SIGTERM');
        });
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        const got = await fetch(`${origin}${ready}`).then((response) => response.status, () => 0);
        if (got === status) return { origin, stop };
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await stop();
    throw new Error(`${tree} on ${port} never answered ${status} on ${ready}:\n${output}`);
}

// --- Shots and diffs ---------------------------------------------------------------------------------------------

type Box = { x: number; y: number; w: number; h: number };
interface Shot {
    file: string;
    /** Every theme control or toggle on the page, the curator's preview frame's included, in page pixels. */
    controls: Box[];
}
interface Pair {
    /** The page, as `name` in the table. */
    name: string;
    url: string;
    /** After the load: reveal Home's chrome, scroll to the sequence, open the lightbox, hover or focus a photograph. */
    act?: (page: Page) => Promise<void>;
    /** Home's intro, at a fixed frame on a faked clock, with motion allowed. */
    intro?: boolean;
    /** Home with its chrome: the accepted raster bound instead of 0. */
    raster?: boolean;
    /** A signed-in curator page. */
    session?: boolean;
    /** The legacy Gallery, on the e2e suite's photo fixtures. */
    photos?: boolean;
    /** A page the head adds the control to, where the base had no toggle (the curator's header): the head's shot
     * takes the control out of the layout, as no JavaScript does, so the rest must match. */
    addsControl?: boolean;
    /** A page that never hydrates (the 503). */
    bare?: boolean;
    /** A page the base can't repeat pixel for pixel (Home's intro: its blurred ripples rasterize differently from one
     * load to the next at 1x). The base is shot twice, and the head may differ from the closer shot by as much as the
     * two differ from each other, or the raster bound, whichever is larger. */
    noisy?: boolean;
}

let browser: Browser;

async function shoot(origin: string, stored: string, pair: Pair, viewport: { width: number; height: number }, scale: number, tag: string, session?: string): Promise<Shot> {
    const context = await browser.newContext({ viewport, deviceScaleFactor: scale, colorScheme: 'dark', reducedMotion: pair.intro ? 'no-preference' : 'reduce' });
    if (session) await context.addCookies(JSON.parse(session).map((cookie: { name: string; value: string }) => ({ ...cookie, url: origin })));
    await context.addInitScript((value) => {
        try {
            localStorage.setItem('theme', value);
        } catch {
            // No storage.
        }
    }, stored);
    const page = await context.newPage();
    if (pair.photos) await routePhotoFixtures(page);
    if (pair.intro) {
        // Paused until the portrait has loaded, then 900 ms on: the same frame however long the load took.
        const start = new Date('2026-10-28T12:00:00Z').getTime();
        await page.clock.install({ time: start });
        await page.clock.pauseAt(start + 1);
    }
    await page.goto(`${origin}${pair.url}`, { waitUntil: pair.intro ? 'domcontentloaded' : 'load' });
    if (pair.intro) {
        await page.waitForFunction(() => [...document.images].every((image) => image.complete), undefined, { timeout: 20_000 }).catch(() => undefined);
        await page.evaluate(() => document.fonts.ready);
        await page.clock.runFor(900);
    } else {
        if (!pair.bare) await page.waitForSelector('html[data-hydrated]', { timeout: 30_000 }).catch(() => undefined);
        await page.evaluate(() => document.fonts.ready);
        if (pair.url === '/') {
            await page.waitForSelector('[data-home-badge][data-landed]:not([data-lingering])', { timeout: 20_000 }).catch(() => undefined);
        }
        await pair.act?.(page);
        await page.evaluate(async () => {
            await Promise.all([...document.images].filter((image) => !image.complete).map((image) => new Promise((resolve) => {
                image.onload = image.onerror = resolve;
                setTimeout(resolve, 4000);
            })));
            // Loaded isn't painted: a photo still decoding can draw a row short.
            await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
        });
        await page.waitForTimeout(600);
    }
    if (pair.addsControl && tag !== 'base') await page.addStyleTag({ content: '[data-theme-control]{display:none!important}' });
    // The control in the page and in any same-origin frame: today's toggle in the base, the theme control in the head.
    const controls = await page.evaluate(() => {
        const boxes: { x: number; y: number; w: number; h: number }[] = [];
        const visit = (doc: Document, dx: number, dy: number) => {
            for (const el of doc.querySelectorAll('[data-theme-control], nav button, header button')) {
                if (!el.matches('[data-theme-control]') && !/^Switch to/.test((el.textContent ?? '').trim())) continue;
                const box = el.getBoundingClientRect();
                if (box.width === 0) continue;
                boxes.push({ x: Math.floor(box.x + dx), y: Math.floor(box.y + dy), w: Math.ceil(box.width), h: Math.ceil(box.height) });
            }
            for (const frame of doc.querySelectorAll('iframe')) {
                const inner = frame.contentDocument;
                const at = frame.getBoundingClientRect();
                if (inner) visit(inner, dx + at.x + frame.clientLeft, dy + at.y + frame.clientTop);
            }
        };
        visit(document, window.scrollX, window.scrollY);
        return boxes;
    });
    const file = path.join(OUT, `${pair.name}-${viewport.width}-${scale}x-${tag}.png`);
    // The intro's CSS transitions (the portrait's rim light) run on the real clock, so they're settled for its frame.
    await page.screenshot({ path: file, fullPage: pair.session === true && pair.url.includes('publish'), animations: pair.intro ? 'disabled' : 'allow' });
    await context.close();
    return { file, controls };
}

interface Diff {
    count: number;
    maxStep: number;
    worstBandMean: number;
    box: string;
}

/** Every channel compared exactly, outside the controls' boxes (scaled to device pixels, ±2 CSS px). */
async function diff(a: Shot, b: Shot, scale: number, name: string): Promise<Diff> {
    const [left, right] = await Promise.all([a.file, b.file].map((file) => sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
    if (left.info.width !== right.info.width || left.info.height !== right.info.height) {
        return { count: Number.POSITIVE_INFINITY, maxStep: 255, worstBandMean: 255, box: `sizes differ: ${left.info.width}x${left.info.height} against ${right.info.width}x${right.info.height}` };
    }
    const { width, height } = left.info;
    const masks = [...a.controls, ...b.controls].map((box) => ({ x0: (box.x - 2) * scale, y0: (box.y - 2) * scale, x1: (box.x + box.w + 2) * scale, y1: (box.y + box.h + 2) * scale }));
    const band = 120 * scale;
    const bands = new Map<string, { sum: [number, number, number]; n: number }>();
    let count = 0;
    let maxStep = 0;
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    const mark = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 3;
            const masked = masks.some((m) => x >= m.x0 && x < m.x1 && y >= m.y0 && y < m.y1);
            const steps = [0, 1, 2].map((c) => Math.abs(left.data[i + c] - right.data[i + c]));
            for (const key of [`x${Math.floor(x / band)}`, `y${Math.floor(y / band)}`]) {
                const entry = bands.get(key) ?? { sum: [0, 0, 0], n: 0 };
                if (!masked) for (const c of [0, 1, 2]) entry.sum[c as 0 | 1 | 2] += steps[c];
                entry.n++;
                bands.set(key, entry);
            }
            const gray = Math.round((left.data[i] + left.data[i + 1] + left.data[i + 2]) / 9);
            mark[i] = mark[i + 1] = mark[i + 2] = gray;
            if (masked || Math.max(...steps) === 0) continue;
            count++;
            maxStep = Math.max(maxStep, ...steps);
            mark[i] = 255;
            mark[i + 1] = mark[i + 2] = 0;
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
    }
    const worstBandMean = Math.max(0, ...[...bands.values()].flatMap((entry) => entry.sum.map((sum) => sum / entry.n)));
    if (count > 0) await sharp(Buffer.from(mark), { raw: { width, height, channels: 3 } }).png().toFile(path.join(OUT, `${name}-diff.png`));
    const css = (v: number) => Math.round(v / scale);
    return { count, maxStep, worstBandMean, box: count ? `x ${css(x0)} to ${css(x1)}, y ${css(y0)} to ${css(y1)}` : '' };
}

// --- Pages -------------------------------------------------------------------------------------------------------

const series = `/work/${HOME_SERIES.slug}`;
const revealChrome = async (page: Page) => {
    const { width, height } = page.viewportSize()!;
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.move(width / 2 + 40, height / 2 + 10);
};
const toSequence = async (page: Page) => {
    await page.getByRole('heading', { name: 'Sequence' }).evaluate((heading) => heading.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -80));
};

const VISITOR: Pair[] = [
    { name: 'home-intro', url: '/', intro: true, noisy: true },
    { name: 'home-rest', url: '/' },
    { name: 'home-chrome', url: '/', act: revealChrome, raster: true },
    { name: 'work', url: '/work' },
    { name: 'series', url: series },
    { name: 'series-sequence', url: series, act: toSequence },
    {
        name: 'thumbnail-hover',
        url: series,
        act: async (page) => {
            await toSequence(page);
            await page.locator('section[aria-labelledby="series-sequence"] ol li a').first().hover();
        },
    },
    {
        name: 'thumbnail-focus',
        url: series,
        act: async (page) => {
            await toSequence(page);
            await page.keyboard.press('Tab');
            await page.locator('section[aria-labelledby="series-sequence"] ol li a').first().focus();
        },
    },
    { name: 'cover-hover', url: series, act: (page) => page.locator('main figure a').first().hover() },
    {
        name: 'cover-focus',
        url: series,
        act: async (page) => {
            await page.keyboard.press('Tab');
            await page.locator('main figure a').first().focus();
        },
    },
    { name: 'viewer', url: `${series}/photo/${HOME_OPENING}` },
    { name: 'about', url: '/about' },
    { name: '404', url: '/no-such-page' },
];
const LEGACY: Pair[] = [
    { name: 'gallery', url: '/gallery', photos: true },
    {
        name: 'lightbox',
        url: '/gallery',
        photos: true,
        act: async (page) => {
            // Enter, as a keyboard visitor opens it.
            await page.getByRole('button', { name: 'Photograph 1 of 12', exact: true }).focus();
            await page.keyboard.press('Enter');
            await expect(page.locator('.yarl__portal_open')).toHaveCSS('opacity', '1');
            await expect.poll(() => page.locator('.yarl__portal').evaluate((root) => root.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length)).toBe(0);
        },
    },
];
const CURATOR: Pair[] = [
    { name: 'signin', url: '/curation/login', addsControl: true },
    { name: 'inbox', url: '/curation/inbox', session: true, addsControl: true },
    { name: 'publish', url: '/curation/publish', session: true, addsControl: true },
];

/** Shoots `pair` from both, at every size and scale, and pins the diff; and, with `legacy`, the head on a stored `dark`. */
const row = (label: string, size: string, width: number, scale: number, d: Diff) =>
    record(`| ${label} | ${size} ${width} | ${scale}x | ${d.count} | ${d.maxStep} | ${d.worstBandMean.toFixed(3)} | ${d.box} |`);

/** What a pair may differ by: nothing; the raster bound; or, on a page the base can't repeat, the base's own spread. */
function bound(pair: Pair, noise: Diff | null): { maxStep: number; bandMean: number } | null {
    if (noise) return { maxStep: Math.max(1, noise.maxStep), bandMean: Math.max(0.5, noise.worstBandMean) };
    return pair.raster || pair.addsControl ? { maxStep: 1, bandMean: 0.5 } : null;
}

function expectWithin(name: string, d: Diff, limit: ReturnType<typeof bound>) {
    if (!limit) {
        expect.soft(d.count, `${name}: pixels differing outside the control (${d.box})`).toBe(0);
        return;
    }
    expect.soft(d.maxStep, `${name}: no channel steps more than ${limit.maxStep}`).toBeLessThanOrEqual(limit.maxStep);
    expect.soft(d.worstBandMean, `${name}: mean |Δ| per channel per 120 px band`).toBeLessThanOrEqual(limit.bandMean);
}

/** The closer of the head's diffs against the base's shots: with two base shots, the base's own spread can't count against the head. */
async function closest(bases: Shot[], head: Shot, scale: number, name: string): Promise<Diff> {
    const diffs = await Promise.all(bases.map((shot, index) => diff(shot, head, scale, index === 0 ? name : `${name}-against-the-second-base`)));
    return diffs.reduce((best, d) => (d.maxStep < best.maxStep || (d.maxStep === best.maxStep && d.count < best.count) ? d : best));
}

/** Shoots `pair` from both, at every size and scale, and pins the diff; and, with `legacy`, the head on a stored `dark`. */
function parity(group: string, pairs: Pair[], origins: () => { base: string; head: string }, options: { legacy?: boolean; session?: () => { base: string; head: string } } = {}) {
    for (const pair of pairs) {
        test(`${group}: ${pair.name}`, async () => {
            const { base, head } = origins();
            const cookies = pair.session ? options.session!() : undefined;
            for (const [size, viewport] of Object.entries(VIEWPORTS)) {
                for (const scale of SCALES) {
                    const name = `${pair.name}-${viewport.width}-${scale}x`;
                    const bases = [await shoot(base, 'dark', pair, viewport, scale, 'base', cookies?.base)];
                    let noise: Diff | null = null;
                    if (pair.noisy) {
                        bases.push(await shoot(base, 'dark', pair, viewport, scale, 'base-again', cookies?.base));
                        noise = await diff(bases[0], bases[1], scale, `${name}-base-against-itself`);
                        row(`${pair.name}, the base against itself`, size, viewport.width, scale, noise);
                    }
                    const limit = bound(pair, noise);
                    const result = await closest(bases, await shoot(head, 'black', pair, viewport, scale, 'head', cookies?.head), scale, name);
                    row(pair.name, size, viewport.width, scale, result);
                    expectWithin(name, result, limit);
                    if (options.legacy && scale === 1) {
                        const legacy = await closest(bases, await shoot(head, 'dark', pair, viewport, scale, 'head-legacy-dark', cookies?.head), scale, `${name}-legacy-dark`);
                        row(`${pair.name}, head on stored \`dark\``, size, viewport.width, 1, legacy);
                        expectWithin(`${name}, the head on a stored dark`, legacy, limit);
                    }
                }
            }
        });
    }
}

/** The base checkout's commit, for the report. */
function baseCommit(): string {
    const head = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: BASE, encoding: 'utf8' });
    return head.status === 0 ? head.stdout.trim() : String(BASE);
}

// --- Fixtures and rounds -----------------------------------------------------------------------------------------

let temp = '';
let siteConfig = '';
let library = '';
let visitorRoot = '';
let inbox: InboxFixture | undefined;
let secrets: TestCuratorSecrets | undefined;
const port = async (index: number) => pinned[index] ?? (await freePort());

test.beforeAll(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'themes-parity-'));
    siteConfig = path.join(temp, 'site-config');
    library = path.join(temp, 'library');
    fs.mkdirSync(siteConfig);
    fs.mkdirSync(library);
    const written = spawnSync(process.execPath, [path.join(HEAD, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'e2e/support/write-site-config.ts', siteConfig], { cwd: HEAD, encoding: 'utf8' });
    if (written.status !== 0) throw new Error(`write-site-config failed: ${written.stderr}`);
    visitorRoot = path.join(temp, 'visitor');
    await publishHomeFixture(visitorRoot);
    browser = await chromium.launch();
});

test.afterAll(async () => {
    await browser?.close();
    await inbox?.cleanup();
    secrets?.cleanup();
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
    fs.writeFileSync(
        path.join(OUT, 'black-parity.md'),
        `# Black against the base, pixel for pixel\n\nBase: \`${baseCommit()}\`. Pixels differing in any channel, outside the theme controls' boxes (the base's toggle, the head's control). The curator's header gains the control, so its head shots take it out of the layout first.\n\n| Page | Viewport | Scale | Pixels | Max step | Worst band mean | Where |\n|---|---|---|---|---|---|---|\n${fs.existsSync(ROWS) ? fs.readFileSync(ROWS, 'utf8') : ''}`,
    );
});

test.describe('the visitor site and the legacy Gallery', () => {
    const servers: Server[] = [];
    let visitor = { base: '', head: '' };
    let legacy = { base: '', head: '' };

    test.beforeAll(async () => {
        const common = { PHOTOGRAPHY_LIBRARY_DIR: library, PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig };
        const catalog = { ...common, PHOTOGRAPHY_DATA_DIR: visitorRoot };
        const [a, b, c, d] = [await port(0), await port(1), await port(2), await port(3)];
        const started = await Promise.all([serve(BASE!, a, catalog, '/api/ready'), serve(HEAD, b, catalog, '/api/ready'), serve(BASE!, c, common, '/'), serve(HEAD, d, common, '/')]);
        servers.push(...started);
        visitor = { base: started[0].origin, head: started[1].origin };
        legacy = { base: started[2].origin, head: started[3].origin };
    });

    test.afterAll(async () => {
        await Promise.all(servers.map((server) => server.stop()));
    });

    parity('visitor', VISITOR, () => visitor, { legacy: true });
    parity('legacy', LEGACY, () => legacy, { legacy: true });

    // Once, for the record (R2-P2-2): with the scrim on a layer of its own in both builds, does Home's raster step go?
    test('diagnosis: Home with its chrome, with the scrim on its own layer', async () => {
        const pair: Pair = {
            name: 'home-chrome-will-change',
            url: '/',
            act: async (page) => {
                await page.addStyleTag({ content: '[class*=vignette]{will-change:transform}' });
                await revealChrome(page);
            },
        };
        const viewport = VIEWPORTS.desktop;
        const result = await diff(await shoot(visitor.base, 'dark', pair, viewport, 1, 'base'), await shoot(visitor.head, 'black', pair, viewport, 1, 'head'), 1, 'home-chrome-will-change');
        record(`| home-chrome, the scrim on its own layer (diagnosis) | desktop 1440 | 1x | ${result.count} | ${result.maxStep} | ${result.worstBandMean.toFixed(3)} | ${result.box} |`);
        test.info().annotations.push({ type: 'diagnosis', description: `${result.count} pixels differ, max step ${result.maxStep}` });
    });
});

test.describe('the curator and its 503', () => {
    const servers: Server[] = [];
    let curator = { base: '', head: '' };
    let broken = { base: '', head: '' };
    const cookies = { base: '', head: '' };

    test.beforeAll(async () => {
        inbox = await createInboxFixture();
        await openInboxItems(inbox);
        secrets = await makeCuratorSecrets();
        const [a, b, c, d] = [await port(0), await port(1), await port(2), await port(3)];
        const env = (listen: number, secretEnv: Record<string, string>) => ({
            PHOTOGRAPHY_LIBRARY_DIR: inbox!.library,
            PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig,
            PHOTOGRAPHY_DATA_DIR: inbox!.root,
            CURATION_ENABLED: 'true',
            CURATOR_TUNNEL_PORT: String(listen),
            ...secretEnv,
        });
        const missing = { CURATOR_PASSPHRASE_HASH_FILE: path.join(temp, 'no-such.hash'), CURATOR_SESSION_SECRET_FILE: path.join(temp, 'no-such.key') };
        const started = await Promise.all([
            serve(BASE!, a, env(a, secrets.env), '/curation/login'),
            serve(HEAD, b, env(b, secrets.env), '/curation/login'),
            serve(BASE!, c, env(c, missing), '/curation/login', 503),
            serve(HEAD, d, env(d, missing), '/curation/login', 503),
        ]);
        servers.push(...started);
        curator = { base: started[0].origin, head: started[1].origin };
        broken = { base: started[2].origin, head: started[3].origin };
        // One session per server, signed in through its own form, as the owner does.
        for (const which of ['base', 'head'] as const) {
            const context = await browser.newContext();
            const page = await context.newPage();
            await page.goto(`${curator[which]}/curation/login`);
            await page.waitForSelector('html[data-hydrated]');
            await page.getByLabel('Passphrase').fill(secrets.passphrase);
            await page.getByRole('button', { name: 'Sign in' }).click();
            await page.waitForURL(`${curator[which]}/curation`);
            cookies[which] = JSON.stringify((await context.cookies()).map(({ name, value }) => ({ name, value })));
            await context.close();
        }
    });

    test.afterAll(async () => {
        await Promise.all(servers.map((server) => server.stop()));
    });

    parity('curator', CURATOR, () => curator, { legacy: true, session: () => cookies });
    parity('curator', [{ name: '503', url: '/curation/login', bare: true }], () => broken, { legacy: true });
});

test.describe('the error page', () => {
    const servers: Server[] = [];
    let failing = { base: '', head: '' };

    test.beforeAll(async () => {
        // A catalog whose active pointer is damaged: the site has cut over and can't read it, so a page throws and the
        // visitor gets app/error.tsx.
        const root = path.join(temp, 'damaged');
        fs.mkdirSync(path.join(root, 'catalog', 'active'), { recursive: true });
        fs.writeFileSync(path.join(root, 'catalog', 'active', 'v1.json'), 'not a pointer');
        const env = { PHOTOGRAPHY_LIBRARY_DIR: library, PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig, PHOTOGRAPHY_DATA_DIR: root };
        const [a, b] = [await port(0), await port(1)];
        const started = await Promise.all([serve(BASE!, a, env, '/work', 500), serve(HEAD, b, env, '/work', 500)]);
        servers.push(...started);
        failing = { base: started[0].origin, head: started[1].origin };
    });

    test.afterAll(async () => {
        await Promise.all(servers.map((server) => server.stop()));
    });

    parity('visitor', [{ name: 'error', url: '/work' }], () => failing, { legacy: true });
});

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

// Black is today's site, exactly (the owner's ruling, 2026-10-28). This renders the same pages from two builds, the
// base (PARITY_BASE_DIR: next before the themes) with today's toggle's stored `dark` and the head with `black` stored,
// on the same fixtures, a dark device and reduced motion, and diffs every pixel. A pixel may differ only inside the
// theme control's box (the control replaced the toggle, both builds' boxes ±2 px). Home with its chrome may differ by a
// raster step, at most 1 in any channel and on average at most 0.5 per channel in every 120 px band: the scrim blends
// in a different raster path once the chrome shows, with the same values (the round 2 design review). A second table
// pins the ruling on owner question 4: the head with today's stored `dark` paints Black too.
// At 1440x900 and 390x844, each at 1x and 2x.

const BASE = process.env.PARITY_BASE_DIR;
const HEAD = process.cwd();
const OUT = path.join(HEAD, 'test-results', 'parity');
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } } as const;
const SCALES = [1, 2] as const;
const report: string[] = [];

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
    control: Box | null;
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
    if (pair.intro) await page.clock.install({ time: new Date('2026-10-28T12:00:00Z') });
    await page.goto(`${origin}${pair.url}`, { waitUntil: pair.intro ? 'domcontentloaded' : 'load' });
    if (pair.intro) {
        await page.clock.runFor(900);
    } else {
        await page.waitForSelector('html[data-hydrated]', { timeout: 30_000 }).catch(() => undefined);
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
        });
        await page.waitForTimeout(600);
    }
    const control = await page.evaluate(() => {
        const button = [...document.querySelectorAll('nav button, header button')].find((el) => /^(Switch to|Theme)/.test((el.textContent ?? '').trim()));
        const box = button?.getBoundingClientRect();
        return box ? { x: Math.floor(box.x), y: Math.floor(box.y), w: Math.ceil(box.width), h: Math.ceil(box.height) } : null;
    });
    const file = path.join(OUT, `${pair.name}-${viewport.width}-${scale}x-${tag}.png`);
    // The intro's CSS transitions (the portrait's rim light) run on the real clock, so they're settled for its frame.
    await page.screenshot({ path: file, fullPage: pair.session === true && pair.url.includes('publish'), animations: pair.intro ? 'disabled' : 'allow' });
    await context.close();
    return { file, control };
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
    const masks = [a.control, b.control].filter((box): box is Box => box !== null).map((box) => ({ x0: (box.x - 2) * scale, y0: (box.y - 2) * scale, x1: (box.x + box.w + 2) * scale, y1: (box.y + box.h + 2) * scale }));
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
    { name: 'home-intro', url: '/', intro: true },
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
            await page.locator('main ul li a').first().hover();
        },
    },
    {
        name: 'thumbnail-focus',
        url: series,
        act: async (page) => {
            await toSequence(page);
            await page.keyboard.press('Tab');
            await page.locator('main ul li a').first().focus();
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
    { name: 'gallery', url: '/gallery' },
    {
        name: 'lightbox',
        url: '/gallery',
        act: async (page) => {
            await page.locator('main [data-tooltip], main button, main a').first().focus();
            await page.keyboard.press('Enter');
            await expect(page.locator('.yarl__portal_open')).toHaveCSS('opacity', '1');
            await expect.poll(() => page.locator('.yarl__portal').evaluate((root) => root.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length)).toBe(0);
        },
    },
];
const CURATOR: Pair[] = [
    { name: 'signin', url: '/curation/login' },
    { name: 'inbox', url: '/curation/inbox', session: true },
    { name: 'publish', url: '/curation/publish', session: true },
];

/** Shoots `pair` from both, at every size and scale, and pins the diff; and, with `legacy`, the head on a stored `dark`. */
function parity(group: string, pairs: Pair[], origins: () => { base: string; head: string }, options: { legacy?: boolean; session?: () => { base: string; head: string } } = {}) {
    for (const pair of pairs) {
        test(`${group}: ${pair.name}`, async () => {
            const { base, head } = origins();
            const cookies = pair.session ? options.session!() : undefined;
            for (const [size, viewport] of Object.entries(VIEWPORTS)) {
                for (const scale of SCALES) {
                    const before = await shoot(base, 'dark', pair, viewport, scale, 'base', cookies?.base);
                    const after = await shoot(head, 'black', pair, viewport, scale, 'head', cookies?.head);
                    const name = `${pair.name}-${viewport.width}-${scale}x`;
                    const result = await diff(before, after, scale, name);
                    report.push(`| ${pair.name} | ${size} ${viewport.width} | ${scale}x | ${result.count} | ${result.maxStep} | ${result.worstBandMean.toFixed(3)} | ${result.box} |`);
                    if (pair.raster) {
                        expect.soft(result.maxStep, `${name}: no channel steps more than 1`).toBeLessThanOrEqual(1);
                        expect.soft(result.worstBandMean, `${name}: mean |Δ| per channel per 120 px band`).toBeLessThanOrEqual(0.5);
                    } else {
                        expect.soft(result.count, `${name}: pixels differing outside the control (${result.box})`).toBe(0);
                    }
                    if (options.legacy && scale === 1) {
                        const legacy = await shoot(head, 'dark', pair, viewport, scale, 'head-legacy-dark', cookies?.head);
                        const legacyResult = await diff(before, legacy, scale, `${name}-legacy-dark`);
                        report.push(`| ${pair.name}, head on stored \`dark\` | ${size} ${viewport.width} | 1x | ${legacyResult.count} | ${legacyResult.maxStep} | ${legacyResult.worstBandMean.toFixed(3)} | ${legacyResult.box} |`);
                        if (pair.raster) expect.soft(legacyResult.maxStep, `${name}: the head on a stored dark`).toBeLessThanOrEqual(1);
                        else expect.soft(legacyResult.count, `${name}: the head on a stored dark`).toBe(0);
                    }
                }
            }
        });
    }
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
        `# Black against the base, pixel for pixel\n\nBase: \`${BASE}\`. Pixels differing in any channel, outside the theme control's box.\n\n| Page | Viewport | Scale | Pixels | Max step | Worst band mean | Where |\n|---|---|---|---|---|---|---|\n${report.join('\n')}\n`,
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
        report.push(`| home-chrome, the scrim on its own layer (diagnosis) | desktop 1440 | 1x | ${result.count} | ${result.maxStep} | ${result.worstBandMean.toFixed(3)} | ${result.box} |`);
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
    parity('curator', [{ name: '503', url: '/curation/login' }], () => broken, { legacy: true });
});

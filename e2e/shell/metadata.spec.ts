import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { expect, test } from '../support/test';

// Each describe starts its own `next start` on a free port from the build the
// harness made, so SITE_URL reaches that process only, never the build. It
// serves #1's empty photo library, like the harness's own server.

test.skip(({ isMobile }) => isMobile, 'The desktop project covers it.');
test.describe.configure({ mode: 'serial' });

const SITE_NAME = 'Keyur Golani Photography';
/** How long a server gets to answer, and to exit before it's killed. */
const READY_TIMEOUT = 30_000;
const STOP_TIMEOUT = 5_000;
/** Above both, so a slow start fails in startServer, which stops its child, not in the hook's own timeout. */
const HOOK_TIMEOUT = READY_TIMEOUT + STOP_TIMEOUT + 15_000;

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
    output: () => string;
    stop: () => Promise<void>;
}

async function startServer(siteUrl: string | undefined): Promise<Server> {
    const library = process.env.E2E_EMPTY_LIBRARY;
    if (!library) throw new Error('playwright.config.ts sets E2E_EMPTY_LIBRARY, so the server never reads a real photo library');
    const port = await freePort();
    // ALLOW_PROVISIONAL_COPY as in playwright.config.ts: /about runs the copy gate per request too.
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', PHOTOGRAPHY_LIBRARY_DIR: library, ALLOW_PROVISIONAL_COPY: '1' };
    delete env.SITE_URL;
    if (siteUrl) env.SITE_URL = siteUrl;
    const next = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
    // Its own process group, so stopping it also stops any process it starts.
    const child = spawn(process.execPath, [next, 'start', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: process.cwd(), env, detached: true });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const signal = (name: NodeJS.Signals) => {
        try {
            if (child.pid) process.kill(-child.pid, name);
        } catch {
            // The group is already gone.
        }
    };
    const stop = () =>
        new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const force = setTimeout(() => signal('SIGKILL'), STOP_TIMEOUT);
            child.once('exit', () => {
                clearTimeout(force);
                resolve();
            });
            signal('SIGTERM');
        });
    const origin = `http://127.0.0.1:${port}`;
    try {
        await expect
            .poll(async () => {
                try {
                    return (await fetch(`${origin}/api/photos`)).status;
                } catch {
                    return 0;
                }
            }, { timeout: READY_TIMEOUT })
            .toBe(200);
    } catch (error) {
        // No hook gets the server back to stop it, so a failed start stops its own.
        await stop();
        throw error;
    }
    return { origin, output: () => output, stop };
}

/** The content of the first `<meta>` with `property` or `name`. */
const meta = (html: string, key: string) => new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html)?.[1];
/** The icon links in `html`, resolved against `origin`. */
const iconLinks = (html: string, origin: string) =>
    [...html.matchAll(/<link rel="(icon|apple-touch-icon)" href="([^"]+)"/g)].map(([, rel, href]) => ({ rel, url: new URL(href.replaceAll('&amp;', '&'), origin) }));

test.describe('with SITE_URL set for this server only', () => {
    let server: Server;
    test.beforeAll(async () => {
        test.setTimeout(HOOK_TIMEOUT);
        server = await startServer('https://example.test');
    });
    test.afterAll(async () => {
        test.setTimeout(HOOK_TIMEOUT);
        await server?.stop();
    });

    for (const [route, title] of [
        ['/', SITE_NAME],
        ['/gallery', `Gallery · ${SITE_NAME}`],
        ['/about', `About · ${SITE_NAME}`],
        ['/does-not-exist', `Page not found · ${SITE_NAME}`],
    ] as const) {
        test(`${route} has its title and an absolute share image`, async ({ request }) => {
            const html = await (await request.get(`${server.origin}${route}`)).text();
            expect(html).toContain(`<title>${title}</title>`);
            expect(meta(html, 'og:image')).toMatch(/^https:\/\/example\.test\//);
            expect(meta(html, 'og:image:alt')).toBe(SITE_NAME);
            expect(meta(html, 'og:site_name')).toBe(SITE_NAME);
            expect(meta(html, 'twitter:card')).toBe('summary_large_image');
        });
    }

    test('the icons and the 1200 by 630 share image are real files of the right types', async ({ request }) => {
        const html = await (await request.get(`${server.origin}/about`)).text();
        const ogImage = new URL(meta(html, 'og:image') ?? '');
        expect([meta(html, 'og:image:width'), meta(html, 'og:image:height')]).toEqual(['1200', '630']);
        const links = iconLinks(html, server.origin);
        const files = [
            ['the share image', new URL(`${ogImage.pathname}${ogImage.search}`, server.origin), 'image/png'],
            ['the icon', links.find(({ rel, url }) => rel === 'icon' && url.pathname === '/icon.svg')?.url, 'image/svg+xml'],
            ['the Apple touch icon', links.find(({ rel }) => rel === 'apple-touch-icon')?.url, 'image/png'],
            ['/favicon.ico', new URL('/favicon.ico', server.origin), 'image/x-icon'],
        ] as const;
        for (const [name, url, type] of files) {
            expect(url, `${name} is linked`).toBeDefined();
            const response = await request.get(String(url));
            expect(response.status(), name).toBe(200);
            expect(response.headers()['content-type'], name).toContain(type);
            expect((await response.body()).length, `${name} isn't empty`).toBeGreaterThan(0);
        }
    });
});

test.describe('with SITE_URL unset', () => {
    let server: Server;
    test.beforeAll(async () => {
        test.setTimeout(HOOK_TIMEOUT);
        server = await startServer(undefined);
    });
    test.afterAll(async () => {
        test.setTimeout(HOOK_TIMEOUT);
        await server?.stop();
    });

    const warnings = () => server.output().match(/SITE_URL/g)?.length ?? 0;

    test('the server logs one warning at startup, still one after page requests, and share URLs fall back to localhost', async ({ request }) => {
        // Readiness only asked /api/photos, so a warning now came from startup, not from rendering a page.
        await expect.poll(warnings, { timeout: 5_000 }).toBe(1);
        expect(server.output()).toContain("SITE_URL isn't set, so share links point at http://localhost:3000.");
        const html = await (await request.get(`${server.origin}/about`)).text();
        expect(meta(html, 'og:image')).toMatch(/^http:\/\/localhost:3000\//);
        for (const route of ['/', '/gallery', '/does-not-exist']) await request.get(`${server.origin}${route}`);
        expect(warnings()).toBe(1);
    });
});

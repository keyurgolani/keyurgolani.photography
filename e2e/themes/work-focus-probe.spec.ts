import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Browser } from '@playwright/test';
import sharp from 'sharp';
import { publishHomeFixture } from '../support/homeFixture';

// A one-off probe, never merged, for the Dark parity decision on Work's entry reveal: Dark parity's work-focus state
// (a key press, then focus in place on the first entry's link) at 1440 by 900, in the base and the head, in Dark's
// two routes, System on a dark device and a stored `dark`, at 1x and 2x. For each it saves the viewport and a crop of
// the focused entry with 30 px round it, and writes the page's scroll, the entry's box, the ring's paint, and the
// ring's contrast against the colours outside and inside it, sampled from the shot along each edge, to
// test-results/parity/work-focus-probe/. It deletes nothing: its temp folder stays for the runner, which is thrown
// away whole.

const BASE = process.env.PARITY_BASE_DIR;
const HEAD = process.cwd();
const OUT = path.join(HEAD, 'test-results', 'parity', 'work-focus-probe');
const VIEWPORT = { width: 1440, height: 900 };

if (!BASE && process.env.CI) throw new Error('PARITY_BASE_DIR is required in CI.');
test.skip(!BASE, 'Set PARITY_BASE_DIR to a built checkout of the base.');

interface Server {
    origin: string;
    stop: () => Promise<void>;
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as net.AddressInfo;
            probe.close(() => resolve(port));
        });
    });
}

/** `next start` from `tree`'s build on 127.0.0.1, ready once /api/ready answers 200. */
async function serve(tree: string, env: Record<string, string>): Promise<Server> {
    const port = await freePort();
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
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        const got = await fetch(`${origin}/api/ready`).then((response) => response.status, () => 0);
        if (got === 200) return { origin, stop };
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await stop();
    throw new Error(`${tree} on ${port} never answered 200 on /api/ready:\n${output}`);
}

type Rgb = [number, number, number];
const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a: Rgb, b: Rgb) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};
const hex = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

let temp = '';
let browser: Browser | undefined;
const servers: Server[] = [];
const origins: Record<'base' | 'head', string> = { base: '', head: '' };
const results: unknown[] = [];

test.beforeAll(async ({ playwright }) => {
    test.setTimeout(5 * 60_000);
    fs.mkdirSync(OUT, { recursive: true });
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'work-focus-probe-'));
    const siteConfig = path.join(temp, 'site-config');
    const library = path.join(temp, 'library');
    fs.mkdirSync(siteConfig);
    fs.mkdirSync(library);
    const written = spawnSync(process.execPath, [path.join(HEAD, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'e2e/support/write-site-config.ts', siteConfig], { cwd: HEAD, encoding: 'utf8' });
    if (written.status !== 0) throw new Error(`write-site-config failed: ${written.stderr}`);
    const visitorRoot = path.join(temp, 'visitor');
    await publishHomeFixture(visitorRoot);
    const env = { PHOTOGRAPHY_LIBRARY_DIR: library, PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig, PHOTOGRAPHY_DATA_DIR: visitorRoot };
    const [base, head] = await Promise.all([serve(BASE!, env), serve(HEAD, env)]);
    servers.push(base, head);
    origins.base = base.origin;
    origins.head = head.origin;
    browser = await playwright.chromium.launch();
});

test.afterAll(async () => {
    await browser?.close();
    await Promise.all(servers.map((server) => server.stop()));
    fs.writeFileSync(path.join(OUT, 'work-focus-probe.json'), JSON.stringify(results, null, 2));
});

for (const build of ['base', 'head'] as const) {
    for (const route of [
        { name: 'system-dark', stored: '' },
        { name: 'stored-dark', stored: 'dark' },
    ]) {
        for (const scale of [1, 2]) {
            test(`work-focus at 1440 by 900, ${build}, ${route.name}, ${scale}x`, async () => {
                const context = await browser!.newContext({ viewport: VIEWPORT, deviceScaleFactor: scale, colorScheme: 'dark', reducedMotion: 'reduce' });
                await context.addInitScript((value) => {
                    try {
                        if (value) localStorage.setItem('theme', value);
                    } catch {
                        // No storage.
                    }
                }, route.stored);
                const page = await context.newPage();
                await page.goto(`${origins[build]}/work`);
                await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
                await page.evaluate(async () => {
                    await document.fonts.ready;
                    await Promise.all(
                        [...document.images].map((img) =>
                            img.complete
                                ? Promise.resolve()
                                : new Promise((done) => {
                                      img.addEventListener('load', done, { once: true });
                                      img.addEventListener('error', done, { once: true });
                                  }),
                        ),
                    );
                    await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
                });
                const rest = await page.evaluate(() => window.scrollY);
                // Dark parity's act: a key press, so the focus is :focus-visible, then focus in place.
                await page.keyboard.press('Shift');
                const link = page.getByRole('main').locator('ul > li a').first();
                await link.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
                expect(await link.evaluate((element) => element.matches(':focus-visible')), 'the focused link shows its ring').toBe(true);
                await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 300)))));
                const ring = await link.evaluate((element) => {
                    const px = (value: string) => parseFloat(value) || 0;
                    const rect = (r: DOMRect) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
                    const after = getComputedStyle(element, '::after');
                    const onAfter = after.content !== 'none' && after.outlineStyle !== 'none';
                    const style = onAfter ? after : getComputedStyle(element);
                    // The border edge the ring is drawn from: the ::after's, from its containing block less its insets, or the link's own.
                    let edge = rect(element.getBoundingClientRect());
                    if (onAfter) {
                        let block: Element | null = element;
                        while (block && getComputedStyle(block).position === 'static') block = block.parentElement;
                        const b = (block ?? document.documentElement) as HTMLElement;
                        const r = b.getBoundingClientRect();
                        const pad = { left: r.left + b.clientLeft, top: r.top + b.clientTop, right: r.left + b.clientLeft + b.clientWidth, bottom: r.top + b.clientTop + b.clientHeight };
                        edge = { top: pad.top + px(after.top), bottom: pad.bottom - px(after.bottom), left: pad.left + px(after.left), right: pad.right - px(after.right) };
                    }
                    const offset = px(style.outlineOffset);
                    const width = style.outlineStyle === 'none' ? 0 : px(style.outlineWidth);
                    const shadow = (style.boxShadow.match(/rgba?\([^)]*\)[^,]*/) ?? [''])[0];
                    const lengths = (shadow.match(/-?[\d.]+px/g) ?? []).map(px);
                    const spread = lengths[3] ?? 0;
                    const inset = /inset/.test(shadow);
                    const li = element.closest('li')!;
                    return {
                        host: onAfter ? '::after' : 'the link',
                        edge,
                        li: rect(li.getBoundingClientRect()),
                        outline: { color: style.outlineColor, style: style.outlineStyle, width, offset },
                        band: { shadow, spread, inset },
                        scrollY: window.scrollY,
                        theme: document.documentElement.dataset.theme ?? null,
                        ground: getComputedStyle(element.closest('main')!).backgroundColor,
                    };
                });
                // Depths are outward from the edge. The outline paints over the band where they meet.
                const light: [number, number] = [ring.outline.offset, ring.outline.offset + ring.outline.width];
                const dark: [number, number] = ring.band.inset ? [-ring.band.spread, 0] : [0, ring.band.spread];
                const darkSeen: [number, number] = light[1] >= dark[1] && light[0] < dark[1] ? [dark[0], Math.max(dark[0], light[0])] : light[0] <= dark[0] && light[1] > dark[0] ? [Math.min(dark[1], light[1]), dark[1]] : dark;
                const outer = Math.max(light[1], darkSeen[1]);
                const inner = Math.min(light[0], darkSeen[0]);
                const depths = { outside: outer + 2, light: (light[0] + light[1]) / 2, dark: (darkSeen[0] + darkSeen[1]) / 2, inside: inner - 3 };
                const shot = await page.screenshot();
                const { data, info } = await sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
                const at = (x: number, y: number): Rgb | null => {
                    const ix = Math.floor(x * scale);
                    const iy = Math.floor(y * scale);
                    if (ix < 0 || iy < 0 || ix >= info.width || iy >= info.height) return null;
                    const o = (iy * info.width + ix) * 3;
                    return [data[o], data[o + 1], data[o + 2]];
                };
                const e = ring.edge;
                const along = {
                    top: (t: number, d: number) => [e.left + t * (e.right - e.left), e.top - d] as const,
                    bottom: (t: number, d: number) => [e.left + t * (e.right - e.left), e.bottom + d] as const,
                    left: (t: number, d: number) => [e.left - d, e.top + t * (e.bottom - e.top)] as const,
                    right: (t: number, d: number) => [e.right + d, e.top + t * (e.bottom - e.top)] as const,
                };
                const edges: Record<string, unknown> = {};
                for (const [side, point] of Object.entries(along)) {
                    const rows: Record<keyof typeof depths, Rgb>[] = [];
                    for (let i = 0; i < 19; i++) {
                        const t = 0.1 + (0.8 * i) / 18;
                        const sample = Object.fromEntries(Object.entries(depths).map(([k, d]) => [k, at(...point(t, d))]));
                        if (Object.values(sample).some((v) => v === null)) continue;
                        rows.push(sample as Record<keyof typeof depths, Rgb>);
                    }
                    if (rows.length === 0) {
                        edges[side] = 'off screen';
                        continue;
                    }
                    const pair = (a: keyof typeof depths, b: keyof typeof depths) => {
                        const values = rows.map((row) => contrast(row[a], row[b]));
                        return { min: +Math.min(...values).toFixed(2), max: +Math.max(...values).toFixed(2) };
                    };
                    edges[side] = {
                        samples: rows.length,
                        colours: Object.fromEntries(Object.keys(depths).map((k) => [k, [...new Set(rows.map((row) => hex(row[k as keyof typeof depths])))].slice(0, 8)])),
                        'light against outside': pair('light', 'outside'),
                        'dark against inside': pair('dark', 'inside'),
                        'light against dark': pair('light', 'dark'),
                        'light against inside': pair('light', 'inside'),
                        'dark against outside': pair('dark', 'outside'),
                    };
                }
                const name = `${build}-${route.name}-${scale}x`;
                fs.writeFileSync(path.join(OUT, `${name}-viewport.png`), shot);
                const grow = 30;
                const clip = { left: Math.max(0, ring.li.left - grow), top: Math.max(0, ring.li.top - grow), right: Math.min(VIEWPORT.width, ring.li.right + grow), bottom: Math.min(VIEWPORT.height, ring.li.bottom + grow) };
                await page.screenshot({ path: path.join(OUT, `${name}-entry.png`), clip: { x: clip.left, y: clip.top, width: clip.right - clip.left, height: clip.bottom - clip.top } });
                const result = { name, build, route: route.name, scale, rest, ...ring, depths, edges, clip };
                fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(result, null, 2));
                results.push(result);
                await context.close();
            });
        }
    }
}

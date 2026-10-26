// @vitest-environment node
/**
 * `npm run test:prod` builds, then runs this against a copy of
 * .next/standalone, like activation.test.ts. Plain `npm test` skips it
 * unless RUN_PROD_TESTS=1.
 *
 * The owner, 2026-10-25: "I want the about photo to be configured from the
 * directory where the website is deployed and not committed to the github
 * repository." So one server process, pointed at a temp site config folder,
 * has to log why About has no portrait at start, then show a portrait put
 * there afterwards, follow a swap to new content-hashed URLs, and go back to
 * the name panel once the file is gone, all with no restart and no 500. The
 * build itself must hold no portrait for About.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leakyJpeg, PRIVATE_VALUES } from '../fixtures/exif';

const STANDALONE = path.resolve(import.meta.dirname, '../../.next/standalone');
const PORTRAIT_URL = /\/about\/portrait\/([0-9a-f]{32})\/w1200\.webp/;

async function freePort(): Promise<number> {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address() as net.AddressInfo;
    probe.close();
    await once(probe, 'close');
    return port;
}

describe.skipIf(process.env.RUN_PROD_TESTS !== '1')("About's portrait from the host", () => {
    let served = '';
    let siteConfig = '';
    let library = '';
    let child: ChildProcess | undefined;
    let output = '';
    let base = '';

    const about = (name: string) => path.join(siteConfig, 'about', name);
    const page = async () => {
        const response = await fetch(`${base}/about`);
        return { status: response.status, html: await response.text() };
    };

    beforeAll(async () => {
        served = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-test-about-'));
        fs.cpSync(STANDALONE, served, { recursive: true, verbatimSymlinks: true });
        siteConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-test-site-config-'));
        library = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-test-library-'));
        const port = await freePort();
        base = `http://127.0.0.1:${port}`;
        const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PHOTOGRAPHY_')));
        child = spawn(process.execPath, ['server.js'], {
            cwd: served,
            env: { ...env, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1', PHOTOGRAPHY_LIBRARY_DIR: library, PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.on('data', (chunk) => (output += chunk));
        child.stderr?.on('data', (chunk) => (output += chunk));
        const deadline = Date.now() + 60_000;
        for (;;) {
            if (child.exitCode !== null) throw new Error(`The server exited with ${child.exitCode}:\n${output}`);
            try {
                await (await fetch(`${base}/api/health`)).arrayBuffer();
                break;
            } catch {
                // Not listening yet.
            }
            if (Date.now() > deadline) throw new Error(`The server did not answer within 60 s:\n${output}`);
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }, 90_000);

    afterAll(async () => {
        if (child && child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill();
            await exited;
        }
        for (const dir of [served, siteConfig, library]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('builds no portrait for About: the standalone output holds no site config folder', () => {
        expect(fs.existsSync(path.join(STANDALONE, 'site-config'))).toBe(false);
    });

    it('logs once at start why About has no portrait, naming no absolute path, and serves the name panel', async () => {
        const { status, html } = await page();
        expect(status).toBe(200);
        expect(html).not.toMatch(PORTRAIT_URL);
        expect(html).toContain('data-testid="about-portrait"');
        // No portrait from the build either: no static media copy and no optimizer URL.
        expect(html).not.toMatch(/_next\/static\/media\/[^"]+\.(png|jpe?g|webp)|_next\/image/);
        const lines = output.split('\n').filter((line) => line.includes('[about]'));
        expect(lines).toEqual(['[about] No portrait: about/ does not exist, so About shows the name instead.']);
        expect(output).not.toContain(siteConfig);
    });

    it('shows a portrait put there afterwards, with no restart, upright and stripped of its GPS EXIF', async () => {
        const { jpeg } = await leakyJpeg();
        fs.mkdirSync(path.join(siteConfig, 'about'));
        fs.writeFileSync(about('portrait.jpg'), await sharp(await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toBuffer()).withMetadata({ orientation: 6 }).jpeg().toBuffer());
        fs.writeFileSync(about('portrait.json'), JSON.stringify({ alt: 'The stand-in portrait', focalPoint: { x: 50, y: 30 } }));
        const { status, html } = await page();
        expect(status).toBe(200);
        const url = PORTRAIT_URL.exec(html)?.[0];
        expect(url).toBeDefined();
        expect(html).toContain('alt="The stand-in portrait"');
        expect(html).toMatch(/width="600" height="900"/);
        const response = await fetch(`${base}${url}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        const body = Buffer.from(await response.arrayBuffer());
        const metadata = await sharp(body).metadata();
        expect({ format: metadata.format, width: metadata.width, height: metadata.height, exif: metadata.exif }).toEqual({ format: 'webp', width: 600, height: 900, exif: undefined });

        // Now one that carries GPS, serials, XMP, and IPTC.
        fs.writeFileSync(about('portrait.jpg'), jpeg);
        const leaky = PORTRAIT_URL.exec((await page()).html)?.[0];
        expect(leaky).toBeDefined();
        expect(leaky).not.toBe(url);
        // The swapped-out portrait stops answering at once.
        const old = await fetch(`${base}${url}`);
        expect(old.status).toBe(404);
        expect(old.headers.get('cache-control')).toBe('no-store');
        const stripped = Buffer.from(await (await fetch(`${base}${leaky}`)).arrayBuffer());
        expect((await sharp(stripped).metadata()).exif).toBeUndefined();
        for (const value of [...Object.values(PRIVATE_VALUES), 'GPS']) expect(stripped.toString('latin1')).not.toContain(value);
    });

    it('goes back to the name panel once the file is gone, and 404s the old URL as no-store, never a 500', async () => {
        const before = PORTRAIT_URL.exec((await page()).html)?.[1];
        fs.rmSync(about('portrait.jpg'));
        const { status, html } = await page();
        expect(status).toBe(200);
        expect(html).not.toMatch(PORTRAIT_URL);
        expect(before).toMatch(/^[0-9a-f]{32}$/);
        for (const token of [before, '0'.repeat(32)]) {
            const response = await fetch(`${base}/about/portrait/${token}/w800.webp`);
            expect(response.status, token).toBe(404);
            expect(response.headers.get('cache-control')).toBe('no-store');
        }
        expect(output).toContain('[about] No portrait: there is no about/portrait.jpg, .jpeg, .png, or .webp, so About shows the name instead.');
        expect(output).not.toContain(siteConfig);
    });
});

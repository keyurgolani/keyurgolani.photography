// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import exifReader from 'exif-reader';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEPT_VALUES, leakyJpeg, PRIVATE_VALUES } from '../../../test/fixtures/exif';
import { assertOutsideRepository } from '../../../test/helpers/tempDataRoot';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../identity/variants';
import { readAboutPortrait, resetAboutPortraitReader } from '../aboutPortrait';
import { SITE_CONFIG_ENV } from '../dir';
import { aboutPortraitView, createPortraitHandler, portraitUrl, portraitVariant, resetPortraitVariants } from '../portraitVariants';

let root: string;
const quiet = { log: () => undefined, warn: () => undefined };
const about = (...parts: string[]) => path.join(root, 'about', ...parts);

function put(name: string, data: Buffer | string): void {
    fs.mkdirSync(about(), { recursive: true });
    fs.writeFileSync(about(name), data);
}

async function jpeg(width = 900, height = 1200, color = { r: 180, g: 120, b: 60 }): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}

async function currentToken(): Promise<string> {
    const portrait = await readAboutPortrait({ logger: quiet });
    if (portrait.state !== 'ready') throw new Error(`no portrait: ${portrait.reason}`);
    return portrait.token;
}

const handler = createPortraitHandler({ logger: quiet });
const get = (url: string, headers: Record<string, string> = {}) => {
    const [, , , token, variant] = new URL(url, 'http://test').pathname.split('/');
    return handler(new Request(new URL(url, 'http://test'), { headers }), { params: Promise.resolve({ token, variant }) });
};

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-config-'));
    assertOutsideRepository(root);
    vi.stubEnv(SITE_CONFIG_ENV, root);
    resetAboutPortraitReader();
    resetPortraitVariants();
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

describe('the portrait derivatives', () => {
    it('strip every piece of metadata from a source carrying GPS, serials, XMP, and IPTC', async () => {
        const { jpeg: leaky } = await leakyJpeg();
        // The fixture really carries GPS, so a pass below means the encoder dropped it.
        const sourceMetadata = await sharp(leaky).metadata();
        expect(sourceMetadata.exif).toBeDefined();
        expect(exifReader(sourceMetadata.exif as Buffer).GPSInfo?.GPSLatitude).toBeDefined();
        put('portrait.jpg', leaky);
        const token = await currentToken();
        for (const width of VARIANT_WIDTHS) {
            for (const format of VARIANT_FORMATS) {
                const data = await portraitVariant(token, width, format, { logger: quiet });
                expect(data, `${width}.${format}`).not.toBeNull();
                const metadata = await sharp(data as Buffer).metadata();
                expect(metadata.format).toBe(format === 'avif' ? 'heif' : 'webp');
                expect({ exif: metadata.exif, xmp: metadata.xmp, iptc: metadata.iptc }, `${width}.${format}`).toEqual({ exif: undefined, xmp: undefined, iptc: undefined });
                const text = (data as Buffer).toString('latin1');
                for (const value of [...Object.values(PRIVATE_VALUES), ...Object.values(KEPT_VALUES), 'GPS', 'Exif']) expect(text, `${width}.${format} holds ${value}`).not.toContain(value);
            }
        }
    });

    it('come out upright, from a source stored on its side, and never enlarged', async () => {
        put('portrait.jpg', await sharp(await jpeg(1600, 1000)).withMetadata({ orientation: 6 }).jpeg().toBuffer());
        const token = await currentToken();
        const sizes = await Promise.all(
            VARIANT_WIDTHS.map(async (width) => {
                const { width: w, height: h } = await sharp((await portraitVariant(token, width, 'webp', { logger: quiet })) as Buffer).metadata();
                return [width, w, h];
            }),
        );
        expect(sizes).toEqual([
            ['w400', 400, 640],
            ['w800', 800, 1280],
            ['w1200', 1000, 1600],
            ['w1920', 1000, 1600],
        ]);
    });

    it('are described to the page by their upright size and URLs on the token', async () => {
        put('portrait.jpg', await jpeg(900, 1200));
        const view = await aboutPortraitView('Pat Artist', { logger: quiet });
        const token = await currentToken();
        expect(view).not.toBeNull();
        if (!view) return;
        expect(view.asset.width).toBe(900);
        expect(view.asset.height).toBe(1200);
        expect(view.asset.variants.w400.avif).toEqual({ url: `/about/portrait/${token}/w400.avif`, width: 400 });
        expect(view.asset.variants.w1200.webp).toEqual({ url: `/about/portrait/${token}/w1200.webp`, width: 900 });
        expect(view.alt).toBe('Portrait of Pat Artist');
        expect(view.focalPoint).toEqual({ x: 50, y: 50 });
    });

    it('take the alt and focal point from portrait.json', async () => {
        put('portrait.jpg', await jpeg());
        put('portrait.json', JSON.stringify({ alt: 'Pat on a ridge', focalPoint: { x: 30, y: 20 } }));
        expect(await aboutPortraitView('Pat Artist', { logger: quiet })).toMatchObject({ alt: 'Pat on a ridge', focalPoint: { x: 30, y: 20 } });
    });

    it('are none, for the no-photo layout, when there is no usable portrait', async () => {
        expect(await aboutPortraitView('Pat Artist', { logger: quiet })).toBeNull();
        put('portrait.jpg', 'not a picture');
        expect(await aboutPortraitView('Pat Artist', { logger: quiet })).toBeNull();
    });

    it('encode a set once, from one read of the source, however many requests ask', async () => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        const open = vi.spyOn(fs.promises, 'open');
        const [a, b] = await Promise.all([portraitVariant(token, 'w800', 'avif', { logger: quiet }), portraitVariant(token, 'w800', 'avif', { logger: quiet })]);
        expect(a).toBe(b);
        await portraitVariant(token, 'w400', 'webp', { logger: quiet });
        const reads = open.mock.calls.filter(([file]) => String(file).endsWith('portrait.jpg'));
        expect(reads).toHaveLength(1);
    });
    it('drops a set whose source could not be read, so the next request reads it again instead of keeping a 404', async () => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        const open = fs.promises.open.bind(fs.promises);
        const spy = vi.spyOn(fs.promises, 'open').mockImplementationOnce(() => Promise.reject(Object.assign(new Error('EMFILE'), { code: 'EMFILE' })));
        expect(await portraitVariant(token, 'w800', 'webp', { logger: quiet })).toBeNull();
        spy.mockImplementation(open);
        expect(await portraitVariant(token, 'w800', 'webp', { logger: quiet })).not.toBeNull();
    });

    it('starts no work for a token that is not the portrait, so requests for made-up tokens never push the real set out', async () => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        const open = vi.spyOn(fs.promises, 'open');
        await portraitVariant(token, 'w800', 'webp', { logger: quiet });
        for (const bogus of ['1', '2', '3']) expect(await portraitVariant(bogus.repeat(32), 'w800', 'webp', { logger: quiet })).toBeNull();
        await portraitVariant(token, 'w400', 'webp', { logger: quiet });
        expect(open.mock.calls.filter(([file]) => String(file).endsWith('portrait.jpg'))).toHaveLength(1);
    });
});

describe('GET /about/portrait/<token>/<variant>', () => {
    it('serves the current portrait as immutable, typed, and sniff-proof, with a 304 for its ETag', async () => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        const response = await get(portraitUrl(token, 'w800', 'webp'));
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(response.headers.get('content-type')).toBe('image/webp');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        const body = Buffer.from(await response.arrayBuffer());
        expect(response.headers.get('content-length')).toBe(String(body.length));
        expect((await sharp(body).metadata()).width).toBe(800);
        const etag = response.headers.get('etag') as string;
        expect(etag).toMatch(/^"[0-9a-f]{32}-w800-webp"$/);
        const again = await get(portraitUrl(token, 'w800', 'webp'), { 'If-None-Match': `W/${etag}` });
        expect(again.status).toBe(304);
        expect(again.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    });

    it.each([
        ['a token for no portrait', `/about/portrait/${'0'.repeat(32)}/w800.webp`],
        ['a short token', '/about/portrait/abc/w800.webp'],
        ['an uppercase token', `/about/portrait/${'A'.repeat(32)}/w800.webp`],
        ['a traversal for a token', '/about/portrait/..%2F..%2Fetc/w800.webp'],
        ['a variant /media never serves', 'TOKEN/w640.webp'],
        ['the source format', 'TOKEN/w800.jpg'],
        ['a path in the variant', 'TOKEN/..%2Fportrait.jpg'],
        ['the original file name', 'TOKEN/portrait.jpg'],
    ])('is a no-store 404 for %s', async (_, url) => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        const response = await get(url.startsWith('TOKEN/') ? `/about/portrait/${token}/${url.slice('TOKEN/'.length)}` : url);
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.arrayBuffer()).toHaveProperty('byteLength', 0);
    });

    it('is a no-store 404 with no portrait, never a 500', async () => {
        const response = await get(`/about/portrait/${'a'.repeat(32)}/w800.webp`);
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('serves a swapped portrait at its new URL with no restart, and keeps the one before for pages already sent', async () => {
        put('portrait.jpg', await jpeg());
        const before = await currentToken();
        expect((await get(portraitUrl(before, 'w800', 'avif'))).status).toBe(200);
        put('portrait.jpg', await jpeg(900, 1200, { r: 30, g: 90, b: 150 }));
        const time = new Date(Date.now() + 10_000);
        fs.utimesSync(about('portrait.jpg'), time, time);
        const after = await currentToken();
        expect(after).not.toBe(before);
        expect((await get(portraitUrl(after, 'w800', 'avif'))).status).toBe(200);
        // A page rendered just before the swap still loads its image.
        expect((await get(portraitUrl(before, 'w800', 'avif'))).status).toBe(200);
    });

    it('stops serving a portrait once it is removed and its set was never started', async () => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        fs.rmSync(about('portrait.jpg'));
        expect((await get(portraitUrl(token, 'w800', 'webp'))).status).toBe(404);
    });
});

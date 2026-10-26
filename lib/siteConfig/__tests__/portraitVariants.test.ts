// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import exifReader from 'exif-reader';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEPT_VALUES, leakyJpeg, PRIVATE_VALUES } from '../../../test/fixtures/exif';
import { assertOutsideRepository } from '../../../test/helpers/tempDataRoot';
import { encodeVariant } from '../../identity/profile';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../identity/variants';
import { readAboutPortrait, resetAboutPortraitReader } from '../aboutPortrait';
import { SITE_CONFIG_ENV } from '../dir';
import { aboutPortraitView, createPortraitHandler, ENCODE_RETRY, portraitUrl, portraitVariant, resetPortraitVariants } from '../portraitVariants';

// The real encoder, wrapped, so a test can make one encode fail or return something else.
vi.mock('../../identity/profile', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../identity/profile')>();
    return { ...actual, encodeVariant: vi.fn(actual.encodeVariant) };
});
const encode = vi.mocked(encodeVariant);

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

/** Write a new picture over the portrait, with a later mtime, as a swap would. */
async function swapTo(color: { r: number; g: number; b: number }, seconds: number): Promise<string> {
    put('portrait.jpg', await jpeg(900, 1200, color));
    const time = new Date(Date.now() + seconds * 1000);
    fs.utimesSync(about('portrait.jpg'), time, time);
    return currentToken();
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

beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-config-'));
    assertOutsideRepository(root);
    vi.stubEnv(SITE_CONFIG_ENV, root);
    resetAboutPortraitReader();
    await resetPortraitVariants();
});

afterEach(async () => {
    // A set still encoding in the background finishes before the next test counts encodes.
    await resetPortraitVariants();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    encode.mockReset();
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

    it.each(['jpg', 'png', 'webp'] as const)('drop a Display P3 ICC profile from a .%s source', async (extension) => {
        const created = sharp({ create: { width: 900, height: 1200, channels: 3, background: { r: 200, g: 60, b: 40 } } }).withIccProfile('p3');
        const source = await (extension === 'jpg' ? created.jpeg() : extension === 'png' ? created.png() : created.webp()).toBuffer();
        const { icc } = await sharp(source).metadata();
        // The source really carries the profile, so a pass below means the encoder dropped it.
        expect(icc).toBeDefined();
        put(`portrait.${extension}`, source);
        const token = await currentToken();
        for (const width of VARIANT_WIDTHS) {
            for (const format of VARIANT_FORMATS) {
                const data = await portraitVariant(token, width, format, { logger: quiet });
                expect(data, `${width}.${format}`).not.toBeNull();
                expect((await sharp(data as Buffer).metadata()).icc, `${width}.${format}`).toBeUndefined();
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

    const expectGone = async (token: string) => {
        const response = await get(portraitUrl(token, 'w800', 'avif'));
        expect(response.status, `${token} still answers`).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
    };

    it('serves a swapped portrait at its new URL with no restart, and the one before stops answering at once', async () => {
        put('portrait.jpg', await jpeg());
        const before = await currentToken();
        expect((await get(portraitUrl(before, 'w800', 'avif'))).status).toBe(200);
        const after = await swapTo({ r: 30, g: 90, b: 150 }, 10);
        expect(after).not.toBe(before);
        expect((await get(portraitUrl(after, 'w800', 'avif'))).status).toBe(200);
        await expectGone(before);
    });

    it('stops serving a portrait once it is removed and its set was never started', async () => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        fs.rmSync(about('portrait.jpg'));
        expect((await get(portraitUrl(token, 'w800', 'webp'))).status).toBe(404);
    });

    it('stops serving a portrait at once when it is removed after its set was built', async () => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        expect((await get(portraitUrl(token, 'w800', 'avif'))).status).toBe(200);
        fs.rmSync(about('portrait.jpg'));
        await expectGone(token);
        // Its ETag gets no 304 either.
        expect((await get(portraitUrl(token, 'w800', 'avif'), { 'If-None-Match': `"${token}-w800-avif"` })).status).toBe(404);
    });

    it('stops serving a portrait at once when it is replaced by a file that is refused', async () => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        expect((await get(portraitUrl(token, 'w800', 'avif'))).status).toBe(200);
        put('portrait.jpg', 'not a picture');
        expect(await readAboutPortrait({ logger: quiet })).toMatchObject({ state: 'none' });
        await expectGone(token);
    });

    it('drops the old set when About renders with no portrait, so nothing holds the removed photo', async () => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        expect((await get(portraitUrl(token, 'w800', 'avif'))).status).toBe(200);
        fs.rmSync(about('portrait.jpg'));
        expect(await aboutPortraitView('Pat Artist', { logger: quiet })).toBeNull();
        // Put back, the same bytes get the same token, and its set is encoded again rather than kept.
        put('portrait.jpg', await jpeg());
        expect(await currentToken()).toBe(token);
        const calls = encode.mock.calls.length;
        expect((await get(portraitUrl(token, 'w800', 'avif'))).status).toBe(200);
        expect(encode.mock.calls.length).toBeGreaterThan(calls);
    });

    it('answers nothing for a portrait removed while its variant was encoding', async () => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        encode.mockImplementationOnce(async (...args) => {
            fs.rmSync(about('portrait.jpg'));
            return (await vi.importActual<typeof import('../../identity/profile')>('../../identity/profile')).encodeVariant(...args);
        });
        await expectGone(token);
    });

    it('serves only the current portrait through a swap back and forth: A, B, A, then C', async () => {
        const a = { r: 180, g: 120, b: 60 };
        put('portrait.jpg', await jpeg(900, 1200, a));
        const tokenA = await currentToken();
        expect((await get(portraitUrl(tokenA, 'w800', 'avif'))).status).toBe(200);
        const tokenB = await swapTo({ r: 30, g: 90, b: 150 }, 10);
        expect((await get(portraitUrl(tokenB, 'w800', 'avif'))).status).toBe(200);
        await expectGone(tokenA);
        expect(await swapTo(a, 20)).toBe(tokenA);
        expect((await get(portraitUrl(tokenA, 'w800', 'avif'))).status).toBe(200);
        await expectGone(tokenB);
        const tokenC = await swapTo({ r: 90, g: 160, b: 40 }, 30);
        expect((await get(portraitUrl(tokenC, 'w800', 'avif'))).status).toBe(200);
        await expectGone(tokenA);
        await expectGone(tokenB);
    });
});

describe('a variant that fails to encode', () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    const variant = (token: string) => portraitVariant(token, 'w1200', 'avif', { logger });
    const encodesOf = (name: string) => encode.mock.calls.filter(([, width, format]) => `${width}.${format}` === name).length;

    beforeEach(() => {
        logger.warn.mockClear();
    });

    it('is a 404 until its wait is up, then the next request encodes it again', async () => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        // w1200.avif encodes first.
        encode.mockRejectedValueOnce(new Error('out of memory'));
        expect(await variant(token)).toBeNull();
        // The other variants are fine.
        expect(await portraitVariant(token, 'w800', 'webp', { logger })).not.toBeNull();
        clock.mockReturnValue(now + ENCODE_RETRY.firstMs - 1);
        expect(await variant(token)).toBeNull();
        expect(encodesOf('w1200.avif')).toBe(1);
        clock.mockReturnValue(now + ENCODE_RETRY.firstMs);
        expect(await variant(token)).not.toBeNull();
        expect(encodesOf('w1200.avif')).toBe(2);
        // Only the failed variant is encoded again.
        expect(encodesOf('w800.webp')).toBe(1);
        expect((await get(portraitUrl(token, 'w1200', 'avif'))).status).toBe(200);
    });

    it('waits twice as long after each failure, up to the cap, and logs once for the file', async () => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        let now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const real = encode.getMockImplementation();
        encode.mockImplementation(async (...args) => {
            if (`${args[1]}.${args[2]}` === 'w1200.avif') throw new Error('corrupt');
            return (real as typeof encodeVariant)(...args);
        });
        expect(await variant(token)).toBeNull();
        const waits: number[] = [];
        for (let round = 0; round < 9; round += 1) {
            // A burst of requests in the wait encodes nothing.
            const before = encodesOf('w1200.avif');
            for (let request = 0; request < 5; request += 1) expect(await variant(token)).toBeNull();
            expect(encodesOf('w1200.avif')).toBe(before);
            // Find when the next retry runs, to the millisecond.
            let wait = 1;
            while (encodesOf('w1200.avif') === before) {
                now += 1000;
                wait += 1000;
                await variant(token);
            }
            waits.push(wait - 1);
        }
        expect(waits).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000, 600_000]);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0][0]).toMatch(/^\[about\] The portrait's w1200\.avif couldn't be encoded \(corrupt\), so it isn't served\. A later request tries it again\.$/);
    });

    it('is refused, not served, when the encoder hands back EXIF', async () => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        const { jpeg: leaky } = await leakyJpeg();
        encode.mockResolvedValueOnce(await sharp(leaky).keepExif().avif().toBuffer());
        expect(await variant(token)).toBeNull();
        expect((await get(portraitUrl(token, 'w1200', 'avif'))).status).toBe(404);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[about\] The portrait's w1200\.avif kept metadata, so it isn't served/));
    });

    it('is refused, not served, when the encoder hands back an ICC profile', async () => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        const withProfile = await sharp(await jpeg()).withIccProfile('p3').avif().toBuffer();
        expect((await sharp(withProfile).metadata()).icc).toBeDefined();
        encode.mockResolvedValueOnce(withProfile);
        expect(await variant(token)).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/kept metadata/));
    });
});

describe('the source read for encoding', () => {
    it('gives nothing, and keeps no set, when the file changes between its check and the read', async () => {
        put('portrait.jpg', await jpeg());
        const token = await currentToken();
        const other = await jpeg(900, 1200, { r: 10, g: 200, b: 90 });
        const open = fs.promises.open.bind(fs.promises);
        // The swap lands after the stat that keeps the token current and before the bytes are read again.
        vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args: Parameters<typeof open>) => {
            fs.writeFileSync(about('portrait.jpg'), other);
            return open(...args);
        });
        expect(await portraitVariant(token, 'w800', 'webp', { logger: quiet })).toBeNull();
        expect(encode).not.toHaveBeenCalled();
        const time = new Date(Date.now() + 10_000);
        fs.utimesSync(about('portrait.jpg'), time, time);
        const next = await currentToken();
        expect(next).not.toBe(token);
        expect(await portraitVariant(token, 'w800', 'webp', { logger: quiet })).toBeNull();
        expect(await portraitVariant(next, 'w800', 'webp', { logger: quiet })).not.toBeNull();
    });
});

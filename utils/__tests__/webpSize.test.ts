// @vitest-environment node
import { describe, expect, it } from 'vitest';
import sharp, { type WebpOptions } from 'sharp';
import { webpSize } from '../imageOptimizer';

/** A WebP of this size, in the format `options` gives. */
async function webp(width: number, height: number, channels: 3 | 4, options: WebpOptions): Promise<Buffer> {
    const background = channels === 4 ? { r: 40, g: 160, b: 90, alpha: 0.5 } : { r: 40, g: 160, b: 90 };
    return sharp({ create: { width, height, channels, background } }).webp(options).toBuffer();
}

describe('webpSize', () => {
    it.each([
        ['VP8 ', 'lossy', 1919, 1081, 3, { quality: 85 }],
        ['VP8 ', 'lossy, tall', 640, 16383, 3, { quality: 85 }],
        ['VP8X', 'lossy with alpha', 1920, 1279, 4, { quality: 85 }],
        ['VP8L', 'lossless', 1001, 999, 3, { lossless: true }],
    ] as const)('reads a %s (%s) header as Sharp does', async (chunk, _format, width, height, channels, options) => {
        const data = await webp(width, height, channels, options);
        expect(data.toString('latin1', 12, 16)).toBe(chunk);
        const { width: sharpWidth, height: sharpHeight } = await sharp(data).metadata();
        expect(webpSize(data)).toEqual({ width, height });
        expect(webpSize(data)).toEqual({ width: sharpWidth, height: sharpHeight });
        // The first 30 bytes are enough
        expect(webpSize(data.subarray(0, 30))).toEqual({ width, height });
    });

    it('leaves out the upscaling bits a lossy header keeps above each side', async () => {
        const scaled = Buffer.from(await webp(300, 200, 3, { quality: 85 }));
        scaled[27] |= 0xc0;
        scaled[29] |= 0x40;
        expect(webpSize(scaled)).toEqual({ width: 300, height: 200 });
    });

    it('returns null for anything but a WebP header', async () => {
        const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).jpeg().toBuffer();
        const lossy = await webp(8, 8, 3, { quality: 85 });
        const wave = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1'), Buffer.alloc(14)]);
        const notKeyFrame = Buffer.from(lossy);
        notKeyFrame[23] = 0;
        const badSignature = Buffer.from(await webp(8, 8, 3, { lossless: true }));
        badSignature[20] = 0;
        // A RIFF file of another form, with a chunk that looks like WebP's
        const notWebp = Buffer.from(await webp(8, 8, 4, { quality: 85 }));
        notWebp.write('WAVE', 8, 'latin1');
        const notRiff = Buffer.from(lossy);
        notRiff.write('RIFX', 0, 'latin1');

        expect(webpSize(jpeg)).toBeNull();
        expect(webpSize(wave)).toBeNull();
        expect(webpSize(notKeyFrame)).toBeNull();
        expect(webpSize(badSignature)).toBeNull();
        expect(webpSize(notWebp)).toBeNull();
        expect(webpSize(notRiff)).toBeNull();
        expect(webpSize(lossy.subarray(0, 29))).toBeNull();
        expect(webpSize(Buffer.from('not a WebP'))).toBeNull();
    });
});

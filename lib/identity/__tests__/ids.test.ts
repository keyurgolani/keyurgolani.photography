// @vitest-environment node
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { mediaUrl } from '../../media/url';
import {
    ASSET_REVISION_RE,
    assetRevisionOf,
    canonicalJson,
    mintPhotoId,
    namedUuid,
    PHOTO_ID_RE,
    PIXEL_DIGEST_RE,
    pixelDigestOf,
    PROFILE_ID_RE,
    profileIdOf,
} from '../ids';
import { currentProfileId, PROFILE_1 } from '../profile';
import { VARIANT_FILE_RE } from '../variants';

describe('identifiers', () => {
    it('mints photo IDs as ph_ plus a lowercase UUID v4, from the injected generator', () => {
        expect(mintPhotoId(() => '6F1C1A2E-0B4B-4D8E-9A43-1D2B3C4D5E6F')).toBe('ph_6f1c1a2e-0b4b-4d8e-9a43-1d2b3c4d5e6f');
        expect(mintPhotoId()).toMatch(PHOTO_ID_RE);
        expect(() => mintPhotoId(() => 'landscape.jpg')).toThrow(/not a UUID v4/);
        expect(() => mintPhotoId(() => '6f1c1a2e-0b4b-1d8e-9a43-1d2b3c4d5e6f')).toThrow(/not a UUID v4/);
    });

    it('names a UUID by its input alone, as RFC 9562 version 8', () => {
        const name = 'processing-failed:sha256-x:sha256-x\0raw.heic\0unsupported-format';
        expect(namedUuid(name)).toBe(namedUuid(name));
        expect(namedUuid(name)).not.toBe(namedUuid(`${name} `));
        expect(namedUuid(name)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('digests source bytes as sha256- plus 64 hex, through an injectable hasher', () => {
        const bytes = Buffer.from('source bytes');
        expect(assetRevisionOf(bytes)).toBe(`sha256-${createHash('sha256').update(bytes).digest('hex')}`);
        expect(assetRevisionOf(bytes)).toMatch(ASSET_REVISION_RE);
        expect(assetRevisionOf(bytes, () => 'f'.repeat(64))).toBe(`sha256-${'f'.repeat(64)}`);
        expect(() => assetRevisionOf(bytes, () => 'not hex')).toThrow(/64 lowercase hex/);
    });

    it('digests pixels together with their shape, so the same bytes in another shape differ', () => {
        const data = new Uint8Array(24).fill(7);
        const wide = pixelDigestOf({ data, width: 4, height: 2, channels: 3 });
        const tall = pixelDigestOf({ data, width: 2, height: 4, channels: 3 });
        const grey = pixelDigestOf({ data, width: 4, height: 6, channels: 1 });
        expect(wide).toMatch(PIXEL_DIGEST_RE);
        expect(new Set([wide, tall, grey]).size).toBe(3);
        expect(pixelDigestOf({ data, width: 4, height: 2, channels: 3 })).toBe(wide);
    });

    it('derives profile IDs from the recipe and the Sharp and libvips versions, independent of key order', () => {
        const versions = { sharp: '0.35.5', vips: '8.18.7' };
        const id = profileIdOf({ a: 1, b: { c: 2, d: 3 } }, versions);
        expect(id).toMatch(PROFILE_ID_RE);
        expect(profileIdOf({ b: { d: 3, c: 2 }, a: 1 }, versions)).toBe(id);
        expect(profileIdOf({ a: 1, b: { c: 2, d: 3 } }, { ...versions, vips: '8.18.8' })).not.toBe(id);
        expect(profileIdOf({ a: 1, b: { c: 2, d: 4 } }, versions)).not.toBe(id);
        expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
        expect(currentProfileId()).toBe(profileIdOf(PROFILE_1, { sharp: sharp.versions.sharp, vips: sharp.versions.vips }));
    });

    it('builds /media URLs from validated segments only', () => {
        const ref = { photoId: 'ph_6f1c1a2e-0b4b-4d8e-9a43-1d2b3c4d5e6f', assetRevision: `sha256-${'a'.repeat(64)}`, profileId: 'p_0123456789abcdef' };
        const url = mediaUrl(ref, 'w1200', 'webp');
        expect(url).toBe(`/media/${ref.photoId}/${ref.assetRevision}/${ref.profileId}/w1200.webp`);
        expect(url.split('/').pop()).toMatch(VARIANT_FILE_RE);
        expect(() => mediaUrl({ ...ref, photoId: '../etc' }, 'w400', 'avif')).toThrow(/Invalid photoId/);
        expect(() => mediaUrl({ ...ref, assetRevision: 'sha256-abc' }, 'w400', 'avif')).toThrow(/Invalid assetRevision/);
        expect(() => mediaUrl({ ...ref, profileId: 'p_x' }, 'w400', 'avif')).toThrow(/Invalid profileId/);
    });
});

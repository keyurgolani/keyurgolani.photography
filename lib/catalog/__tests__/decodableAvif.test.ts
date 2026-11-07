// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { VARIANT_WIDTHS } from '@/lib/identity/variants';
import { BUDGET_VARIANT_BYTES } from '@/lib/perf/fixture';
import { createTestCatalog } from '../testing';

// The budget library's AVIF files decode (B8's CI): first-viewport.spec.ts counts the first load's requests on the
// success path, where a file that can't decode would take the WebP retry and fetch a second format. Each AVIF file is a
// real AVIF at its variant's size, then a free box that fills it to the declared bytes, which stays sparse. WebP stays
// zeros: the success path never asks for it. The folder is left under the temp folder for the lead, never removed.

describe('createTestCatalog with decodableAvif', () => {
    it('writes each AVIF variant as a real image at its declared size and bytes, with the digest its manifest names', async () => {
        const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'decodable-avif-')), 'data');
        console.info(`decodable-avif fixture: ${path.dirname(root)}`);
        const catalog = await createTestCatalog({ root, photos: 1, series: 1, seed: 801, variantBytes: BUDGET_VARIANT_BYTES, decodableAvif: true });
        const [photo] = catalog.content.photos;
        const dir = path.join(root, 'assets', photo.id, photo.assetRevision, catalog.profileId);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        for (const variant of VARIANT_WIDTHS) {
            const declared = manifest.variants[variant];
            const avif = fs.readFileSync(path.join(dir, `${variant}.avif`));
            expect(avif.length, `${variant}.avif`).toBe(BUDGET_VARIANT_BYTES[variant].avif);
            expect(createHash('sha256').update(avif).digest('hex'), `${variant}.avif`).toBe(declared.avif.sha256);
            const decoded = await sharp(avif).raw().toBuffer({ resolveWithObject: true });
            expect([decoded.info.width, decoded.info.height], `${variant}.avif`).toEqual([declared.avif.width, declared.avif.height]);
            // The rest of the file is one ISOBMFF free box, so a decoder skips it.
            const webp = fs.readFileSync(path.join(dir, `${variant}.webp`));
            expect(webp.length, `${variant}.webp`).toBe(BUDGET_VARIANT_BYTES[variant].webp);
            expect(webp.every((byte) => byte === 0), `${variant}.webp`).toBe(true);
            expect(createHash('sha256').update(webp).digest('hex'), `${variant}.webp`).toBe(declared.webp.sha256);
        }
    });

    it('leaves every variant zeros without it, as before', async () => {
        const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'decodable-avif-')), 'data');
        console.info(`decodable-avif fixture: ${path.dirname(root)}`);
        const catalog = await createTestCatalog({ root, photos: 1, series: 1, seed: 801, variantBytes: BUDGET_VARIANT_BYTES });
        const [photo] = catalog.content.photos;
        const avif = fs.readFileSync(path.join(root, 'assets', photo.id, photo.assetRevision, catalog.profileId, 'w400.avif'));
        expect(avif.length).toBe(BUDGET_VARIANT_BYTES.w400.avif);
        expect(avif.every((byte) => byte === 0)).toBe(true);
    });
});

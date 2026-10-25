// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import exifReader from 'exif-reader';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildExif, KEPT_VALUES, leakyJpeg, PRIVATE_VALUES } from '../../../test/fixtures/exif';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { pixelDigestOf } from '../ids';
import { inspectEntry, type ImageInspection } from '../inspect';
import { exifCaptureTime, extractMetadataTiers, TECHNICAL_KEYS, tiersFromParsedExif, toPublicAsset, VARIANT_FORMATS, VARIANT_WIDTHS } from '../metadata';
import { runReconcilePass } from '../pass';
import { identityPaths } from '../registry';
import { scanLibrary } from '../scan';
import type { AssetManifest, PhotoRecord } from '../types';
import { sequentialIds } from './reconcileFixtures';

let leaky: { jpeg: Buffer; thumbnail: Buffer };
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
    leaky = await leakyJpeg();
});

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Fail on any private value, in any encoding a JSON dump would carry it. */
function expectNoPrivateValues(serialized: string, label: string): void {
    for (const [name, value] of Object.entries(PRIVATE_VALUES)) expect(serialized, `${label} carries ${name}`).not.toContain(value);
    expect(serialized, `${label} carries the embedded thumbnail`).not.toContain(leaky.thumbnail.toString('base64').slice(0, 24));
}

describe('the leaky fixture', () => {
    it('really carries everything the tiers must drop', async () => {
        const metadata = await sharp(leaky.jpeg).metadata();
        expect(metadata.xmp?.toString('utf8')).toContain(PRIVATE_VALUES.xmpCreator);
        expect(metadata.iptc?.toString('utf8')).toContain(PRIVATE_VALUES.iptcByline);
        const parsed = exifReader(metadata.exif as Buffer);
        expect(parsed.Photo?.BodySerialNumber).toBe(PRIVATE_VALUES.bodySerial);
        expect(parsed.Photo?.CameraOwnerName).toBe(PRIVATE_VALUES.ownerName);
        expect(String(parsed.Photo?.MakerNote)).toBe(PRIVATE_VALUES.makerNote);
        expect(parsed.Image?.Software).toBe(PRIVATE_VALUES.software);
        expect(parsed.Image?.HostComputer).toBe(PRIVATE_VALUES.hostComputer);
        expect(parsed.Thumbnail?.JPEGInterchangeFormatLength).toBe(leaky.thumbnail.length);
        expect(parsed.GPSInfo?.GPSLatitudeRef).toBe('N');
    });
});

describe('metadata tiers', () => {
    it('keep only the allowlisted public keys, GPS only for the curator, and nothing from the never-stored list', async () => {
        const tiers = extractMetadataTiers((await sharp(leaky.jpeg).metadata()).exif);

        expect(Object.keys(tiers.derived.technical).sort()).toEqual([...TECHNICAL_KEYS].sort());
        expect(Object.fromEntries(Object.entries(tiers.derived.technical).map(([key, entry]) => [key, entry?.value]))).toEqual({
            Make: KEPT_VALUES.make,
            Model: KEPT_VALUES.model,
            LensModel: KEPT_VALUES.lensModel,
            FocalLength: '35',
            FNumber: '1.8',
            ExposureTime: '1/200',
            ISO: '400',
        });
        expect(tiers.derived.technical.ISO?.source).toBe('exif:Photo.ISOSpeedRatings');
        expect(tiers.derived.capturedDate).toEqual({ value: '2024-05-01', source: 'exif:Photo.DateTimeOriginal' });
        expect(tiers.derived.extractorVersion).toBe(1);
        expect(JSON.stringify(tiers.derived)).not.toMatch(/latitude|longitude|GPS|Artist|Copyright/i);

        expect(tiers.curatorOnly).toEqual({
            extractorVersion: 1,
            dateTimeOriginal: { value: '2024-05-01T14:30:00-07:00', source: 'exif:Photo.DateTimeOriginal+OffsetTimeOriginal' },
            gps: { value: { latitude: 37.7749, longitude: -122.4194, altitude: 12.5 }, source: 'exif:GPSInfo' },
            artist: { value: KEPT_VALUES.artist, source: 'exif:Image.Artist' },
            copyright: { value: KEPT_VALUES.copyright, source: 'exif:Image.Copyright' },
        });
        expectNoPrivateValues(JSON.stringify(tiers), 'the tiers');
    });

    it('never stores a never-stored field, even one handed over already parsed', () => {
        const tiers = tiersFromParsedExif({
            Image: { Make: 'Make', ImageDescription: 'a caption the camera wrote', XPComment: 'x', CameraSerialNumber: PRIVATE_VALUES.cameraSerial },
            Photo: {
                MakerNote: Buffer.from(PRIVATE_VALUES.makerNote),
                UserComment: Buffer.from(PRIVATE_VALUES.userComment),
                BodySerialNumber: PRIVATE_VALUES.bodySerial,
                CameraOwnerName: PRIVATE_VALUES.ownerName,
                ImageUniqueID: PRIVATE_VALUES.imageUniqueId,
                ISOSpeedRatings: [200, 400],
                ExposureTime: 0.3,
                FNumber: Number.NaN,
                FocalLength: Infinity,
                LensModel: Buffer.from('Lens with a UTF-8 name ✓'),
            },
        });
        expect(Object.keys(tiers.derived.technical).sort()).toEqual(['ExposureTime', 'ISO', 'LensModel', 'Make']);
        expect(tiers.derived.technical.ISO?.value).toBe('200');
        expect(tiers.derived.technical.ExposureTime?.value).toBe('0.3');
        expect(tiers.derived.technical.LensModel?.value).toBe('Lens with a UTF-8 name ✓');
        expect(JSON.stringify(tiers)).not.toMatch(/caption|ImageDescription|XPComment/);
        expectNoPrivateValues(JSON.stringify(tiers), 'parsed tiers');
    });

    it('are empty, not an error, for missing or unparseable EXIF', () => {
        expect(extractMetadataTiers(undefined)).toEqual({ derived: { extractorVersion: 1, technical: {}, capturedDate: null }, curatorOnly: { extractorVersion: 1 } });
        expect(extractMetadataTiers(Buffer.from('Exif\0\0garbage'))).toEqual(extractMetadataTiers(undefined));
    });

    it('drop a GPS position missing its hemisphere and a zeroed capture date', () => {
        const tiers = tiersFromParsedExif({
            Photo: { DateTimeOriginal: '0000:00:00 00:00:00' },
            GPSInfo: { GPSLatitude: [37, 46, 29.64], GPSLongitude: [122, 25, 9.84], GPSLongitudeRef: 'W' },
        });
        expect(tiers.derived.capturedDate).toBeNull();
        expect(tiers.curatorOnly).toEqual({ extractorVersion: 1 });
    });

    it("read the capture date from the tag's own text, since exif-reader rolls a bad field over", async () => {
        const exif = await exifWithDate('2024:00:00 00:00:00', 'little-endian');
        expect(exifReader(exif).Photo?.DateTimeOriginal).toEqual(new Date('2023-11-30T00:00:00.000Z'));
        expect(extractMetadataTiers(exif).derived.capturedDate).toBeNull();
        // A Date handed over already parsed may have rolled over the same way, so it isn't trusted either.
        expect(tiersFromParsedExif({ Photo: { DateTimeOriginal: new Date('2024-05-01T14:30:00.000Z') } }).derived.capturedDate).toBeNull();
    });

    it('read the capture date from a block without the Exif prefix, and only from an ASCII tag', () => {
        const date = '2024:05:01 14:30:00';
        const bare = buildExif({ ifd0: {}, exif: { 0x9003: { type: 'ascii', value: date } }, gps: {}, thumbnail: Buffer.alloc(0) }).subarray(6);
        expect(extractMetadataTiers(bare).derived.capturedDate).toEqual({ value: '2024-05-01', source: 'exif:Photo.DateTimeOriginal' });
        const untyped = buildExif({ ifd0: {}, exif: { 0x9003: { type: 'undefined', value: Buffer.from(`${date}\0`, 'latin1') } }, gps: {}, thumbnail: Buffer.alloc(0) });
        expect(extractMetadataTiers(untyped).derived.capturedDate).toBeNull();
    });

    describe.each(['little-endian', 'big-endian'] as const)('in %s EXIF', (order) => {
        it.each([
            ['month and day 00', '2024:00:00 00:00:00'],
            ['a day the month lacks', '2024:02:30 10:00:00'],
            ['February 29 outside a leap year', '2023:02:29 10:00:00'],
            ['month 13', '2024:13:01 10:00:00'],
            ['hour 24', '2024:05:01 24:00:00'],
            ['minute 60', '2024:05:01 14:60:00'],
            ['second 60', '2024:05:01 14:30:60'],
            ['a year before 1900', '1899:12:31 23:59:59'],
            ['every field zero', '0000:00:00 00:00:00'],
            ['every field blank', '    :  :     :  :  '],
        ])('drop a capture date with %s (%s)', async (_label, value) => {
            const tiers = extractMetadataTiers(await exifWithDate(value, order));
            expect(tiers.derived.capturedDate).toBeNull();
            expect(tiers.curatorOnly.dateTimeOriginal).toBeUndefined();
        });

        it('keep a capture date whose fields are all in range', async () => {
            const tiers = extractMetadataTiers(await exifWithDate('2024:02:29 23:59:59', order));
            expect(tiers.derived.capturedDate).toEqual({ value: '2024-02-29', source: 'exif:Photo.DateTimeOriginal' });
            expect(tiers.curatorOnly.dateTimeOriginal).toEqual({ value: '2024-02-29T23:59:59', source: 'exif:Photo.DateTimeOriginal' });
        });
    });
});

describe('exifCaptureTime', () => {
    /** An EXIF block with these DateTimeOriginal and IFD0 DateTime texts. */
    async function exifWithDates(original: string, modified: string, order: 'little-endian' | 'big-endian'): Promise<Buffer> {
        if (order === 'big-endian') {
            return buildExif({ ifd0: { 0x0132: { type: 'ascii', value: modified } }, exif: { 0x9003: { type: 'ascii', value: original } }, gps: {}, thumbnail: Buffer.alloc(0) });
        }
        const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
            .withExif({ IFD0: { DateTime: modified }, IFD2: { DateTimeOriginal: original } })
            .jpeg()
            .toBuffer();
        return (await sharp(jpeg).metadata()).exif as Buffer;
    }

    it.each(['little-endian', 'big-endian'] as const)('reads DateTimeOriginal as written, in %s EXIF', async (order) => {
        expect(exifCaptureTime(await exifWithDates('2024:02:29 23:59:59', '2024:05:02 09:00:00', order))).toBe('2024-02-29T23:59:59');
    });

    // The Gallery sorted these by exif-reader's Date before, so each keeps its place.
    it.each([
        ['1888:07:04 12:00:00', '1888-07-04T12:00:00'],
        ['1899:12:31 23:59:59', '1899-12-31T23:59:59'],
        ['2250:01:01 00:00:00', '2250-01-01T00:00:00'],
    ])('reads a DateTimeOriginal of any year, such as %s', async (value, expected) => {
        for (const order of ['little-endian', 'big-endian'] as const) {
            expect(exifCaptureTime(await exifWithDates(value, '2024:05:02 09:00:00', order)), order).toBe(expected);
        }
    });

    it.each(['little-endian', 'big-endian'] as const)('leaves out a DateTimeOriginal that rolls over or is all zeros, and never reads DateTime instead, in %s EXIF', async (order) => {
        const exif = await exifWithDates('2024:00:00 00:00:00', '2020:01:01 00:00:00', order);
        expect(exifReader(exif).Photo?.DateTimeOriginal).toEqual(new Date('2023-11-30T00:00:00.000Z'));
        expect(exifCaptureTime(exif)).toBeUndefined();
        expect(exifCaptureTime(await exifWithDates('0000:00:00 00:00:00', '2020:01:01 00:00:00', order))).toBeUndefined();
    });

    it('is undefined for missing or unparseable EXIF', () => {
        expect(exifCaptureTime(undefined)).toBeUndefined();
        expect(exifCaptureTime(Buffer.from('Exif\0\0garbage'))).toBeUndefined();
    });
});

/** An EXIF block whose DateTimeOriginal is `value`, little-endian as Sharp writes it, or big-endian. */
async function exifWithDate(value: string, order: 'little-endian' | 'big-endian'): Promise<Buffer> {
    if (order === 'big-endian') return buildExif({ ifd0: {}, exif: { 0x9003: { type: 'ascii', value } }, gps: {}, thumbnail: Buffer.alloc(0) });
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .withExif({ IFD2: { DateTimeOriginal: value } })
        .jpeg()
        .toBuffer();
    const exif = (await sharp(jpeg).metadata()).exif as Buffer;
    expect(exif.subarray(6, 8).toString('latin1')).toBe('II');
    return exif;
}

describe('the pixel digest', () => {
    it('hashes the pixels as stored, so a copy whose color profile was stripped still matches', async () => {
        const lib = await createTempLibrary();
        cleanups.push(() => lib.cleanup());
        const base = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 80, b: 40 } } }).png().toBuffer();
        const p3 = await sharp(base).withIccProfile('p3').png().toBuffer();
        // The same stored pixels, written out again without the profile
        const stored = await sharp(p3).keepIccProfile().raw().toBuffer({ resolveWithObject: true });
        const stripped = await sharp(stored.data, { raw: stored.info }).png().toBuffer();
        expect((await sharp(p3).metadata()).icc).toBeDefined();
        expect((await sharp(stripped).metadata()).icc).toBeUndefined();
        fs.writeFileSync(lib.file('p3.png'), p3);
        fs.writeFileSync(lib.file('stripped.png'), stripped);

        const scan = await scanLibrary(lib.root);
        const [withProfile, withoutProfile] = await Promise.all(['p3.png', 'stripped.png'].map(async (name) => {
            const entry = scan.entries.find((candidate) => candidate.path === name);
            if (!entry) throw new Error(`The scan missed ${name}`);
            return await inspectEntry(lib.root, entry) as ImageInspection;
        }));
        expect(withProfile.assetRevision).not.toBe(withoutProfile.assetRevision);
        expect(withProfile.pixelDigest).not.toBeNull();
        expect(withProfile.pixelDigest).toBe(withoutProfile.pixelDigest);
    });

    it('hashes a CMYK JPEG as Sharp converts it to sRGB, the one exception to the stored pixels', async () => {
        const lib = await createTempLibrary();
        cleanups.push(() => lib.cleanup());
        const cmyk = await sharp({ create: { width: 16, height: 12, channels: 3, background: { r: 200, g: 40, b: 40 } } })
            .toColourspace('cmyk')
            .jpeg()
            .toBuffer();
        expect(await sharp(cmyk).metadata()).toMatchObject({ space: 'cmyk', channels: 4 });
        fs.writeFileSync(lib.file('cmyk.jpg'), cmyk);

        const entry = (await scanLibrary(lib.root)).entries.find((candidate) => candidate.path === 'cmyk.jpg');
        if (!entry) throw new Error('The scan missed cmyk.jpg');
        const inspection = await inspectEntry(lib.root, entry) as ImageInspection;
        const converted = await sharp(cmyk).autoOrient().raw().toBuffer({ resolveWithObject: true });
        expect(converted.info.channels).toBe(3);
        expect(inspection.pixelDigest).toBe(pixelDigestOf({ data: converted.data, ...converted.info }));
    });
});

describe('stored and public metadata from a real file', () => {
    let lib: TempLibrary;
    let data: TempDataRoot;

    it('stores only the tiers in the registry, and the public projection carries only allowlisted keys', async () => {
        lib = await createTempLibrary();
        cleanups.push(() => lib.cleanup());
        data = createTempDataRoot();
        cleanups.push(() => data.cleanup());
        fs.writeFileSync(lib.file('leaky.jpg'), leaky.jpeg);

        const scan = await scanLibrary(lib.root);
        const inspection = await inspectEntry(lib.root, scan.entries[0]) as ImageInspection;
        expect(inspection).toMatchObject({ kind: 'image', width: 64, height: 48, sourceFormat: 'jpeg' });
        expectNoPrivateValues(JSON.stringify(inspection), 'the inspection');

        const outcome = await runReconcilePass({ clock: () => Date.now() + 60_000, idGen: sequentialIds(), sinks: [] });
        expect(outcome.status).toBe('committed');
        // Every version the registry folder holds, not only the newest
        const registryDir = identityPaths(data.root).registry;
        const versions = fs.readdirSync(registryDir).sort();
        expect(versions).toEqual(['v1.json']);
        const registryJson = fs.readFileSync(path.join(registryDir, 'v1.json'), 'utf8');
        const statCacheJson = fs.readFileSync(identityPaths(data.root).statCache, 'utf8');
        expectNoPrivateValues(registryJson, 'registry/v1.json');
        expectNoPrivateValues(statCacheJson, 'stat-cache.json');

        const registry = JSON.parse(registryJson);
        const photo = Object.values(registry.photos)[0] as PhotoRecord;
        const revision = photo.revisions[photo.source.observedRevision];
        expect(revision.curatorOnly.gps?.value).toEqual({ latitude: 37.7749, longitude: -122.4194, altitude: 12.5 });
        // GPS appears in the registry only under curatorOnly.
        expect(registryJson.match(/"latitude"/g)).toHaveLength(1);
        expect(JSON.stringify({ ...revision, curatorOnly: undefined })).not.toMatch(/latitude|longitude/);

        const manifest: AssetManifest = {
            schemaVersion: 1,
            photoId: photo.photoId,
            assetRevision: photo.source.observedRevision,
            profileId: 'p_0123456789abcdef',
            variants: Object.fromEntries(VARIANT_WIDTHS.map((width) => [width, Object.fromEntries(VARIANT_FORMATS.map((format) => [format, {
                width: 64, height: 48, bytes: 100, sha256: 'a'.repeat(64),
            }]))])) as AssetManifest['variants'],
            lqip: 'data:image/webp;base64,UklGRg==',
            createdAt: '2026-06-01T12:00:00.000Z',
        };
        const projection = toPublicAsset(photo, photo.source.observedRevision, 'p_0123456789abcdef', manifest);

        expect(Object.keys(projection)).toMatchInlineSnapshot(`
          [
            "photoId",
            "assetRevision",
            "profileId",
            "width",
            "height",
            "lqip",
            "variants",
            "technical",
            "capturedDate",
          ]
        `);
        expect(Object.keys(projection.technical)).toMatchInlineSnapshot(`
          [
            "Make",
            "Model",
            "LensModel",
            "FocalLength",
            "FNumber",
            "ExposureTime",
            "ISO",
          ]
        `);
        expect(Object.keys(projection.variants)).toEqual(['w400', 'w800', 'w1200', 'w1920']);
        expect(Object.keys(projection.variants.w1200)).toEqual(['avif', 'webp']);
        expect(Object.keys(projection.variants.w1200.webp)).toEqual(['url', 'width', 'height', 'bytes']);
        expect(projection.variants.w1200.webp.url).toBe(`/media/${photo.photoId}/${photo.source.observedRevision}/p_0123456789abcdef/w1200.webp`);
        expect(projection.capturedDate).toBe('2024-05-01');

        const publicJson = JSON.stringify(projection);
        expectNoPrivateValues(publicJson, 'the public projection');
        expect(publicJson).not.toMatch(/latitude|longitude|leaky\.jpg|Pat Artist|-07:00/);
    });

    it('refuses to project a revision the photo does not own or a manifest for another asset', () => {
        const photo = { photoId: 'ph_00000000-0000-4000-8000-000000000001', revisions: {} } as unknown as PhotoRecord;
        const manifest = { photoId: photo.photoId, assetRevision: `sha256-${'b'.repeat(64)}`, profileId: 'p_0123456789abcdef' } as AssetManifest;
        expect(() => toPublicAsset(photo, `sha256-${'b'.repeat(64)}`, 'p_0123456789abcdef', manifest)).toThrow(/not a revision/);
    });
});

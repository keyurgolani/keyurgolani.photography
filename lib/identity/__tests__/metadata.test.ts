// @vitest-environment node
import fs from 'node:fs';
import exifReader from 'exif-reader';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { KEPT_VALUES, leakyJpeg, PRIVATE_VALUES } from '../../../test/fixtures/exif';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { inspectEntry, type ImageInspection } from '../inspect';
import { extractMetadataTiers, TECHNICAL_KEYS, tiersFromParsedExif, toPublicAsset, VARIANT_FORMATS, VARIANT_WIDTHS } from '../metadata';
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
            // What exif-reader makes of "0000:00:00 00:00:00".
            Photo: { DateTimeOriginal: new Date(Date.UTC(0, -1, 0, 0, 0, 0)) },
            GPSInfo: { GPSLatitude: [37, 46, 29.64], GPSLongitude: [122, 25, 9.84], GPSLongitudeRef: 'W' },
        });
        expect(tiers.derived.capturedDate).toBeNull();
        expect(tiers.curatorOnly).toEqual({ extractorVersion: 1 });
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
        const registryJson = fs.readFileSync(identityPaths(data.root).registry, 'utf8');
        const statCacheJson = fs.readFileSync(identityPaths(data.root).statCache, 'utf8');
        expectNoPrivateValues(registryJson, 'registry.json');
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

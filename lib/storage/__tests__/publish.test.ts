// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { IntegrityError, MANIFEST_FILE, publishDirectory, verifyDirectory, type AssetIdentity, type DirectoryManifest } from '../publish';

const IDENTITY: AssetIdentity = {
    photoId: 'ph_6f1c1a2e-0b4b-4d8e-9a43-1d2b3c4d5e6f',
    assetRevision: `sha256-${'a'.repeat(64)}`,
    profileId: 'p_0123456789abcdef',
};

let data: TempDataRoot;

beforeEach(() => {
    data = createTempDataRoot();
});

afterEach(async () => {
    await data.cleanup();
});

function sha256(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/** Write a small derivative set into `dir`: two files and a manifest that describes them. */
function writeSet(dir: string, { identity = IDENTITY, seed = 'v1' }: { identity?: AssetIdentity; seed?: string } = {}): DirectoryManifest {
    fs.mkdirSync(dir, { recursive: true });
    const files = { 'w400.webp': Buffer.from(`webp ${seed}`), 'w400.avif': Buffer.from(`avif ${seed}`) };
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
    const manifest: DirectoryManifest = {
        ...identity,
        variants: {
            w400: {
                webp: { bytes: files['w400.webp'].length, sha256: sha256(files['w400.webp']) },
                avif: { bytes: files['w400.avif'].length, sha256: sha256(files['w400.avif']) },
            },
        },
    };
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ schemaVersion: 1, ...manifest, lqip: 'data:', createdAt: 'now' }));
    return manifest;
}

function snapshot(dir: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const name of fs.readdirSync(dir).sort()) result[name] = sha256(fs.readFileSync(path.join(dir, name)));
    return result;
}

const staging = () => data.file('staging', 'job-1');
const final = () => data.file('assets', IDENTITY.photoId, IDENTITY.assetRevision, IDENTITY.profileId);

describe('publishDirectory', () => {
    it('renames a staged set into place', async () => {
        writeSet(staging());
        const staged = snapshot(staging());
        expect(await publishDirectory(staging(), final())).toEqual({ published: true });
        expect(fs.existsSync(staging())).toBe(false);
        expect(snapshot(final())).toEqual(staged);
        expect(await verifyDirectory(final(), IDENTITY)).toEqual([]);
    });

    it('keeps a valid existing set byte-identical and discards the staged copy', async () => {
        writeSet(final(), { seed: 'first build' });
        const before = snapshot(final());
        writeSet(staging(), { seed: 'second build' });

        expect(await publishDirectory(staging(), final())).toEqual({ published: false });
        expect(snapshot(final())).toEqual(before);
        expect(fs.existsSync(staging())).toBe(false);
    });

    it.each([
        ['a file whose bytes changed', (dir: string) => fs.writeFileSync(path.join(dir, 'w400.webp'), 'webp v2')],
        ['a file whose size changed', (dir: string) => fs.appendFileSync(path.join(dir, 'w400.avif'), 'x')],
        ['a missing file', (dir: string) => fs.rmSync(path.join(dir, 'w400.avif'))],
        ['a missing manifest', (dir: string) => fs.rmSync(path.join(dir, MANIFEST_FILE))],
    ])('throws IntegrityError over %s and changes neither directory', async (_label, damage) => {
        writeSet(final());
        damage(final());
        const before = snapshot(final());
        writeSet(staging());
        const staged = snapshot(staging());

        await expect(publishDirectory(staging(), final())).rejects.toBeInstanceOf(IntegrityError);
        expect(snapshot(final())).toEqual(before);
        expect(snapshot(staging())).toEqual(staged);
    });

    it('throws IntegrityError over a valid set that belongs to another photo, revision, or profile', async () => {
        for (const field of ['photoId', 'assetRevision', 'profileId'] as const) {
            const other = { ...IDENTITY, [field]: field === 'photoId' ? 'ph_00000000-0000-4000-8000-000000000000' : field === 'assetRevision' ? `sha256-${'b'.repeat(64)}` : 'p_fedcba9876543210' };
            fs.rmSync(data.file('assets'), { recursive: true, force: true });
            writeSet(final(), { identity: other });
            writeSet(staging());
            const error = await publishDirectory(staging(), final()).catch((caught: unknown) => caught);
            expect(error, field).toBeInstanceOf(IntegrityError);
            expect((error as IntegrityError).problems.join(' '), field).toContain(field);
        }
    });

    it('lets exactly one of two racing publishers rename, and the other keeps its set', async () => {
        const stagingA = data.file('staging', 'job-a');
        const stagingB = data.file('staging', 'job-b');
        writeSet(stagingA, { seed: 'a' });
        writeSet(stagingB, { seed: 'b' });

        const results = await Promise.all([publishDirectory(stagingA, final()), publishDirectory(stagingB, final())]);

        expect(results.map((result) => result.published).sort()).toEqual([false, true]);
        expect(await verifyDirectory(final(), IDENTITY)).toEqual([]);
        expect(fs.existsSync(stagingA)).toBe(false);
        expect(fs.existsSync(stagingB)).toBe(false);
    });

    it('leaves the staged set untouched and publishes nothing when the rename cannot happen', async () => {
        writeSet(staging());
        const staged = snapshot(staging());
        // A file where the asset folder should be makes the final path impossible to create.
        fs.writeFileSync(data.file('assets'), 'not a directory');

        await expect(publishDirectory(staging(), final())).rejects.toMatchObject({ code: expect.stringMatching(/^(ENOTDIR|EEXIST)$/) });
        expect(snapshot(staging())).toEqual(staged);
        expect(fs.statSync(data.file('assets')).isFile()).toBe(true);
    });

    it('refuses to publish a staged set that does not match its own manifest', async () => {
        writeSet(staging());
        fs.writeFileSync(path.join(staging(), 'w400.webp'), 'torn');
        await expect(publishDirectory(staging(), final())).rejects.toBeInstanceOf(IntegrityError);
        expect(fs.existsSync(final())).toBe(false);
    });

    it('refuses a staging directory without a manifest and a manifest naming a file outside its directory', async () => {
        fs.mkdirSync(staging(), { recursive: true });
        await expect(publishDirectory(staging(), final())).rejects.toThrow(/has no manifest\.json/);

        writeSet(final());
        const manifest = JSON.parse(fs.readFileSync(path.join(final(), MANIFEST_FILE), 'utf8'));
        manifest.variants['../w400'] = manifest.variants.w400;
        fs.writeFileSync(path.join(final(), MANIFEST_FILE), JSON.stringify(manifest));
        expect((await verifyDirectory(final(), IDENTITY)).join(' ')).toContain('Invalid manifest entry');
    });
});

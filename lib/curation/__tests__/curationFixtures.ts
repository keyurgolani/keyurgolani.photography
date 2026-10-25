import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseRevisionFile } from '../../catalog/schema';
import { createTestCatalog, type TestCatalog } from '../../catalog/testing';
import { catalogPaths } from '../../catalog/working-layer';
import { readRegistry, writeRegistry } from '../../identity/registry';
import type { IdentityFact, IdentityFactType, PhotoRecord } from '../../identity/types';
import { versionFile, versionText } from '../../storage/document';
import { withLock, type LockContext } from '../../storage/lock';
import { CURATION_LOCK, curationPaths } from '../repository';

/**
 * Curation test roots: a #13 test catalog (a published and a draft series,
 * both authored), optionally published as the active revision, plus
 * photographs the registry knows and the working layer doesn't, as a new
 * source arrives. Their curator-only EXIF holds GPS and their public tier a
 * serial-like model string, so a test can show neither reaches an authored
 * record or an event.
 */

export const PUBLISHED = 'ser_fixture-00';
export const DRAFT = 'ser_fixture-01';
export const GPS = { latitude: 47.60621, longitude: -122.33207 };
export const SERIAL = 'FIXTURE-SERIAL-0042';
const FIXTURE_TIME = '2026-01-01T00:00:00.000Z';

export interface CurationFixture {
    catalog: TestCatalog;
    root: string;
    /** Photo IDs the registry holds and the working layer doesn't. */
    fresh: string[];
    revisionOf(photoId: string): string;
    /** A fact as #10's reconcile commits it. */
    fact(type: IdentityFactType, photoId: string | null, extra?: Partial<IdentityFact>): IdentityFact;
    cleanup(): Promise<void>;
}

const hex = (text: string) => createHash('sha256').update(text).digest('hex');

export function fixtureUuid(n: number): string {
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export async function createCurationFixture({ published = false, fresh = 2, seed = 41 }: { published?: boolean; fresh?: number; seed?: number } = {}): Promise<CurationFixture> {
    const catalog = await createTestCatalog({
        seed,
        photos: 4,
        series: [{ id: PUBLISHED, photos: 2, visibility: 'published' }, { id: DRAFT, photos: 2, visibility: 'draft' }],
    });
    const root = catalog.root;
    const registry = await readRegistry(root);
    const ids: string[] = [];
    for (let index = 0; index < fresh; index++) {
        const photoId = `ph_${fixtureUuid(9000 + index)}`;
        const assetRevision = `sha256-${hex(`fresh:${seed}:${index}`)}`;
        const sourcePath = `trips/harbor-${index + 1}.jpg`;
        const record: PhotoRecord = {
            photoId,
            createdAt: FIXTURE_TIME,
            source: { path: sourcePath, key: sourcePath.toLowerCase(), present: true, observedRevision: assetRevision, lastSeenAt: FIXTURE_TIME },
            sourceHealth: 'present',
            duplicateOf: null,
            revisions: {
                [assetRevision]: {
                    assetRevision,
                    pixelDigest: `sha256-${hex(`fresh-pixels:${seed}:${index}`)}`,
                    firstSeenAt: FIXTURE_TIME,
                    firstSeenPath: sourcePath,
                    sourceBytes: 2_000_000 + index,
                    sourceFormat: 'jpeg',
                    width: 3000,
                    height: 2000,
                    orientation: 1,
                    derived: {
                        extractorVersion: 1,
                        technical: { Make: { value: 'Fixture Make', source: 'fixture' }, Model: { value: `Fixture Model ${SERIAL}`, source: 'fixture' } },
                        capturedDate: { value: `2024-06-0${index + 1}`, source: 'fixture' },
                    },
                    curatorOnly: {
                        extractorVersion: 1,
                        gps: { value: GPS, source: 'fixture' },
                        dateTimeOriginal: { value: `2024-06-0${index + 1}T05:06:07`, source: 'fixture' },
                        artist: { value: 'Fixture Artist', source: 'fixture' },
                    },
                    profiles: { [catalog.profileId]: { state: 'pending', attempts: 0 } },
                },
            },
        };
        registry.photos[photoId] = record;
        ids.push(photoId);
    }
    await writeRegistry(root, registry, registry.version);

    if (published) {
        const parsed = parseRevisionFile({ revisionId: catalog.revisionId, schemaVersion: 1, baseRevisionId: null, compiledAt: FIXTURE_TIME, content: catalog.content });
        if (!parsed.ok) throw new Error(`The fixture revision is invalid: ${JSON.stringify(parsed.error.issues)}`);
        const paths = catalogPaths(root);
        fs.mkdirSync(paths.revisionsDir, { recursive: true });
        fs.writeFileSync(path.join(paths.revisionsDir, `${catalog.revisionId}.json`), `${JSON.stringify(parsed.value, null, 2)}\n`);
        fs.mkdirSync(paths.active, { recursive: true });
        fs.writeFileSync(versionFile(paths.active, 1), versionText({ schemaVersion: 1, revisionId: catalog.revisionId, activationId: `act_${fixtureUuid(1)}` }, 1));
    }

    const revisionOf = (photoId: string) => {
        const photo = registry.photos[photoId];
        if (!photo) throw new Error(`No fixture photo ${photoId}`);
        return photo.source.observedRevision;
    };
    return {
        catalog,
        root,
        fresh: ids,
        revisionOf,
        fact(type, photoId, extra = {}) {
            const assetRevision = extra.assetRevision ?? (photoId ? revisionOf(photoId) : `sha256-${hex(`unbound:${type}`)}`);
            const sourcePath = extra.path ?? (photoId ? registry.photos[photoId].source.path : 'trips/unbound.heic');
            return {
                type,
                factId: randomUUID(),
                key: `${type}:${photoId ?? assetRevision}:${assetRevision}`,
                photoId,
                assetRevision,
                path: sourcePath,
                folder: path.posix.dirname(sourcePath) === '.' ? '' : path.posix.dirname(sourcePath),
                observedAt: '2026-02-01T00:00:00.000Z',
                ...extra,
            };
        },
        cleanup: () => catalog.cleanup(),
    };
}

/** Write `curation/rules.json` the way the owner would. */
export function writeRules(root: string, rules: unknown): void {
    fs.mkdirSync(curationPaths(root).dir, { recursive: true });
    fs.writeFileSync(curationPaths(root).rules, typeof rules === 'string' ? rules : `${JSON.stringify(rules, null, 2)}\n`);
}

/** Run `fn` holding the curation lock, as the watcher or another curator would. */
export function holdingCuration<T>(root: string, fn: (hold: LockContext) => Promise<T>): Promise<T> {
    return withLock(CURATION_LOCK, { root, waitMs: 1_000 }, fn);
}

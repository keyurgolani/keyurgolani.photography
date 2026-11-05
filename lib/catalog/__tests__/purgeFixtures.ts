import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStoredRegistry, writeRegistry } from '../../identity/registry';
import { versionFile, versionText } from '../../storage/document';
import type { CurationEvent } from '../../curation/events';
import { publish } from '../publish';
import { runSequenceCommand } from '../sequence-commands';
import { createTestCatalog, type TestCatalog } from '../testing';
import { tombstoneFile, revokeFile, type Tombstone } from '../tombstones';
import { readWorkingLayer } from '../working-layer';
import { writeAuthoredRecord } from '../working-layer-writer';
import { VARIANT_BYTES } from './catalogFixtures';

/**
 * #181's A10 fixtures: a data root with three published revisions, every
 * case #15's purge and GC rules name, built once and copied for each test.
 * Test values only.
 *
 * - A: in the live revision and the draft series.
 * - B: live at B2, a second asset revision the record pins now. B1, its
 *   first, only older revisions show. The draft series lists B, at B2.
 * - C: in the draft series, put back after the live revision left it out.
 * - D: shown only by revision 1, its candidate, and its own record.
 */

export const quiet = { log: () => undefined };

/** A second asset revision for B, as a replacement would add it. */
export const B2 = `sha256-${'b2'.repeat(32)}`;

export interface PurgeFixture {
    catalog: TestCatalog;
    root: string;
    seriesId: string;
    profileId: string;
    a: string;
    b: string;
    c: string;
    d: string;
    /** Each photo's first asset revision, the one createTestCatalog made. */
    first: Record<string, string>;
    /** Revision IDs, by number. */
    revisions: { 1: string; 2: string; 3: string };
}

async function check(result: { exitCode: number; output: string }): Promise<void> {
    if (result.exitCode !== 0) throw new Error(`A fixture step failed: ${result.output}`);
}

async function published(root: string, confirmLaunch = false): Promise<string> {
    const result = await publish({ dataRoot: root, actor: 'test', confirmLaunch, logger: quiet });
    if (result.outcome !== 'PUBLISHED' || !result.revisionId) throw new Error(`Publishing ended ${result.outcome}: ${result.message}`);
    return result.revisionId;
}

/** Give `photoId` a second asset revision, B2, with a ready set copied from its first, and pin it in its record. */
async function secondRevision(root: string, photoId: string, firstRevision: string, profileId: string): Promise<void> {
    const stored = await readStoredRegistry(root);
    if (!stored) throw new Error('The fixture has no registry.');
    const registry = structuredClone(stored.registry);
    const photo = registry.photos[photoId];
    photo.revisions[B2] = { ...structuredClone(photo.revisions[firstRevision]), assetRevision: B2 };
    photo.source.observedRevision = B2;
    await writeRegistry(root, registry, stored.registry.version);
    const from = path.join(root, 'assets', photoId, firstRevision, profileId);
    const to = path.join(root, 'assets', photoId, B2, profileId);
    fs.cpSync(from, to, { recursive: true });
    const manifestFile = path.join(to, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { assetRevision: string };
    manifest.assetRevision = B2;
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const record = (await readWorkingLayer(root)).photos.find((each) => each.id === photoId);
    if (!record) throw new Error(`No record for ${photoId}.`);
    await writeAuthoredRecord({ ...record, assetRevision: B2 }, { expectedVersion: record.version, root });
}

/**
 * Revision 1 shows A, B1, C and D. Revision 2 leaves out C and D. Revision 3,
 * live, shows A and B2. Then C goes back into the draft series, unpublished.
 */
export async function buildPurgeFixture(seed: number, root: string): Promise<Omit<PurgeFixture, 'catalog'> & { catalog: TestCatalog }> {
    const catalog = await createTestCatalog({ seed, photos: 4, series: 1, variantBytes: VARIANT_BYTES, root });
    const [a, b, c, d] = catalog.photos.map((photo) => photo.id);
    const seriesId = catalog.series[0].id;
    const first = Object.fromEntries(catalog.photos.map((photo) => [photo.id, photo.assetRevision]));
    const one = await published(root, true);
    await check(await runSequenceCommand({ dataRoot: root }, { command: 'remove', seriesId, photoId: d }));
    await check(await runSequenceCommand({ dataRoot: root }, { command: 'remove', seriesId, photoId: c }));
    const two = await published(root);
    await secondRevision(root, b, first[b], catalog.profileId);
    const three = await published(root);
    await check(await runSequenceCommand({ dataRoot: root }, { command: 'insert', seriesId, photoId: c, at: 'end' }));
    return { catalog, root, seriesId, profileId: catalog.profileId, a, b, c, d, first, revisions: { 1: one, 2: two, 3: three } };
}

const templates = new Map<number, Promise<Omit<PurgeFixture, 'root'> & { root: string }>>();
const templateDirs: string[] = [];

/** Remove the templates this file built. Call it from afterAll. */
export function cleanupPurgeTemplates(): void {
    for (const dir of templateDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    templates.clear();
}

/** A fresh copy of the fixture for `seed`, built once per test file. The caller cleans it up. */
export async function purgeFixture(seed: number): Promise<PurgeFixture & { cleanup(): void }> {
    if (!templates.has(seed)) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-template-'));
        templateDirs.push(dir);
        templates.set(seed, buildPurgeFixture(seed, path.join(dir, 'data')));
    }
    const template = await (templates.get(seed) as Promise<PurgeFixture>);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-fixture-'));
    const root = path.join(dir, 'data');
    fs.cpSync(template.root, root, { recursive: true, preserveTimestamps: true });
    return { ...template, root, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A tombstone written straight to disk, as purge would, to set up what purge itself refuses. */
export function writeTombstone(root: string, fields: Partial<Tombstone> & Pick<Tombstone, 'photoId' | 'assetRevisions'>, n = 1): Tombstone {
    const tombstone: Tombstone = {
        tombstoneId: `tomb_00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
        assetRevision: null,
        actor: 'test',
        reason: 'a test takedown',
        createdAt: '2026-10-01T00:00:00.000Z',
        ...fields,
    };
    fs.mkdirSync(path.dirname(tombstoneFile(root, tombstone.tombstoneId)), { recursive: true });
    fs.writeFileSync(tombstoneFile(root, tombstone.tombstoneId), `${JSON.stringify(tombstone, null, 2)}\n`);
    return tombstone;
}

export function writeRevoke(root: string, tombstoneId: string, createdAt = '2026-10-02T00:00:00.000Z'): void {
    fs.writeFileSync(revokeFile(root, tombstoneId), `${JSON.stringify({ tombstoneId, actor: 'test', reason: 'a test revoke', createdAt }, null, 2)}\n`);
}

/** An open Inbox item naming `photoId` at `assetRevision`, as the watcher would leave a replacement. */
export function writeOpenEvent(root: string, photoId: string, assetRevision: string, status: CurationEvent['status'] = 'open', n = 1): CurationEvent {
    const event: CurationEvent = {
        schemaVersion: 1,
        version: 1,
        id: `evt_${n.toString(16).padStart(24, '0')}`,
        key: `replaced:${photoId}:${assetRevision}`,
        type: 'replacement',
        photoId,
        sourceFingerprint: `fp_${'c'.repeat(64)}`,
        assetRevision,
        observedAt: '2026-10-01T00:00:00.000Z',
        lastObservedAt: '2026-10-01T00:00:00.000Z',
        factIds: ['fact-1'],
        status,
        derivedFacts: { factType: 'replaced', sourcePath: 'fixture-replaced.jpg', folder: '' },
        suggestions: { series: null, placement: null },
        edits: null,
        decisions: [],
        reviewedAt: null,
        reviewedBy: null,
    };
    const dir = path.join(root, 'curation', 'events', event.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(versionFile(dir, 1), versionText(event, 1));
    return event;
}

/** A staging folder a build is writing `photoId`'s set into, its manifest already there. */
export function writeStaging(root: string, id: string, ref: { photoId: string; assetRevision: string; profileId: string }): string {
    const dir = path.join(root, 'staging', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'w400.webp'), 'partial');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, ...ref }));
    return dir;
}

/** Every path under `dir`, with its size, so a change anywhere shows. Leaves out locks/. */
export function snapshot(dir: string): Map<string, string> {
    const found = new Map<string, string>();
    const walk = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            const relative = path.relative(dir, full).split(path.sep).join('/');
            if (relative === 'locks') continue;
            const stat = fs.lstatSync(full);
            found.set(relative, entry.isDirectory() ? 'dir' : `${entry.isSymbolicLink() ? 'link' : 'file'} ${stat.size}`);
            if (entry.isDirectory()) walk(full);
        }
    };
    walk(dir);
    return found;
}

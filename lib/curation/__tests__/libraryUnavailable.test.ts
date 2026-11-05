// @vitest-environment node
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { runStatusCommand } from '../../catalog/owner-status';
import { writeWatcherHeartbeat } from '../../identity/heartbeat';
import { readRegistry, writeRegistry } from '../../identity/registry';
import type { IdentityFact, PhotoRecord } from '../../identity/types';
import { versionFile } from '../../storage/document';
import { inboxAlerts } from '../alerts';
import { runCurationCli } from '../commands';
import { eventIdOf, eventKey, type CurationEvent } from '../events';
import { createLibraryReporter, heldMissingIds, LIBRARY_EVENT_ID, readLibraryItem, recordLibraryState } from '../library';
import { eventDir, readEvent } from '../repository';
import { createCurationSink } from '../sink';
import { createCurationFixture, type CurationFixture } from './curationFixtures';

/**
 * A6 (#17): one `library-unavailable` item opens when the library root is
 * missing, empty or unreadable, or when one pass marks at least 20 bound
 * sources and over 10% of them missing. While it is open, the missing items
 * that pass opened are held: they don't count as missing, `--check` fails on
 * the library instead, and each waits until a pass finds the library again
 * or `confirm-missing` runs.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const NOW = Date.parse('2026-02-01T03:00:00.000Z');
const clock = () => NOW;
const iso = (ms: number) => new Date(ms).toISOString();
const ACTOR = 'curator:test';
const OUTAGE = '2026-02-01T02:00:00.000Z';

async function fixture(): Promise<CurationFixture> {
    const f = await createCurationFixture({ published: true });
    cleanups.push(() => f.cleanup());
    await writeWatcherHeartbeat(f.root, { pid: 1, hostname: 'fixture', lastPassAt: iso(NOW - 30_000), lastPassResult: 'committed', passStartedAt: null, heartbeatAt: iso(NOW - 30_000), lastProgressAt: iso(NOW - 30_000), legacyDerivatives: false });
    return f;
}

const hex = (n: number) => n.toString(16).padStart(64, '0');

/** Add `count` present photos to the registry, as if the library held that many more. */
async function addPhotos(f: CurationFixture, count: number): Promise<PhotoRecord[]> {
    const registry = await readRegistry(f.root);
    const template = registry.photos[f.fresh[0]];
    const added: PhotoRecord[] = [];
    for (let index = 0; index < count; index++) {
        const photoId = `ph_00000000-0000-4000-8000-${String(7000 + index).padStart(12, '0')}`;
        const assetRevision = `sha256-${hex(0xa0000 + index)}`;
        const sourcePath = `bulk/photo-${index}.jpg`;
        const revision = { ...template.revisions[template.source.observedRevision], assetRevision, firstSeenPath: sourcePath };
        const record: PhotoRecord = { ...template, photoId, source: { ...template.source, path: sourcePath, key: sourcePath, observedRevision: assetRevision }, revisions: { [assetRevision]: revision } };
        registry.photos[photoId] = record;
        added.push(record);
    }
    await writeRegistry(f.root, registry, registry.version);
    return added;
}

/** Mark `photos` missing in the registry, then deliver one pass's missing facts for them, as #10's pass would. */
async function goMissing(f: CurationFixture, photos: readonly PhotoRecord[], observedAt = OUTAGE): Promise<string[]> {
    const registry = await readRegistry(f.root);
    for (const photo of photos) {
        registry.photos[photo.photoId].source.present = false;
        registry.photos[photo.photoId].sourceHealth = 'missing';
    }
    await writeRegistry(f.root, registry, registry.version);
    const facts: IdentityFact[] = photos.map((photo) => f.fact('missing', photo.photoId, { assetRevision: photo.source.observedRevision, path: photo.source.path, observedAt }));
    await createCurationSink({ root: f.root, logger: quiet })(facts);
    return facts.map((fact) => eventIdOf(eventKey('missing', fact)));
}

async function comeBack(f: CurationFixture, photos: readonly PhotoRecord[]): Promise<void> {
    const registry = await readRegistry(f.root);
    for (const photo of photos) {
        registry.photos[photo.photoId].source.present = true;
        registry.photos[photo.photoId].sourceHealth = 'present';
    }
    await writeRegistry(f.root, registry, registry.version);
}

const record = (f: CurationFixture, state: Parameters<typeof recordLibraryState>[0], at = NOW) => recordLibraryState(state, { root: f.root, clock: () => at, logger: quiet });
const status = (f: CurationFixture, options: { check?: boolean; json?: boolean } = {}) => runStatusCommand({ dataRoot: f.root }, { ...options, clock });
const stamp = (f: CurationFixture, version: number) => (JSON.parse(fs.readFileSync(versionFile(eventDir(f.root, LIBRARY_EVENT_ID), version), 'utf8')) as { schemaVersion: number }).schemaVersion;

describe('the library-unavailable item', () => {
    it('opens once for a missing root, stamped 2, and writes nothing more while nothing changes', async () => {
        const f = await fixture();
        expect(await record(f, { available: false, cause: 'missing' })).toBe('opened');
        const item = await readEvent(f.root, LIBRARY_EVENT_ID) as CurationEvent;
        expect(item).toMatchObject({
            type: 'library-unavailable',
            status: 'open',
            photoId: null,
            assetRevision: null,
            version: 1,
            derivedFacts: { factType: 'library-unavailable', sourcePath: '.', folder: '', library: { cause: 'missing', since: iso(NOW) } },
        });
        // v1.7.0's schema has no such type, so v1.7.x reads it as a newer build's item, not a damaged one.
        expect(stamp(f, 1)).toBe(2);
        expect(await record(f, { available: false, cause: 'missing' }, NOW + 60_000)).toBeNull();
        expect((await readEvent(f.root, LIBRARY_EVENT_ID))?.version).toBe(1);
    });

    it('records a new cause, closes once a pass gets through, and opens again on the next outage', async () => {
        const f = await fixture();
        await record(f, { available: false, cause: 'missing' });
        expect(await record(f, { available: false, cause: 'unreadable', detail: 'EACCES' }, NOW + 1)).toBe('updated');
        expect((await readLibraryItem(f.root))?.derivedFacts.library).toEqual({ cause: 'unreadable', detail: 'EACCES', since: iso(NOW) });
        expect(await record(f, { available: true }, NOW + 2)).toBe('closed');
        const closed = await readLibraryItem(f.root) as CurationEvent;
        expect(closed.status).toBe('resolved');
        expect(closed.decisions.at(-1)).toMatchObject({ action: 'close', by: 'watcher', reason: 'The library is available again.' });
        expect(await record(f, { available: true }, NOW + 3)).toBeNull();
        expect(await record(f, { available: false, cause: 'empty' }, NOW + 4)).toBe('reopened');
        expect(await readLibraryItem(f.root)).toMatchObject({ status: 'open', derivedFacts: { library: { cause: 'empty', since: iso(NOW + 4) } } });
    });

    it('never throws from the watcher hook: a failure is logged and the next pass tries again', async () => {
        const f = await fixture();
        const lines: string[] = [];
        const reporter = createLibraryReporter({ root: `${f.root}-nowhere`, logger: { ...quiet, warn: (line: string) => { lines.push(line); } } });
        await expect(reporter({ available: false, cause: 'missing' })).resolves.toBeUndefined();
        expect(lines).toEqual([expect.stringContaining('library-unavailable')]);
    });
});

describe('photos status --check on an unavailable library', () => {
    it('exits 1 with library-unavailable, and prints held and failure counts', async () => {
        const f = await fixture();
        await record(f, { available: false, cause: 'missing' }, NOW - 600_000);
        const text = await status(f, { check: true });
        expect(text.exitCode).toBe(1);
        expect(text.output).toContain('library unavailable since 2026-02-01T02:50:00.000Z');
        expect(text.output).toMatch(/\nHeld: 0 missing sources\. Builds: 0 retrying, 0 failed for good\.\nCheck: failed\.\n/);
        expect(text.output).toContain('  - The library is unavailable (the library root is missing) since 2026-02-01T02:50:00.000Z, 10 min ago.');
        const json = JSON.parse((await status(f, { check: true, json: true })).output) as { check: { ok: boolean; problems: { code: string }[]; counts: unknown } };
        expect(json.check.problems.map((problem) => problem.code)).toEqual(['library-unavailable']);
        expect(json.check.counts).toEqual({ held: 0, retrying: 0, permanent: 0 });
        expect(JSON.stringify(json.check)).not.toContain(f.root);
    });

    it('passes again once the item closes', async () => {
        const f = await fixture();
        await record(f, { available: false, cause: 'missing' });
        await record(f, { available: true });
        const result = await status(f, { check: true });
        expect(result.exitCode, result.output).toBe(0);
        expect(result.output).toMatch(/\nHeld: 0 missing sources\. Builds: 0 retrying, 0 failed for good\.\nCheck: passed\.\n$/);
    });

    it('counts builds waiting for a retry and builds that failed for good', async () => {
        const f = await fixture();
        const registry = await readRegistry(f.root);
        const [retrying, failed] = f.fresh;
        const entry = (photoId: string) => registry.photos[photoId].revisions[registry.photos[photoId].source.observedRevision].profiles;
        entry(retrying)[f.catalog.profileId] = { state: 'pending', attempts: 1, error: 'ENOSPC', retries: 1, retryAt: iso(NOW + 30_000) };
        entry(failed)[f.catalog.profileId] = { state: 'failed', attempts: 4, error: 'retries-exhausted: ENOSPC' };
        await writeRegistry(f.root, registry, registry.version);
        const json = JSON.parse((await status(f, { check: true, json: true })).output) as { check: { counts: unknown } };
        expect(json.check.counts).toEqual({ held: 0, retrying: 1, permanent: 1 });
        expect((await status(f, { check: true })).output).toContain('\nHeld: 0 missing sources. Builds: 1 retrying, 1 failed for good.\n');
    });
});

describe('one pass that marks many sources missing', () => {
    it('opens the item and holds its missing items at 20 of 36 bound sources', async () => {
        const f = await fixture();
        const added = await addPhotos(f, 30);
        const ids = await goMissing(f, added.slice(0, 20));
        const item = await readLibraryItem(f.root);
        expect(item).toMatchObject({ status: 'open', derivedFacts: { library: { cause: 'mass-missing', since: OUTAGE, missing: 20, bound: 36 } } });
        const alerts = await inboxAlerts(f.root, clock);
        expect(alerts.counts).toMatchObject({ missing: 0, held: 20 });
        expect(alerts.held.map((held) => held.eventId).sort()).toEqual([...ids].sort());
        expect(new Set(heldMissingIds((await Promise.all(ids.map((id) => readEvent(f.root, id)))) as CurationEvent[], item))).toEqual(new Set(ids));

        const text = await status(f, { check: true });
        expect(text.exitCode).toBe(1);
        expect(text.output).toContain(', 20 held');
        expect(text.output).toContain('one pass found 20 of 36 bound sources missing');
        expect(text.output).toContain('\nHeld: 20 missing sources.');
        const json = JSON.parse((await status(f, { check: true, json: true })).output) as { check: { problems: { code: string }[] } };
        // The held items aren't reported as missing: the library is.
        expect(json.check.problems.map((problem) => problem.code)).toEqual(['library-unavailable']);
    });

    it('opens nothing at 19 missing, or at exactly 10%, and those items count as missing', async () => {
        const f = await fixture();
        const added = await addPhotos(f, 30);
        await goMissing(f, added.slice(0, 19));
        expect(await readLibraryItem(f.root)).toBeNull();
        expect((await inboxAlerts(f.root, clock)).counts).toMatchObject({ missing: 19, held: 0 });

        const g = await fixture();
        const many = await addPhotos(g, 194);
        await goMissing(g, many.slice(0, 20));
        expect(await readLibraryItem(g.root)).toBeNull();
        expect((await inboxAlerts(g.root, clock)).counts).toMatchObject({ missing: 20, held: 0 });
    });

    it('holds no missing item opened before the outage', async () => {
        const f = await fixture();
        const added = await addPhotos(f, 30);
        const [earlier] = await goMissing(f, added.slice(0, 1), '2026-02-01T01:00:00.000Z');
        await goMissing(f, added.slice(1, 21));
        const alerts = await inboxAlerts(f.root, clock);
        expect(alerts.missing.map((item) => item.eventId)).toEqual([earlier]);
        expect(alerts.counts.held).toBe(20);
    });

    it('lets confirm-missing release one held item, which then counts as missing', async () => {
        const f = await fixture();
        const added = await addPhotos(f, 30);
        const [first] = await goMissing(f, added.slice(0, 20));
        const event = await readEvent(f.root, first) as CurationEvent;
        const confirmed = await runCurationCli(['confirm-missing', first, '--version', String(event.version)], { dataRoot: f.root }, { PHOTOS_ACTOR: ACTOR });
        expect(confirmed.exitCode, confirmed.output).toBe(0);
        const alerts = await inboxAlerts(f.root, clock);
        expect(alerts.missing.map((item) => item.eventId)).toEqual([first]);
        expect(alerts.counts.held).toBe(19);
    });

    it('stays open while the held sources are still gone, and closes once a pass finds them, releasing what is left', async () => {
        const f = await fixture();
        const added = await addPhotos(f, 30);
        const ids = await goMissing(f, added.slice(0, 20));
        expect(await record(f, { available: true })).toBeNull();
        expect((await readLibraryItem(f.root))?.status).toBe('open');

        // 17 come back; 3 really are gone.
        await comeBack(f, added.slice(0, 17));
        expect(await record(f, { available: true })).toBe('closed');
        const alerts = await inboxAlerts(f.root, clock);
        expect(alerts.counts.held).toBe(0);
        expect(alerts.missing.map((item) => item.eventId).sort()).toEqual(expect.arrayContaining(ids.slice(17)));
    });
});

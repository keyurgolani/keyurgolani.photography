// @vitest-environment node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { folderBytes } from '../../../test/helpers/folderBytes';
import { recordDirectorySyncs } from '../../../test/helpers/directorySyncs';
import { setDataDir } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary } from '../../../test/helpers/tempLibrary';
import { catalogPaths, readAuthoredRecord } from '../../catalog/working-layer';
import { writeAuthoredRecord } from '../../catalog/working-layer-writer';
import { runReconcilePass } from '../../identity/pass';
import { readRegistry, writeRegistry } from '../../identity/registry';
import type { IdentityFact, IdentityFactType } from '../../identity/types';
import { deferEvent, dismissEvent } from '../actions';
import { eventIdOf, eventKey, EVENT_TYPE_FOR_FACT, type CurationEvent } from '../events';
import { curationPaths, eventDir, listEvents, readEvent, writeEvent } from '../repository';
import { createCurationSink } from '../sink';
import { createCurationFixture, DRAFT, GPS, holdingCuration, PUBLISHED, SERIAL, writeRules, type CurationFixture } from './curationFixtures';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const NOW = Date.parse('2026-02-01T00:00:05.000Z');

async function fixture(options: Parameters<typeof createCurationFixture>[0] = {}): Promise<CurationFixture> {
    const created = await createCurationFixture(options);
    cleanups.push(() => created.cleanup());
    return created;
}

const sinkFor = (root: string, extra: Parameters<typeof createCurationSink>[0] = {}) => createCurationSink({ root, clock: () => NOW, logger: quiet, ...extra });

describe('the curation sink', () => {
    it('writes nothing for an empty delivery, and the inbox reads as empty', async () => {
        const f = await fixture();
        await sinkFor(f.root)([]);
        expect(fs.existsSync(curationPaths(f.root).dir)).toBe(false);
        expect(await listEvents(f.root)).toEqual({ events: [], problems: [] });
    });

    it('opens one event per approved type, and none for a rename', async () => {
        const f = await fixture();
        const [photo, other] = f.fresh;
        const facts = [
            f.fact('new', photo),
            f.fact('replaced', f.catalog.photos[0].id, { assetRevision: `sha256-${'a'.repeat(64)}` }),
            f.fact('metadata-changed', f.catalog.photos[1].id, { assetRevision: `sha256-${'b'.repeat(64)}` }),
            f.fact('missing', f.catalog.photos[2].id),
            f.fact('reappeared', f.catalog.photos[3].id),
            f.fact('ambiguous', other, { candidates: [other, f.catalog.photos[0].id] }),
            f.fact('processing-failed', null, { reason: 'unsupported-format', path: 'trips/raw.heic' }),
            f.fact('renamed', photo, { fromPath: 'trips/old.jpg' }),
        ];
        await sinkFor(f.root)(facts);
        const { events, problems } = await listEvents(f.root);
        expect(problems).toEqual([]);
        expect(events.map((event) => event.type).sort()).toEqual(['ambiguous', 'missing', 'new', 'processing-failure', 'reappeared', 'replacement', 'replacement']);
        const failure = events.find((event) => event.type === 'processing-failure') as CurationEvent;
        expect(failure).toMatchObject({ status: 'failed', photoId: null, derivedFacts: { failure: 'unsupported-format', sourcePath: 'trips/raw.heic' } });
        expect(events.filter((event) => event.type !== 'processing-failure').every((event) => event.status === 'open')).toBe(true);
        const ambiguous = events.find((event) => event.type === 'ambiguous') as CurationEvent;
        expect(ambiguous.key.split('|')[1]).toBe(ambiguous.sourceFingerprint);
        expect(EVENT_TYPE_FOR_FACT.renamed).toBeNull();
    });

    it('returns the same event for a fact delivered again, and writes nothing', async () => {
        const f = await fixture();
        const fact = f.fact('new', f.fresh[0]);
        const sink = sinkFor(f.root);
        await sink([fact]);
        const dir = eventDir(f.root, eventIdOf(eventKey('new', fact)));
        const before = folderBytes(dir);
        await sink([fact]);
        await sink([fact, fact]);
        expect(folderBytes(dir)).toEqual(before);
        expect((await listEvents(f.root)).events).toHaveLength(1);
    });

    it('updates the same item when a later pass reports the same evidence, and keeps the curator\'s status', async () => {
        const f = await fixture();
        const first = f.fact('new', f.fresh[0]);
        await sinkFor(f.root)([first]);
        const id = eventIdOf(eventKey('new', first));
        expect(await deferEvent({ root: f.root, eventId: id, expectedVersion: 1, actor: 'curator:test' })).toMatchObject({ ok: true });
        // A new sink instance, as after a watcher restart, reads what the last one wrote.
        await sinkFor(f.root)([{ ...first, factId: 'second-delivery', observedAt: '2026-03-01T00:00:00.000Z' }]);
        const event = await readEvent(f.root, id);
        expect(event).toMatchObject({ version: 3, status: 'deferred', observedAt: first.observedAt, lastObservedAt: '2026-03-01T00:00:00.000Z', factIds: [first.factId, 'second-delivery'] });
        expect((await listEvents(f.root)).events).toHaveLength(1);
    });

    it('keeps derived facts to #10\'s public tier and the library-relative path', async () => {
        const f = await fixture();
        await sinkFor(f.root)([f.fact('new', f.fresh[0])]);
        const [event] = (await listEvents(f.root)).events;
        expect(event.derivedFacts).toEqual({ factType: 'new', sourcePath: 'trips/harbor-1.jpg', folder: 'trips', capturedDate: '2024-06-01', width: 3000, height: 2000, sourceFormat: 'jpeg' });
        const stored = JSON.stringify(folderBytes(curationPaths(f.root).dir));
        expect(stored).not.toContain(String(GPS.latitude));
        expect(stored).not.toContain('Fixture Artist');
        expect(stored).not.toContain(SERIAL);
        expect(stored).not.toContain(f.root);
    });

    it('keeps suggestions apart from decisions, each with its producer, time, confidence, and evidence', async () => {
        const f = await fixture();
        writeRules(f.root, { schemaVersion: 1, series: [{ seriesId: DRAFT, folders: ['trips'] }] });
        await sinkFor(f.root)([f.fact('new', f.fresh[0])]);
        const [event] = (await listEvents(f.root)).events;
        expect(event.suggestions.series).toMatchObject({ value: DRAFT, confidence: 'high', producedAt: new Date(NOW).toISOString(), producedBy: expect.stringMatching(/^rules@[0-9a-f]{12}$/) });
        expect(event.suggestions.series?.evidence.join(' ')).toContain('trips');
        expect(event.suggestions.placement).toMatchObject({ value: 'end', confidence: 'low', producedBy: 'placement@1' });
        expect(event).toMatchObject({ edits: null, decisions: [], reviewedAt: null, reviewedBy: null });
        expect(Object.keys(event.suggestions).sort()).toEqual(['placement', 'series']);
    });

    it('suggests nothing but a draft for other types, and no description for any', async () => {
        const f = await fixture();
        writeRules(f.root, { schemaVersion: 1, series: [{ seriesId: PUBLISHED, filenameTags: ['harbor'] }] });
        await sinkFor(f.root)([f.fact('new', f.fresh[0]), f.fact('missing', f.catalog.photos[0].id)]);
        const events = (await listEvents(f.root)).events;
        const missing = events.find((event) => event.type === 'missing') as CurationEvent;
        expect(missing.suggestions).toEqual({ series: null, placement: null });
        const fresh = events.find((event) => event.type === 'new') as CurationEvent;
        expect(fresh.suggestions.series).toMatchObject({ value: PUBLISHED, confidence: 'medium' });
        expect(JSON.stringify(events)).not.toMatch(/description/i);
    });

    it('makes no network request, with fetch and node:net stubbed to throw', async () => {
        const f = await fixture();
        writeRules(f.root, { schemaVersion: 1, series: [{ seriesId: DRAFT, folders: ['trips'], filenameTags: ['harbor'] }] });
        const refuse = () => {
            throw new Error('network access attempted');
        };
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(refuse);
        const connectSpy = vi.spyOn(net, 'connect').mockImplementation(refuse);
        const createSpy = vi.spyOn(net, 'createConnection').mockImplementation(refuse);
        const socketSpy = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(refuse);
        await sinkFor(f.root)([f.fact('new', f.fresh[0]), f.fact('new', f.fresh[1])]);
        expect((await listEvents(f.root)).events).toHaveLength(2);
        for (const spy of [fetchSpy, connectSpy, createSpy, socketSpy]) expect(spy).not.toHaveBeenCalled();
    });

    it('keeps both events when two deliveries race', async () => {
        const f = await fixture();
        const [a, b] = f.fresh;
        await Promise.all([sinkFor(f.root)([f.fact('new', a)]), sinkFor(f.root)([f.fact('new', b)])]);
        expect((await listEvents(f.root)).events.map((event) => event.photoId).sort()).toEqual([a, b].sort());
    });

    it('loses neither the watcher\'s nor the curator\'s write when they race', async () => {
        const f = await fixture();
        const first = f.fact('new', f.fresh[0]);
        await sinkFor(f.root)([first]);
        const id = eventIdOf(eventKey('new', first));
        const [, deferred] = await Promise.all([
            sinkFor(f.root)([{ ...first, factId: 'again' }]),
            deferEvent({ root: f.root, eventId: id, expectedVersion: 1, actor: 'curator:test' }),
        ]);
        const event = await readEvent(f.root, id) as CurationEvent;
        // The lock puts one first. Either way the watcher's fact is kept, and the deferral either lands or fails as stale.
        expect(event.factIds).toContain('again');
        if (deferred.ok) {
            expect(event).toMatchObject({ status: 'deferred', version: 3 });
        } else {
            expect(deferred).toMatchObject({ ok: false, code: 'stale' });
            expect(event).toMatchObject({ status: 'open', version: 2 });
        }
    });

    it('fails the delivery while the curation lock stays busy, so the facts stay pending', async () => {
        const f = await fixture();
        await holdingCuration(f.root, async () => {
            await expect(sinkFor(f.root, { waitMs: 0 })([f.fact('new', f.fresh[0])])).rejects.toThrow(/curation/);
        });
        expect((await listEvents(f.root)).events).toEqual([]);
    });

    it('fails the delivery when the data root is not ready', async () => {
        const f = await fixture();
        fs.rmSync(path.join(f.root, 'data-root.json'));
        await expect(sinkFor(f.root)([f.fact('new', f.fresh[0])])).rejects.toThrow(/not ready|uninitialized/);
    });

    it('skips an event it can\'t read and records the rest', async () => {
        const f = await fixture();
        const [a, b] = f.fresh;
        const factA = f.fact('new', a);
        await sinkFor(f.root)([factA]);
        const dir = eventDir(f.root, eventIdOf(eventKey('new', factA)));
        fs.writeFileSync(path.join(dir, 'v1.json'), '{ not json');
        const errors: string[] = [];
        await createCurationSink({ root: f.root, logger: { ...quiet, error: (line: string) => errors.push(line) } })([{ ...factA, factId: 'again' }, f.fact('new', b)]);
        expect(errors).toEqual([expect.stringMatching(/can't be used.*skipped and not delivered again/)]);
        expect(errors[0]).not.toContain(f.root);
        const { events, problems } = await listEvents(f.root);
        expect(events.map((event) => event.photoId)).toEqual([b]);
        expect(problems).toEqual([expect.objectContaining({ reason: 'invalid-json' })]);
    });

    it.each<IdentityFactType>(['new', 'missing', 'processing-failed'])('names its event folder only from a checked ID for a %s fact', async (type) => {
        const f = await fixture();
        await sinkFor(f.root)([f.fact(type, type === 'processing-failed' ? null : f.fresh[0], { path: '../../escape/../x.jpg', folder: '../../escape' })]);
        expect(fs.readdirSync(curationPaths(f.root).events)).toEqual([expect.stringMatching(/^evt_[0-9a-f]{24}$/)]);
        expect(fs.existsSync(path.join(f.root, '..', 'escape'))).toBe(false);
    });
});

describe('a fact the sink can\'t shape', () => {
    it('is skipped by factId while the rest deliver, so a pass clears it and asks for no other', async () => {
        const f = await fixture();
        const errors: string[] = [];
        const good = f.fact('new', f.fresh[0]);
        const unknownType = { ...f.fact('new', f.fresh[1]), type: 'future-type' } as unknown as IdentityFact;
        const badRevision = { ...f.fact('new', f.fresh[1]), assetRevision: 'sha256-short', key: 'new:x:sha256-short' };
        const noPath = { ...f.fact('missing', f.catalog.photos[0].id), path: undefined } as unknown as IdentityFact;
        const sink = createCurationSink({ root: f.root, logger: { ...quiet, error: (line: string) => errors.push(line), warn: (line: string) => errors.push(line) } });
        await expect(sink([unknownType, good, badRevision, noPath])).resolves.toBeUndefined();
        const { events } = await listEvents(f.root);
        expect(events.map((event) => event.photoId)).toEqual([f.fresh[0]]);
        expect(events[0].factIds).toEqual([good.factId]);
        for (const fact of [unknownType, badRevision, noPath]) expect(errors.join('\n')).toContain(fact.factId);
        expect(errors.join('\n')).not.toContain(f.root);
    });

    it('leaves no pending fact behind after a watcher pass, so check() asks for no 30 s re-pass', async () => {
        const f = await fixture();
        const lib = await createTempLibrary();
        cleanups.push(() => lib.cleanup());
        const restore = setDataDir(f.root);
        cleanups.push(async () => restore());
        const registry = await readRegistry(f.root);
        const bad = { ...f.fact('new', f.fresh[0]), type: 'future-type' } as unknown as IdentityFact;
        const odd = { ...f.fact('new', f.fresh[1]), assetRevision: 'sha256-short' };
        await writeRegistry(f.root, { ...registry, pendingFacts: [bad, odd, f.fact('new', f.fresh[0])] }, registry.version);
        const outcome = await runReconcilePass({ sinks: [createCurationSink({ logger: quiet })], clearDelivered: true, logger: quiet, clock: () => Date.now() + 60_000 });
        expect(outcome.status).toBe('committed');
        expect((await readRegistry(f.root)).pendingFacts).toEqual([]);
        expect((await listEvents(f.root)).events.some((event) => event.photoId === f.fresh[0] && event.type === 'new')).toBe(true);
    });
});

describe('a missing source that comes back as missing', () => {
    it('reopens a dismissed item once something references the photo, and says why', async () => {
        const f = await fixture({ published: true });
        const photoId = f.fresh[0];
        const first = f.fact('missing', photoId);
        await sinkFor(f.root)([first]);
        const id = eventIdOf(eventKey('missing', first));
        expect(await dismissEvent({ root: f.root, eventId: id, expectedVersion: 1, actor: 'curator:test', reason: 'Not used anywhere.' })).toMatchObject({ ok: true });
        // Unreferenced, a repeat stays dismissed.
        await sinkFor(f.root)([{ ...first, factId: 'again-1' }]);
        expect(await readEvent(f.root, id)).toMatchObject({ status: 'dismissed', version: 3 });
        const draft = await readAuthoredRecord(f.root, 'series', DRAFT);
        await writeAuthoredRecord({ ...draft!, photoIds: [...(draft?.photoIds ?? []), photoId] }, { expectedVersion: draft?.version ?? 0, root: f.root });
        await sinkFor(f.root)([{ ...first, factId: 'again-2' }]);
        const event = await readEvent(f.root, id);
        expect(event).toMatchObject({ status: 'open', version: 4 });
        expect(event?.decisions.at(-1)).toMatchObject({ action: 'reopen', by: 'watcher', baseRevisionId: f.catalog.revisionId, reason: expect.stringMatching(new RegExp(`series ${DRAFT}`)) });
    });

    it('reopens for the active revision too, and leaves other dismissed types alone', async () => {
        const f = await fixture({ published: true });
        const published = f.catalog.series[0].photoIds[0];
        const missing = f.fact('missing', published);
        const replaced = f.fact('replaced', published, { assetRevision: `sha256-${'e'.repeat(64)}` });
        await sinkFor(f.root)([missing, replaced]);
        // Written by hand as dismissed, as an older build or a hand edit could leave it.
        for (const [fact, type] of [[missing, 'missing'], [replaced, 'replacement']] as const) {
            const id = eventIdOf(eventKey(type, fact));
            const stored = await readEvent(f.root, id) as CurationEvent;
            await holdingCuration(f.root, (hold) => writeEvent(f.root, { ...stored, status: 'dismissed' }, stored.version, hold));
        }
        await sinkFor(f.root)([{ ...missing, factId: 'again-m' }, { ...replaced, factId: 'again-r' }]);
        expect(await readEvent(f.root, eventIdOf(eventKey('missing', missing)))).toMatchObject({ status: 'open', decisions: [expect.objectContaining({ action: 'reopen', reason: expect.stringMatching(/active revision/) })] });
        expect(await readEvent(f.root, eventIdOf(eventKey('replacement', replaced)))).toMatchObject({ status: 'dismissed' });
    });
});

describe('a rename', () => {
    it('refreshes the source path of the photo\'s open items, and of no closed one', async () => {
        const f = await fixture();
        const [a, b] = f.fresh;
        await sinkFor(f.root)([f.fact('new', a), f.fact('new', b)]);
        const idB = eventIdOf(eventKey('new', f.fact('new', b)));
        await dismissEvent({ root: f.root, eventId: idB, expectedVersion: 1, actor: 'curator:test', reason: 'No.' });
        await sinkFor(f.root)([f.fact('renamed', a, { path: 'trips/renamed/a.jpg', folder: 'trips/renamed', fromPath: 'trips/harbor-1.jpg' }), f.fact('renamed', b, { path: 'trips/b.jpg', folder: 'trips', fromPath: 'trips/harbor-2.jpg' })]);
        const { events } = await listEvents(f.root);
        expect(events.find((event) => event.photoId === a)?.derivedFacts).toMatchObject({ sourcePath: 'trips/renamed/a.jpg', folder: 'trips/renamed' });
        expect(events.find((event) => event.photoId === b)?.derivedFacts).toMatchObject({ sourcePath: 'trips/harbor-2.jpg' });
        expect(events).toHaveLength(2);
    });
});

describe('curation/rules.json', () => {
    it.each([
        ['a FIFO', (file: string) => execFileSync('mkfifo', [file])],
        ['a folder', (file: string) => fs.mkdirSync(file)],
        ['a file over the size cap', (file: string) => fs.writeFileSync(file, `{"schemaVersion":1,"series":[]}${' '.repeat(300 * 1024)}`)],
        ['a symlink to a device', (file: string) => fs.symlinkSync('/dev/zero', file)],
    ])('is treated as invalid when it is %s, without blocking the delivery', async (_label, make) => {
        const f = await fixture();
        fs.mkdirSync(curationPaths(f.root).dir, { recursive: true });
        make(curationPaths(f.root).rules);
        const warnings: string[] = [];
        await withTimeout(Promise.resolve(createCurationSink({ root: f.root, logger: { ...quiet, warn: (line: string) => warnings.push(line) } })([f.fact('new', f.fresh[0])])), 5_000);
        const [event] = (await listEvents(f.root)).events;
        expect(event.suggestions.series).toMatchObject({ value: null, producedBy: 'rules@invalid' });
        expect(warnings.join('\n')).toMatch(/rules\.json/);
    });

    it('caps how many series, folders, and tags it holds', async () => {
        const f = await fixture();
        writeRules(f.root, { schemaVersion: 1, series: Array.from({ length: 501 }, (_, index) => ({ seriesId: `ser_s${index}`, folders: ['trips'] })) });
        await sinkFor(f.root)([f.fact('new', f.fresh[0])]);
        expect((await listEvents(f.root)).events[0].suggestions.series).toMatchObject({ producedBy: 'rules@invalid' });
    });
});

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))]);
}

describe('round 2', () => {
    it.skipIf(process.getuid?.() === 0)('fails the delivery on an I/O error reading an event, so the fact retries and the item reopens once it can be read', async () => {
        const f = await fixture({ published: true });
        const published = f.catalog.series[0].photoIds[0];
        const first = f.fact('missing', published);
        await sinkFor(f.root)([first]);
        const id = eventIdOf(eventKey('missing', first));
        const stored = await readEvent(f.root, id) as CurationEvent;
        await holdingCuration(f.root, (hold) => writeEvent(f.root, { ...stored, status: 'dismissed' }, stored.version, hold));
        const dir = eventDir(f.root, id);
        fs.chmodSync(dir, 0o000);
        cleanups.push(async () => fs.chmodSync(dir, 0o700));
        const again = { ...first, factId: 'again-io' };
        await expect(sinkFor(f.root)([again])).rejects.toThrow();
        fs.chmodSync(dir, 0o700);
        await sinkFor(f.root)([again]);
        expect(await readEvent(f.root, id)).toMatchObject({ status: 'open', factIds: expect.arrayContaining(['again-io']), decisions: [expect.objectContaining({ action: 'reopen', by: 'watcher' })] });
    });

    it('reopens once when the data root can\'t tell whether anything references the photo', async () => {
        const f = await fixture({ published: true });
        const photoId = f.fresh[0];
        const first = f.fact('missing', photoId);
        await sinkFor(f.root)([first]);
        const id = eventIdOf(eventKey('missing', first));
        expect(await dismissEvent({ root: f.root, eventId: id, expectedVersion: 1, actor: 'curator:test', reason: 'Not used.' })).toMatchObject({ ok: true });
        const candidates = catalogPaths(f.root).candidatesDir;
        fs.mkdirSync(candidates, { recursive: true });
        fs.writeFileSync(path.join(candidates, 'bad.json'), '{ not json');
        await sinkFor(f.root)([{ ...first, factId: 'cant-tell-1' }]);
        const reopened = await readEvent(f.root, id) as CurationEvent;
        expect(reopened).toMatchObject({ status: 'open', version: 3 });
        expect(reopened.decisions.at(-1)).toMatchObject({ action: 'reopen', by: 'watcher', reason: expect.stringMatching(/can't show whether anything still references/) });
        await sinkFor(f.root)([{ ...first, factId: 'cant-tell-2' }]);
        const later = await readEvent(f.root, id) as CurationEvent;
        expect(later.decisions.filter((decision) => decision.action === 'reopen')).toHaveLength(1);
        expect(await dismissEvent({ root: f.root, eventId: id, expectedVersion: later.version, actor: 'curator:test', reason: 'Still not used.' })).toMatchObject({ ok: false, code: 'damaged' });
    });

    it('rewrites nothing for a rename with no photo ID', async () => {
        const f = await fixture();
        await sinkFor(f.root)([f.fact('processing-failed', null, { reason: 'unsupported-format', path: 'trips/raw.heic' })]);
        const before = folderBytes(curationPaths(f.root).events);
        await sinkFor(f.root)([f.fact('renamed', null, { path: 'trips/other.heic', folder: 'trips', fromPath: 'trips/raw.heic' })]);
        expect(folderBytes(curationPaths(f.root).events)).toEqual(before);
    });
});

describe('event folders, as #49 hardens version folders', () => {
    it('refuses a symlinked event folder, reading or writing, and skips its fact', async () => {
        const f = await fixture();
        const fact = f.fact('new', f.fresh[0]);
        await sinkFor(f.root)([fact]);
        const id = eventIdOf(eventKey('new', fact));
        const dir = eventDir(f.root, id);
        const elsewhere = path.join(f.root, 'elsewhere');
        fs.renameSync(dir, elsewhere);
        fs.symlinkSync(elsewhere, dir);
        const before = folderBytes(elsewhere);
        await expect(readEvent(f.root, id)).rejects.toThrow(/symlink/);
        expect((await listEvents(f.root)).problems).toEqual([expect.objectContaining({ id, reason: 'file-name', message: expect.stringMatching(/symlink/) })]);
        const errors: string[] = [];
        await createCurationSink({ root: f.root, logger: { ...quiet, error: (line: string) => errors.push(line) } })([{ ...fact, factId: 'through-link' }]);
        expect(folderBytes(elsewhere)).toEqual(before);
        expect(errors.join('\n')).toMatch(/symlink/);
        expect(errors.join('\n')).not.toContain(f.root);
    });

    it('refuses a dangling symlink in place of an event folder, and writes nothing through it', async () => {
        const f = await fixture();
        const fact = f.fact('new', f.fresh[0]);
        const id = eventIdOf(eventKey('new', fact));
        fs.mkdirSync(curationPaths(f.root).events, { recursive: true });
        const target = path.join(f.root, 'nowhere');
        fs.symlinkSync(target, eventDir(f.root, id));
        await createCurationSink({ root: f.root, logger: quiet })([fact]);
        expect(fs.existsSync(target)).toBe(false);
        expect((await listEvents(f.root)).problems).toEqual([expect.objectContaining({ id, reason: 'file-name' })]);
    });

    it('refuses an event stored as one file, as an old layout would have it', async () => {
        const f = await fixture();
        const fact = f.fact('new', f.fresh[0]);
        const id = eventIdOf(eventKey('new', fact));
        fs.mkdirSync(curationPaths(f.root).events, { recursive: true });
        fs.writeFileSync(`${eventDir(f.root, id)}.json`, '{}');
        await expect(readEvent(f.root, id)).rejects.toThrow(/folder holding v<N>\.json/);
        expect((await listEvents(f.root)).problems).toEqual([expect.objectContaining({ id, reason: 'file-name' })]);
        await createCurationSink({ root: f.root, logger: quiet })([fact]);
        expect(fs.existsSync(eventDir(f.root, id))).toBe(false);
    });

    it('fsyncs every folder above a first event, even ones another writer made', async () => {
        const f = await fixture();
        // Another writer made curation/events/ and crashed before syncing anything.
        fs.mkdirSync(curationPaths(f.root).events, { recursive: true });
        const synced = recordDirectorySyncs();
        const fact = f.fact('new', f.fresh[0]);
        await sinkFor(f.root)([fact]);
        const dir = eventDir(f.root, eventIdOf(eventKey('new', fact)));
        expect(synced).toEqual(expect.arrayContaining([dir, curationPaths(f.root).events, curationPaths(f.root).dir, path.resolve(f.root)]));
    });
});

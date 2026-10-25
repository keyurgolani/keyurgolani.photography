// @vitest-environment node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { folderBytes } from '../../../test/helpers/folderBytes';
import type { IdentityFactType } from '../../identity/types';
import { deferEvent } from '../actions';
import { eventIdOf, eventKey, EVENT_TYPE_FOR_FACT, type CurationEvent } from '../events';
import { curationPaths, eventDir, listEvents, readEvent } from '../repository';
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
        expect(errors).toEqual([expect.stringMatching(/can't be used.*not recorded until it is fixed/)]);
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

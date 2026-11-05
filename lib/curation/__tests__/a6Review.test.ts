// @vitest-environment node
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { runStatusCommand } from '../../catalog/owner-status';
import { writeWatcherHeartbeat, type PassResult } from '../../identity/heartbeat';
import { readRegistry, writeRegistry } from '../../identity/registry';
import type { IdentityFact } from '../../identity/types';
import { requeueIoErrors } from '../../identity/worker';
import { eventIdOf, eventKey, type CurationEvent } from '../events';
import { createLibraryReporter, LIBRARY_EVENT_ID, readLibraryItem, recordLibraryState } from '../library';
import { curationPaths, readEvent } from '../repository';
import { createCurationSink } from '../sink';
import { createCurationFixture, type CurationFixture } from './curationFixtures';

/**
 * A6's review (11-05), on the inbox's side: --check fails closed on the
 * heartbeat's library result, an io-error item closes when the file reads
 * again, the outage requeue is keyed on the outage and survives a restart,
 * a dismissed library item comes back with the next refused pass, and the
 * permanent count leaves superseded builds out.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

const isRoot = process.getuid?.() === 0;
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const NOW = Date.parse('2026-02-01T03:00:00.000Z');
const clock = () => NOW;
const iso = (ms: number) => new Date(ms).toISOString();
const MINUTE = 60_000;

async function fixture(): Promise<CurationFixture> {
    const f = await createCurationFixture({ published: true });
    cleanups.push(() => f.cleanup());
    return f;
}

const beat = (f: CurationFixture, lastPassResult: PassResult, progressAgoMs = 30_000) =>
    writeWatcherHeartbeat(f.root, { pid: 1, hostname: 'fixture', lastPassAt: iso(NOW - 30_000), lastPassResult, passStartedAt: null, heartbeatAt: iso(NOW - 30_000), lastProgressAt: iso(NOW - progressAgoMs), legacyDerivatives: false });
const check = async (f: CurationFixture) => JSON.parse((await runStatusCommand({ dataRoot: f.root }, { check: true, json: true, clock })).output) as { check: { ok: boolean; problems: { code: string; message: string }[]; counts: { permanent: number } } };

describe('review 3: --check fails closed on the heartbeat', () => {
    it.each(['library-unavailable', 'library-empty'] as const)('fails on a last pass of %s with no item to say so', async (result) => {
        const f = await fixture();
        await beat(f, result);
        const { check: verdict } = await check(f);
        expect(verdict.ok).toBe(false);
        expect(verdict.problems.map((problem) => problem.code)).toEqual(['library-unavailable']);
    });

    it('reports the library once when the item and the heartbeat both say it', async () => {
        const f = await fixture();
        await beat(f, 'library-unavailable');
        await recordLibraryState({ available: false, cause: 'missing' }, { root: f.root, clock: () => NOW - MINUTE, logger: quiet });
        expect((await check(f)).check.problems.map((problem) => problem.code)).toEqual(['library-unavailable']);
    });

    it.skipIf(isRoot)("fails when curation/events/ can't be written, so the item never opens", async () => {
        const f = await fixture();
        const events = curationPaths(f.root).events;
        fs.mkdirSync(events, { recursive: true });
        fs.chmodSync(events, 0o500);
        // Before the fixture's own cleanup, which needs the folder writable.
        cleanups.unshift(async () => fs.chmodSync(events, 0o700));
        const warnings: string[] = [];
        await createLibraryReporter({ root: f.root, logger: { ...quiet, warn: (line: string) => { warnings.push(line); } } })({ available: false, cause: 'missing' });
        expect(warnings).toEqual([expect.stringContaining('library-unavailable')]);
        fs.chmodSync(events, 0o700);
        expect(await readLibraryItem(f.root)).toBeNull();
        await beat(f, 'library-unavailable');
        expect((await check(f)).check.problems.map((problem) => problem.code)).toEqual(['library-unavailable']);
    });

    it("doesn't count a refused pass as progress for the stall rule", async () => {
        const f = await fixture();
        // The watcher moves lastProgressAt only on a committed pass, so 40 minutes of refusals stall.
        await beat(f, 'library-unavailable', 40 * MINUTE);
        expect((await check(f)).check.problems.map((problem) => problem.code)).toEqual(['library-unavailable', 'pass-stalled']);
    });
});

describe('review 8: an io-error item closes when the file reads again', () => {
    it('closes as resolved on io-recovered, with the same key', async () => {
        const f = await fixture();
        const photoId = f.fresh[0];
        const failed = f.fact('processing-failed', photoId, { reason: 'io-error' });
        const sink = createCurationSink({ root: f.root, logger: quiet });
        await sink([failed]);
        const id = eventIdOf(eventKey('processing-failure', failed));
        expect(await readEvent(f.root, id)).toMatchObject({ status: 'failed', derivedFacts: { failure: 'io-error' } });
        const back: IdentityFact = { ...f.fact('io-recovered' as IdentityFact['type'], photoId), key: failed.key, assetRevision: failed.assetRevision, observedAt: '2026-02-01T00:10:00.000Z' };
        await sink([back]);
        const closed = await readEvent(f.root, id) as CurationEvent;
        expect(closed.status).toBe('resolved');
        expect(closed.decisions.at(-1)).toMatchObject({ action: 'close', by: 'watcher', reason: 'The file can be read again.' });
        // Delivered again, it changes nothing.
        await sink([back]);
        expect((await readEvent(f.root, id))?.version).toBe(closed.version);
    });
});

describe('review 2a: the outage requeue', () => {
    it('hands the outage id to beforeClose before the item closes, and survives a restart, once per outage', async () => {
        const f = await fixture();
        const registry = await readRegistry(f.root);
        const photo = registry.photos[f.fresh[0]];
        photo.revisions[photo.source.observedRevision].profiles[f.catalog.profileId] = { state: 'failed', attempts: 1, error: "source unreadable: EIO: i/o error, read", requeuedFor: 'clean-pass' };
        await writeRegistry(f.root, registry, registry.version);
        // The outage opens, then the watcher restarts before it ends: a new reporter, the same item.
        await recordLibraryState({ available: false, cause: 'unreadable', detail: 'EIO' }, { root: f.root, clock: () => NOW - 10 * MINUTE, logger: quiet });
        const outage = `${LIBRARY_EVENT_ID}@${iso(NOW - 10 * MINUTE)}`;
        const seen: string[] = [];
        const beforeClose = async (outageId: string) => {
            seen.push(outageId);
            await requeueIoErrors(f.root, { outageId, profileId: f.catalog.profileId, logger: quiet });
        };
        expect(await recordLibraryState({ available: true }, { root: f.root, clock, logger: quiet, beforeClose })).toBe('closed');
        expect(seen).toEqual([outage]);
        const after = await readRegistry(f.root);
        expect(after.photos[f.fresh[0]].revisions[photo.source.observedRevision].profiles[f.catalog.profileId]).toEqual({ state: 'pending', attempts: 1, requeuedFor: outage });
        // The same outage again, as after a crash between the requeue and the close, puts nothing back twice.
        expect(await requeueIoErrors(f.root, { outageId: outage, profileId: f.catalog.profileId, logger: quiet })).toBe(0);
    });
});

describe('review nits', () => {
    it('opens a library item the curator dismissed during the outage again on the next refused pass', async () => {
        const f = await fixture();
        await recordLibraryState({ available: false, cause: 'missing' }, { root: f.root, clock, logger: quiet });
        const item = await readLibraryItem(f.root) as CurationEvent;
        const { runCurationCli } = await import('../commands');
        const dismissed = await runCurationCli(['dismiss', item.id, '--version', String(item.version), '--reason', 'known outage'], { dataRoot: f.root }, { PHOTOS_ACTOR: 'curator:test' });
        expect(dismissed.exitCode, dismissed.output).toBe(0);
        expect(await recordLibraryState({ available: false, cause: 'missing' }, { root: f.root, clock: () => NOW + MINUTE, logger: quiet })).toBe('reopened');
    });

    it("leaves source-superseded out of the permanent count", async () => {
        const f = await fixture();
        const registry = await readRegistry(f.root);
        const [superseded, exhausted] = f.fresh;
        const profiles = (photoId: string) => registry.photos[photoId].revisions[registry.photos[photoId].source.observedRevision].profiles;
        profiles(superseded)[f.catalog.profileId] = { state: 'failed', attempts: 1, error: 'source-superseded' };
        profiles(exhausted)[f.catalog.profileId] = { state: 'failed', attempts: 4, error: 'retries-exhausted: ENOSPC' };
        await writeRegistry(f.root, registry, registry.version);
        await beat(f, 'committed');
        expect((await check(f)).check.counts.permanent).toBe(1);
    });
});

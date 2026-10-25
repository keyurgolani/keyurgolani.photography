// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { emptyRegistry, type AssetRevisionRecord, type ProfileEntry, type Registry } from '../../identity/types';
import { candidateOf, failureOf, owedSettles, replacementEventIds, withCandidate, type CandidateView } from '../candidates';
import type { CurationEvent } from '../events';

const PHOTO = 'ph_00000000-0000-4000-8000-000000000001';
const REV = `sha256-${'b'.repeat(64)}`;
const CURRENT = 'p_00000000000000aa';
const OLDER = 'p_00000000000000bb';
const AT = '2026-03-01T00:00:00.000Z';

function registryWith(profiles: Record<string, ProfileEntry>, extra: Partial<AssetRevisionRecord> = {}): Registry {
    const registry = emptyRegistry();
    registry.photos[PHOTO] = {
        photoId: PHOTO,
        createdAt: AT,
        source: { path: 'a.jpg', key: 'a.jpg', present: true, observedRevision: REV, lastSeenAt: AT },
        sourceHealth: 'present',
        duplicateOf: null,
        revisions: {
            [REV]: {
                assetRevision: REV,
                pixelDigest: null,
                firstSeenAt: AT,
                firstSeenPath: 'a.jpg',
                sourceBytes: 1,
                sourceFormat: 'jpeg',
                width: 10,
                height: 10,
                orientation: null,
                derived: {} as AssetRevisionRecord['derived'],
                curatorOnly: {} as AssetRevisionRecord['curatorOnly'],
                profiles,
                ...extra,
            },
        },
    };
    return registry;
}

function event(status: CurationEvent['status'], candidate?: CurationEvent['candidate']): CurationEvent {
    return {
        schemaVersion: 1,
        version: 1,
        id: replacementEventIds(PHOTO, REV)[0],
        key: 'k',
        type: 'replacement',
        photoId: PHOTO,
        sourceFingerprint: `fp_${'b'.repeat(64)}`,
        assetRevision: REV,
        observedAt: AT,
        lastObservedAt: AT,
        factIds: ['f'],
        status,
        derivedFacts: { factType: 'replaced', sourcePath: 'a.jpg', folder: '' },
        suggestions: { series: null, placement: null },
        edits: null,
        decisions: [],
        reviewedAt: null,
        reviewedBy: null,
        ...(candidate ? { candidate } : {}),
    };
}

describe('candidateOf', () => {
    const cases: [string, Record<string, ProfileEntry>, CandidateView][] = [
        ['ready on the current profile', { [CURRENT]: { state: 'ready', attempts: 1, readyAt: AT }, [OLDER]: { state: 'ready', attempts: 1, readyAt: '2026-04-01T00:00:00.000Z' } }, { state: 'ready', profileId: CURRENT }],
        ['ready on an older profile only, as a revert finds it', { [OLDER]: { state: 'ready', attempts: 1, readyAt: AT } }, { state: 'ready', profileId: OLDER }],
        ['pending while any entry is', { [CURRENT]: { state: 'pending', attempts: 0 }, [OLDER]: { state: 'failed', attempts: 1, error: 'x' } }, { state: 'pending' }],
        ['failed, the current profile first', { [CURRENT]: { state: 'failed', attempts: 2, error: 'integrity: w400.webp is 1 bytes' }, [OLDER]: { state: 'failed', attempts: 1, error: 'x' } }, { state: 'failed', profileId: CURRENT, failure: 'integrity' }],
        ['pending with no entry yet', {}, { state: 'pending' }],
    ];
    it.each(cases)('is %s', (_name, profiles, expected) => {
        expect(candidateOf(registryWith(profiles), PHOTO, REV, CURRENT)).toEqual(expected);
    });

    it('is gone for an unknown or reassigned revision', () => {
        expect(candidateOf(emptyRegistry(), PHOTO, REV, CURRENT)).toEqual({ state: 'gone' });
        expect(candidateOf(registryWith({ [CURRENT]: { state: 'ready', attempts: 1 } }, { reassignedTo: 'ph_x' }), PHOTO, REV, CURRENT)).toEqual({ state: 'gone' });
    });

    it('keeps no failure text, only its class', () => {
        expect(['source-superseded', 'undecodable', 'integrity: /srv/data/assets/x', 'EACCES: permission denied, open /srv/library/a.jpg', undefined].map(failureOf))
            .toEqual(['superseded', 'undecodable', 'integrity', 'build', 'build']);
    });
});

describe('withCandidate', () => {
    const ready = { state: 'ready', profileId: CURRENT } as const;
    const failed = { state: 'failed', profileId: CURRENT, failure: 'build' } as const;

    it('moves the status only when the candidate state moves', () => {
        expect(withCandidate(event('open'), failed, AT)).toMatchObject({ status: 'failed', candidate: { state: 'failed', failure: 'build', at: AT } });
        // Leave in draft sticks: a set that fails afterwards lands only in the candidate.
        expect(withCandidate(event('deferred'), failed, AT)).toMatchObject({ status: 'deferred', candidate: { state: 'failed', failure: 'build', at: AT } });
        expect(withCandidate(event('deferred', { ...failed, at: AT }), { ...failed, failure: 'integrity' }, AT)).toMatchObject({ status: 'deferred', candidate: { failure: 'integrity' } });
        expect(withCandidate(event('failed', { ...failed, at: AT }), ready, AT)).toMatchObject({ status: 'open', candidate: { state: 'ready' } });
        expect(withCandidate(event('deferred', { ...failed, at: AT }), ready, AT)).toMatchObject({ status: 'deferred', candidate: { state: 'ready' } });
        // A curator who deferred a failed item keeps it deferred while it stays failed.
        expect(withCandidate(event('deferred', { ...failed, at: AT }), failed, AT)).toBeNull();
        expect(withCandidate(event('open', { ...ready, at: AT }), ready, AT)).toBeNull();
    });

    it('never touches a settled item, another type, or a set still building', () => {
        expect(withCandidate(event('approved'), ready, AT)).toBeNull();
        expect(withCandidate(event('dismissed'), failed, AT)).toBeNull();
        expect(withCandidate({ ...event('open'), type: 'missing' }, ready, AT)).toBeNull();
        expect(withCandidate(event('open'), { state: 'pending' }, AT)).toBeNull();
        expect(withCandidate(event('open'), { state: 'gone' }, AT)).toBeNull();
    });
});

describe('owedSettles', () => {
    const other = `sha256-${'c'.repeat(64)}`;

    it('hands each owed revision once, and clears only what a settle covered', () => {
        const owed = owedSettles();
        owed.add({ photoId: PHOTO, assetRevision: REV });
        owed.add({ photoId: PHOTO, assetRevision: REV });
        const taken = owed.take();
        expect(taken.refs).toEqual([{ photoId: PHOTO, assetRevision: REV }]);
        // Until a settle covers it, it stays owed.
        expect(owed.take().refs).toEqual([{ photoId: PHOTO, assetRevision: REV }]);
        taken.settled();
        expect(owed.take().refs).toEqual([]);
    });

    it('keeps a revision owed again while a settle ran, since that settle may have read the registry before it', () => {
        const owed = owedSettles();
        owed.add({ photoId: PHOTO, assetRevision: REV });
        const taken = owed.take();
        owed.add({ photoId: PHOTO, assetRevision: REV });
        owed.add({ photoId: PHOTO, assetRevision: other });
        taken.settled();
        expect(owed.take().refs).toEqual([{ photoId: PHOTO, assetRevision: REV }, { photoId: PHOTO, assetRevision: other }]);
    });
});

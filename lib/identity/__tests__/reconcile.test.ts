// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PHOTO_ID_RE } from '../ids';
import { isStillChanging, reconcile, STABILITY_MS } from '../reconcile';
import { emptyRegistry } from '../types';
import { FakeLibrary, image, NOW, PROFILE, Reconciler, revisionOf, sequentialIds } from './reconcileFixtures';

/** A reconciler whose first pass bound each `path: bytes` pair to a new photo. */
function seeded(files: Record<string, string>): Reconciler {
    const r = new Reconciler();
    for (const [path, bytes] of Object.entries(files)) r.library.put(path, image(bytes));
    r.pass();
    return r;
}

describe('reconcile: first sight', () => {
    it('mints one photo per file with a pending profile, a job, and a new fact', () => {
        const r = seeded({ 'a.jpg': 'A', 'series/b.jpg': 'B' });
        expect(r.factSummary()).toEqual(['new a.jpg', 'new series/b.jpg']);
        const a = r.photoAt('a.jpg');
        expect(a.photoId).toMatch(PHOTO_ID_RE);
        expect(a).toMatchObject({ sourceHealth: 'present', duplicateOf: null, source: { present: true, observedRevision: revisionOf('A') } });
        expect(a.revisions[revisionOf('A')]).toMatchObject({ firstSeenPath: 'a.jpg', sourceBytes: 1_000, profiles: { [PROFILE]: { state: 'pending', attempts: 0 } } });
        expect(r.last.jobs).toEqual([
            { photoId: a.photoId, assetRevision: revisionOf('A'), profileId: PROFILE, path: 'a.jpg' },
            { photoId: r.photoAt('series/b.jpg').photoId, assetRevision: revisionOf('B'), profileId: PROFILE, path: 'series/b.jpg' },
        ]);
        const fact = r.last.facts.find((candidate) => candidate.path === 'series/b.jpg');
        expect(fact).toEqual({
            type: 'new',
            key: `new:${r.photoAt('series/b.jpg').photoId}:${revisionOf('B')}`,
            photoId: r.photoAt('series/b.jpg').photoId,
            assetRevision: revisionOf('B'),
            path: 'series/b.jpg',
            folder: 'series',
            observedAt: '2026-06-01T12:00:00.000Z',
        });
    });

    it('is pure: the input registry is untouched and a second identical pass changes nothing', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const frozen = structuredClone(r.registry);
        const again = reconcile(r.library.scan(), r.registry, r.library.lookup, { idGen: sequentialIds(100), profileId: PROFILE });
        expect(r.registry).toEqual(frozen);
        expect(again.facts).toEqual([]);
        expect(again.jobs).toEqual([]);
        expect(again.registry.photos).toEqual(frozen.photos);
    });

    it('points a duplicate at the photo first seen at the earliest path when photos share a creation time, whatever their IDs', () => {
        // IDs that count down, so ID order and path order disagree.
        let next = 99;
        const idGen = () => `00000000-0000-4000-8000-${String(next--).padStart(12, '0')}`;
        const library = new FakeLibrary().put('a.jpg', image('A')).put('b.jpg', image('A'));
        const first = reconcile(library.scan(), emptyRegistry(), library.lookup, { idGen, profileId: PROFILE });
        const at = (registry: typeof first.registry, path: string) => Object.values(registry.photos).find((photo) => photo.source.path === path);
        const [a, b] = [at(first.registry, 'a.jpg'), at(first.registry, 'b.jpg')];
        expect(b?.duplicateOf).toBe(a?.photoId);
        expect((a?.photoId ?? '') > (b?.photoId ?? '')).toBe(true);

        // A minute later, a.jpg's photo moves past b.jpg by name, with a metadata edit, so its newest
        // revision was first seen at z.jpg. It was still first seen at a.jpg.
        const minutesLater = (minutes: number) => ({ ...library.scan(), observedAt: NOW + minutes * 60_000 });
        library.remove('a.jpg').put('z.jpg', image('A, edited', { pixels: 'A' }));
        const second = reconcile(minutesLater(1), first.registry, library.lookup, { idGen, profileId: PROFILE });
        expect(second.facts).toMatchObject([{ type: 'metadata-changed', photoId: a?.photoId, path: 'z.jpg' }]);

        library.put('c.jpg', image('A'));
        const third = reconcile(minutesLater(2), second.registry, library.lookup, { idGen, profileId: PROFILE });
        expect(at(third.registry, 'c.jpg')?.duplicateOf).toBe(a?.photoId);
        expect(third.facts).toMatchObject([{ type: 'new', path: 'c.jpg', duplicateOf: a?.photoId }]);
    });

    it('keeps duplicate bytes as separate records, the later one pointing at the earlier', () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'A' });
        const [a, b] = [r.photoAt('a.jpg'), r.photoAt('b.jpg')];
        expect(a.photoId).not.toBe(b.photoId);
        expect(a.duplicateOf).toBeNull();
        expect(b.duplicateOf).toBe(a.photoId);
        expect(r.last.facts.find((fact) => fact.path === 'b.jpg')).toMatchObject({ type: 'new', duplicateOf: a.photoId });
    });
});

describe('reconcile: the identity table', () => {
    it('row 1: a bound path holding its observed revision changes nothing', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const before = r.photoAt('a.jpg');
        r.pass();
        expect(r.last.facts).toEqual([]);
        expect(r.photoAt('a.jpg')).toEqual(before);
    });

    it('row 2: an older revision back at its path repoints and reuses its derivatives', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        r.registry.photos[id].revisions[revisionOf('A')].profiles[PROFILE] = { state: 'ready', attempts: 1, readyAt: 'then' };
        r.library.put('a.jpg', image('B'));
        r.pass();
        r.library.put('a.jpg', image('A'));
        r.pass();

        expect(r.last.facts).toMatchObject([{ type: 'replaced', photoId: id, assetRevision: revisionOf('A'), revert: true }]);
        expect(r.photo(id).source.observedRevision).toBe(revisionOf('A'));
        expect(Object.keys(r.photo(id).revisions).sort()).toEqual([revisionOf('A'), revisionOf('B')].sort());
        expect(r.last.jobs).toEqual([]);
    });

    it('row 2: a revert requeues a revision whose build was superseded', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        r.library.put('a.jpg', image('B'));
        r.pass();
        r.registry.photos[id].revisions[revisionOf('A')].profiles[PROFILE] = { state: 'failed', attempts: 1, error: 'source-superseded' };
        r.library.put('a.jpg', image('A'));
        r.pass();
        expect(r.photo(id).revisions[revisionOf('A')].profiles[PROFILE]).toEqual({ state: 'pending', attempts: 0 });
        expect(r.last.jobs).toEqual([{ photoId: id, assetRevision: revisionOf('A'), profileId: PROFILE, path: 'a.jpg' }]);
    });

    it('row 3: new bytes with the same pixels are a metadata edit on the same photo', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        r.library.put('a.jpg', image('A with new EXIF', { pixels: 'A' }));
        r.pass();
        expect(r.last.facts).toMatchObject([{ type: 'metadata-changed', photoId: id, assetRevision: revisionOf('A with new EXIF') }]);
        expect(r.photo(id).source.observedRevision).toBe(revisionOf('A with new EXIF'));
        expect(r.last.jobs).toHaveLength(1);
    });

    it('row 4: new bytes at the path while the old bytes sit at an unbound path holds both', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        r.library.put('a.jpg', image('C')).put('copy-of-a.jpg', image('A'));
        r.pass();
        expect(r.factSummary()).toEqual(['ambiguous a.jpg', 'ambiguous copy-of-a.jpg']);
        expect(r.registry.holds).toEqual([
            { path: 'a.jpg', assetRevision: revisionOf('C'), candidates: [id], since: '2026-06-01T12:00:00.000Z' },
            { path: 'copy-of-a.jpg', assetRevision: revisionOf('A'), candidates: [id], since: '2026-06-01T12:00:00.000Z' },
        ]);
        expect(r.photo(id)).toMatchObject({ sourceHealth: 'ambiguous', source: { path: 'a.jpg', observedRevision: revisionOf('A') } });
        expect(Object.keys(r.photo(id).revisions)).toEqual([revisionOf('A')]);
        expect(Object.keys(r.registry.photos)).toHaveLength(1);
    });

    it('row 5: new bytes and new pixels are a replacement that keeps the photoId and the old revision', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        r.library.put('a.jpg', image('C'));
        r.pass();
        expect(r.last.facts).toMatchObject([{ type: 'replaced', photoId: id, assetRevision: revisionOf('C') }]);
        expect(r.last.facts[0].revert).toBeUndefined();
        expect(r.photo(id).source.observedRevision).toBe(revisionOf('C'));
        expect(Object.keys(r.photo(id).revisions).sort()).toEqual([revisionOf('A'), revisionOf('C')].sort());
        expect(r.last.jobs).toEqual([{ photoId: id, assetRevision: revisionOf('C'), profileId: PROFILE, path: 'a.jpg' }]);
    });

    it("row 6: a bound path holding another photo's bytes is held with both as candidates", () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'B' });
        const [x, y] = [r.photoAt('a.jpg').photoId, r.photoAt('b.jpg').photoId];
        r.library.put('a.jpg', image('B'));
        r.pass();
        expect(r.last.facts).toMatchObject([{ type: 'ambiguous', path: 'a.jpg', photoId: null, candidates: [x, y].sort() }]);
        expect(r.photo(x).sourceHealth).toBe('ambiguous');
        expect(r.photo(y).sourceHealth).toBe('ambiguous');
        expect(r.photo(x).source.observedRevision).toBe(revisionOf('A'));
    });

    it('row 7: bytes of one sourceless photo at a new path rebind it as renamed', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        r.library.move('a.jpg', 'trips/a-renamed.jpg');
        r.pass();
        expect(r.last.facts).toMatchObject([{ type: 'renamed', photoId: id, path: 'trips/a-renamed.jpg', fromPath: 'a.jpg', folder: 'trips' }]);
        expect(r.photo(id)).toMatchObject({ sourceHealth: 'present', source: { path: 'trips/a-renamed.jpg', present: true } });
        expect(r.last.jobs).toEqual([]);
    });

    it('row 7: bytes back at the last path of a missing photo rebind it as reappeared', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        r.library.remove('a.jpg');
        r.pass();
        expect(r.photo(id).sourceHealth).toBe('missing');
        r.library.put('a.jpg', image('A'));
        r.pass();
        expect(r.last.facts).toMatchObject([{ type: 'reappeared', photoId: id, path: 'a.jpg' }]);
        expect(r.last.facts[0].fromPath).toBeUndefined();
        expect(r.photo(id).sourceHealth).toBe('present');
    });

    it('row 8: bytes that belong only to present photos make a new duplicate', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        r.library.put('copy.jpg', image('A'));
        r.pass();
        const copy = r.photoAt('copy.jpg');
        expect(copy.photoId).not.toBe(id);
        expect(copy.duplicateOf).toBe(id);
        expect(r.last.facts).toMatchObject([{ type: 'new', photoId: copy.photoId, duplicateOf: id }]);
    });

    it('row 8: bytes of an archived photo reappearing make a new duplicate of it', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        r.registry.photos[id].sourceHealth = 'archived';
        r.registry.photos[id].source.present = false;
        r.library.move('a.jpg', 'b.jpg');
        r.pass();
        expect(r.photoAt('b.jpg')).toMatchObject({ duplicateOf: id, sourceHealth: 'present' });
        expect(r.photo(id).sourceHealth).toBe('archived');
        expect(r.factSummary()).toEqual(['new b.jpg']);
    });

    it('row 9: bytes matching two sourceless photos are held with both as candidates', () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'A' });
        const [x, y] = [r.photoAt('a.jpg').photoId, r.photoAt('b.jpg').photoId];
        r.library.remove('a.jpg', 'b.jpg');
        r.pass();
        r.library.put('c.jpg', image('A'));
        r.pass();
        expect(r.last.facts).toMatchObject([{ type: 'ambiguous', path: 'c.jpg', photoId: null, candidates: [x, y].sort() }]);
        expect(r.photo(x).sourceHealth).toBe('ambiguous');
        expect(r.photo(y).sourceHealth).toBe('ambiguous');
        expect(Object.keys(r.registry.photos)).toHaveLength(2);
    });

    it("row 9: two unbound paths sharing one photo's bytes fail row 7's uniqueness and are both held", () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        r.library.remove('a.jpg').put('b.jpg', image('A')).put('c.jpg', image('A'));
        r.pass();
        expect(r.factSummary()).toEqual(['ambiguous b.jpg', 'ambiguous c.jpg']);
        expect(r.registry.holds.map((held) => held.candidates)).toEqual([[id], [id]]);
        expect(r.photo(id).sourceHealth).toBe('ambiguous');
    });

    it("row 9: an unbound path sharing only the pixels of a claimed path also fails uniqueness", () => {
        const r = seeded({ 'a.jpg': 'A' });
        r.library.remove('a.jpg').put('b.jpg', image('A')).put('c.jpg', image('A, edited EXIF', { pixels: 'A' }));
        r.pass();
        expect(r.factSummary()).toEqual(['ambiguous b.jpg', 'ambiguous c.jpg']);
    });

    it('row 9: a claim also fails uniqueness when the path sharing its pixels is not itself a claim', () => {
        const r = new Reconciler();
        r.library.put('x.jpg', image('A')).put('z.jpg', image('A, edited EXIF', { pixels: 'A' }));
        r.pass();
        const [x, z] = [r.photoAt('x.jpg').photoId, r.photoAt('z.jpg').photoId];
        // u1 holds sourceless X's bytes. u2 copies present Z, which has the same pixels.
        r.library.remove('x.jpg').put('u1.jpg', image('A')).put('u2.jpg', image('A, edited EXIF', { pixels: 'A' }));
        r.pass();
        expect(r.registry.holds).toMatchObject([{ path: 'u1.jpg', candidates: [x] }]);
        expect(r.photoAt('u2.jpg').duplicateOf).toBe(z);
        expect(r.factSummary()).toEqual(['ambiguous u1.jpg', 'new u2.jpg']);
    });

    it('row 10: unknown bytes matching one sourceless photo by pixels rebind it with a new revision', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        r.library.remove('a.jpg').put('b.jpg', image('A, edited EXIF', { pixels: 'A' }));
        r.pass();
        expect(r.last.facts).toMatchObject([{ type: 'metadata-changed', photoId: id, path: 'b.jpg', fromPath: 'a.jpg' }]);
        expect(r.photo(id).source).toMatchObject({ path: 'b.jpg', observedRevision: revisionOf('A, edited EXIF') });
        expect(r.last.jobs).toHaveLength(1);
    });

    it('row 11: unknown bytes matching a present photo by pixels make a new duplicate', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        r.library.put('b.jpg', image('A, edited EXIF', { pixels: 'A' }));
        r.pass();
        expect(r.photoAt('b.jpg').duplicateOf).toBe(id);
        expect(r.factSummary()).toEqual(['new b.jpg']);
    });

    it('row 12: unknown bytes and pixels make a new photo, noting a missing one that lived at the path', () => {
        const r = seeded({ 'IMG_0001.jpg': 'first shot' });
        const first = r.photoAt('IMG_0001.jpg').photoId;
        r.library.remove('IMG_0001.jpg');
        r.pass();
        // The camera's counter resets and reuses the file name for another photo.
        r.library.put('IMG_0001.jpg', image('second shot'));
        r.pass();
        const second = Object.values(r.registry.photos).find((photo) => photo.photoId !== first);
        expect(second?.source.path).toBe('IMG_0001.jpg');
        expect(r.last.facts).toMatchObject([{ type: 'new', photoId: second?.photoId, samePathAs: first }]);
        expect(r.photo(first)).toMatchObject({ sourceHealth: 'missing', source: { present: false, path: 'IMG_0001.jpg' } });
    });

    it('row 13: a vanished bound path keeps everything and reports missing once', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        const revisions = r.photo(id).revisions;
        r.library.remove('a.jpg');
        r.pass();
        expect(r.last.facts).toMatchObject([{ type: 'missing', photoId: id, assetRevision: revisionOf('A'), path: 'a.jpg' }]);
        expect(r.photo(id)).toMatchObject({ sourceHealth: 'missing', source: { present: false, path: 'a.jpg' } });
        expect(r.photo(id).revisions).toEqual(revisions);
        r.pass();
        expect(r.last.facts).toEqual([]);
    });

    it('row 14: a digest matching a revision of another size is skipped as a collision', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        r.library.put('impostor.jpg', image('A', { size: 2_000 }));
        r.pass();
        expect(r.last.facts).toMatchObject([{ type: 'processing-failed', reason: 'digest-collision', photoId: null, path: 'impostor.jpg' }]);
        expect(Object.keys(r.registry.photos)).toEqual([id]);
        expect(r.last.report.collisions).toEqual(['impostor.jpg']);

        // At a bound path, the photo counts as unchanged.
        r.library.remove('impostor.jpg').put('a.jpg', image('A', { size: 3_000 }));
        r.pass();
        expect(r.last.facts).toMatchObject([{ type: 'processing-failed', reason: 'digest-collision', photoId: id, path: 'a.jpg' }]);
        expect(r.photo(id)).toMatchObject({ sourceHealth: 'present', source: { observedRevision: revisionOf('A') } });
    });

    it('row 14: two new files with one digest and different sizes are both skipped', () => {
        const r = new Reconciler();
        r.library.put('a.jpg', image('A')).put('b.jpg', image('A', { size: 5 }));
        r.pass();
        expect(r.factSummary()).toEqual(['processing-failed a.jpg', 'processing-failed b.jpg']);
        expect(Object.keys(r.registry.photos)).toEqual([]);
    });
});

describe('reconcile: undecodable and unsupported files', () => {
    it('an undecodable file matches by bytes only and gets a failed profile and processing-failed', () => {
        const r = new Reconciler();
        r.library.put('corrupt.jpg', image('corrupt', { pixels: null }));
        r.pass();
        const photo = r.photoAt('corrupt.jpg');
        expect(photo.revisions[revisionOf('corrupt')]).toMatchObject({ pixelDigest: null, width: null, height: null, profiles: { [PROFILE]: { state: 'failed', error: 'undecodable' } } });
        expect(r.factSummary()).toEqual(['new corrupt.jpg', 'processing-failed corrupt.jpg']);
        expect(r.last.facts.find((fact) => fact.type === 'processing-failed')).toMatchObject({ reason: 'undecodable', photoId: photo.photoId });
        expect(r.last.jobs).toEqual([]);

        r.library.move('corrupt.jpg', 'moved.jpg');
        r.pass();
        expect(r.last.facts).toMatchObject([{ type: 'renamed', photoId: photo.photoId }]);
    });

    it('an unsupported image emits processing-failed with no photoId and no record', () => {
        const r = new Reconciler();
        r.library.put('raw/DSC_0001.NEF', { kind: 'unsupported', assetRevision: revisionOf('nef'), sourceBytes: 9 }, { kind: 'unsupported' });
        r.pass();
        expect(r.last.facts).toMatchObject([{ type: 'processing-failed', reason: 'unsupported-format', photoId: null, path: 'raw/DSC_0001.NEF', folder: 'raw' }]);
        expect(r.registry.photos).toEqual({});
        expect(r.last.report.unsupported).toEqual(['raw/DSC_0001.NEF']);
    });

    it('an unreadable file is skipped, but an unreadable bound path counts as unchanged', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        r.library.put('a.jpg', { kind: 'unreadable', error: 'EACCES' }).put('b.jpg', { kind: 'unreadable', error: 'EACCES' });
        r.pass();
        expect(r.last.facts).toEqual([]);
        expect(r.photo(id).sourceHealth).toBe('present');
        expect(r.last.report.unreadable).toEqual(['a.jpg', 'b.jpg']);
    });

    it('photos under a folder that cannot be listed count as unchanged', () => {
        const r = seeded({ 'locked/a.jpg': 'A' });
        r.library.remove('locked/a.jpg');
        r.library.unreadableDirs.push('locked');
        r.pass();
        expect(r.last.facts).toEqual([]);
        expect(r.photoAt('locked/a.jpg').sourceHealth).toBe('present');
    });
});

describe('reconcile: renames, copies, swaps, and unstable files', () => {
    it('a rename seen absent first goes missing, then is renamed back into place', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        // The scan saw the old folder after the move and the new folder before it.
        r.library.remove('a.jpg');
        r.pass();
        expect(r.factSummary()).toEqual(['missing a.jpg']);
        r.library.put('2026/a.jpg', image('A'));
        r.pass();
        expect(r.last.facts).toMatchObject([{ type: 'renamed', photoId: id, fromPath: 'a.jpg', path: '2026/a.jpg' }]);
        expect(r.photo(id).sourceHealth).toBe('present');
    });

    it('a rename seen present first waits for the fresh path, then keeps the photoId', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        // The new path shows up while the old one is still listed, as with a copy then delete.
        r.library.put('2026/a.jpg', image('A'), { fresh: true });
        r.pass();
        expect(r.last.facts).toEqual([]);
        expect(r.last.retryAfterMs).toBe(STABILITY_MS);
        expect(r.last.report.unstable).toEqual(['2026/a.jpg']);
        r.library.remove('a.jpg').settle();
        r.pass();
        expect(r.last.facts).toMatchObject([{ type: 'renamed', photoId: id, path: '2026/a.jpg' }]);
        expect(Object.keys(r.registry.photos)).toEqual([id]);
    });

    it('a copy that kept a future mtime still waits on its fresh ctime, so a copy then delete is a rename', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const id = r.photoAt('a.jpg').photoId;
        // Copied a moment ago with the source's mtime, set a minute ahead by a camera or another host's clock.
        r.library.put('2026/a.jpg', image('A'), { fresh: true, mtimeMs: NOW + 60_000 });
        r.pass();
        expect(r.last.facts).toEqual([]);
        expect(r.last.report.unstable).toEqual(['2026/a.jpg']);
        r.library.remove('a.jpg').settle();
        r.pass();
        expect(r.last.facts).toMatchObject([{ type: 'renamed', photoId: id, path: '2026/a.jpg' }]);
        expect(Object.keys(r.registry.photos)).toEqual([id]);
    });

    it('judges mtime and ctime each on its own, within STABILITY_MS either way', () => {
        const changing = (mtimeMs: number, ctimeMs: number) => isStillChanging({ mtimeMs, ctimeMs }, NOW);
        expect(changing(NOW + 60_000, NOW - 1_000)).toBe(true);
        expect(changing(NOW - 1_000, NOW - 60_000)).toBe(true);
        expect(changing(NOW + 1_000, NOW - 60_000)).toBe(true);
        expect(changing(NOW - 60_000, NOW + 1_000)).toBe(true);
        expect(changing(NOW + 60_000, NOW - 60_000)).toBe(false);
        expect(changing(NOW - 60_000, NOW - 60_000)).toBe(false);
        expect(changing(NOW - STABILITY_MS, NOW - STABILITY_MS)).toBe(false);
    });

    it('a rename made while stopped is one renamed fact and no missing one', () => {
        const r = seeded({ 'a.jpg': 'A' });
        r.library.move('a.jpg', 'b.jpg');
        r.pass();
        expect(r.factSummary()).toEqual(['renamed b.jpg']);
    });

    it('renames a 50-file batch in one pass', () => {
        const files = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`batch/${i}.jpg`, `photo ${i}`]));
        const r = seeded(files);
        const ids = Object.keys(files).map((path) => r.photoAt(path).photoId);
        for (const path of Object.keys(files)) r.library.move(path, path.replace('batch/', 'renamed/'));
        r.pass();
        expect(r.last.facts).toHaveLength(50);
        expect(r.last.facts.every((fact) => fact.type === 'renamed')).toBe(true);
        expect(Object.keys(files).map((path) => r.photoAt(path.replace('batch/', 'renamed/')).photoId)).toEqual(ids);
    });

    it('a fresh file is not read and defers every missing fact until it settles', () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'B' });
        r.library.remove('a.jpg').put('incoming.jpg', image('C'), { fresh: true });
        r.library.inspected.length = 0;
        r.pass();
        expect(r.library.inspected).not.toContain('incoming.jpg');
        expect(r.last.facts).toEqual([]);
        expect(r.last.report.missingDeferred).toBe(true);
        expect(r.photoAt('a.jpg').sourceHealth).toBe('present');

        r.library.settle();
        r.pass();
        expect(r.factSummary()).toEqual(['missing a.jpg', 'new incoming.jpg']);
    });

    it('a file that changed while it was read waits like a fresh one', () => {
        const r = seeded({ 'a.jpg': 'A' });
        r.library.put('b.jpg', { kind: 'changed' });
        r.pass();
        expect(r.last.report.unstable).toEqual(['b.jpg']);
        expect(r.last.retryAfterMs).toBe(STABILITY_MS);
    });

    it("counts only other unbound paths for row 7, so a hold at another photo's bound path leaves a rename a rename", () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'B' });
        const [x, y] = [r.photoAt('a.jpg').photoId, r.photoAt('b.jpg').photoId];
        // b.jpg moves to c.jpg, and a copy of it lands over a.jpg.
        r.library.move('b.jpg', 'c.jpg').put('a.jpg', image('B'));
        r.pass();
        expect(r.factSummary()).toEqual(['ambiguous a.jpg', 'renamed c.jpg']);
        expect(r.photo(y).source).toMatchObject({ path: 'c.jpg', present: true });
        expect(r.registry.holds).toMatchObject([{ path: 'a.jpg', candidates: [x, y].sort() }]);

        // Nothing changes: the rename stands, and only a.jpg waits for a decision.
        r.pass();
        expect(r.last.facts).toEqual([]);
        expect(r.photo(y).source).toMatchObject({ path: 'c.jpg', present: true });
        expect(r.registry.holds.map((held) => held.path)).toEqual(['a.jpg']);
    });

    it('resolves a renumbered series as renames: mv 3 4, mv 2 3, mv 1 2', () => {
        const r = seeded({ '1.jpg': 'A', '2.jpg': 'B', '3.jpg': 'C' });
        const [x1, x2, x3] = ['1.jpg', '2.jpg', '3.jpg'].map((path) => r.photoAt(path).photoId);
        r.library.move('3.jpg', '4.jpg').move('2.jpg', '3.jpg').move('1.jpg', '2.jpg');
        r.pass();
        expect(r.factSummary()).toEqual(['renamed 2.jpg', 'renamed 3.jpg', 'renamed 4.jpg']);
        expect(r.last.facts).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'renamed', photoId: x1, path: '2.jpg', fromPath: '1.jpg' }),
            expect.objectContaining({ type: 'renamed', photoId: x2, path: '3.jpg', fromPath: '2.jpg' }),
            expect.objectContaining({ type: 'renamed', photoId: x3, path: '4.jpg', fromPath: '3.jpg' }),
        ]));
        expect(r.registry.holds).toEqual([]);
        expect(Object.keys(r.registry.photos)).toHaveLength(3);
        expect([x1, x2, x3].map((id) => [r.photo(id).source.path, r.photo(id).sourceHealth])).toEqual([['2.jpg', 'present'], ['3.jpg', 'present'], ['4.jpg', 'present']]);
        r.pass();
        expect(r.last.facts).toEqual([]);
    });

    it('resolves a longer renumbered series in a folder the same way', () => {
        const files = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`trip/${n}.jpg`, `P${n}`]));
        const r = seeded(files);
        const ids = [1, 2, 3, 4, 5].map((n) => r.photoAt(`trip/${n}.jpg`).photoId);
        for (const n of [5, 4, 3, 2, 1]) r.library.move(`trip/${n}.jpg`, `trip/${n + 1}.jpg`);
        r.pass();
        expect(r.factSummary()).toEqual([2, 3, 4, 5, 6].map((n) => `renamed trip/${n}.jpg`));
        expect(r.registry.holds).toEqual([]);
        expect(ids.map((id) => r.photo(id).source.path)).toEqual([2, 3, 4, 5, 6].map((n) => `trip/${n}.jpg`));
    });

    it('never moves a photo twice in one pass, so a copy freed by a later rename is a new duplicate', () => {
        const r = seeded({ '1.jpg': 'A', '2.jpg': 'B', '6.jpg': 'F', '7.jpg': 'G' });
        const [x1, x2, x6, x7] = ['1.jpg', '2.jpg', '6.jpg', '7.jpg'].map((path) => r.photoAt(path).photoId);
        // Two renumberings, and a copy of 1.jpg's bytes lands where 6.jpg's photo left.
        r.library.move('2.jpg', '3.jpg').move('1.jpg', '2.jpg').move('7.jpg', '9.jpg').move('6.jpg', '7.jpg').put('6.jpg', image('A'));
        r.pass();
        expect(r.factSummary()).toEqual(['new 6.jpg', 'renamed 2.jpg', 'renamed 3.jpg', 'renamed 7.jpg', 'renamed 9.jpg']);
        expect([x1, x2, x6, x7].map((id) => r.photo(id).source.path)).toEqual(['2.jpg', '3.jpg', '7.jpg', '9.jpg']);
        expect(r.photoAt('6.jpg').duplicateOf).toBe(x1);
        expect(r.registry.holds).toEqual([]);
    });

    it('holds freed paths that share pixels with each other, as row 7 holds unbound ones', () => {
        const r = new Reconciler();
        r.library.put('a.jpg', image('A1', { pixels: 'P' })).put('b.jpg', image('A2', { pixels: 'P' })).put('c.jpg', image('C')).put('d.jpg', image('D'));
        r.pass();
        const [x1, x2] = [r.photoAt('a.jpg').photoId, r.photoAt('b.jpg').photoId];
        // c.jpg and d.jpg move on, and copies of a.jpg's and b.jpg's bytes, the same pixels, take their places.
        r.library.remove('a.jpg', 'b.jpg').move('c.jpg', 'e.jpg').move('d.jpg', 'f.jpg')
            .put('c.jpg', image('A1', { pixels: 'P' })).put('d.jpg', image('A2', { pixels: 'P' }));
        r.pass();
        expect(r.factSummary()).toEqual(['ambiguous c.jpg', 'ambiguous d.jpg', 'renamed e.jpg', 'renamed f.jpg']);
        expect(r.registry.holds).toMatchObject([{ path: 'c.jpg', candidates: [x1] }, { path: 'd.jpg', candidates: [x2] }]);
    });

    it('reads a move with another photo copied over the old path as a rename and a new duplicate', () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'B' });
        const [x, y] = [r.photoAt('a.jpg').photoId, r.photoAt('b.jpg').photoId];
        r.library.move('a.jpg', 'c.jpg').put('a.jpg', image('B'));
        r.pass();
        expect(r.factSummary()).toEqual(['new a.jpg', 'renamed c.jpg']);
        expect(r.photo(x).source).toMatchObject({ path: 'c.jpg', present: true });
        expect(r.photo(y).source).toMatchObject({ path: 'b.jpg', present: true });
        expect(r.photoAt('a.jpg')).toMatchObject({ duplicateOf: y, sourceHealth: 'present' });
        expect(r.registry.holds).toEqual([]);
    });

    it("never moves a photo off its unchanged path because a copy of its bytes sits on another photo's path", () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'B' });
        const [x, y] = [r.photoAt('a.jpg').photoId, r.photoAt('b.jpg').photoId];
        r.library.put('a.jpg', image('B')).put('c.jpg', image('B'));
        r.pass();
        expect(r.factSummary()).toEqual(['ambiguous a.jpg', 'new c.jpg']);
        expect(r.photo(y).source).toMatchObject({ path: 'b.jpg', present: true });
        expect(r.photoAt('c.jpg').duplicateOf).toBe(y);
        expect(r.registry.holds).toMatchObject([{ path: 'a.jpg', candidates: [x, y].sort() }]);
    });

    it('swapping two photos holds both paths', () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'B' });
        const [x, y] = [r.photoAt('a.jpg').photoId, r.photoAt('b.jpg').photoId];
        r.library.put('a.jpg', image('B')).put('b.jpg', image('A'));
        r.pass();
        expect(r.factSummary()).toEqual(['ambiguous a.jpg', 'ambiguous b.jpg']);
        expect(r.registry.holds.map((held) => held.candidates)).toEqual([[x, y].sort(), [x, y].sort()]);
    });
});

describe('reconcile: case and Unicode', () => {
    it('two present paths differing only by case are both held', () => {
        const r = seeded({ 'IMG.jpg': 'A' });
        const id = r.photoAt('IMG.jpg').photoId;
        r.library.put('img.jpg', image('B'));
        r.pass();
        expect(r.factSummary()).toEqual(['ambiguous IMG.jpg', 'ambiguous img.jpg']);
        expect(r.last.report.keyCollisions).toEqual([['IMG.jpg', 'img.jpg']]);
        expect(r.registry.holds.map((held) => held.candidates)).toEqual([[id], [id]]);
        expect(r.photo(id).sourceHealth).toBe('ambiguous');
    });

    it('a case-only rename updates the path and keeps everything else', () => {
        const r = seeded({ 'IMG.jpg': 'A' });
        const id = r.photoAt('IMG.jpg').photoId;
        r.library.move('IMG.jpg', 'img.JPG');
        r.pass();
        expect(r.last.facts).toEqual([]);
        expect(r.photo(id).source).toMatchObject({ path: 'img.JPG', key: 'img.jpg', present: true });
    });

    it('keeps a key-collision hold while both paths are there, without repeating facts, and renews it for new bytes', () => {
        const r = seeded({ 'IMG.jpg': 'A' });
        r.library.put('img.jpg', image('B'));
        r.pass();
        const holds = r.registry.holds;
        r.pass();
        expect(r.last.facts).toEqual([]);
        expect(r.registry.holds).toEqual(holds);

        // img.jpg is being written, so it can't be read yet.
        r.library.put('img.jpg', image('C'), { fresh: true });
        r.pass();
        expect(r.last.facts).toEqual([]);
        expect(r.registry.holds).toEqual(holds);

        r.library.settle();
        r.pass();
        expect(r.factSummary()).toEqual(['ambiguous img.jpg']);
        expect(r.registry.holds.map((held) => [held.path, held.assetRevision])).toEqual([['IMG.jpg', revisionOf('A')], ['img.jpg', revisionOf('C')]]);
    });

    it('ends a key-collision hold once its key has one path again, so a case-only rename done as copy then delete matches a plain one', () => {
        const plain = seeded({ 'beach.jpg': 'A' });
        plain.library.move('beach.jpg', 'Beach.jpg');
        plain.pass();

        const r = seeded({ 'beach.jpg': 'A' });
        const id = r.photoAt('beach.jpg').photoId;
        r.library.put('Beach.jpg', image('A'));
        r.pass();
        expect(r.factSummary()).toEqual(['ambiguous Beach.jpg', 'ambiguous beach.jpg']);
        expect(r.photo(id).sourceHealth).toBe('ambiguous');

        r.library.remove('beach.jpg');
        r.pass();
        expect(r.last.facts).toEqual([]);
        expect(r.last.jobs).toEqual([]);
        expect(r.registry.holds).toEqual([]);
        expect(r.photo(id)).toMatchObject({ sourceHealth: 'present', source: { path: 'Beach.jpg', present: true } });
        expect(r.photo(id)).toEqual(plain.photo(id));
    });

    it('gives the file left a photo once two new files that differ only by case are down to one', () => {
        const r = new Reconciler();
        r.library.put('a.jpg', image('A')).put('A.jpg', image('B'));
        r.pass();
        expect(r.factSummary()).toEqual(['ambiguous A.jpg', 'ambiguous a.jpg']);
        expect(r.registry.holds.map((held) => held.candidates)).toEqual([[], []]);
        expect(r.registry.photos).toEqual({});

        r.library.remove('A.jpg');
        r.pass();
        expect(r.factSummary()).toEqual(['new a.jpg']);
        expect(r.registry.holds).toEqual([]);
        expect(r.photoAt('a.jpg')).toMatchObject({ sourceHealth: 'present', source: { present: true, observedRevision: revisionOf('A') } });
        expect(r.last.jobs).toHaveLength(1);
    });

    it("keeps a key-collision hold while the other path's folder can't be listed", () => {
        const r = seeded({ 'trip/a.jpg': 'A' });
        const id = r.photoAt('trip/a.jpg').photoId;
        r.library.put('Trip/a.jpg', image('B'));
        r.pass();
        expect(r.factSummary()).toEqual(['ambiguous Trip/a.jpg', 'ambiguous trip/a.jpg']);

        // trip/ can't be listed, so its file may still be there. Meanwhile it is deleted.
        r.library.remove('trip/a.jpg');
        r.library.unreadableDirs.push('trip');
        r.pass();
        expect(r.last.facts).toEqual([]);
        expect(r.last.report.keyCollisions).toEqual([]);
        expect(r.registry.holds.map((held) => held.path)).toEqual(['Trip/a.jpg', 'trip/a.jpg']);
        expect(r.photo(id)).toMatchObject({ sourceHealth: 'ambiguous', source: { path: 'trip/a.jpg', present: true, observedRevision: revisionOf('A') } });

        // Once it can be listed, Trip/a.jpg is classified like a case-only rename with new bytes.
        r.library.unreadableDirs.length = 0;
        r.pass();
        expect(r.factSummary()).toEqual(['replaced Trip/a.jpg']);
        expect(r.registry.holds).toEqual([]);
        expect(r.photo(id)).toMatchObject({ sourceHealth: 'present', source: { path: 'Trip/a.jpg', present: true, observedRevision: revisionOf('B') } });
    });

    it('an NFD name built from the stored NFC path rebinds by key and stores the NFD path', () => {
        const nfc = 'café/crème.jpg';
        const r = seeded({ [nfc]: 'A' });
        const stored = r.photoAt(nfc);
        const nfd = stored.source.path.normalize('NFD');
        expect(nfd).not.toBe(nfc);
        r.library.move(nfc, nfd);
        r.pass();
        expect(r.last.facts).toEqual([]);
        expect(r.photo(stored.photoId).source).toMatchObject({ path: nfd, key: stored.source.key });
    });
});

describe('reconcile: holds', () => {
    it('persist while the held bytes stay, without repeating facts', () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'B' });
        r.library.put('a.jpg', image('B'));
        r.pass();
        const holds = r.registry.holds;
        r.pass();
        expect(r.last.facts).toEqual([]);
        expect(r.registry.holds).toEqual(holds);
    });

    it('end with a byte change, and the path is classified afresh', () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'B' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.put('a.jpg', image('B'));
        r.pass();
        r.library.put('a.jpg', image('C'));
        r.pass();
        expect(r.registry.holds).toEqual([]);
        expect(r.last.facts).toMatchObject([{ type: 'replaced', photoId: x, assetRevision: revisionOf('C') }]);
        expect(Object.values(r.registry.photos).map((photo) => photo.sourceHealth)).toEqual(['present', 'present']);
    });

    it('drop when the held path vanishes, returning candidates to present or missing', () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'A' });
        const [x, y] = [r.photoAt('a.jpg').photoId, r.photoAt('b.jpg').photoId];
        r.library.remove('a.jpg', 'b.jpg');
        r.pass();
        r.library.put('c.jpg', image('A'));
        r.pass();
        expect(r.registry.holds).toHaveLength(1);
        r.library.remove('c.jpg');
        r.pass();
        expect(r.registry.holds).toEqual([]);
        expect(r.factSummary()).toEqual(['missing a.jpg', 'missing b.jpg']);
        expect([r.photo(x).sourceHealth, r.photo(y).sourceHealth]).toEqual(['missing', 'missing']);
    });
});

describe('reconcile: ID minting', () => {
    it('never reissues an ID', () => {
        const scan = new FakeLibrary().put('a.jpg', image('A')).put('b.jpg', image('B'));
        expect(() => reconcile(scan.scan(), emptyRegistry(), scan.lookup, { idGen: () => '00000000-0000-4000-8000-000000000001', profileId: PROFILE }))
            .toThrow(/never reissued/);
    });
});

// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import {
    createDecision,
    decisionFileName,
    parseDecision,
    readPendingDecisions,
    settleDecisions,
    writeDecision,
    type DecisionOutcome,
    type IdentityDecision,
} from '../decisions';
import { toPublicAsset } from '../metadata';
import { identityPaths } from '../registry';
import type { AssetManifest } from '../types';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../variants';
import { image, NOW, PROFILE, Reconciler, revisionOf, sequentialIds } from './reconcileFixtures';

const UUID = '00000000-0000-4000-8000-0000000000aa';
const PHOTO = 'ph_00000000-0000-4000-8000-0000000000bb';
const OTHER = 'ph_00000000-0000-4000-8000-0000000000cc';
const CREATED = '2026-06-01T12:00:00.000Z';
const base = { schemaVersion: 1, decisionId: UUID, actor: 'cli', reason: '', createdAt: CREATED };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A reconciler whose first pass bound each `path: bytes` pair to a new photo. */
function seeded(files: Record<string, string>): Reconciler {
    const r = new Reconciler();
    for (const [file, bytes] of Object.entries(files)) r.library.put(file, image(bytes));
    r.pass();
    return r;
}

/** The photoId a `new` decision minted. */
function mintedBy(decision: IdentityDecision): string {
    if (decision.type !== 'new') throw new Error(`not a new decision: ${decision.type}`);
    return decision.photoId;
}

const outcomes = (r: Reconciler) => r.last.decisions.map(({ status, ...rest }) => ({ status, ...('reason' in rest ? { reason: rest.reason } : {}) }));

describe('parseDecision', () => {
    it.each([
        { type: 'bind', path: 'trips/a.jpg', photoId: PHOTO },
        { type: 'bind', path: 'trips/a.jpg', photoId: PHOTO, merge: OTHER },
        { type: 'new', path: 'a.jpg', photoId: PHOTO },
        { type: 'archive', photoId: PHOTO },
        { type: 'retry', photoId: PHOTO },
        { type: 'retry', photoId: PHOTO, assetRevision: revisionOf('A') },
        { type: 'reprofile', photoId: PHOTO },
        { type: 'reprofile' },
    ])('accepts $type %#', (fields) => {
        expect(parseDecision({ ...base, ...fields })).toEqual({ decision: { ...base, ...fields } });
    });

    it.each([
        ['a non-object', 'nope', 'it is not a JSON object'],
        ['an unknown field', { ...base, type: 'archive', photoId: PHOTO, extra: 1 }, 'unknown field extra'],
        ['a newer schema', { ...base, schemaVersion: 2, type: 'archive', photoId: PHOTO }, 'schemaVersion 2 comes from a newer build'],
        ['an old schema', { ...base, schemaVersion: 0, type: 'archive', photoId: PHOTO }, 'schemaVersion must be 1'],
        ['a bad decisionId', { ...base, decisionId: 'x', type: 'archive', photoId: PHOTO }, 'decisionId must be a lowercase UUID v4'],
        ['an unknown type', { ...base, type: 'merge', photoId: PHOTO }, 'type must be one of bind, new, archive, retry, reprofile'],
        ['an empty actor', { ...base, actor: '', type: 'archive', photoId: PHOTO }, 'actor must be a non-empty string'],
        ['a non-string reason', { ...base, reason: 3, type: 'archive', photoId: PHOTO }, 'reason must be a string'],
        ['a date without a time', { ...base, createdAt: '2026-06-01', type: 'archive', photoId: PHOTO }, 'createdAt must be an ISO timestamp'],
        ['bind without a path', { ...base, type: 'bind', photoId: PHOTO }, 'bind needs a library-relative path'],
        ['a path leaving the library', { ...base, type: 'bind', path: '../a.jpg', photoId: PHOTO }, 'bind needs a library-relative path'],
        ['an absolute path', { ...base, type: 'new', path: '/a.jpg', photoId: PHOTO }, 'new needs a library-relative path'],
        ['an empty segment', { ...base, type: 'new', path: 'a//b.jpg', photoId: PHOTO }, 'new needs a library-relative path'],
        ['an empty path', { ...base, type: 'new', path: '', photoId: PHOTO }, 'new needs a library-relative path'],
        ['a NUL byte', { ...base, type: 'new', path: 'a\0.jpg', photoId: PHOTO }, 'new needs a library-relative path'],
        ['archive with a path', { ...base, type: 'archive', path: 'a.jpg', photoId: PHOTO }, 'archive takes no path'],
        ['new without its photoId', { ...base, type: 'new', path: 'a.jpg' }, 'new needs a photoId'],
        ['a bad photoId', { ...base, type: 'archive', photoId: 'ph_1' }, 'photoId must be ph_ plus a UUID v4'],
        ['new with a merge', { ...base, type: 'new', path: 'a.jpg', photoId: PHOTO, merge: OTHER }, 'new takes no merge'],
        ['a bad merge', { ...base, type: 'bind', path: 'a.jpg', photoId: PHOTO, merge: 'ph_1' }, 'merge must be ph_ plus a UUID v4'],
        ['a merge naming the photo itself', { ...base, type: 'bind', path: 'a.jpg', photoId: PHOTO, merge: PHOTO }, 'merge must name a photo other than photoId'],
        ['a bad assetRevision', { ...base, type: 'retry', photoId: PHOTO, assetRevision: 'sha256-x' }, 'assetRevision must be sha256- plus 64 hex'],
        ['reprofile with a revision', { ...base, type: 'reprofile', assetRevision: revisionOf('A') }, 'reprofile takes no assetRevision'],
    ])('rejects %s', (_name, value, invalid) => {
        expect(parseDecision(value)).toEqual({ invalid });
    });
});

describe('createDecision', () => {
    it('mints the photoId for new, and names the file by time, then decisionId', () => {
        const decision = createDecision({ type: 'new', path: 'a.jpg', actor: 'cli' }, { idGen: sequentialIds(), clock: () => NOW });
        expect(decision).toEqual({
            schemaVersion: 1,
            decisionId: '00000000-0000-4000-8000-000000000001',
            type: 'new',
            path: 'a.jpg',
            photoId: 'ph_00000000-0000-4000-8000-000000000002',
            actor: 'cli',
            reason: '',
            createdAt: '2026-06-01T12:00:00.000Z',
        });
        expect(decisionFileName(decision)).toBe('2026-06-01T12-00-00-000Z-00000000-0000-4000-8000-000000000001.json');
    });

    it('carries the photo a bind may merge', () => {
        const decision = createDecision({ type: 'bind', path: 'a.jpg', photoId: PHOTO, merge: OTHER, actor: 'cli' }, { idGen: sequentialIds(), clock: () => NOW });
        expect(decision).toMatchObject({ type: 'bind', path: 'a.jpg', photoId: PHOTO, merge: OTHER });
    });

    it('refuses input that makes no valid decision', () => {
        expect(() => createDecision({ type: 'new', path: 'a.jpg', photoId: PHOTO, actor: 'cli' })).toThrow('new mints its own photoId');
        expect(() => createDecision({ type: 'bind', path: '../a.jpg', photoId: PHOTO, actor: 'cli' })).toThrow(/needs a library-relative path/);
        expect(() => createDecision({ type: 'archive', actor: 'cli' })).toThrow(/archive needs a photoId/);
    });
});

describe('decision files', () => {
    function root(): TempDataRoot {
        const data = createTempDataRoot();
        cleanups.push(() => data.cleanup());
        return data;
    }

    it('reads pending decisions in file order, skipping dot-files, temp files, folders, and other files', async () => {
        const data = root();
        const ids = sequentialIds();
        // Written newest first, so only sorting puts them in order wherever a listing isn't sorted already.
        const decisions = [5, 4, 3, 2, 1, 0].map((offset) => createDecision({ type: 'archive', photoId: PHOTO, actor: 'cli' }, { idGen: ids, clock: () => NOW + offset }));
        for (const decision of decisions) {
            const written = await writeDecision(data.root, decision);
            expect(written).toBe(path.join(identityPaths(data.root).decisions, decisionFileName(decision)));
        }
        const dir = identityPaths(data.root).decisions;
        fs.writeFileSync(path.join(dir, '.hidden.json'), '{}');
        fs.writeFileSync(path.join(dir, `.${decisionFileName(decisions[0])}.1.x.tmp`), '{');
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'hi');
        fs.mkdirSync(path.join(dir, 'a-folder.json'));
        fs.mkdirSync(path.join(dir, 'applied'));
        fs.writeFileSync(path.join(dir, 'applied', 'old.json'), '{}');
        const files = await readPendingDecisions(data.root);
        expect(files.map((file) => [file.name, file.decision])).toEqual([...decisions].reverse().map((decision) => [decisionFileName(decision), decision]));
    });

    it('reads an invalid file as a decision to reject, keeping its text', async () => {
        const data = root();
        const dir = identityPaths(data.root).decisions;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'a.json'), '{ not json');
        fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ ...base, type: 'archive' }));
        expect(await readPendingDecisions(data.root)).toEqual([
            { name: 'a.json', decision: null, invalid: 'it is not valid JSON', raw: '{ not json' },
            { name: 'b.json', decision: null, invalid: 'archive needs a photoId', raw: JSON.stringify({ ...base, type: 'archive' }) },
        ]);
    });

    it('reads nothing when there is no decisions folder', async () => {
        expect(await readPendingDecisions(root().root)).toEqual([]);
    });

    it('moves applied decisions as they are, records rejected ones with the reason, and leaves deferred ones', async () => {
        const data = root();
        const ids = sequentialIds();
        const [applied, rejected, deferred] = [0, 1, 2].map((offset) => createDecision({ type: 'archive', photoId: PHOTO, actor: 'cli' }, { idGen: ids, clock: () => NOW + offset }));
        for (const decision of [applied, rejected, deferred]) await writeDecision(data.root, decision);
        const dir = identityPaths(data.root).decisions;
        fs.writeFileSync(path.join(dir, 'garbage.json'), '{ nope');
        const appliedBytes = fs.readFileSync(path.join(dir, decisionFileName(applied)));
        const files = await readPendingDecisions(data.root);
        const outcome = (decision: typeof applied, rest: Record<string, string>) => ({ name: decisionFileName(decision), decisionId: decision.decisionId, ...rest }) as DecisionOutcome;
        await settleDecisions(data.root, files, [
            outcome(applied, { status: 'applied', detail: 'archived' }),
            outcome(rejected, { status: 'rejected', reason: 'it is present' }),
            outcome(deferred, { status: 'deferred', reason: 'still changing' }),
            { name: 'garbage.json', decisionId: null, status: 'rejected', reason: 'it is not valid JSON' },
        ], '2026-06-01T12:05:00.000Z');

        expect(fs.readdirSync(dir).sort()).toEqual([decisionFileName(deferred), 'applied', 'rejected']);
        expect(fs.readFileSync(path.join(dir, 'applied', decisionFileName(applied))).equals(appliedBytes)).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'rejected', decisionFileName(rejected)), 'utf8'))).toEqual({
            rejectedAt: '2026-06-01T12:05:00.000Z',
            reason: 'it is present',
            decision: rejected,
        });
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'rejected', 'garbage.json'), 'utf8'))).toEqual({
            rejectedAt: '2026-06-01T12:05:00.000Z',
            reason: 'it is not valid JSON',
            raw: '{ nope',
        });
    });
});

describe('reconcile: bind', () => {
    it('gives a new file to a photo whose file is gone, as a replacement, instead of minting a photo', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.remove('a.jpg').put('z.jpg', image('Z'));
        r.decide({ type: 'bind', path: 'z.jpg', photoId: x });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'applied' }]);
        expect(Object.keys(r.registry.photos)).toEqual([x]);
        expect(r.photo(x)).toMatchObject({ sourceHealth: 'present', source: { path: 'z.jpg', present: true, observedRevision: revisionOf('Z') } });
        expect(Object.keys(r.photo(x).revisions).sort()).toEqual([revisionOf('A'), revisionOf('Z')].sort());
        expect(r.last.facts).toMatchObject([{ type: 'replaced', photoId: x, assetRevision: revisionOf('Z'), path: 'z.jpg', fromPath: 'a.jpg' }]);
        expect(r.last.jobs).toEqual([{ photoId: x, assetRevision: revisionOf('Z'), profileId: PROFILE, path: 'z.jpg' }]);
    });

    it("gives a held path to one of its candidates, ending the hold, and leaves the other missing", () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'A' });
        const [x1, x2] = [r.photoAt('a.jpg').photoId, r.photoAt('b.jpg').photoId];
        r.library.remove('a.jpg', 'b.jpg');
        r.pass();
        r.library.put('c.jpg', image('A'));
        r.pass();
        expect(r.registry.holds).toHaveLength(1);
        r.decide({ type: 'bind', path: 'c.jpg', photoId: x1 });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'applied' }]);
        expect(r.registry.holds).toEqual([]);
        expect(r.photo(x1)).toMatchObject({ sourceHealth: 'present', source: { path: 'c.jpg', observedRevision: revisionOf('A') } });
        // x2 leaves the hold for missing again, which is a transition the ledger hears about.
        expect(r.photo(x2).sourceHealth).toBe('missing');
        expect(r.last.facts).toMatchObject([{ type: 'renamed', photoId: x1, path: 'c.jpg', fromPath: 'a.jpg' }, { type: 'missing', photoId: x2 }]);
        expect(r.last.jobs).toEqual([{ photoId: x1, assetRevision: revisionOf('A'), profileId: PROFILE, path: 'c.jpg' }]);
    });

    it("gives a held path holding another photo's bytes to the photo that lived there", () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'B' });
        const [x, y] = [r.photoAt('a.jpg').photoId, r.photoAt('b.jpg').photoId];
        r.library.put('a.jpg', image('B'));
        r.pass();
        r.decide({ type: 'bind', path: 'a.jpg', photoId: x });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'applied' }]);
        expect(r.registry.holds).toEqual([]);
        expect(r.photo(x)).toMatchObject({ sourceHealth: 'present', source: { path: 'a.jpg', observedRevision: revisionOf('B') } });
        expect(r.photo(y).sourceHealth).toBe('present');
        expect(r.last.facts).toMatchObject([{ type: 'replaced', photoId: x, assetRevision: revisionOf('B'), path: 'a.jpg' }]);
    });

    it('merges a photo minted at the path into the photo it really is, when the decision names it', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.remove('a.jpg').put('z.jpg', image('Z'));
        r.pass();
        const n = r.photoAt('z.jpg').photoId;
        r.registry.photos[n].revisions[revisionOf('Z')].profiles[PROFILE] = { state: 'ready', attempts: 1, readyAt: CREATED };
        r.decide({ type: 'bind', path: 'z.jpg', photoId: x, merge: n });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'applied' }]);
        expect(r.last.decisions[0]).toMatchObject({ detail: `bound z.jpg to ${x} and merged ${n} into it` });
        expect(r.photo(x)).toMatchObject({ sourceHealth: 'present', source: { path: 'z.jpg', observedRevision: revisionOf('Z') } });
        expect(r.photo(x).revisions[revisionOf('Z')].profiles).toEqual({ [PROFILE]: { state: 'pending', attempts: 0 } });
        expect(r.photo(x).revisions[revisionOf('Z')].reassignedTo).toBeUndefined();
        expect(r.photo(n)).toMatchObject({ sourceHealth: 'archived', mergedInto: x, source: { present: false } });
        expect(r.photo(n).revisions[revisionOf('Z')]).toMatchObject({ reassignedTo: x, profiles: { [PROFILE]: { state: 'ready' } } });
        expect(r.last.facts).toMatchObject([{ type: 'replaced', photoId: x, assetRevision: revisionOf('Z'), path: 'z.jpg', fromPath: 'a.jpg' }]);
        expect(r.last.jobs).toEqual([{ photoId: x, assetRevision: revisionOf('Z'), profileId: PROFILE, path: 'z.jpg' }]);
    });

    it('refuses a photo present at another path', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.put('b.jpg', image('B'));
        r.decide({ type: 'bind', path: 'b.jpg', photoId: x });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'rejected', reason: `${x} is present at a.jpg` }]);
        // The rows then treat b.jpg as they would without the decision.
        expect(r.factSummary()).toEqual(['new b.jpg']);
    });

    it('refuses a path another photo holds unless the decision names it to merge, so a mistyped ID retires nothing', () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'B' });
        const [x, b] = [r.photoAt('a.jpg').photoId, r.photoAt('b.jpg').photoId];
        r.library.remove('a.jpg');
        r.pass();
        // b.jpg was meant. b has only the revision first seen at b.jpg, which a merge would take.
        r.decide({ type: 'bind', path: 'b.jpg', photoId: x });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'rejected', reason: `b.jpg is bound to ${b}. To merge ${b} into ${x}, name it with --merge` }]);
        expect(r.photo(b)).toMatchObject({ sourceHealth: 'present', source: { path: 'b.jpg', present: true } });
        expect(r.photo(b).mergedInto).toBeUndefined();
        expect(r.photo(x).sourceHealth).toBe('missing');
    });

    it('refuses a merge that names another photo than the one holding the path', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.remove('a.jpg').put('z.jpg', image('Z'));
        r.pass();
        const n = r.photoAt('z.jpg').photoId;
        r.decide({ type: 'bind', path: 'z.jpg', photoId: x, merge: OTHER });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'rejected', reason: `the decision merges ${OTHER}, but z.jpg is bound to ${n}` }]);
        expect(r.photo(n).sourceHealth).toBe('present');
    });

    it('refuses to merge a photo that was more than minted at the path', () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'B' });
        const [x, n] = [r.photoAt('a.jpg').photoId, r.photoAt('b.jpg').photoId];
        r.library.put('b.jpg', image('B2'));
        r.library.remove('a.jpg');
        r.pass();
        // n now has two revisions, so it wasn't merely minted at b.jpg.
        r.decide({ type: 'bind', path: 'b.jpg', photoId: x, merge: n });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'rejected', reason: `${n} has more than the one revision first seen at b.jpg, so it can't be merged` }]);
        expect(r.photo(n).sourceHealth).toBe('present');
    });

    it("gives a path holding a moved photo's bytes to that photo, and the photo whose file it overwrote goes missing", () => {
        const r = seeded({ 'x.jpg': 'X', 'y.jpg': 'Y' });
        const [x, y] = [r.photoAt('x.jpg').photoId, r.photoAt('y.jpg').photoId];
        const revisions = structuredClone(r.photo(x).revisions);
        // mv y.jpg x.jpg
        r.library.move('y.jpg', 'x.jpg');
        r.pass();
        expect(r.registry.holds).toMatchObject([{ path: 'x.jpg', candidates: [x, y].sort() }]);
        r.decide({ type: 'bind', path: 'x.jpg', photoId: y });
        r.pass();
        expect(r.last.decisions).toMatchObject([{ status: 'applied', detail: `bound x.jpg to ${y}, which ${x} no longer holds` }]);
        expect(r.registry.holds).toEqual([]);
        expect(r.photo(y)).toMatchObject({ sourceHealth: 'present', source: { path: 'x.jpg', present: true, observedRevision: revisionOf('Y') } });
        expect(r.photo(x)).toMatchObject({ sourceHealth: 'missing', source: { path: 'x.jpg', present: false, observedRevision: revisionOf('X') } });
        expect(r.photo(x).mergedInto).toBeUndefined();
        expect(r.photo(x).revisions).toEqual(revisions);
        expect(r.photo(y).revisions[revisionOf('X')]).toBeUndefined();
        expect(r.factSummary()).toEqual(['missing x.jpg', 'renamed x.jpg']);
    });

    it.each([
        ['an unknown photo', () => ({ photoId: 'ph_00000000-0000-4000-8000-000000000999', path: 'z.jpg' }), 'rejected', 'there is no photo ph_00000000-0000-4000-8000-000000000999'],
        ['a path with no image', (r: Reconciler) => ({ photoId: r.photoAt('a.jpg').photoId, path: 'nothing.jpg' }), 'rejected', 'there is no image at nothing.jpg'],
        ['a file still being written', (r: Reconciler) => ({ photoId: r.photoAt('a.jpg').photoId, path: 'fresh.jpg' }), 'deferred', 'fresh.jpg is still changing'],
        ['a name two files share', (r: Reconciler) => ({ photoId: r.photoAt('a.jpg').photoId, path: 'twin.jpg' }), 'rejected', '2 files share the name twin.jpg apart from case or Unicode form'],
    ])('does not bind %s', (_name, target, status, reason) => {
        const r = seeded({ 'a.jpg': 'A' });
        r.library.remove('a.jpg').put('z.jpg', image('Z')).put('fresh.jpg', image('F'), { fresh: true }).put('twin.jpg', image('T1')).put('TWIN.jpg', image('T2'));
        r.decide({ type: 'bind', ...target(r) });
        r.pass();
        expect(outcomes(r)).toEqual([{ status, reason }]);
    });

    it('takes the photo out of every hold it was in, so a path held only for it gets its own photo', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        // Renamed, and a new file saved under the old name: both paths are held for x.
        r.library.move('a.jpg', 'elsewhere.jpg').put('a.jpg', image('B'));
        r.pass();
        expect(r.registry.holds.map((held) => [held.path, held.candidates])).toEqual([['a.jpg', [x]], ['elsewhere.jpg', [x]]]);

        r.decide({ type: 'bind', path: 'elsewhere.jpg', photoId: x });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'applied' }]);
        expect(r.registry.holds).toEqual([]);
        expect(r.photo(x)).toMatchObject({ sourceHealth: 'present', source: { path: 'elsewhere.jpg', observedRevision: revisionOf('A') } });
        const others = Object.values(r.registry.photos).filter((photo) => photo.photoId !== x);
        expect(others).toMatchObject([{ sourceHealth: 'present', source: { path: 'a.jpg', observedRevision: revisionOf('B') } }]);
    });

    it('refuses an archived photo', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.remove('a.jpg').put('z.jpg', image('Z'));
        r.decide({ type: 'archive', photoId: x });
        r.decide({ type: 'bind', path: 'z.jpg', photoId: x });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'applied' }, { status: 'rejected', reason: `${x} is archived` }]);
    });

    it('applies a second time as a no-op', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.remove('a.jpg').put('z.jpg', image('Z'));
        const decision = r.decide({ type: 'bind', path: 'z.jpg', photoId: x });
        r.pass();
        const after = structuredClone(r.registry.photos);
        r.queueFile({ name: decisionFileName(decision), decision, raw: '' });
        r.pass();
        expect(r.last.decisions).toEqual([{ name: decisionFileName(decision), decisionId: decision.decisionId, status: 'applied', detail: `z.jpg was already bound to ${x}` }]);
        expect(r.last.facts).toEqual([]);
        expect(r.registry.photos[x].revisions).toEqual(after[x].revisions);
    });
});

describe('reconcile: new', () => {
    it("gives a held path its own photo, a duplicate of the photo whose bytes it holds, and the path's old photo goes missing", () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'B' });
        const [x, y] = [r.photoAt('a.jpg').photoId, r.photoAt('b.jpg').photoId];
        r.library.put('a.jpg', image('B'));
        r.pass();
        const decision = r.decide({ type: 'new', path: 'a.jpg' });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'applied' }]);
        const n = mintedBy(decision);
        expect(r.registry.holds).toEqual([]);
        expect(r.photo(n)).toMatchObject({ duplicateOf: y, sourceHealth: 'present', source: { path: 'a.jpg', observedRevision: revisionOf('B') } });
        expect(r.photo(x)).toMatchObject({ sourceHealth: 'missing', source: { present: false, observedRevision: revisionOf('A') } });
        expect(r.photo(y).sourceHealth).toBe('present');
        expect(r.factSummary()).toEqual(['missing a.jpg', 'new a.jpg']);
        expect(r.last.jobs).toEqual([{ photoId: n, assetRevision: revisionOf('B'), profileId: PROFILE, path: 'a.jpg' }]);
    });

    it('moves the revision a bound path holds to the new photo, and the old photo goes back to its latest other revision', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.put('a.jpg', image('B'));
        r.pass();
        r.library.put('a.jpg', image('C'));
        r.pass();
        expect(r.photo(x).source.observedRevision).toBe(revisionOf('C'));
        // The fake library observes every pass at one instant, so date the revisions the way three passes would.
        const revisions = r.registry.photos[x].revisions;
        [revisions[revisionOf('A')].firstSeenAt, revisions[revisionOf('B')].firstSeenAt] = ['2026-05-01T00:00:00.000Z', '2026-05-15T00:00:00.000Z'];
        revisions[revisionOf('C')].profiles[PROFILE] = { state: 'ready', attempts: 1, readyAt: CREATED };
        const n = mintedBy(r.decide({ type: 'new', path: 'a.jpg' }));
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'applied' }]);
        expect(r.photo(n).revisions[revisionOf('C')]).toMatchObject({ firstSeenPath: 'a.jpg', profiles: { [PROFILE]: { state: 'pending', attempts: 0 } } });
        expect(r.photo(n).revisions[revisionOf('C')].reassignedTo).toBeUndefined();
        expect(r.photo(x).revisions[revisionOf('C')].reassignedTo).toBe(n);
        expect(r.photo(x)).toMatchObject({ sourceHealth: 'missing', source: { present: false, observedRevision: revisionOf('B') } });
        expect(r.last.facts).toMatchObject([
            { type: 'new', photoId: n, assetRevision: revisionOf('C'), path: 'a.jpg' },
            { type: 'missing', photoId: x, assetRevision: revisionOf('B') },
        ]);
        expect(r.photo(n).duplicateOf).toBeNull();
        expect(r.last.jobs).toEqual([{ photoId: n, assetRevision: revisionOf('C'), profileId: PROFILE, path: 'a.jpg' }]);
    });

    it('leaves the old photo in the hold its bytes are in, for a later bind', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.put('a.jpg', image('C')).put('elsewhere.jpg', image('A'));
        r.pass();
        expect(r.registry.holds).toHaveLength(2);
        const n = mintedBy(r.decide({ type: 'new', path: 'a.jpg' }));
        r.pass();
        expect(r.photo(n).source.path).toBe('a.jpg');
        expect(r.photo(x)).toMatchObject({ sourceHealth: 'ambiguous', source: { path: 'a.jpg', present: false } });
        // elsewhere.jpg is still held for x, so x waits for a bind there.
        expect(r.registry.holds.map((held) => held.path)).toEqual(['elsewhere.jpg']);
        r.decide({ type: 'bind', path: 'elsewhere.jpg', photoId: x });
        r.pass();
        expect(r.photo(x)).toMatchObject({ sourceHealth: 'present', source: { path: 'elsewhere.jpg', observedRevision: revisionOf('A') } });
        expect(r.registry.holds).toEqual([]);
    });

    it('gives the photo its own revision back when a bind undoes it, so the revision builds and projects again', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        const n = mintedBy(r.decide({ type: 'new', path: 'a.jpg' }));
        r.pass();
        expect(r.photo(x).revisions[revisionOf('A')].reassignedTo).toBe(n);

        r.decide({ type: 'bind', path: 'a.jpg', photoId: x, merge: n });
        r.pass();
        expect(r.last.decisions).toMatchObject([{ status: 'applied', detail: `bound a.jpg to ${x} and merged ${n} into it` }]);
        const record = r.photo(x).revisions[revisionOf('A')];
        expect(record.reassignedTo).toBeUndefined();
        expect(record.profiles).toEqual({ [PROFILE]: { state: 'pending', attempts: 0 } });
        expect(r.photo(x)).toMatchObject({ sourceHealth: 'present', source: { path: 'a.jpg', present: true, observedRevision: revisionOf('A') } });
        expect(r.photo(n)).toMatchObject({ sourceHealth: 'archived', mergedInto: x });
        expect(r.photo(n).revisions[revisionOf('A')].reassignedTo).toBe(x);
        expect(r.factSummary()).toEqual(['reappeared a.jpg']);
        expect(r.last.jobs).toEqual([{ photoId: x, assetRevision: revisionOf('A'), profileId: PROFILE, path: 'a.jpg' }]);
        const manifest = {
            schemaVersion: 1,
            photoId: x,
            assetRevision: revisionOf('A'),
            profileId: PROFILE,
            variants: Object.fromEntries(VARIANT_WIDTHS.map((width) => [width, Object.fromEntries(VARIANT_FORMATS.map((format) => [format, { width: 64, height: 48, bytes: 100, sha256: 'a'.repeat(64) }]))])),
            lqip: 'data:image/webp;base64,UklGRg==',
            createdAt: CREATED,
        } as AssetManifest;
        expect(toPublicAsset(r.photo(x), revisionOf('A'), PROFILE, manifest)).toMatchObject({ photoId: x, assetRevision: revisionOf('A') });
    });

    it("refuses to bind a photo to bytes it gave to another photo, unless that photo's merge brings them back", () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        const n = mintedBy(r.decide({ type: 'new', path: 'a.jpg' }));
        r.pass();
        r.library.remove('a.jpg').put('p.jpg', image('A')).put('q.jpg', image('A'));
        r.pass();
        expect(r.registry.holds).toMatchObject([{ path: 'p.jpg', candidates: [n] }, { path: 'q.jpg', candidates: [n] }]);
        r.decide({ type: 'bind', path: 'p.jpg', photoId: x });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'rejected', reason: `p.jpg holds ${revisionOf('A')}, which ${x} gave to ${n}` }]);
        expect(r.photo(x).revisions[revisionOf('A')].reassignedTo).toBe(n);
        expect(r.photo(x).source.present).toBe(false);
    });

    it('refuses a path that is neither held nor bound, which gets a photo ID by itself', () => {
        const r = seeded({ 'a.jpg': 'A' });
        r.library.put('b.jpg', image('B'));
        r.decide({ type: 'new', path: 'b.jpg' });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'rejected', reason: 'b.jpg is neither held nor bound, so a pass gives it a photo ID by itself' }]);
        expect(r.factSummary()).toEqual(['new b.jpg']);
    });

    it('applies a second time as a no-op, minting nothing', () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'B' });
        r.library.put('a.jpg', image('B'));
        r.pass();
        const decision = r.decide({ type: 'new', path: 'a.jpg' });
        r.pass();
        const count = Object.keys(r.registry.photos).length;
        r.queueFile({ name: decisionFileName(decision), decision, raw: '' });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'applied' }]);
        expect(Object.keys(r.registry.photos)).toHaveLength(count);
        expect(r.last.facts).toEqual([]);
    });
});

describe('reconcile: archive', () => {
    it('archives a missing photo and keeps everything, and its bytes coming back make a new duplicate', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        const revisions = structuredClone(r.photo(x).revisions);
        r.library.remove('a.jpg');
        r.pass();
        r.decide({ type: 'archive', photoId: x });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'applied' }]);
        expect(r.photo(x)).toMatchObject({ sourceHealth: 'archived', source: { path: 'a.jpg', present: false } });
        expect(r.photo(x).revisions).toEqual(revisions);
        expect(r.last.facts).toEqual([]);
        r.library.put('a.jpg', image('A'));
        r.pass();
        const back = Object.values(r.registry.photos).filter((photo) => photo.photoId !== x);
        expect(back).toMatchObject([{ duplicateOf: x, sourceHealth: 'present', source: { path: 'a.jpg' } }]);
    });

    it('archives a photo whose file vanished this pass without reporting it missing', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.remove('a.jpg');
        r.decide({ type: 'archive', photoId: x });
        r.pass();
        expect(r.photo(x)).toMatchObject({ sourceHealth: 'archived', source: { path: 'a.jpg', present: false } });
        expect(r.last.facts).toEqual([]);
    });

    it("refuses a photo whose file is present", () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.decide({ type: 'archive', photoId: x });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'rejected', reason: `${x} is present at a.jpg, and archive is for a photo whose file is gone` }]);
        expect(r.photo(x).sourceHealth).toBe('present');
    });

    it("drops the photo from a hold's candidates and leaves the hold", () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'A' });
        const [x1, x2] = [r.photoAt('a.jpg').photoId, r.photoAt('b.jpg').photoId];
        r.library.remove('a.jpg', 'b.jpg');
        r.pass();
        r.library.put('c.jpg', image('A'));
        r.pass();
        r.decide({ type: 'archive', photoId: x2 });
        r.pass();
        expect(r.registry.holds).toMatchObject([{ path: 'c.jpg', candidates: [x1] }]);
        expect(r.photo(x2).sourceHealth).toBe('archived');
        expect(r.photo(x1).sourceHealth).toBe('ambiguous');
    });

    it.each([
        ['moved', image('A')],
        ['moved and edited only in its metadata', image('A2', { pixels: 'A' })],
    ])('refuses a photo whose file came back %s this pass, which the pass gives back to it', (_how, back) => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.remove('a.jpg');
        r.pass();
        r.library.put('trips/a.jpg', back);
        r.decide({ type: 'archive', photoId: x });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'rejected', reason: `${x}'s file is back at trips/a.jpg, and archive is for a photo whose file is gone` }]);
        expect(Object.keys(r.registry.photos)).toEqual([x]);
        expect(r.photo(x)).toMatchObject({ sourceHealth: 'present', source: { path: 'trips/a.jpg', present: true } });
    });

    it('ends a hold whose only candidate it archives, so the held path gets its own photo', () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'A' });
        const [x1, x2] = [r.photoAt('a.jpg').photoId, r.photoAt('b.jpg').photoId];
        r.library.remove('a.jpg', 'b.jpg');
        r.pass();
        r.library.put('c.jpg', image('A'));
        r.pass();
        r.decide({ type: 'archive', photoId: x1 });
        r.decide({ type: 'archive', photoId: x2 });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'applied' }, { status: 'applied' }]);
        expect(r.registry.holds).toEqual([]);
        const others = Object.values(r.registry.photos).filter((photo) => photo.photoId !== x1 && photo.photoId !== x2);
        expect(others).toMatchObject([{ sourceHealth: 'present', duplicateOf: x1, source: { path: 'c.jpg' } }]);
    });

    it('applies a second time as a no-op', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.remove('a.jpg');
        r.decide({ type: 'archive', photoId: x });
        r.decide({ type: 'archive', photoId: x });
        r.pass();
        expect(r.last.decisions.map((outcome) => outcome.status === 'applied' && outcome.detail)).toEqual([`archived ${x}`, `${x} was already archived`]);
    });
});

describe('reconcile: retry', () => {
    function failedAt(r: Reconciler, photoId: string, bytes: string, error: string) {
        r.registry.photos[photoId].revisions[revisionOf(bytes)].profiles[PROFILE] = { state: 'failed', attempts: 2, error };
    }

    it('puts failed entries back to pending and queues them, keeping the attempt count', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        failedAt(r, x, 'A', 'the disk was full');
        r.decide({ type: 'retry', photoId: x });
        r.pass();
        expect(r.last.decisions).toMatchObject([{ status: 'applied', detail: `put 1 failed entry of ${x} back to pending` }]);
        expect(r.photo(x).revisions[revisionOf('A')].profiles[PROFILE]).toEqual({ state: 'pending', attempts: 2 });
        expect(r.last.jobs).toEqual([{ photoId: x, assetRevision: revisionOf('A'), profileId: PROFILE, path: 'a.jpg' }]);
    });

    it("leaves a source-superseded entry failed unless its bytes are back at the photo's path", () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.put('a.jpg', image('C'));
        r.pass();
        failedAt(r, x, 'A', 'source-superseded');
        r.decide({ type: 'retry', photoId: x });
        r.pass();
        expect(r.photo(x).revisions[revisionOf('A')].profiles[PROFILE]).toEqual({ state: 'failed', attempts: 2, error: 'source-superseded' });

        // The bytes back at the path, and the registry still naming them, as after an interrupted revert.
        r.library.put('a.jpg', image('A'));
        r.registry.photos[x].source.observedRevision = revisionOf('A');
        r.decide({ type: 'retry', photoId: x, assetRevision: revisionOf('A') });
        r.pass();
        expect(r.photo(x).revisions[revisionOf('A')].profiles[PROFILE]).toEqual({ state: 'pending', attempts: 2 });
    });

    it('retries one revision when named, and refuses a revision the photo does not have', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.put('a.jpg', image('C'));
        r.pass();
        failedAt(r, x, 'A', 'the disk was full');
        failedAt(r, x, 'C', 'the disk was full');
        r.decide({ type: 'retry', photoId: x, assetRevision: revisionOf('C') });
        r.decide({ type: 'retry', photoId: x, assetRevision: revisionOf('nope') });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'applied' }, { status: 'rejected', reason: `${x} has no revision ${revisionOf('nope')}` }]);
        expect(r.photo(x).revisions[revisionOf('C')].profiles[PROFILE].state).toBe('pending');
        expect(r.photo(x).revisions[revisionOf('A')].profiles[PROFILE].state).toBe('failed');
    });

    it('refuses an unknown or archived photo', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.remove('a.jpg');
        r.decide({ type: 'retry', photoId: 'ph_00000000-0000-4000-8000-000000000999' });
        r.decide({ type: 'archive', photoId: x });
        r.decide({ type: 'retry', photoId: x });
        r.pass();
        expect(outcomes(r)).toEqual([
            { status: 'rejected', reason: 'there is no photo ph_00000000-0000-4000-8000-000000000999' },
            { status: 'applied' },
            { status: 'rejected', reason: `${x} is archived` },
        ]);
    });
});

describe('reconcile: reprofile', () => {
    const OLD = 'p_00000000000000ff';

    it("queues the current profile for a present photo's observed revision that only has an older one", () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.registry.photos[x].revisions[revisionOf('A')].profiles = { [OLD]: { state: 'ready', attempts: 1, readyAt: CREATED } };
        r.decide({ type: 'reprofile', photoId: x });
        r.pass();
        expect(r.last.decisions).toMatchObject([{ status: 'applied', detail: 'queued the current profile for 1 revision' }]);
        expect(r.photo(x).revisions[revisionOf('A')].profiles).toEqual({ [OLD]: { state: 'ready', attempts: 1, readyAt: CREATED }, [PROFILE]: { state: 'pending', attempts: 0 } });
        expect(r.last.jobs).toEqual([{ photoId: x, assetRevision: revisionOf('A'), profileId: PROFILE, path: 'a.jpg' }]);
    });

    it('queues every present photo without the current profile, and nothing else', () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'B', 'c.jpg': 'C', 'd.jpg': 'D' });
        const [a, b, c, d] = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].map((file) => r.photoAt(file).photoId);
        for (const [id, bytes] of [[a, 'A'], [b, 'B'], [d, 'D']]) r.registry.photos[id].revisions[revisionOf(bytes)].profiles = { [OLD]: { state: 'ready', attempts: 1 } };
        r.library.remove('b.jpg');
        r.pass();
        r.decide({ type: 'reprofile' });
        r.pass();
        expect(r.last.decisions).toMatchObject([{ status: 'applied', detail: 'queued the current profile for 2 revisions' }]);
        expect(r.last.jobs.map((job) => job.photoId).sort()).toEqual([a, d].sort());
        expect(r.photo(b).revisions[revisionOf('B')].profiles[PROFILE]).toBeUndefined();
        expect(r.photo(c).revisions[revisionOf('C')].profiles[PROFILE]).toEqual({ state: 'pending', attempts: 0 });
    });

    it('refuses a photo that is not present', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const x = r.photoAt('a.jpg').photoId;
        r.library.remove('a.jpg');
        r.pass();
        r.decide({ type: 'reprofile', photoId: x });
        r.pass();
        expect(outcomes(r)).toEqual([{ status: 'rejected', reason: `${x} is not present` }]);
    });
});

describe('reconcile: decision files', () => {
    it('rejects an invalid file with its reason and changes nothing', () => {
        const r = seeded({ 'a.jpg': 'A' });
        const before = structuredClone(r.registry.photos);
        r.queueFile({ name: 'broken.json', decision: null, invalid: 'it is not valid JSON', raw: '{' });
        r.pass();
        expect(r.last.decisions).toEqual([{ name: 'broken.json', decisionId: null, status: 'rejected', reason: 'it is not valid JSON' }]);
        expect(r.registry.photos).toEqual(before);
    });

    it('applies decisions in order, each against what the ones before it left', () => {
        const r = seeded({ 'a.jpg': 'A', 'b.jpg': 'B' });
        r.library.put('a.jpg', image('B'));
        r.pass();
        const n = mintedBy(r.decide({ type: 'new', path: 'a.jpg' }));
        r.decide({ type: 'new', path: 'a.jpg' });
        r.decide({ type: 'reprofile', photoId: n });
        r.pass();
        expect(outcomes(r)).toEqual([
            { status: 'applied' },
            // a.jpg is bound to n now, so a second new takes it from n.
            { status: 'applied' },
            { status: 'rejected', reason: `${n} is not present` },
        ]);
    });
});

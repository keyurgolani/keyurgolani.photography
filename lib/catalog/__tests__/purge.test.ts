// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStoredRegistry, writeRegistry } from '../../identity/registry';
import { withLock } from '../../storage/lock';
import { UsageError } from '../owner-cli';
import { purgeArgs, runPurgeCommand, type PurgeArgs } from '../purge-cli';
import { PURGE_EXIT_CODES, runPurge, type PurgeOptions } from '../purge';
import { references } from '../references';
import { CATALOG_LOCK } from '../repository';
import { readTombstones, standingFor, tombstonesDir, TOMBSTONE_ID_RE } from '../tombstones';
import { readActivePointer } from '../working-layer';
import { B2, cleanupPurgeTemplates, purgeFixture, quiet, snapshot, writeTombstone, type PurgeFixture } from './purgeFixtures';

/**
 * #181's A10: `photos purge` and `photos purge --revoke`, with #15's
 * refusals and fail-safes, each with its own test. Test values only.
 */

const NOW = Date.parse('2026-12-02T10:00:00.000Z');
const clock = () => NOW;
const UUID = '0f0f0f0f-0000-4000-8000-00000000a10a';

const cleanups: (() => void)[] = [];
let library = '';

beforeAll(() => {
    library = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-test-library-'));
});

// No test here reaches a real library: PHOTOGRAPHY_LIBRARY_DIR is an empty temp folder unless a test sets another.
beforeEach(() => {
    vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', library);
});

afterEach(() => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

afterAll(() => {
    cleanupPurgeTemplates();
});

/** Another asset revision of `photoId` in the registry, as a replacement adds one. No set is built for it. */
async function addRevision(root: string, photoId: string, assetRevision: string): Promise<void> {
    const stored = await readStoredRegistry(root);
    if (!stored) throw new Error('No registry.');
    const registry = structuredClone(stored.registry);
    const [firstRevision] = Object.values(registry.photos[photoId].revisions);
    registry.photos[photoId].revisions[assetRevision] = { ...structuredClone(firstRevision), assetRevision };
    await writeRegistry(root, registry, stored.registry.version);
}

async function fixture(): Promise<PurgeFixture> {
    const built = await purgeFixture(181);
    cleanups.push(built.cleanup);
    return built;
}

const env = { PHOTOS_ACTOR: 'owner' };

async function command(root: string, argv: string[], options: Partial<PurgeOptions> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const exitCode = await runPurgeCommand(root, purgeArgs(argv, env), { out: (line) => out.push(line), err: (line) => err.push(line) }, { clock, idGen: () => UUID, logger: quiet, waitMs: 200, ...options });
    return { exitCode, out, err, all: [...out, ...err].join('\n') };
}

describe('the purge fixture', { timeout: 120_000 }, () => {
    it('has revision 3 live, B at B2 in it, C in the draft series only, and D in revision 1 only', async () => {
        const built = await fixture();
        expect((await readActivePointer(built.root))?.revisionId).toBe(built.revisions[3]);
        const refs = await references(built.root);
        const active = refs.filter((ref) => ref.source === 'active-revision').map((ref) => `${ref.photoId}@${ref.assetRevision}`).sort();
        expect(active).toEqual([`${built.a}@${built.first[built.a]}`, `${built.b}@${B2}`].sort());
        const series = refs.filter((ref) => ref.source === 'working-layer-series').map((ref) => ref.photoId).sort();
        expect(series).toEqual([built.a, built.b, built.c].sort());
        expect(refs.filter((ref) => ref.photoId === built.d).map((ref) => ref.source)).toEqual(expect.arrayContaining(['candidate', 'revision', 'working-layer-photo']));
    });
});

describe('photos purge, its arguments', () => {
    const photo = 'ph_00000000-0000-4000-8000-000000000001';

    it('needs a reason and an actor, so a missing one exits 2', () => {
        expect(() => purgeArgs([photo, '--actor', 'owner'], {})).toThrow(UsageError);
        expect(() => purgeArgs([photo, '--reason', ' ', '--actor', 'owner'], {})).toThrow(/--reason/);
        expect(() => purgeArgs([photo, '--reason', 'takedown'], {})).toThrow(/--actor <name> or PHOTOS_ACTOR/);
        expect(() => purgeArgs(['--revoke', `tomb_${UUID}`, '--reason', 'oops'], {})).toThrow(/--actor/);
        expect(() => purgeArgs(['--revoke', `tomb_${UUID}`, '--actor', 'owner'], {})).toThrow(/--reason/);
        expect(purgeArgs([photo, '--reason', 'takedown'], env)).toEqual({ kind: 'purge', photoId: photo, reason: 'takedown', actor: 'owner', yes: false });
    });

    it('refuses what it can never act on', () => {
        expect(() => purgeArgs([], env)).toThrow(/photo ID, or --revoke/);
        expect(() => purgeArgs(['ph_nope', '--reason', 'x'], env)).toThrow(/not a photo ID/);
        expect(() => purgeArgs([photo, '--asset-revision', 'sha256-x', '--reason', 'x'], env)).toThrow(/--asset-revision takes/);
        expect(() => purgeArgs([photo, '--revoke', `tomb_${UUID}`, '--reason', 'x'], env)).toThrow(/not both/);
        expect(() => purgeArgs(['--revoke', 'tomb_x', '--reason', 'x'], env)).toThrow(/tombstone ID/);
        expect(() => purgeArgs([photo, photo, '--reason', 'x'], env)).toThrow(/one photo ID/);
        expect(() => purgeArgs([photo, '--reason', 'x', '--reason', 'y'], env)).toThrow(/more than once/);
    });

    it('is a dry run unless --yes', () => {
        const parsed = purgeArgs([photo, '--reason', 'x', '--yes'], env) as Extract<PurgeArgs, { kind: 'purge' }>;
        expect(parsed.yes).toBe(true);
        expect((purgeArgs([photo, '--reason', 'x'], env) as Extract<PurgeArgs, { kind: 'purge' }>).yes).toBe(false);
    });
});

describe('photos purge, the dry run', { timeout: 120_000 }, () => {
    it('writes nothing, and says first, in one plain line, what it takes down', async () => {
        const built = await fixture();
        const before = snapshot(built.root);
        const { exitCode, out, err } = await command(built.root, [built.d, '--reason', 'model release withdrawn']);

        expect({ exitCode, err }).toEqual({ exitCode: 0, err: [] });
        expect(snapshot(built.root)).toEqual(before);
        expect(fs.existsSync(tombstonesDir(built.root))).toBe(false);
        expect(out[0]).toMatch(new RegExp(`^Takes down ${built.d}: 1 asset revision, 1 set, \\d+\\.\\d kB\\. They answer 410 at once\\. GC can delete the bytes from 2026-12-09 10:00 UTC\\.$`));
        expect(out).toContainEqual(expect.stringMatching(new RegExp(`^  ${built.first[built.d]}: 1 set, `)));
        expect(out).toContainEqual(expect.stringMatching(new RegExp(`^    assets/${built.d}/${built.first[built.d]}/${built.profileId}: `)));
        expect(out).toContainEqual(expect.stringMatching(new RegExp(`^No rollback can return to these while it stands, since they show it: revision 1 \\(${built.revisions[1]}\\)\\. A revoke brings them back until photos gc --apply deletes a folder it lists\\. Once photos gc --apply has deleted a folder a tombstone lists, that takedown is permanent`)));
        expect(out.at(-1)).toBe('[photos] PLANNED: This was a dry run. Nothing was written. Run it again with --yes to take it down.');
    });

    it('plans an --asset-revision purge with each revision that loses rollback eligibility, newest first', async () => {
        const built = await fixture();
        const result = await runPurge({ dataRoot: built.root, photoId: built.b, assetRevision: built.first[built.b], reason: 'x', actor: 'owner', clock, logger: quiet });
        expect(result.outcome).toBe('PLANNED');
        expect(result.plan?.assetRevisions.map((each) => each.assetRevision)).toEqual([built.first[built.b]]);
        expect(result.plan?.losing.map((each) => each.revisionNumber)).toEqual([2, 1]);
    });
});

describe("photos purge, #15's refusals", { timeout: 120_000 }, () => {
    it('refuses a photo the live revision shows, exits 1, writes nothing, and points to publishing without it', async () => {
        const built = await fixture();
        const before = snapshot(built.root);
        const { exitCode, out, err } = await command(built.root, [built.a, '--reason', 'x', '--yes']);
        expect(exitCode).toBe(1);
        expect(out).toEqual([]);
        expect(err).toHaveLength(1);
        expect(err[0]).toMatch(new RegExp(`^\\[photos\\] IN_ACTIVE_REVISION: The live revision, revision 3 \\(${built.revisions[3]}\\), shows ${built.a} at ${built.first[built.a]}, so a purge would take it off the live site\\. Nothing was written\\.`));
        expect(err[0]).toContain(`Publish without it first: take it out with photos sequence remove ${built.seriesId} ${built.a}, publish, then purge it.`);
        expect(snapshot(built.root)).toEqual(before);
    });

    it('refuses an --asset-revision the live revision shows, though the photo has others', async () => {
        const built = await fixture();
        const before = snapshot(built.root);
        const { exitCode, err } = await command(built.root, [built.b, '--asset-revision', B2, '--reason', 'x', '--yes']);
        expect(exitCode).toBe(1);
        expect(err[0]).toMatch(/^\[photos\] IN_ACTIVE_REVISION: /);
        expect(snapshot(built.root)).toEqual(before);
    });

    it('refuses a photo a draft series lists, exits 1, writes nothing, and points to photos sequence remove', async () => {
        const built = await fixture();
        const before = snapshot(built.root);
        const { exitCode, err } = await command(built.root, [built.c, '--reason', 'x', '--yes']);
        expect(exitCode).toBe(1);
        expect(err[0]).toBe(`[photos] IN_SERIES: The draft's series ${built.seriesId} lists ${built.c} at ${built.first[built.c]}, so the next publish would show it. Nothing was written. Take it out with photos sequence remove ${built.seriesId} ${built.c} and publish without it, or pin another asset revision and purge this one with --asset-revision.`);
        expect(snapshot(built.root)).toEqual(before);
    });

    it('refuses the asset revision a draft series lists a photo at, by its record', async () => {
        const built = await fixture();
        const result = await runPurge({ dataRoot: built.root, photoId: built.c, assetRevision: built.first[built.c], reason: 'x', actor: 'owner', yes: true, clock, logger: quiet });
        expect(result.outcome).toBe('IN_SERIES');
        expect(PURGE_EXIT_CODES[result.outcome]).toBe(1);
        expect((await readTombstones(built.root)).tombstones).toEqual([]);
    });

    it('takes down an --asset-revision the record no longer pins, the photo still in its series', async () => {
        const built = await fixture();
        const { exitCode, out, err } = await command(built.root, [built.b, '--asset-revision', built.first[built.b], '--reason', 'an earlier edit showed a plate', '--yes']);
        expect({ exitCode, err }).toEqual({ exitCode: 0, err: [] });
        expect(out[0]).toMatch(new RegExp(`^Takes down ${built.b} at ${built.first[built.b]}: 1 asset revision, 1 set, `));
        expect(out.at(-1)).toMatch(new RegExp(`^\\[photos\\] PURGED: Wrote catalog/tombstones/tomb_${UUID}\\.json\\.`));
        // Still in its series, at B2, and still live there.
        const refs = await references(built.root);
        expect(refs.some((ref) => ref.source === 'working-layer-series' && ref.photoId === built.b && ref.assetRevision === B2)).toBe(true);
        expect((await readTombstones(built.root)).tombstones.map((entry) => entry.assetRevisions)).toEqual([[built.first[built.b]]]);
    });

    it('refuses a photo the registry has no record of, and an asset revision it has none of', async () => {
        const built = await fixture();
        const before = snapshot(built.root);
        const unknown = await command(built.root, ['ph_00000000-0000-4000-8000-0000000000ff', '--reason', 'x', '--yes']);
        expect(unknown.exitCode).toBe(1);
        expect(unknown.err[0]).toMatch(/^\[photos\] UNKNOWN_PHOTO: /);
        const revision = await command(built.root, [built.d, '--asset-revision', `sha256-${'e'.repeat(64)}`, '--reason', 'x', '--yes']);
        expect(revision.exitCode).toBe(1);
        expect(revision.err[0]).toMatch(/^\[photos\] UNKNOWN_ASSET_REVISION: /);
        expect(snapshot(built.root)).toEqual(before);
    });
});

describe('photos purge --yes', { timeout: 120_000 }, () => {
    it('prints the same, then writes exactly one tombstone with its fields, and no revoke file', async () => {
        const built = await fixture();
        const dry = await command(built.root, [built.d, '--reason', 'model release withdrawn']);
        const before = snapshot(built.root);
        const { exitCode, out } = await command(built.root, [built.d, '--reason', 'model release withdrawn', '--yes']);
        expect(exitCode).toBe(0);
        expect(out.slice(0, -1)).toEqual(dry.out.slice(0, -1));
        expect(fs.readdirSync(tombstonesDir(built.root))).toEqual([`tomb_${UUID}.json`]);
        const written = JSON.parse(fs.readFileSync(path.join(tombstonesDir(built.root), `tomb_${UUID}.json`), 'utf8')) as Record<string, unknown>;
        expect(written).toEqual({
            tombstoneId: `tomb_${UUID}`,
            photoId: built.d,
            assetRevision: null,
            assetRevisions: [built.first[built.d]],
            actor: 'owner',
            reason: 'model release withdrawn',
            createdAt: new Date(NOW).toISOString(),
        });
        expect(TOMBSTONE_ID_RE.test(written.tombstoneId as string)).toBe(true);
        // Nothing else changed: the tombstone folder and its file are all that's new.
        const after = snapshot(built.root);
        expect([...after.keys()].filter((key) => !before.has(key)).sort()).toEqual(['catalog/tombstones', `catalog/tombstones/tomb_${UUID}.json`]);
        for (const [key, value] of before) expect(after.get(key)).toBe(value);
    });

    it('gives a whole-photo tombstone every asset revision the registry holds when it is written, and no later one', async () => {
        const built = await fixture();
        const second = `sha256-${'d2'.repeat(32)}`;
        const later = `sha256-${'d3'.repeat(32)}`;
        await addRevision(built.root, built.d, second);
        const result = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'x', actor: 'owner', yes: true, clock, idGen: () => UUID, logger: quiet });
        expect(result.outcome).toBe('PURGED');
        expect(result.tombstone?.assetRevisions).toEqual([built.first[built.d], second].sort());
        expect(result.tombstone?.assetRevision).toBeNull();
        // A redacted replacement after it isn't covered.
        await addRevision(built.root, built.d, later);
        const read = await readTombstones(built.root);
        expect(standingFor(read, built.d, second)).toHaveLength(1);
        expect(standingFor(read, built.d, later)).toEqual([]);
    });

    it('writes nothing again for a photo a standing tombstone takes down already', async () => {
        const built = await fixture();
        writeTombstone(built.root, { photoId: built.d, assetRevisions: [built.first[built.d]] });
        const before = snapshot(built.root);
        const { exitCode, out } = await command(built.root, [built.d, '--reason', 'x', '--yes']);
        expect(exitCode).toBe(0);
        expect(out.at(-1)).toMatch(/^\[photos\] ALREADY_TAKEN_DOWN: tomb_00000000-0000-4000-8000-000000000001 already takes down every asset revision this would\. Nothing was written\.$/);
        expect(snapshot(built.root)).toEqual(before);
    });

    it('runs under the catalog lock: a held lock exits 3 and writes nothing', async () => {
        const built = await fixture();
        const before = snapshot(built.root);
        const result = await withLock(CATALOG_LOCK, { root: built.root, waitMs: 0 }, () => command(built.root, [built.d, '--reason', 'x', '--yes']));
        expect(result.exitCode).toBe(3);
        expect(result.err[0]).toMatch(/^\[photos\] CATALOG_LOCKED: Another command holds the catalog lock: /);
        expect(snapshot(built.root)).toEqual(before);
    });

    it('stops, writing nothing, on a tombstone file it cannot read', async () => {
        const built = await fixture();
        fs.mkdirSync(tombstonesDir(built.root), { recursive: true });
        fs.writeFileSync(path.join(tombstonesDir(built.root), `tomb_${UUID.replace('a10a', 'bad0')}.json`), '{not json');
        const before = snapshot(built.root);
        const { exitCode, err } = await command(built.root, [built.d, '--reason', 'x', '--yes']);
        expect(exitCode).toBe(4);
        expect(err[0]).toMatch(/^\[photos\] INTEGRITY_MISMATCH: catalog\/tombstones\/tomb_[^ ]+\.json: it is not valid JSON, so nobody can tell what is taken down already\. Nothing was written\./);
        expect(snapshot(built.root)).toEqual(before);
    });

    it('logs the tombstone it wrote', async () => {
        const built = await fixture();
        const events: Record<string, unknown>[] = [];
        await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'x', actor: 'owner', yes: true, clock, idGen: () => UUID, logger: { log: (line) => events.push(JSON.parse(line) as Record<string, unknown>) } });
        expect(events).toEqual([expect.objectContaining({ event: 'catalog.purge.tombstoned', outcome: 'PURGED', photoId: built.d, tombstoneId: `tomb_${UUID}` })]);
    });

    it('leaves the library byte for byte as it was', async () => {
        const built = await fixture();
        const library = fs.mkdtempSync(path.join(path.dirname(built.root), 'library-'));
        fs.writeFileSync(path.join(library, 'original.jpg'), "the owner's original");
        vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', library);
        const before = snapshot(library);
        const result = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'x', actor: 'owner', yes: true, clock, idGen: () => UUID, logger: quiet });
        expect(result.outcome).toBe('PURGED');
        expect(snapshot(library)).toEqual(before);
        expect(fs.readFileSync(path.join(library, 'original.jpg'), 'utf8')).toBe("the owner's original");
    });
});

describe('photos purge --revoke', { timeout: 120_000 }, () => {
    async function purged(built: PurgeFixture): Promise<string> {
        const result = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'x', actor: 'owner', yes: true, clock, idGen: () => UUID, logger: quiet });
        if (result.outcome !== 'PURGED' || !result.tombstone) throw new Error(result.message);
        return result.tombstone.tombstoneId;
    }

    it('is a dry run unless --yes, then writes <tombstoneId>.revoked.json, which readTombstones() counts', async () => {
        const built = await fixture();
        const id = await purged(built);
        const before = snapshot(built.root);
        const dry = await command(built.root, ['--revoke', id, '--reason', 'released after all']);
        expect(dry.exitCode).toBe(0);
        expect(dry.out[0]).toMatch(new RegExp(`^Revokes ${id}, written ${new Date(NOW).toISOString()} by owner: ${built.d}, 1 asset revision\\.`));
        expect(snapshot(built.root)).toEqual(before);

        const { exitCode, out } = await command(built.root, ['--revoke', id, '--reason', 'released after all', '--yes']);
        expect(exitCode).toBe(0);
        expect(out.at(-1)).toMatch(new RegExp(`^\\[photos\\] REVOKED: Wrote catalog/tombstones/${id}\\.revoked\\.json\\.`));
        const revoked = JSON.parse(fs.readFileSync(path.join(tombstonesDir(built.root), `${id}.revoked.json`), 'utf8')) as Record<string, unknown>;
        expect(revoked).toEqual({ tombstoneId: id, actor: 'owner', reason: 'released after all', createdAt: new Date(NOW).toISOString() });
        expect((await readTombstones(built.root)).tombstones[0].revoked).toEqual(revoked);
    });

    it('exits 1 for a tombstone that is not there, and 0, writing nothing, for one revoked already', async () => {
        const built = await fixture();
        const missing = await command(built.root, ['--revoke', `tomb_${UUID}`, '--reason', 'x', '--yes']);
        expect(missing.exitCode).toBe(1);
        expect(missing.err[0]).toMatch(/^\[photos\] UNKNOWN_TOMBSTONE: /);
        const id = await purged(built);
        await command(built.root, ['--revoke', id, '--reason', 'x', '--yes']);
        const before = snapshot(built.root);
        const again = await command(built.root, ['--revoke', id, '--reason', 'x', '--yes']);
        expect(again.exitCode).toBe(0);
        expect(again.out.at(-1)).toMatch(/^\[photos\] ALREADY_REVOKED: /);
        expect(snapshot(built.root)).toEqual(before);
    });
});

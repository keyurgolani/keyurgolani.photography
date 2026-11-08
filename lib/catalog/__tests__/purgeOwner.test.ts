// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BREAKS, IMAGE_UID, ownerRefusal, type WriterKind } from '../data-root-owner';

/**
 * ownerRefusal(), the check the owner gate asks (#15: a
 * takedown file is written only as the data root's owner). Which commands ask, and that each refuses before its first lock, is
 * ownerGatePins.test.ts, end to end; this is the check itself: the effective
 * uid against the data root's owner, through a symlink, and each writer's
 * own words. process.geteuid() and getuid() are faked against the owner of
 * the test's own temp folder, which stat() reports as IMAGE_UID, uid 1001, as
 * production's data root is, or another uid where a case says so.
 */

afterEach(() => vi.restoreAllMocks());

/** fs.statSync() of each folder, through any symlink, reports <uid> as its owner, IMAGE_UID unless given. Returns that uid. */
function ownedBy(roots: string[], uid: number = IMAGE_UID): number {
    const real = fs.statSync;
    const targets = roots.map((root) => fs.realpathSync(root));
    vi.spyOn(fs, 'statSync').mockImplementation(((each: fs.PathLike, options?: fs.StatSyncOptions) => {
        const stat = real(each, options as fs.StatSyncOptions & { bigint?: false });
        if (!stat) return stat;
        let resolved: string;
        try { resolved = fs.realpathSync(String(each)); } catch { return stat; }
        if (!targets.includes(resolved)) return stat;
        return Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as fs.Stats, stat, { uid });
    }) as typeof fs.statSync);
    return uid;
}
const ownerOf = (root: string) => ownedBy([root]);
const posix = typeof process.geteuid === 'function' || typeof process.getuid === 'function';

/** The effective uid answers <uid>, as if the command ran as that user. The real uid stays <realUid> when given, so only geteuid() can tell. */
function runAs(uid: number, realUid?: number): void {
    vi.spyOn(process, 'geteuid').mockReturnValue(uid);
    if (realUid !== undefined) vi.spyOn(process, 'getuid').mockReturnValue(realUid);
}

const WRONG = /runs as uid (\d+), but uid (\d+) owns the data root, and web runs as that owner\..* It took no lock\. Nothing was written\./;

describe('ownerRefusal() (#15)', () => {
    it.runIf(posix)('refuses when the effective uid differs, even with the real uid the owner, and allows when it matches', () => {
        // Only stat()ed: whoever owns it, the faked uid differs from or matches that owner.
        const root = os.tmpdir();
        const owner = ownerOf(root);
        runAs(owner + 7, owner);
        expect(ownerRefusal(root, 'photos purge --yes', 'tombstone')).toMatch(WRONG);
        expect(ownerRefusal(root, 'photos purge --yes', 'tombstone')).toContain(`runs as uid ${owner + 7}, but uid ${owner} owns`);
        runAs(owner, owner + 7);
        expect(ownerRefusal(root, 'photos purge --yes', 'tombstone')).toBeNull();
    });

    it.runIf(posix)('falls back to getuid() where there is no geteuid()', () => {
        const root = os.tmpdir();
        const owner = ownerOf(root);
        const original = Object.getOwnPropertyDescriptor(process, 'geteuid');
        Object.defineProperty(process, 'geteuid', { value: undefined, configurable: true, writable: true });
        try {
            vi.spyOn(process, 'getuid').mockReturnValue(owner + 1);
            expect(ownerRefusal(root, 'photos sequence', 'authored')).toMatch(WRONG);
            vi.spyOn(process, 'getuid').mockReturnValue(owner);
            expect(ownerRefusal(root, 'photos sequence', 'authored')).toBeNull();
        } finally {
            if (original) Object.defineProperty(process, 'geteuid', original);
        }
    });

    it.runIf(posix)('says what each writer would break, each in its own words', () => {
        const root = os.tmpdir();
        runAs(ownerOf(root) + 1);
        const said = (kind: WriterKind) => ownerRefusal(root, `the ${kind} writer`, kind) ?? '';
        expect(said('tombstone')).toMatch(/serve the set as the live revision says, and every publish and rollback would stop on assets\.tombstoned/);
        expect(said('revoke')).toMatch(/keep answering 410 for the sets, and every publish and rollback would stop on assets\.tombstoned/);
        expect(said('gc-apply')).toMatch(/keep its sets at 410 and stop every publish and rollback on assets\.tombstoned\. GC deletes and writes its markers only as the data root's owner/);
        expect(said('set-aside')).toMatch(/moves into trash\/ would be one the owner's commands can't read, move or clear, and the lock file it takes/);
        expect(said('watcher')).toMatch(/\/media would 404 the new sets, and the healthcheck would fail\. .*as docker-compose\.prod\.yml's image-watcher does with user: "\d+:\d+"\.$/);
        expect(said('curator')).toMatch(/Inbox and the draft would stop .*Start it as uid \d+, as docker-compose\.prod\.yml's curator does with user: "\d+:\d+"\.$/);
        expect(said('locking-read')).toMatch(/It takes a lock to read, which writes a lock file in locks\//);
        expect(said('authored')).toMatch(/docker compose -f docker-compose\.prod\.yml run --rm --no-deps image-watcher node dist\/scripts\/photos\.mjs the authored writer …$/);
        for (const kind of Object.keys(BREAKS) as WriterKind[]) expect(said(kind)).toMatch(new RegExp(`^the ${kind} writer runs as uid `));
        expect(new Set(Object.values(BREAKS)).size).toBe(Object.keys(BREAKS).length);
        for (const kind of ['tombstone', 'revoke'] as const) expect(said(kind)).not.toMatch(/marker/);
    });

    it.runIf(posix)("follows a symlinked data root to the folder's owner, as stat() does, not the link's, as lstat() would", () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-link-'));
        const target = path.join(base, 'data');
        fs.mkdirSync(target);
        const link = path.join(base, 'data-link');
        fs.symlinkSync(target, link);
        const owner = ownerOf(target);
        // As if another user, root say, had made the link: only lstat() sees the link's own owner.
        const real = fs.lstatSync;
        vi.spyOn(fs, 'lstatSync').mockImplementation(((each: fs.PathLike, options?: fs.StatSyncOptions) => {
            const stat = real(each, options as fs.StatSyncOptions & { bigint?: false });
            if (path.resolve(String(each)) !== link || !stat) return stat;
            return Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as fs.Stats, stat, { uid: owner + 1 });
        }) as typeof fs.lstatSync);
        runAs(owner);
        expect(ownerRefusal(link, 'photos purge --yes', 'tombstone')).toBeNull();
        runAs(owner + 1);
        expect(ownerRefusal(link, 'photos purge --yes', 'tombstone')).toContain(`but uid ${owner} owns the data root`);
    });

    it.runIf(posix)("on a data root that isn't uid 1001's, says to give it back to 1001, never to run as its owner, and lets its own owner through", () => {
        const root = os.tmpdir();
        ownedBy([root], 0);
        runAs(IMAGE_UID);
        const asImage = ownerRefusal(root, 'photos purge --yes', 'tombstone') ?? '';
        expect(asImage).toBe(`photos purge --yes runs as uid ${IMAGE_UID}, the user the image runs every service as, but uid 0 owns the data root. It took no lock. Nothing was written. On the host, in the folder that holds docker-compose.prod.yml, give the data root (the folder mounted at /data/portfolio) back to uid ${IMAGE_UID}: sudo chown -R ${IMAGE_UID}:${IMAGE_UID} portfolio-data/. Don't widen its permissions instead.`);
        runAs(1000);
        const asHostUser = ownerRefusal(root, 'photos purge --yes', 'tombstone') ?? '';
        expect(asHostUser).toBe(`photos purge --yes runs as uid 1000 and uid 0 owns the data root, but the image runs every service as uid ${IMAGE_UID}. It took no lock. Nothing was written. On the host, in the folder that holds docker-compose.prod.yml, give the data root (the folder mounted at /data/portfolio) to uid ${IMAGE_UID} with sudo chown -R ${IMAGE_UID}:${IMAGE_UID} portfolio-data/, then run this as uid ${IMAGE_UID}, as docker-compose.prod.yml's image-watcher does with user: "${IMAGE_UID}:${IMAGE_UID}".`);
        for (const said of [asImage, asHostUser]) expect(said).not.toMatch(/as uid 0[,.]|user: "0:|web runs as that owner/);
        // A run as root on a root-owned root matches its owner, so the gate lets it through; the release steps check on the host that uid 1001 owns the data root.
        runAs(0);
        expect(ownerRefusal(root, 'photos purge --yes', 'tombstone')).toBeNull();

        // An owner that's neither root nor 1001, as a deploy user's after a skipped setup chown: the same two messages, naming it.
        vi.restoreAllMocks();
        ownedBy([root], 1000);
        runAs(IMAGE_UID);
        expect(ownerRefusal(root, 'photos purge --yes', 'tombstone')).toBe(`photos purge --yes runs as uid ${IMAGE_UID}, the user the image runs every service as, but uid 1000 owns the data root. It took no lock. Nothing was written. On the host, in the folder that holds docker-compose.prod.yml, give the data root (the folder mounted at /data/portfolio) back to uid ${IMAGE_UID}: sudo chown -R ${IMAGE_UID}:${IMAGE_UID} portfolio-data/. Don't widen its permissions instead.`);
        runAs(0);
        expect(ownerRefusal(root, 'photos purge --yes', 'tombstone')).toBe(`photos purge --yes runs as uid 0 and uid 1000 owns the data root, but the image runs every service as uid ${IMAGE_UID}. It took no lock. Nothing was written. On the host, in the folder that holds docker-compose.prod.yml, give the data root (the folder mounted at /data/portfolio) to uid ${IMAGE_UID} with sudo chown -R ${IMAGE_UID}:${IMAGE_UID} portfolio-data/, then run this as uid ${IMAGE_UID}, as docker-compose.prod.yml's image-watcher does with user: "${IMAGE_UID}:${IMAGE_UID}".`);
        // Its own owner goes through, as a developer's run does on a data root of their own.
        runAs(1000);
        expect(ownerRefusal(root, 'photos purge --yes', 'tombstone')).toBeNull();
    });

    it('skips the check where there is no geteuid() or getuid(), as on Windows', () => {
        const saved = (['geteuid', 'getuid'] as const).map((name) => [name, Object.getOwnPropertyDescriptor(process, name)] as const);
        for (const [name] of saved) Object.defineProperty(process, name, { value: undefined, configurable: true, writable: true });
        try {
            expect(ownerRefusal('/nowhere/at/all', 'photos purge --yes', 'tombstone')).toBeNull();
        } finally {
            for (const [name, original] of saved) if (original) Object.defineProperty(process, name, original);
        }
    });
});

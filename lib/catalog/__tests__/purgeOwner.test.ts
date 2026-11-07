// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BREAKS, ownerRefusal, type WriterKind } from '../data-root-owner';

/**
 * ownerRefusal(), the check the owner gate asks (#15: a
 * takedown file is written only as the data root's owner). Which commands ask, and that each refuses before its first lock, is
 * ownerGatePins.test.ts, end to end; this is the check itself: the effective
 * uid against the data root's owner, through a symlink, and each writer's
 * own words. process.geteuid() and getuid() are faked against the owner of
 * the test's own temp folder.
 */

afterEach(() => vi.restoreAllMocks());

const ownerOf = (root: string) => fs.statSync(root).uid;
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

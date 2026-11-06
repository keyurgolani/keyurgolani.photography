// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ownerRefusal } from '../data-root-owner';
import { purgeArgs, runPurgeCommand } from '../purge-cli';
import { PURGE_EXIT_CODES, runPurge, runRevoke } from '../purge';
import { GC_EXIT_CODES, runGc } from '../retention';
import { TOMBSTONES_DIR } from '../tombstones';
import { cleanupPurgeTemplates, purgeFixture, quiet, snapshot } from './purgeFixtures';

/**
 * The A11 coordinator's ruling (c), and review round 2: a command that writes
 * into catalog/tombstones/, or deletes as GC, refuses, exit 1, when its
 * effective uid isn't the data root's owner, the uid web runs as. It refuses
 * before it takes any lock, so it writes nothing at all, locks/ included: a
 * lock file left by a killed run as root would stop every command of the
 * owner's. A dry run is only a report and still reports.
 * process.geteuid() (and getuid(), its fallback) is faked to differ from, or
 * match, the owner of the test's own temp root.
 */

afterEach(() => vi.restoreAllMocks());
afterAll(() => cleanupPurgeTemplates());

const ownerOf = (root: string) => fs.statSync(root).uid;
const posix = typeof process.geteuid === 'function' || typeof process.getuid === 'function';

/** The effective uid answers <uid>, as if the command ran as that user. The real uid stays the owner's, so only geteuid() can tell. */
function runAs(uid: number, realUid?: number): void {
    vi.spyOn(process, 'geteuid').mockReturnValue(uid);
    if (realUid !== undefined) vi.spyOn(process, 'getuid').mockReturnValue(realUid);
}

const WRONG = /runs as uid (\d+), but uid (\d+) owns the data root, and web runs as that owner\..*Nothing was written\./;

/** locks/ as it stands: absent, or its mtime, so a lock taken and released shows. */
function locksState(root: string): number | null {
    const dir = path.join(root, 'locks');
    return fs.existsSync(dir) ? fs.statSync(dir).mtimeMs : null;
}

/** Moves locks/ aside, inside the test's own temp root, so the next command would have to make it. */
function withoutLocks(root: string): void {
    if (fs.existsSync(path.join(root, 'locks'))) fs.renameSync(path.join(root, 'locks'), path.join(path.dirname(root), `locks-aside-${path.basename(path.dirname(root))}`));
}

describe.runIf(posix)('takedown writes and the data root owner (A11, ruling c)', { timeout: 60_000 }, () => {
    it('purge --yes refuses as another effective uid before any lock, exit 1, writing nothing; its dry run still reports; as the owner it purges', async () => {
        const built = await purgeFixture(412);
        const owner = ownerOf(built.root);
        // The real uid is the owner's: only the effective uid, which owns what it creates, is another.
        runAs(owner + 1, owner);

        const dry = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'r', actor: 'owner', yes: false, logger: quiet });
        expect(dry.outcome).toBe('PLANNED');
        expect(dry.plan?.summary).toMatch(/^Takes down /);

        const before = snapshot(built.root);
        const locks = locksState(built.root);
        expect(locks).not.toBeNull();
        const refused = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'r', actor: 'owner', yes: true, logger: quiet });
        expect(refused.outcome).toBe('WRONG_OWNER');
        expect(PURGE_EXIT_CODES[refused.outcome]).toBe(1);
        expect(refused.message).toMatch(WRONG);
        expect(refused.message).toContain(`runs as uid ${owner + 1}, but uid ${owner} owns`);
        expect(refused.message).toMatch(/A tombstone this uid writes is one web can't read: \/media would pass it over and serve the set as the live revision says/);
        expect(refused.tombstone).toBeNull();
        expect(snapshot(built.root)).toEqual(before);
        expect(locksState(built.root)).toBe(locks);
        expect(fs.existsSync(path.join(built.root, TOMBSTONES_DIR))).toBe(false);

        runAs(owner);
        expect((await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'r', actor: 'owner', yes: true, logger: quiet })).outcome).toBe('PURGED');
    });

    it('purge --yes as another uid makes no locks/ where there was none', async () => {
        const built = await purgeFixture(412);
        withoutLocks(built.root);
        runAs(ownerOf(built.root) + 1);
        const refused = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'r', actor: 'owner', yes: true, logger: quiet });
        expect(refused.outcome).toBe('WRONG_OWNER');
        expect(locksState(built.root)).toBeNull();
    });

    it('falls back to getuid() where there is no geteuid()', async () => {
        const built = await purgeFixture(412);
        const owner = ownerOf(built.root);
        const original = Object.getOwnPropertyDescriptor(process, 'geteuid');
        Object.defineProperty(process, 'geteuid', { value: undefined, configurable: true, writable: true });
        try {
            vi.spyOn(process, 'getuid').mockReturnValue(owner + 1);
            expect(ownerRefusal(built.root, 'purge')).toMatch(WRONG);
            vi.spyOn(process, 'getuid').mockReturnValue(owner);
            expect(ownerRefusal(built.root, 'purge')).toBeNull();
        } finally {
            if (original) Object.defineProperty(process, 'geteuid', original);
        }
    });

    it('photos purge, the CLI: the dry run prints its Takes down line and exits 0, --yes prints the refusal and exits 1', async () => {
        const built = await purgeFixture(412);
        runAs(ownerOf(built.root) + 1);
        const io = () => {
            const out: string[] = [];
            const err: string[] = [];
            return { out, err, io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
        };
        const dry = io();
        expect(await runPurgeCommand(built.root, purgeArgs([built.d, '--reason', 'smoke', '--actor', 'ci'], {}), dry.io, { logger: quiet })).toBe(0);
        expect(dry.out[0]).toMatch(new RegExp(`^Takes down ${built.d}: `));
        const yes = io();
        expect(await runPurgeCommand(built.root, purgeArgs([built.d, '--reason', 'smoke', '--actor', 'ci', '--yes'], {}), yes.io, { logger: quiet })).toBe(1);
        expect(yes.err.at(-1)).toMatch(/^\[photos\] WRONG_OWNER: /);
        expect(yes.err.at(-1)).toMatch(WRONG);
        expect(fs.existsSync(path.join(built.root, TOMBSTONES_DIR))).toBe(false);
    });

    it('purge --revoke --yes refuses as another uid before any lock, writing nothing; its dry run still reports; as the owner it revokes', async () => {
        const built = await purgeFixture(412);
        const owner = ownerOf(built.root);
        const purged = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'r', actor: 'owner', yes: true, logger: quiet });
        expect(purged.outcome).toBe('PURGED');
        const tombstoneId = purged.tombstone?.tombstoneId ?? '';
        runAs(owner + 1, owner);

        const dry = await runRevoke({ dataRoot: built.root, tombstoneId, reason: 'r', actor: 'owner', yes: false, logger: quiet });
        expect(dry.outcome).toBe('REVOKE_PLANNED');
        expect(dry.revokePlan?.summary).toMatch(/^Revokes /);

        const before = snapshot(built.root);
        const locks = locksState(built.root);
        const refused = await runRevoke({ dataRoot: built.root, tombstoneId, reason: 'r', actor: 'owner', yes: true, logger: quiet });
        expect(refused.outcome).toBe('WRONG_OWNER');
        expect(PURGE_EXIT_CODES[refused.outcome]).toBe(1);
        expect(refused.message).toMatch(WRONG);
        expect(refused.message).toMatch(/A revoke this uid writes is one web can't read: \/media would keep answering 410 for the sets/);
        expect(refused.revoke).toBeNull();
        expect(snapshot(built.root)).toEqual(before);
        expect(locksState(built.root)).toBe(locks);

        withoutLocks(built.root);
        expect((await runRevoke({ dataRoot: built.root, tombstoneId, reason: 'r', actor: 'owner', yes: true, logger: quiet })).outcome).toBe('WRONG_OWNER');
        expect(locksState(built.root)).toBeNull();

        runAs(owner);
        expect((await runRevoke({ dataRoot: built.root, tombstoneId, reason: 'r', actor: 'owner', yes: true, logger: quiet })).outcome).toBe('REVOKED');
    });

    it('gc --apply refuses as another uid before any lock, marker or delete, exit 1; its dry run still plans', async () => {
        const built = await purgeFixture(412);
        const owner = ownerOf(built.root);
        const T0 = Date.now();
        expect((await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'r', actor: 'owner', yes: true, clock: () => T0, logger: quiet })).outcome).toBe('PURGED');
        const later = () => T0 + 8 * 24 * 60 * 60 * 1000;
        runAs(owner + 1, owner);
        const planned = await runGc({ dataRoot: built.root, clock: later, logger: quiet });
        expect(planned.outcome).toBe('PLANNED');
        expect(planned.plan?.delete.map((entry) => entry.path)).toEqual([`assets/${built.d}/${built.first[built.d]}`]);

        const before = snapshot(built.root);
        const locks = locksState(built.root);
        const refused = await runGc({ dataRoot: built.root, clock: later, logger: quiet, apply: planned.plan?.digest });
        expect(refused.outcome).toBe('WRONG_OWNER');
        expect(GC_EXIT_CODES[refused.outcome]).toBe(1);
        expect(refused.message).toMatch(WRONG);
        expect(refused.message).toMatch(/GC deletes and writes its markers only as the data root's owner/);
        expect(refused.deleted).toEqual([]);
        expect(snapshot(built.root)).toEqual(before);
        expect(locksState(built.root)).toBe(locks);

        withoutLocks(built.root);
        expect((await runGc({ dataRoot: built.root, clock: later, logger: quiet, apply: planned.plan?.digest })).outcome).toBe('WRONG_OWNER');
        expect(locksState(built.root)).toBeNull();
        // The uid-matching apply is every other gc --apply test, run as the temp root's owner.
    });

    it('gc --apply refuses as another uid even with no tombstoned folder in the plan', async () => {
        const built = await purgeFixture(412);
        runAs(ownerOf(built.root) + 1);
        const planned = await runGc({ dataRoot: built.root, logger: quiet });
        expect(planned.outcome).toBe('PLANNED');
        expect(planned.plan?.delete.filter((entry) => entry.class === 'tombstoned')).toEqual([]);
        const before = snapshot(built.root);
        const locks = locksState(built.root);
        const refused = await runGc({ dataRoot: built.root, logger: quiet, apply: planned.plan?.digest });
        expect(refused.outcome).toBe('WRONG_OWNER');
        expect(snapshot(built.root)).toEqual(before);
        expect(locksState(built.root)).toBe(locks);
    });
});

describe('ownerRefusal() (A11, ruling c)', () => {
    it.runIf(posix)('refuses when the uids differ and allows when they match', () => {
        // Only stat()ed: whoever owns it, the faked uid differs from or matches that owner.
        const root = os.tmpdir();
        const owner = ownerOf(root);
        runAs(owner + 7);
        expect(ownerRefusal(root, 'purge')).toMatch(WRONG);
        runAs(owner);
        expect(ownerRefusal(root, 'purge')).toBeNull();
    });

    it.runIf(posix)('says what each command would break: purge serves the set, a revoke or marker keeps it at 410', () => {
        const root = os.tmpdir();
        runAs(ownerOf(root) + 1);
        expect(ownerRefusal(root, 'purge')).toMatch(/^photos purge --yes runs as uid .*serve the set as the live revision says, and every publish and rollback would stop on assets\.tombstoned/);
        expect(ownerRefusal(root, 'revoke')).toMatch(/^photos purge --revoke --yes runs as uid .*keep answering 410 for the sets, and every publish and rollback would stop on assets\.tombstoned/);
        expect(ownerRefusal(root, 'gc')).toMatch(/^photos gc --apply runs as uid .*keep its sets at 410 and stop every publish and rollback on assets\.tombstoned\. GC deletes and writes its markers only as the data root's owner/);
        for (const command of ['purge', 'revoke'] as const) expect(ownerRefusal(root, command)).not.toMatch(/marker/);
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
        expect(ownerRefusal(link, 'purge')).toBeNull();
        runAs(owner + 1);
        expect(ownerRefusal(link, 'purge')).toContain(`but uid ${owner} owns the data root`);
    });

    it('skips the check where there is no geteuid() or getuid(), as on Windows', () => {
        const saved = (['geteuid', 'getuid'] as const).map((name) => [name, Object.getOwnPropertyDescriptor(process, name)] as const);
        for (const [name] of saved) Object.defineProperty(process, name, { value: undefined, configurable: true, writable: true });
        try {
            expect(ownerRefusal('/nowhere/at/all', 'purge')).toBeNull();
        } finally {
            for (const [name, original] of saved) if (original) Object.defineProperty(process, name, original);
        }
    });
});

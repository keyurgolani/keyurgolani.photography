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
 * The A11 coordinator's ruling (c): a command that writes into
 * catalog/tombstones/ refuses, exit 1 and writing nothing, when its uid isn't
 * the data root's owner, the uid web runs as. A dry run is only a report and
 * still reports. process.getuid() is faked to differ from, or match, the
 * owner of the test's own temp root.
 */

afterEach(() => vi.restoreAllMocks());
afterAll(() => cleanupPurgeTemplates());

const ownerOf = (root: string) => fs.statSync(root).uid;
const posix = typeof process.getuid === 'function';

/** process.getuid() answers <uid>, as if the command ran as that user. */
function runAs(uid: number): void {
    vi.spyOn(process, 'getuid').mockReturnValue(uid);
}

const WRONG = /runs as uid (\d+), but uid (\d+) owns the data root, and web runs as that owner\..*Nothing was written\./;

describe.runIf(posix)('takedown writes and the data root owner (A11, ruling c)', { timeout: 60_000 }, () => {
    it('purge --yes refuses as another uid, exit 1, writing nothing; its dry run still reports; as the owner it purges', async () => {
        const built = await purgeFixture(412);
        const owner = ownerOf(built.root);
        runAs(owner + 1);
        const before = snapshot(built.root);

        const dry = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'r', actor: 'owner', yes: false, logger: quiet });
        expect(dry.outcome).toBe('PLANNED');
        expect(dry.plan?.summary).toMatch(/^Takes down /);

        const refused = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'r', actor: 'owner', yes: true, logger: quiet });
        expect(refused.outcome).toBe('WRONG_OWNER');
        expect(PURGE_EXIT_CODES[refused.outcome]).toBe(1);
        expect(refused.message).toMatch(WRONG);
        expect(refused.message).toContain(`runs as uid ${owner + 1}, but uid ${owner} owns`);
        expect(refused.tombstone).toBeNull();
        expect(snapshot(built.root)).toEqual(before);
        expect(fs.existsSync(path.join(built.root, TOMBSTONES_DIR))).toBe(false);

        runAs(owner);
        const done = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'r', actor: 'owner', yes: true, logger: quiet });
        expect(done.outcome).toBe('PURGED');
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

    it('purge --revoke --yes refuses as another uid, writing nothing; its dry run still reports; as the owner it revokes', async () => {
        const built = await purgeFixture(412);
        const owner = ownerOf(built.root);
        const purged = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'r', actor: 'owner', yes: true, logger: quiet });
        expect(purged.outcome).toBe('PURGED');
        const tombstoneId = purged.tombstone?.tombstoneId ?? '';
        runAs(owner + 1);
        const before = snapshot(built.root);

        const dry = await runRevoke({ dataRoot: built.root, tombstoneId, reason: 'r', actor: 'owner', yes: false, logger: quiet });
        expect(dry.outcome).toBe('REVOKE_PLANNED');
        expect(dry.revokePlan?.summary).toMatch(/^Revokes /);

        const refused = await runRevoke({ dataRoot: built.root, tombstoneId, reason: 'r', actor: 'owner', yes: true, logger: quiet });
        expect(refused.outcome).toBe('WRONG_OWNER');
        expect(PURGE_EXIT_CODES[refused.outcome]).toBe(1);
        expect(refused.message).toMatch(WRONG);
        expect(refused.revoke).toBeNull();
        expect(snapshot(built.root)).toEqual(before);

        runAs(owner);
        expect((await runRevoke({ dataRoot: built.root, tombstoneId, reason: 'r', actor: 'owner', yes: true, logger: quiet })).outcome).toBe('REVOKED');
    });

    it('gc --apply refuses as another uid before its marker or any delete, exit 1; its dry run still plans', async () => {
        const built = await purgeFixture(412);
        const owner = ownerOf(built.root);
        const T0 = Date.now();
        expect((await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'r', actor: 'owner', yes: true, clock: () => T0, logger: quiet })).outcome).toBe('PURGED');
        const later = () => T0 + 8 * 24 * 60 * 60 * 1000;
        runAs(owner + 1);
        const planned = await runGc({ dataRoot: built.root, clock: later, logger: quiet });
        expect(planned.outcome).toBe('PLANNED');
        expect(planned.plan?.delete.map((entry) => entry.path)).toEqual([`assets/${built.d}/${built.first[built.d]}`]);
        const before = snapshot(built.root);

        const refused = await runGc({ dataRoot: built.root, clock: later, logger: quiet, apply: planned.plan?.digest });
        expect(refused.outcome).toBe('WRONG_OWNER');
        expect(GC_EXIT_CODES[refused.outcome]).toBe(1);
        expect(refused.message).toMatch(WRONG);
        expect(refused.deleted).toEqual([]);
        expect(snapshot(built.root)).toEqual(before);
        // The uid-matching apply is every other gc --apply test, run as the temp root's owner.
    });
});

describe('ownerRefusal() (A11, ruling c)', () => {
    it.runIf(posix)('refuses when the uids differ and allows when they match', () => {
        // Only stat()ed: whoever owns it, the faked uid differs from or matches that owner.
        const root = os.tmpdir();
        const owner = ownerOf(root);
        runAs(owner + 7);
        expect(ownerRefusal(root, 'photos purge')).toMatch(WRONG);
        runAs(owner);
        expect(ownerRefusal(root, 'photos purge')).toBeNull();
    });

    it('skips the check where there is no process.getuid(), as on Windows', () => {
        const original = Object.getOwnPropertyDescriptor(process, 'getuid');
        Object.defineProperty(process, 'getuid', { value: undefined, configurable: true, writable: true });
        try {
            expect(ownerRefusal('/nowhere/at/all', 'photos purge')).toBeNull();
        } finally {
            if (original) Object.defineProperty(process, 'getuid', original);
        }
    });
});

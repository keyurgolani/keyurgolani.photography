// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteCalls, scanSource, sourceFiles, type DeleteCall } from './helpers/deleteCalls';
import { REPO_ROOT } from './helpers/runTsx';

/**
 * The rail for delete calls (#181's A10 review, the coordinator's item 10).
 * Purge and GC reach only data the app itself made, and bytes a tombstone
 * took down go only on the owner's `photos gc --apply`. So every call in the
 * source tree that can delete a file or a folder is on this list, by file
 * and function, with why it may delete, and any other one fails the build.
 *
 * A new delete call needs an entry here, reviewed like the code. An entry
 * marked `until` is allowed only until that work lands: A12 fences or removes
 * the legacy `utils/imageOptimizer.ts` deletes, and whichever of A10 and A12
 * merges second rebases and updates this list.
 */

interface Allowed {
    file: string;
    /** The named functions the calls sit in, outermost first, as the scan names them. */
    fn: string;
    /** How many delete calls that function holds. One more is a new call, and fails. */
    calls: number;
    reason: string;
    /** Allowed only until this lands. */
    until?: string;
}

const ALLOWLIST: readonly Allowed[] = [
    // runGc's apply path, the one place bytes a tombstone took down go, and only on `photos gc --apply <digest>`.
    { file: 'lib/catalog/retention.ts', fn: 'removeSetAside', calls: 1, reason: "GC's tombstoned delete: a manifest-only asset folder it set aside as .gc-<r>-<uuid> this run and checked again" },
    { file: 'lib/catalog/retention.ts', fn: 'runGc.held', calls: 2, reason: "GC's abandoned-staging and orphan-candidate deletes, each rechecked under its locks just before" },
    // Storage pruning.
    { file: 'lib/storage/document.ts', fn: 'pruneVersions.remove', calls: 1, reason: 'drops a versioned document folder\'s oldest version files beyond the retained count, only names it wrote' },
    // Temp and probe cleanup.
    { file: 'lib/storage/config.ts', fn: 'sweepProbes', calls: 1, reason: "removes a .link-probe- file a killed process on this host left in the data root" },
    { file: 'lib/storage/config.ts', fn: 'linkProblem', calls: 1, reason: 'removes the hard-link probe file and its link it just made' },
    { file: 'lib/curation/auth/credential-cli.ts', fn: 'writeOwnerOnly', calls: 1, reason: 'removes its own temp file when the rename into place fails' },
    { file: 'lib/storage/atomicWrite.ts', fn: 'atomicWriteFile', calls: 1, reason: 'removes its own temp file when the write fails' },
    { file: 'lib/storage/atomicWrite.ts', fn: 'atomicCreateFile', calls: 1, reason: 'removes its own temp file once the hard link is made or refused' },
    { file: 'lib/storage/document.ts', fn: 'writeVersionedDocument', calls: 1, reason: 'removes its own temp file once the version is linked into place' },
    // Locks: the lock files the app's own locks create.
    { file: 'lib/storage/lock.ts', fn: 'withLock.breakExpired', calls: 2, reason: 'removes a lock file whose lease expired, after moving it aside' },
    { file: 'lib/storage/lock.ts', fn: 'withLock.tryCreate', calls: 1, reason: 'removes its own half-made lock file' },
    { file: 'lib/storage/lock.ts', fn: 'withLock.release', calls: 1, reason: 'removes the lock file it holds, on release' },
    // Staging and build leftovers: what a derivative build itself wrote under staging/.
    { file: 'lib/identity/derivatives.ts', fn: 'removeAbandonedStaging', calls: 1, reason: "the watcher's start clears a killed build's staging/<id>/, under its build lock, never assets/" },
    { file: 'lib/identity/derivatives.ts', fn: 'buildDerivativeSet', calls: 1, reason: 'a build that fails removes its own staging folder' },
    { file: 'lib/storage/publish.ts', fn: 'publishDirectory', calls: 1, reason: 'drops the staging copy when another writer already published the same set' },
    // Files the app made and has moved or finished with.
    { file: 'lib/identity/decisions.ts', fn: 'settleDecisions', calls: 1, reason: 'removes a rejected decision file from identity/decisions/ once its contents are written to rejected/' },
    { file: 'lib/catalog/edit-record.ts', fn: 'runEditRecord', calls: 1, reason: "removes photos edit's own working copy when the editor fails" },
    { file: 'lib/catalog/edit-record.ts', fn: 'runEditRecord.done', calls: 1, reason: "removes photos edit's own working copy once the edit is saved" },
    { file: 'lib/catalog/testing.ts', fn: 'createTestCatalog.cleanup', calls: 1, reason: 'the test catalog helper removes the temp folder it created' },
    // Legacy derivatives, until A12 fences or removes them.
    { file: 'utils/imageOptimizer.ts', fn: 'removeQuietly', calls: 1, reason: 'legacy derivative temp files', until: 'A12' },
    { file: 'utils/imageOptimizer.ts', fn: 'purgeDynamicCache', calls: 1, reason: 'legacy dynamic-cache files for a rebuilt set', until: 'A12' },
    { file: 'utils/imageOptimizer.ts', fn: 'forgetSetSource', calls: 1, reason: "a legacy set's source record", until: 'A12' },
];

const SCANNED = sourceFiles(['lib', 'app', 'components', 'utils', 'scripts'], ['proxy.ts', 'instrumentation.ts']);
const key = (entry: Pick<DeleteCall, 'file' | 'fn'>) => `${entry.file} ${entry.fn}`;

function grouped(calls: readonly DeleteCall[]): Map<string, DeleteCall[]> {
    const groups = new Map<string, DeleteCall[]>();
    for (const call of calls) groups.set(key(call), [...(groups.get(key(call)) ?? []), call]);
    return groups;
}

describe('the delete-call rail', () => {
    it('scans the source tree', () => {
        expect(SCANNED).toEqual(expect.arrayContaining(['lib/catalog/retention.ts', 'scripts/photos.ts', 'utils/imageOptimizer.ts', 'proxy.ts']));
        expect(SCANNED.some((file) => file.startsWith('app/'))).toBe(true);
        expect(SCANNED.some((file) => file.startsWith('components/'))).toBe(true);
        expect(SCANNED.some((file) => /__tests__|\.test\./.test(file))).toBe(false);
    });

    it('finds no delete call that is not on the allowlist, and no more in a function than it allows', () => {
        const allowed = new Map(ALLOWLIST.map((entry) => [key(entry), entry]));
        const stray: string[] = [];
        for (const [name, calls] of grouped(deleteCalls(SCANNED))) {
            const entry = allowed.get(name);
            const where = calls.map((call) => `${call.file}:${call.line} ${call.call}`).join(', ');
            if (!entry) stray.push(`not allowed: ${where}`);
            else if (calls.length !== entry.calls) stray.push(`${name} allows ${entry.calls}, has ${calls.length}: ${where}`);
        }
        expect(stray).toEqual([]);
    });

    it('has no entry that matches nothing, so a removed delete takes its entry with it', () => {
        const found = grouped(deleteCalls(SCANNED));
        expect(ALLOWLIST.filter((entry) => !found.has(key(entry))).map(key)).toEqual([]);
    });

    it('gives every entry a reason, and allows the legacy imageOptimizer deletes only until A12', () => {
        for (const entry of ALLOWLIST) expect(entry.reason, key(entry)).toMatch(/\S{3}/);
        expect(ALLOWLIST.filter((entry) => entry.file === 'utils/imageOptimizer.ts').every((entry) => entry.until === 'A12')).toBe(true);
        expect(ALLOWLIST.filter((entry) => entry.until !== undefined).every((entry) => entry.file === 'utils/imageOptimizer.ts')).toBe(true);
    });

    it('catches a stray delete in every form, the positive control', () => {
        const fixture = 'test/fixtures/deleteRail/stray.ts';
        const found = scanSource(fixture, fs.readFileSync(path.join(REPO_ROOT, fixture), 'utf8'));
        expect(found.map((call) => [call.fn, call.call])).toEqual([
            ['<module>', 'import rm'],
            ['tidyUp', 'fs.promises.rm'],
            ['tidyUpSync', 'fs.unlinkSync'],
            ['tidyUpSync', "fs['rmSync']"],
            ['viaImport', 'rm'],
            ['viaShell', 'execSync("rm -rf  ")'],
            ['viaShell', 'spawn("rm")'],
            ['viaShell', '-delete'],
            ['passedOn', 'fs.promises.unlink'],
        ]);
        // And the rail fails on it, as it would on any file in the tree.
        const allowed = new Set(ALLOWLIST.map(key));
        expect(found.filter((call) => !allowed.has(key(call)))).toHaveLength(found.length);
    });
});

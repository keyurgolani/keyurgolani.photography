// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callersAcross, callSites, deleteCalls, identifierSites, scanSource, sourceFiles, type DeleteCall } from './helpers/deleteCalls';
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
    /** The delete calls that function holds, by their text as the scan names them, sorted. Another call, or another text, fails. */
    calls: readonly string[];
    reason: string;
    /** Allowed only until this lands. */
    until?: string;
}

const ALLOWLIST: readonly Allowed[] = [
    // runGc's apply path, the one place a tombstoned folder's bytes go.
    { file: 'lib/catalog/retention.ts', fn: 'removeSetAside', calls: ['fs.promises.rm'], reason: "only on the owner's photos gc --apply <digest>: GC's tombstoned delete, of a manifest-only asset folder it set aside as .gc-<r>-<prefix>-<uuid> this run and checked again" },
    { file: 'lib/catalog/retention.ts', fn: 'runGc.collectTombstoned', calls: ['hooks.remove', 'hooks.remove'], reason: "only on photos gc --apply, and only in tests: the hooks.remove seam a test sets in place of removeSetAside" },
    { file: 'lib/catalog/retention.ts', fn: 'runGc.held', calls: ['fs.promises.rm', 'fs.promises.unlink'], reason: "only on photos gc --apply <digest>: GC's abandoned-staging and orphan-candidate deletes, each rechecked under its locks just before" },
    // Storage pruning.
    { file: 'lib/storage/document.ts', fn: 'pruneVersions.remove', calls: ['fs.promises.unlink'], reason: "on every versioned write: drops a versioned document folder's oldest version files beyond the retained count, only names it wrote" },
    { file: 'lib/storage/document.ts', fn: 'pruneVersions', calls: ['remove', 'remove'], reason: 'on every versioned write: its calls to its own remove(), for swept temps and versions past the retained count' },
    // Temp and probe cleanup.
    { file: 'lib/storage/config.ts', fn: 'sweepProbes', calls: ['fs.rmSync'], reason: 'on every data-root write check: removes a .link-probe- file a killed process on this host left in the data root' },
    { file: 'lib/storage/config.ts', fn: 'linkProblem', calls: ['fs.rmSync'], reason: 'on every data-root write check: removes the hard-link probe file and its link it just made' },
    { file: 'lib/curation/auth/credential-cli.ts', fn: 'writeOwnerOnly', calls: ['fs.rmSync'], reason: 'when the owner writes a curator credential: removes its own temp file when the rename into place fails' },
    { file: 'lib/storage/atomicWrite.ts', fn: 'atomicWriteFile', calls: ['fs.promises.rm'], reason: 'on every atomic write: removes its own temp file when the write fails' },
    { file: 'lib/storage/atomicWrite.ts', fn: 'atomicCreateFile', calls: ['fs.promises.rm'], reason: 'on every create-once write: removes its own temp file once the hard link is made or refused' },
    { file: 'lib/storage/document.ts', fn: 'writeVersionedDocument', calls: ['fs.promises.rm'], reason: 'on every versioned write: removes its own temp file once the version is linked into place' },
    // Locks: the lock files the app's own locks create.
    { file: 'lib/storage/lock.ts', fn: 'withLock.breakExpired', calls: ['fs.promises.rm', 'fs.promises.rm'], reason: 'whenever a lock is taken over: removes a lock file whose lease expired, after moving it aside' },
    { file: 'lib/storage/lock.ts', fn: 'withLock.tryCreate', calls: ['fs.promises.rm'], reason: 'whenever a lock is taken: removes its own half-made lock file' },
    { file: 'lib/storage/lock.ts', fn: 'withLock.release', calls: ['fs.promises.rm'], reason: 'whenever a lock is released: removes the lock file it holds' },
    // Staging and build leftovers: what a derivative build itself wrote under staging/.
    { file: 'lib/identity/derivatives.ts', fn: 'clearStagingEntry', calls: ['fs.promises.rm', 'fs.promises.unlink'], reason: "at watcher start (removeAbandonedStaging, from lib/identity/worker.ts): removes only direct children of staging/ that belong to builds that never published; follows no symlink, so an entry that is a symlink is unlinked as a link, never followed; and stays inside staging/ by dev:inode, each target's parent staging/'s own, re-checked right before the delete" },
    { file: 'lib/identity/derivatives.ts', fn: 'buildDerivativeSet', calls: ['fs.promises.rm'], reason: 'when a derivative build fails: removes its own staging folder' },
    { file: 'lib/storage/publish.ts', fn: 'publishDirectory', calls: ['fs.promises.rm'], reason: 'when a build publishes a set another writer already published: drops its own staging copy' },
    // Files the app made and has moved or finished with.
    { file: 'lib/identity/decisions.ts', fn: 'settleDecisions', calls: ['fs.promises.rm'], reason: 'on each identity pass that rejects a decision: removes the decision file from identity/decisions/ once its contents are written to rejected/' },
    { file: 'lib/catalog/edit-record.ts', fn: 'runEditRecord', calls: ['fs.promises.rm'], reason: "when photos edit's editor fails: removes photos edit's own working copy" },
    { file: 'lib/catalog/edit-record.ts', fn: 'runEditRecord.done', calls: ['fs.promises.rm'], reason: "when photos edit saves: removes photos edit's own working copy" },
    { file: 'lib/catalog/edit-record.ts', fn: 'shellEditor', calls: ["spawn runs a shell script that isn't a literal"], reason: "the owner's own program, run at his request, not an app delete" },
    { file: 'lib/catalog/testing.ts', fn: 'createTestCatalog.cleanup', calls: ['fs.promises.rm'], reason: 'when a test calls cleanup(): the test catalog helper removes the temp folder it created' },
    // Legacy derivatives, until A12 fences or removes them.
    { file: 'utils/imageOptimizer.ts', fn: 'removeQuietly', calls: ['fs.promises.rm'], reason: 'inside the photo library, until A12: legacy derivative temp files, when a legacy build writes', until: 'A12' },
    { file: 'utils/imageOptimizer.ts', fn: 'purgeDynamicCache', calls: ['fs.unlinkSync'], reason: 'inside the photo library, until A12: legacy dynamic-cache files, when a legacy set is rebuilt', until: 'A12' },
    { file: 'utils/imageOptimizer.ts', fn: 'forgetSetSource', calls: ['fs.rmSync'], reason: "inside the photo library, until A12: a legacy set's source record, when its set may no longer be its own", until: 'A12' },
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

    it('finds no delete call that is not on the allowlist, and in each function exactly the calls it pins, by text', () => {
        const allowed = new Map(ALLOWLIST.map((entry) => [key(entry), entry]));
        const stray: string[] = [];
        for (const [name, calls] of grouped(deleteCalls(SCANNED))) {
            const entry = allowed.get(name);
            const where = calls.map((call) => `${call.file}:${call.line} ${call.call}`).join(', ');
            if (!entry) stray.push(`not allowed: ${where}`);
            else if (JSON.stringify(calls.map((call) => call.call).sort()) !== JSON.stringify([...entry.calls].sort())) stray.push(`${name} allows ${JSON.stringify(entry.calls)}, has ${where}`);
        }
        expect(stray).toEqual([]);
    });

    it('has no entry that matches nothing, so a removed delete takes its entry with it', () => {
        const found = grouped(deleteCalls(SCANNED));
        expect(ALLOWLIST.filter((entry) => !found.has(key(entry))).map(key)).toEqual([]);
    });

    it('gives every entry a reason that says when it runs, and allows the legacy imageOptimizer deletes only inside the photo library until A12', () => {
        const WHEN = /^(?:only |on |at |when|whenever |inside the photo library, until A12)|run at his request/;
        for (const entry of ALLOWLIST) expect(entry.reason, key(entry)).toMatch(WHEN);
        expect(ALLOWLIST.filter((entry) => entry.file === 'utils/imageOptimizer.ts').every((entry) => entry.until === 'A12' && entry.reason.startsWith('inside the photo library, until A12'))).toBe(true);
        expect(ALLOWLIST.filter((entry) => entry.until !== undefined).every((entry) => entry.file === 'utils/imageOptimizer.ts')).toBe(true);
    });

    it('pins who calls each wrapper a delete sits in (item 17)', () => {
        expect(callersAcross(SCANNED, 'removeSetAside')).toEqual(['lib/catalog/retention.ts runGc.collectTombstoned']);
        expect(callersAcross(SCANNED, 'collectTombstoned')).toEqual(['lib/catalog/retention.ts runGc.held']);
        expect(callersAcross(SCANNED, 'removeAbandonedStaging').map((site) => site.split(' ')[0])).toEqual(['lib/identity/worker.ts']);
        expect(callersAcross(SCANNED, 'clearStagingEntry')).toEqual(['lib/identity/derivatives.ts removeAbandonedStaging']);
        expect(callersAcross(SCANNED, 'pruneVersions')).toEqual(['lib/storage/document.ts writeVersionedDocument']);
        expect(callSites('lib/catalog/retention.ts', 'removeSetAside')).toHaveLength(1);
        // Every reference, not only calls: its declaration, and the call and the hand-off to the test seam in collectTombstoned.
        expect(identifierSites(SCANNED, 'removeSetAside')).toEqual([
            'lib/catalog/retention.ts <module>',
            'lib/catalog/retention.ts runGc.collectTombstoned',
            'lib/catalog/retention.ts runGc.collectTombstoned',
        ]);
    });

    it('lets no shipped caller hand runGc hooks (item 23)', () => {
        // runGc takes hooks only through runGcCommand's fourth argument, which only tests pass.
        const commands = SCANNED.filter((file) => !file.endsWith('.sh')).flatMap((file) => callSites(file, 'runGcCommand').map((site) => ({ file, args: site.node.arguments.length })));
        expect(commands).toEqual([{ file: 'scripts/photos.ts', args: 3 }]);
        const direct = SCANNED.filter((file) => !file.endsWith('.sh')).flatMap((file) => callSites(file, 'runGc').map((site) => `${file} ${site.fn} ${site.node.arguments.map((arg) => arg.getText()).join(', ')}`));
        expect(direct).toEqual(["lib/catalog/retention-cli.ts runGcCommand { ...options, dataRoot, apply: args.apply, announce: (line) => io.out(line) }"]);
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
            ['viaShell', 'execSync runs rm'],
            ['viaShell', 'spawn runs rm'],
            ['viaShell', 'spawn runs find -delete'],
            ['passedOn', 'fs.promises.unlink'],
        ]);
        // And the rail fails on it, as it would on any file in the tree.
        const allowed = new Set(ALLOWLIST.map(key));
        expect(found.filter((call) => !allowed.has(key(call)))).toHaveLength(found.length);
    });

    it("catches each form the second review found it missed, the positive control for item 16", () => {
        const fixture = 'test/fixtures/deleteRail/strayForms.ts';
        const found = scanSource(fixture, fs.readFileSync(path.join(REPO_ROOT, fixture), 'utf8'));
        expect(found.map((call) => [call.fn, call.call])).toEqual([
            ['viaArrayElement', 'spawnSync runs rm'],
            ['viaArrayElement', 'execFileSync runs rm'],
            ['viaComputedCommand', "cp.spawn with a command that isn't a literal"],
            ['viaComputedCommand', "cp.exec with a command that isn't a literal"],
            ['viaShellScript', "spawnSync runs a shell script that isn't a literal"],
            ['viaGitAndFind', 'execFileSync runs git clean'],
            ['viaGitAndFind', 'cp.execSync runs git clean'],
            ['viaGitAndFind', 'spawnSync runs find -delete'],
            ['viaComputedAccess', "fs.promises['unlink']"],
            ['viaComputedAccess', 'computed access fsp[name]'],
            ['viaComputedAccess', 'Reflect.get(fs, …)'],
            ['viaExtraNames', 'fse.remove'],
            ['viaExtraNames', 'fse.removeSync'],
            ['viaExtraNames', 'fse.emptyDir'],
            ['viaExtraNames', 'fse.emptyDirSync'],
            ['Janitor.sweep', 'fs.rmSync'],
            // Round 4: git clean with options, and git with a list it can't read.
            ['viaGitOptions', 'cp.execSync runs git clean'],
            ['viaGitOptions', 'execFileSync runs git clean'],
            ['viaGitOptions', "execFileSync runs git with arguments that aren't a literal list"],
            // Shells and interpreters it can't read fail it closed (item 24).
            ['viaInterpreters', "spawnSync runs bash with arguments that aren't a literal list"],
            ['viaInterpreters', "spawnSync runs a shell script that isn't a literal"],
            ['viaInterpreters', "spawnSync runs a node script that isn't a literal"],
            ['viaInterpreters', "spawnSync runs a perl script that isn't a literal"],
            ['viaInterpreters', "spawnSync runs a python3 script that isn't a literal"],
            ['viaInterpreters', "spawnSync with shell: true and arguments that aren't literals"],
            // The rm family as commands.
            ['viaRmFamily', 'cp.execSync runs rm'],
            ['viaRmFamily', 'cp.execSync runs rm'],
            ['viaRmFamily', 'execFileSync runs rmdir'],
            ['viaRmFamily', 'execFileSync runs unlink'],
            // child_process reached indirectly.
            ['viaIndirectProcess', "exec with a command that isn't a literal"],
            ['viaIndirectProcess', 'loaded.execSync runs rm'],
            ['viaIndirectProcess', 'run runs rm'],
            // fs reached through an alias.
            ['viaFsAliases', 'escapes fs.promises'],
            ['viaFsAliases', "computed access p[name as 'rm']"],
            ['viaFsAliases', "computed access promises[name as 'rm']"],
            ['viaFsAliases', "destructure ['rm']: r"],
            ['viaFsAliases', "Reflect.get(require('fs'), …)"],
            // Modules it can't name, and banned ones through createRequire.
            ['viaDynamicModule', "require of a module that isn't a literal"],
            ['viaDynamicModule', "import() of a module that isn't a literal"],
            ['viaDynamicModule', 'module rimraf/dist/sync'],
            ['viaDynamicModule', 'module del'],
            // A child_process function handed on, which it can't follow.
            ['viaHandOff', 'passes on cp.execSync'],
            // Round 5 (item 27): rm right after a quote.
            ['viaQuotedRm', 'cp.execSync runs rm'],
            ['viaQuotedRm', 'cp.execSync runs rm'],
            ['viaQuotedRm', 'cp.execSync runs rm'],
            // Element access on a process object, like fs.
            ['viaProcessElement', "cp['execSync'] runs rm"],
            ['viaProcessElement', 'computed access cp[name]'],
            // getBuiltinModule, module.require and a require alias.
            ['viaBuiltinLoaders', "process.getBuiltinModule('node:child_process').execSync runs rm"],
            ['viaBuiltinLoaders', "module.require('node:child_process').execSync runs rm"],
            ['viaBuiltinLoaders', "load('node:child_process').execSync runs rm"],
            // The escape rule: anything but .name access or literal-key destructuring fails closed.
            ['viaEscapes', 'escapes fs'],
            ['viaEscapes', "escapes import('node:fs')"],
            ['viaEscapes', 'loaded.rmSync'],
            ['viaEscapes', 'escapes cp'],
            ['viaEscapes', 'escapes fsp'],
            ['viaEscapes', 'escapes fs.promises'],
            ['<module>', 'escapes fsp'],
            // A shell or interpreter with no literal script may read one on stdin.
            ['viaStdin', 'spawnSync runs sh with no literal script, so it may read one from stdin or a file'],
            ['viaStdin', 'spawnSync runs python3 with no literal script, so it may read one from stdin or a file'],
            // Options it can't read, with arguments that aren't literals.
            ['viaOptions', "spawnSync with options the rail can't read, and arguments that aren't literals"],
            ['viaOptions', "spawnSync with options the rail can't read, and arguments that aren't literals"],
            ['viaOptions', "spawnSync with options the rail can't read, and arguments that aren't literals"],
            // node -e scripts are scanned; other interpreters' scripts fail closed.
            ['viaNodeScript', "spawnSync runs node -e with require('fs').rmSync"],
            ['viaNodeScript', 'spawnSync runs node22 -e with require("fs").rmSync'],
            ['viaInterpreterScripts', "spawnSync runs a perl script, which the rail can't read"],
            ['viaInterpreterScripts', "spawnSync runs a python script, which the rail can't read"],
            ['viaInterpreterScripts', "spawnSync runs a python3.12 script, which the rail can't read"],
            ['viaInterpreterScripts', "spawnSync runs a ruby script, which the rail can't read"],
            ['viaInterpreterScripts', "spawnSync runs a bun script, which the rail can't read"],
            ['viaInterpreterScripts', "spawnSync runs a deno script, which the rail can't read"],
            // eval, new Function and Worker eval.
            ['viaEval', "eval, which the rail can't read"],
            ['viaEval', "new Function, which the rail can't read"],
            ['viaEval', "new Worker with eval, which the rail can't read"],
            // The controls round 4 left out.
            ['viaMissingControls', 'computed destructure [name]: anything'],
            ['viaMissingControls', "spawnSync runs sh with arguments that aren't literals"],
            // env, sudo, xargs, nice, timeout and npx, resolved first.
            ['viaWrappers', 'execFileSync runs git clean'],
            ['viaWrappers', 'execFileSync runs git clean'],
            ['viaWrappers', 'execFileSync runs git rm'],
            ['viaWrappers', 'execFileSync runs git worktree remove'],
            ['viaWrappers', 'execFileSync runs rimraf'],
            ['viaWrappers', "execFileSync runs env with arguments that aren't a literal list"],
            ['viaWrappers', "execFileSync runs sudo with arguments that aren't a literal list"],
            ['viaWrappers', 'cp.execSync runs rimraf'],
            // mkdtempDisposable removes its folder when disposed.
            ['viaDisposable', 'disposable.mkdtempDisposableSync'],
            ['viaDisposable', 'disposable.mkdtempDisposable'],
        ]);
    });

    it('bans the deleting packages by module name, default imports, require and import() included', () => {
        const fixture = 'test/fixtures/deleteRail/strayModules.ts.txt';
        const found = scanSource(fixture, fs.readFileSync(path.join(REPO_ROOT, fixture), 'utf8'));
        expect(found.map((call) => [call.fn, call.call])).toEqual([
            ['<module>', 'module rimraf'],
            ['<module>', 'module del'],
            ['<module>', 'module fs-extra'],
            ['<module>', 'module trash'],
            ['<module>', 'module fs-extra'],
            ['later', 'module rimraf'],
            // Round 4: subpaths, re-exports, and an alias by import-equals.
            ['<module>', 'module fs-extra/lib/remove'],
            ['<module>', 'module rimraf/dist/sync'],
            ['dyn', 'computed access fsAlias[name]'],
        ]);
    });
});

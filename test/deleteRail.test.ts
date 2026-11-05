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
    /**
     * What the entry lets past: a delete (the default); a process call, which
     * must say in `runs` what it runs, and in its reason why that can't
     * delete; or a read the rail can't resolve, the only kind whose reason
     * may say it reaches no delete (#181's A10 review, items 39 and 39a).
     */
    kind?: 'delete' | 'process' | 'unresolvable-read';
    /** For a process call: what it runs. */
    runs?: string;
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
    // Process calls: every one is on this list by its exact call text, with what it runs and why that can't delete.
    {
        kind: 'process',
        file: 'lib/catalog/edit-record.ts',
        fn: 'shellEditor',
        calls: ['spawn runs a process'],
        runs: "sh -c '$VISUAL \"$1\"' (or $EDITOR, or vi) on photos edit's own working copy, with the path as its one argument",
        reason: "only on the owner's photos edit, at his request: it opens his own editor, a program he chose, on a copy photos edit made. The app adds no command of its own, so nothing the app wrote runs a delete",
    },
    // Not deletes: a module's own state slot on globalThis, keyed by its Symbol.for(), which the rail can't resolve, so it fails closed and is let past here only.
    ...(
        [
            // file, function, the local given globalThis, its key, how many times it's read by that key, and whose slot it is.
            ['lib/catalog/preview-reader.ts', 'sharedState', 'global', 'PREVIEW_READER_STATE_KEY', 2, "the preview reader's"],
            ['lib/catalog/homePick.ts', 'cursors', 'holder', 'CURSORS', 2, "the test Home pick's"],
            ['lib/catalog/mode.ts', 'cutOver', 'store', 'CUTOVER_KEY', 1, "the catalog cut-over's"],
            ['lib/curation/auth/login.ts', 'state', 'holder', 'LOCK_KEY', 2, "the curator login lockout's"],
            ['lib/curation/auth/sessions.ts', 'store', 'holder', 'STORE_KEY', 2, "the curator sessions'"],
            ['lib/siteConfig/aboutPortrait.ts', 'memory', 'holder', 'MEMORY', 2, "the About portrait reader's"],
            ['lib/siteConfig/portraitVariants.ts', 'kept', 'holder', 'SETS', 2, "the About portrait sets'"],
        ] as const
    ).map(([file, fn, local, slot, reads, whose]): Allowed => ({
        kind: 'unresolvable-read',
        file,
        fn,
        calls: [`${local} = globalThis, which the rail can't read`, ...Array.from({ length: reads }, () => `${local}[${slot}], which the rail can't read`)],
        reason: `${whose} own state slot on globalThis; reaches no delete`,
    })),
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

// Each test parses the whole shipped tree, some several times, which takes longer than vitest's 5 s default on a loaded runner.
describe('the delete-call rail', { timeout: 60_000 }, () => {
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
        // A delete or a process call says when it runs; a read the rail can't resolve says it reaches no delete, and only that kind may.
        const WHEN = /^(?:only |on |at |when|whenever |inside the photo library, until A12)/;
        for (const entry of ALLOWLIST) {
            if (entry.kind === 'unresolvable-read') expect(entry.reason, key(entry)).toMatch(/reaches no delete$/);
            else expect(entry.reason, key(entry)).toMatch(WHEN);
            expect(/reaches no delete/.test(entry.reason), key(entry)).toBe(entry.kind === 'unresolvable-read');
        }
        expect(ALLOWLIST.filter((entry) => entry.file === 'utils/imageOptimizer.ts').every((entry) => entry.until === 'A12' && entry.reason.startsWith('inside the photo library, until A12'))).toBe(true);
        expect(ALLOWLIST.filter((entry) => entry.until !== undefined).every((entry) => entry.file === 'utils/imageOptimizer.ts')).toBe(true);
    });

    it('lets a process call past only on an entry of kind process that says what it runs and why that can\'t delete (item 39a)', () => {
        for (const entry of ALLOWLIST) {
            const process = entry.calls.some((call) => / runs a process$/.test(call));
            expect(entry.kind === 'process', key(entry)).toBe(process);
            if (process) {
                expect(entry.calls.every((call) => / runs a process$/.test(call)), key(entry)).toBe(true);
                expect(entry.runs, key(entry)).toMatch(/\S/);
                expect(entry.reason, key(entry)).toMatch(/nothing the app wrote runs a delete|can't delete/);
            } else {
                expect(entry.runs, key(entry)).toBeUndefined();
            }
        }
        // Today that is only the owner's editor.
        expect(ALLOWLIST.filter((entry) => entry.kind === 'process').map(key)).toEqual(['lib/catalog/edit-record.ts shellEditor']);
    });

    it('fails on a new process call anywhere in the shipped tree, whatever it runs (item 39a\'s positive control)', () => {
        const allowed = new Map(ALLOWLIST.map((entry) => [key(entry), entry]));
        const spawning = [
            "import { spawn } from 'node:child_process';\nexport function later(): void {\n    spawn('ls', ['-l']);\n}\n",
            "import { execFileSync } from 'node:child_process';\nexport const version = () => execFileSync('node', ['--version']);\n",
        ];
        // In every shipped directory, and under the name of a function the allowlist already lets a process call past in.
        for (const file of ['lib/later.ts', 'app/later.ts', 'components/later.tsx', 'utils/later.ts', 'scripts/later.ts', 'proxy.ts', 'lib/catalog/edit-record.ts']) {
            for (const text of [...spawning, "import { spawn } from 'node:child_process';\nexport function shellEditor(): void {\n    spawn('sh', ['-c', 'true']);\n    spawn('ls', []);\n}\n"]) {
                const found = scanSource(file, text);
                expect(found.length, `${file}: ${text}`).toBeGreaterThan(0);
                const groups = grouped(found);
                const passes = [...groups].every(([name, calls]) => {
                    const entry = allowed.get(name);
                    return entry !== undefined && JSON.stringify(calls.map((call) => call.call).sort()) === JSON.stringify([...entry.calls].sort());
                });
                expect(passes, `${file}: ${text}`).toBe(false);
            }
        }
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
        expect(direct).toEqual(["lib/catalog/retention-cli.ts runGcCommand { ...gcOptions, dataRoot, apply: args.apply, announce: (line) => io.out(line) }"]);
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
            ['viaShell', 'execSync runs a process'],
            ['viaShell', 'spawn runs a process'],
            ['viaShell', 'spawn runs a process'],
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
            // Round 8 (item 39): any load of node:vm.
            ['<module>', "module node:vm, which the rail can't read"],
            ['<module>', "module node:vm, which the rail can't read"],
            ['viaArrayElement', 'spawnSync runs a process'],
            ['viaArrayElement', 'execFileSync runs a process'],
            ['viaComputedCommand', 'cp.spawn runs a process'],
            ['viaComputedCommand', 'cp.exec runs a process'],
            ['viaShellScript', 'spawnSync runs a process'],
            ['viaGitAndFind', 'execFileSync runs a process'],
            ['viaGitAndFind', 'cp.execSync runs a process'],
            ['viaGitAndFind', 'spawnSync runs a process'],
            ['viaComputedAccess', "fs.promises['unlink']"],
            ['viaComputedAccess', 'computed access fsp[name]'],
            ['viaComputedAccess', 'Reflect.get(fs, …)'],
            ['viaExtraNames', 'fse.remove'],
            ['viaExtraNames', 'fse.removeSync'],
            ['viaExtraNames', 'fse.emptyDir'],
            ['viaExtraNames', 'fse.emptyDirSync'],
            ['Janitor.sweep', 'fs.rmSync'],
            // Round 4: git clean with options, and git with a list it can't read.
            ['viaGitOptions', 'cp.execSync runs a process'],
            ['viaGitOptions', 'execFileSync runs a process'],
            ['viaGitOptions', 'execFileSync runs a process'],
            // Shells and interpreters (item 24).
            ['viaInterpreters', 'spawnSync runs a process'],
            ['viaInterpreters', 'spawnSync runs a process'],
            ['viaInterpreters', 'spawnSync runs a process'],
            ['viaInterpreters', 'spawnSync runs a process'],
            ['viaInterpreters', 'spawnSync runs a process'],
            ['viaInterpreters', 'spawnSync runs a process'],
            // The rm family as commands.
            ['viaRmFamily', 'cp.execSync runs a process'],
            ['viaRmFamily', 'cp.execSync runs a process'],
            ['viaRmFamily', 'execFileSync runs a process'],
            ['viaRmFamily', 'execFileSync runs a process'],
            // child_process reached indirectly.
            ['viaIndirectProcess', 'exec runs a process'],
            ['viaIndirectProcess', 'loaded.execSync runs a process'],
            ['viaIndirectProcess', 'run runs a process'],
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
            ['viaQuotedRm', 'cp.execSync runs a process'],
            ['viaQuotedRm', 'cp.execSync runs a process'],
            ['viaQuotedRm', 'cp.execSync runs a process'],
            // Element access on a process object, like fs.
            ['viaProcessElement', "cp['execSync'] runs a process"],
            ['viaProcessElement', 'computed access cp[name]'],
            // getBuiltinModule, module.require and a require alias.
            ['viaBuiltinLoaders', "process.getBuiltinModule('node:child_process').execSync runs a process"],
            ['viaBuiltinLoaders', "module.require('node:child_process').execSync runs a process"],
            ['viaBuiltinLoaders', "load('node:child_process').execSync runs a process"],
            // The escape rule: anything but .name access or literal-key destructuring fails closed.
            ['viaEscapes', 'escapes fs'],
            ['viaEscapes', "escapes import('node:fs')"],
            ['viaEscapes', 'loaded.rmSync'],
            ['viaEscapes', 'escapes cp'],
            ['viaEscapes', 'escapes fsp'],
            // The alias is followed, and each use of it escapes too.
            ['viaEscapes', 'escapes alias'],
            ['viaEscapes', 'escapes fs.promises'],
            ['<module>', 'escapes fsp'],
            // A shell or interpreter with no literal script, which may read one on stdin.
            ['viaStdin', 'spawnSync runs a process'],
            ['viaStdin', 'spawnSync runs a process'],
            // Options it can't read, with arguments that aren't literals.
            ['viaOptions', 'spawnSync runs a process'],
            ['viaOptions', 'spawnSync runs a process'],
            ['viaOptions', 'spawnSync runs a process'],
            // node -e scripts, a harmless one included, and other interpreters' scripts.
            ['viaNodeScript', 'spawnSync runs a process'],
            ['viaNodeScript', 'spawnSync runs a process'],
            ['viaNodeScript', 'spawnSync runs a process'],
            ['viaInterpreterScripts', 'spawnSync runs a process'],
            ['viaInterpreterScripts', 'spawnSync runs a process'],
            ['viaInterpreterScripts', 'spawnSync runs a process'],
            ['viaInterpreterScripts', 'spawnSync runs a process'],
            ['viaInterpreterScripts', 'spawnSync runs a process'],
            ['viaInterpreterScripts', 'spawnSync runs a process'],
            // eval, new Function and Worker eval.
            ['viaEval', "eval, which the rail can't read"],
            ['viaEval', "new Function, which the rail can't read"],
            ['viaEval', "new Worker with eval, which the rail can't read"],
            // The controls round 4 left out.
            ['viaMissingControls', 'computed destructure [name]: anything'],
            ['viaMissingControls', 'spawnSync runs a process'],
            // env, sudo, xargs, nice, timeout and npx, resolved first.
            ['viaWrappers', 'execFileSync runs a process'],
            ['viaWrappers', 'execFileSync runs a process'],
            ['viaWrappers', 'execFileSync runs a process'],
            ['viaWrappers', 'execFileSync runs a process'],
            ['viaWrappers', 'execFileSync runs a process'],
            ['viaWrappers', 'execFileSync runs a process'],
            ['viaWrappers', 'execFileSync runs a process'],
            ['viaWrappers', 'cp.execSync runs a process'],
            // mkdtempDisposable removes its folder when disposed.
            ['viaDisposable', 'disposable.mkdtempDisposableSync'],
            ['viaDisposable', 'disposable.mkdtempDisposable'],
            // Round 6 (item 31): Reflect.get on child_process.
            ['viaReflectProcess', 'Reflect.get(cp, …)'],
            // exec string commands.
            ['viaExecWords', 'cp.execSync runs a process'],
            ['viaExecWords', 'cp.execSync runs a process'],
            ['viaExecWords', 'cp.execSync runs a process'],
            // A wrapper's own script flags, and a wrapper that names no command.
            ['viaWrapperFlags', 'execFileSync runs a process'],
            ['viaWrapperFlags', 'execFileSync runs a process'],
            ['viaWrapperFlags', 'execFileSync runs a process'],
            ['viaWrapperFlags', 'execFileSync runs a process'],
            ['viaWrapperFlags', 'execFileSync runs a process'],
            // Quoted keys.
            ['viaQuotedKeys', 'spawnSync runs a process'],
            ['viaQuotedKeys', "new Worker with eval, which the rail can't read"],
            ['viaNamespacedWorker', "new workers.Worker with eval, which the rail can't read"],
            // Indirect eval.
            ['viaIndirectEval', "eval, which the rail can't read"],
            ['viaIndirectEval', "globalThis.eval, which the rail can't read"],
            ['viaIndirectEval', "window.eval, which the rail can't read"],
            // More loaders.
            ['viaMoreLoaders', "process['getBuiltinModule']('node:child_process').execSync runs a process"],
            ['viaMoreLoaders', "globalThis.process.getBuiltinModule('node:child_process').execSync runs a process"],
            ['viaMoreLoaders', "process.mainModule?.require('node:child_process').execSync runs a process"],
            // An absolute rm, and a !rm git alias.
            ['viaAbsoluteAndAlias', 'execFileSync runs a process'],
            ['viaAbsoluteAndAlias', 'cp.execSync runs a process'],
            ['viaAbsoluteAndAlias', 'execFileSync runs a process'],
            // nohup, doas and busybox as wrappers, and npx running rm (M23).
            ['viaMoreWrappers', 'execFileSync runs a process'],
            ['viaMoreWrappers', 'execFileSync runs a process'],
            ['viaMoreWrappers', 'execFileSync runs a process'],
            ['viaMoreWrappers', 'execFileSync runs a process'],
            // node:vm.
            ['viaVm', "vm.runInNewContext, which the rail can't read"],
            ['viaVm', "vm.runInThisContext, which the rail can't read"],
            ['viaVm', "new vm.Script, which the rail can't read"],
            // Round 7 (item 37): shell -c scripts, nested interpreters and stdin shells (X16 strengthened).
            ['viaNestedShellScripts', 'spawnSync runs a process'],
            ['viaNestedShellScripts', 'spawnSync runs a process'],
            ['viaNestedShellScripts', 'spawnSync runs a process'],
            ['viaNestedShellScripts', 'spawnSync runs a process'],
            // The options' input strings.
            ['viaInputStrings', 'spawnSync runs a process'],
            // The loader's owner, bare.
            ['viaBareOwner', "(process as NodeJS.Process).getBuiltinModule('node:child_process').execSync runs a process"],
            // Wrapper script flags combined, or as --flag=, and busybox sh (X19 strengthened).
            ['viaWrapperFlagForms', 'execFileSync runs a process'],
            ['viaWrapperFlagForms', 'execFileSync runs a process'],
            ['viaWrapperFlagForms', 'execFileSync runs a process'],
            ['viaWrapperFlagForms', 'execFileSync runs a process'],
            // More eval and Worker forms.
            ['viaMoreEval', "globalThis['eval'], which the rail can't read"],
            ['viaMoreEval', "Reflect.get(globalThis, …), which the rail can't read"],
            ['viaMoreEval', "new (require('node:worker_threads').Worker) with eval, which the rail can't read"],
            ['viaMoreEval', "new Spawned with eval, which the rail can't read"],
            // Round 8 (item 39): every process call is a finding, whatever it runs, node --version included.
            ['nowFindings', 'cp.execSync runs a process'],
            ['nowFindings', 'spawnSync runs a process'],
            // The review's B1 forms: node reading stdin through input, --eval=, -pe, --import data:, -r and a script outside, and a list it can't read.
            ['viaNodeB1', 'spawnSync runs a process'],
            ['viaNodeB1', 'spawnSync runs a process'],
            ['viaNodeB1', 'spawnSync runs a process'],
            ['viaNodeB1', 'spawnSync runs a process'],
            ['viaNodeB1', 'spawnSync runs a process'],
            ['viaNodeB1', 'spawnSync runs a process'],
            ['viaNodeB1', 'spawnSync runs a process'],
            // Item 41: a variable given the global object, a member chain ending in one, and satisfies and <T> casts.
            ['viaGlobalForms', "g = globalThis, which the rail can't read"],
            ['viaGlobalForms', "alias = globalThis, which the rail can't read"],
            ['viaGlobalForms', "globalThis.globalThis[n as keyof typeof globalThis], which the rail can't read"],
            ['viaGlobalForms', "(globalThis satisfies typeof globalThis)[n as keyof typeof globalThis], which the rail can't read"],
            ['viaGlobalForms', "(<Record<string, unknown>>(globalThis as unknown))[n], which the rail can't read"],
            ['viaGlobalForms', "alias[n as keyof typeof globalThis], which the rail can't read"],
            // A Worker bound from worker_threads by another name, given options it can't read or code.
            ['viaWorkerForms', "new W with eval, which the rail can't read"],
            ['viaWorkerForms', "new NamedWorker with code or a path that isn't a literal, which the rail can't read"],
            // node:vm's Script through import(), .default and a named import.
            ['viaVmForms', "new (await import('node:vm')).Script, which the rail can't read"],
            ['viaVmForms', "module node:vm, which the rail can't read"],
            ['viaVmForms', "new (vm as unknown as { default: typeof vm }).default.Script, which the rail can't read"],
            ['viaVmForms', "new VmScript, which the rail can't read"],
            // The preview reader's state slot under another local name: caught by what it is, not by the name global.
            ['renamedSharedState', "store = globalThis, which the rail can't read"],
            ['renamedSharedState', "store[RENAMED_STATE_KEY], which the rail can't read"],
            ['renamedSharedState', "store[RENAMED_STATE_KEY], which the rail can't read"],
            // A computed key on the global object fails closed, however it's cast.
            ['viaComputedGlobal', "globalThis[name as keyof typeof globalThis], which the rail can't read"],
            ['viaComputedGlobal', "(globalThis as unknown as Record<string, unknown>)[name], which the rail can't read"],
        ]);
    });

    it('finds nothing in a Script class the same file declares (item 41)', () => {
        const fixture = 'test/fixtures/deleteRail/strayForms.ts';
        const found = scanSource(fixture, fs.readFileSync(path.join(REPO_ROOT, fixture), 'utf8'));
        expect(found.filter((call) => call.fn.startsWith('notFindings'))).toEqual([]);
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
            // Round 6: default, as the module object itself; re-exports; a data: URL.
            ['viaNamedDefault', 'computed access fsNamed[name]'],
            ['viaDestructuredDefault', 'whole.exec runs a process'],
            ['viaDotDefault', "computed access (await import('node:fs')).default[name]"],
            ['<module>', 're-exports node:fs'],
            ['<module>', 're-exports node:child_process'],
            ['viaData', "import() of a data: URL, which the rail can't read"],
        ]);
    });
});

// @vitest-environment node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callersAcross, callSites, deleteCalls, exclusionOf, identifierSites, PROCESS_CALL, RAIL_EXCLUSIONS, repositorySources, scanSource, shippedFiles, type DeleteCall } from './helpers/deleteCalls';
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
    { file: 'lib/catalog/retention.ts', fn: 'removeSetAside', calls: ['fs.promises.rm(aside, { recursive: true, force: true })'], reason: "only on the owner's photos gc --apply <digest>: GC's tombstoned delete, of a manifest-only asset folder it set aside as .gc-<r>-<prefix>-<uuid> this run and checked again" },
    { file: 'lib/catalog/retention.ts', fn: 'runGc.collectTombstoned', calls: ['hooks.remove', 'hooks.remove(aside, removeSetAside)'], reason: "only on photos gc --apply, and only in tests: the hooks.remove seam a test sets in place of removeSetAside" },
    { file: 'lib/catalog/retention.ts', fn: 'runGc.held', calls: ['fs.promises.rm(checked.target, { recursive: true, force: true })', 'fs.promises.unlink(checked.target)'], reason: "only on photos gc --apply <digest>: GC's abandoned-staging and orphan-candidate deletes, each rechecked under its locks just before" },
    // Storage pruning.
    { file: 'lib/storage/document.ts', fn: 'pruneVersions.remove', calls: ['fs.promises.unlink(path.join(/*turbopackIgnore: true*/ dir, name))'], reason: "on every versioned write: drops a versioned document folder's oldest version files beyond the retained count, only names it wrote" },
    { file: 'lib/storage/document.ts', fn: 'pruneVersions', calls: ['remove(`v${version}.json`)', 'remove(temp.name)'], reason: 'on every versioned write: its calls to its own remove(), for swept temps and versions past the retained count' },
    // Temp and probe cleanup.
    { file: 'lib/storage/config.ts', fn: 'sweepProbes', calls: ['fs.rmSync(file, { force: true })'], reason: 'on every data-root write check: removes a .link-probe- file a killed process on this host left in the data root' },
    { file: 'lib/storage/config.ts', fn: 'linkProblem', calls: ['fs.rmSync(name, { force: true })'], reason: 'on every data-root write check: removes the hard-link probe file and its link it just made' },
    { file: 'lib/curation/auth/credential-cli.ts', fn: 'writeOwnerOnly', calls: ['fs.rmSync(temp, { force: true })'], reason: 'when the owner writes a curator credential: removes its own temp file when the rename into place fails' },
    { file: 'lib/storage/atomicWrite.ts', fn: 'atomicWriteFile', calls: ['fs.promises.rm(/*turbopackIgnore: true*/ temp, { force: true })'], reason: 'on every atomic write: removes its own temp file when the write fails' },
    { file: 'lib/storage/atomicWrite.ts', fn: 'atomicCreateFile', calls: ['fs.promises.rm(temp, { force: true })'], reason: 'on every create-once write: removes its own temp file once the hard link is made or refused' },
    { file: 'lib/storage/document.ts', fn: 'writeVersionedDocument', calls: ['fs.promises.rm(temp, { force: true })'], reason: 'on every versioned write: removes its own temp file once the version is linked into place' },
    // Locks: the lock files the app's own locks create.
    { file: 'lib/storage/lock.ts', fn: 'withLock.breakExpired', calls: ['fs.promises.rm(stalePath, { force: true })', 'fs.promises.rm(stalePath, { force: true })'], reason: 'whenever a lock is taken over: removes a lock file whose lease expired, after moving it aside' },
    { file: 'lib/storage/lock.ts', fn: 'withLock.tryCreate', calls: ['fs.promises.rm(lockPath, { force: true })'], reason: 'whenever a lock is taken: removes its own half-made lock file' },
    { file: 'lib/storage/lock.ts', fn: 'withLock.release', calls: ['fs.promises.rm(releasing, { force: true })'], reason: 'whenever a lock is released: removes the lock file it holds' },
    // Staging and build leftovers: what a derivative build itself wrote under staging/.
    { file: 'lib/identity/derivatives.ts', fn: 'clearStagingEntry', calls: ['fs.promises.rm(target, { recursive: true, force: true })', 'fs.promises.unlink(target)'], reason: "at watcher start (removeAbandonedStaging, from lib/identity/worker.ts): removes only direct children of staging/ that belong to builds that never published; follows no symlink, so an entry that is a symlink is unlinked as a link, never followed; and stays inside staging/ by dev:inode, each target's parent staging/'s own, re-checked right before the delete" },
    { file: 'lib/identity/derivatives.ts', fn: 'buildDerivativeSet', calls: ['fs.promises.rm(staging, { recursive: true, force: true })'], reason: 'when a derivative build fails: removes its own staging folder' },
    { file: 'lib/storage/publish.ts', fn: 'publishDirectory', calls: ['fs.promises.rm(stagingDir, { recursive: true, force: true })'], reason: 'when a build publishes a set another writer already published: drops its own staging copy' },
    // Files the app made and has moved or finished with.
    { file: 'lib/identity/decisions.ts', fn: 'settleDecisions', calls: ['fs.promises.rm(source, { force: true })'], reason: 'on each identity pass that rejects a decision: removes the decision file from identity/decisions/ once its contents are written to rejected/' },
    { file: 'lib/catalog/edit-record.ts', fn: 'runEditRecord', calls: ['fs.promises.rm(working, { force: true })'], reason: "when photos edit's editor fails: removes photos edit's own working copy" },
    { file: 'lib/catalog/edit-record.ts', fn: 'runEditRecord.done', calls: ['fs.promises.rm(working, { force: true })'], reason: "when photos edit saves: removes photos edit's own working copy" },
    // Process calls: every one is on this list by its whole call, arguments and options included (item 43), with what it runs and why that can't delete.
    {
        kind: 'process',
        file: 'lib/catalog/edit-record.ts',
        fn: 'shellEditor',
        calls: [`${PROCESS_CALL}spawn('sh', ['-c', \`\${command} "$1"\`, 'sh', file], { stdio: 'inherit' })`],
        runs: "spawn('sh', ['-c', `${command} \"$1\"`, 'sh', file], { stdio: 'inherit' })",
        reason: "only on the owner's photos edit, at his request: it opens his own editor ($VISUAL, $EDITOR or vi), a program he chose, on a copy photos edit made, with the path as its one argument. The app adds no command of its own, so nothing the app wrote runs a delete",
    },
    // Not a delete: globalSlot(), the one read of the global object by a computed key, which the rail can't resolve, so it fails closed and is let past here only (item 48's N4).
    {
        kind: 'unresolvable-read',
        file: 'lib/globalSlot.ts',
        fn: 'globalSlot',
        calls: ["holder = globalThis, which the rail can't read", "holder[key], which the rail can't read", "holder[key], which the rail can't read"],
        reason: "each module's own process-wide state slot on globalThis, under its Symbol.for() key; reaches no delete",
    },
    { file: 'lib/catalog/testing.ts', fn: 'createTestCatalog.cleanup', calls: ['fs.promises.rm(created, { recursive: true, force: true })'], reason: 'when a test calls cleanup(): the test catalog helper removes the temp folder it created' },
    // Legacy derivatives, until A12 fences or removes them.
    { file: 'utils/imageOptimizer.ts', fn: 'removeQuietly', calls: ['fs.promises.rm(file, { force: true })'], reason: 'inside the photo library, until A12: legacy derivative temp files, when a legacy build writes', until: 'A12' },
    { file: 'utils/imageOptimizer.ts', fn: 'purgeDynamicCache', calls: ['fs.unlinkSync(path.join(paths.dynamicCache, name))'], reason: 'inside the photo library, until A12: legacy dynamic-cache files, when a legacy set is rebuilt', until: 'A12' },
    { file: 'utils/imageOptimizer.ts', fn: 'forgetSetSource', calls: ['fs.rmSync(setSourceFile(filename, paths), { force: true })'], reason: "inside the photo library, until A12: a legacy set's source record, when its set may no longer be its own", until: 'A12' },
];

const SCANNED = shippedFiles();

/** What a finding is: a process call, a read the rail can't resolve, or a delete (item 47). */
const callKind = (call: string): 'process' | 'unresolvable-read' | 'delete' => (call.startsWith(PROCESS_CALL) ? 'process' : call.endsWith("which the rail can't read") ? 'unresolvable-read' : 'delete');

/** Why an entry's kind doesn't fit its calls, or what a process entry leaves unsaid: none when it fits (items 39a, 43 and 47). */
function kindProblems(entry: Allowed): string[] {
    const kind = entry.kind ?? 'delete';
    const problems = entry.calls.filter((call) => callKind(call) !== kind).map((call) => `a ${kind} entry holds ${callKind(call)} call ${call}`);
    if (kind === 'process') {
        if (entry.runs === undefined || JSON.stringify(entry.calls) !== JSON.stringify([`${PROCESS_CALL}${entry.runs}`])) problems.push(`runs ${JSON.stringify(entry.runs)} isn't the call it pins`);
        if (!/can't delete|nothing the app wrote runs a delete/.test(entry.reason)) problems.push("its reason doesn't say why it can't delete");
    } else if (entry.runs !== undefined) {
        problems.push('only a process entry says what it runs');
    }
    if (/reaches no delete/.test(entry.reason) !== (kind === 'unresolvable-read')) problems.push('only an unresolvable-read entry, and every one, says it reaches no delete');
    return problems;
}

/** Whether the rail lets `found` past: every function it sits in is on the allowlist with exactly these calls. */
function passes(found: readonly DeleteCall[]): boolean {
    const allowed = new Map(ALLOWLIST.map((entry) => [key(entry), entry]));
    return [...grouped(found)].every(([name, calls]) => {
        const entry = allowed.get(name);
        return entry !== undefined && JSON.stringify(calls.map((call) => call.call).sort()) === JSON.stringify([...entry.calls].sort());
    });
}
const key = (entry: Pick<DeleteCall, 'file' | 'fn'>) => `${entry.file} ${entry.fn}`;

function grouped(calls: readonly DeleteCall[]): Map<string, DeleteCall[]> {
    const groups = new Map<string, DeleteCall[]>();
    for (const call of calls) groups.set(key(call), [...(groups.get(key(call)) ?? []), call]);
    return groups;
}

// Each test parses the whole shipped tree, some several times, which takes longer than vitest's 5 s default on a loaded runner.
describe('the delete-call rail', { timeout: 60_000 }, () => {
    it('scans every source file in the repository but what it excludes by name, each with its reason (item 44)', () => {
        expect(SCANNED).toEqual(expect.arrayContaining(['lib/catalog/retention.ts', 'scripts/photos.ts', 'utils/imageOptimizer.ts', 'proxy.ts', 'instrumentation.ts', 'data/artist.ts', 'next.config.mjs']));
        expect(SCANNED.some((file) => file.startsWith('app/'))).toBe(true);
        expect(SCANNED.some((file) => file.startsWith('components/'))).toBe(true);
        expect(SCANNED.some((file) => /__tests__|\.test\.|^e2e\/|^ci\/|^test\//.test(file))).toBe(false);
        // Every source file is scanned or excluded by a rule with its reason, and every rule leaves out something real.
        const all = repositorySources();
        expect(all.filter((file) => !SCANNED.includes(file) && exclusionOf(file) === null)).toEqual([]);
        for (const rule of RAIL_EXCLUSIONS) {
            expect(rule.reason, String(rule.pattern)).toMatch(/\w.{9,}/);
            // node_modules/ and .next/ are git-ignored, so the listing never holds them; each other rule leaves out a file that is there.
            const ignored = rule.pattern.test('node_modules/x.js') || rule.pattern.test('.next/x.js');
            expect(all.some((file) => rule.pattern.test(file)), String(rule.pattern)).toBe(!ignored);
        }
        expect(exclusionOf('ci/check-compose.mjs')?.reason).toMatch(/CI .*aren't shipped/);
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

    it("checks each entry's kind against its calls, and catches each mismatch (item 47)", () => {
        for (const entry of ALLOWLIST) expect(kindProblems(entry), key(entry)).toEqual([]);
        const base = { file: 'lib/x.ts', fn: 'x', reason: 'only on x' };
        // Each mismatch, the positive control: a read entry holding a delete, a delete entry holding a process call or a read, a process entry holding a delete.
        expect(kindProblems({ ...base, kind: 'unresolvable-read', calls: ['fs.rmSync'], reason: 'x; reaches no delete' })).toEqual(['a unresolvable-read entry holds delete call fs.rmSync']);
        expect(kindProblems({ ...base, calls: [`${PROCESS_CALL}spawn('ls', [])`] })).toEqual([`a delete entry holds process call ${PROCESS_CALL}spawn('ls', [])`]);
        expect(kindProblems({ ...base, calls: ["holder[key], which the rail can't read"] })).toEqual(["a delete entry holds unresolvable-read call holder[key], which the rail can't read"]);
        expect(kindProblems({ ...base, kind: 'process', calls: ['fs.rmSync'], runs: 'fs.rmSync', reason: "only on x: it can't delete" })).toEqual(['a process entry holds delete call fs.rmSync', 'runs "fs.rmSync" isn\'t the call it pins']);
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

    it('lets a process call past only by its whole call, so changing its arguments fails the rail (items 39a and 43)', () => {
        // Today the only process entry is the owner's editor.
        expect(ALLOWLIST.filter((entry) => entry.kind === 'process').map(key)).toEqual(['lib/catalog/edit-record.ts shellEditor']);
        const file = 'lib/catalog/edit-record.ts';
        const shipped = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
        expect(passes(scanSource(file, shipped).filter((call) => call.fn === 'shellEditor'))).toBe(true);
        // The positive control: the same function, the same callee, other arguments.
        for (const [from, to] of [
            ["spawn('sh', ['-c', `${command} \"$1\"`, 'sh', file], { stdio: 'inherit' })", "spawn('sh', ['-c', 'rm -rf \"$1\"', 'sh', file], { stdio: 'inherit' })"],
            ["{ stdio: 'inherit' }", "{ stdio: 'inherit', shell: true }"],
            ["'sh', file]", "'sh', file, '/']"],
        ]) {
            expect(shipped.includes(from), from).toBe(true);
            const changed = scanSource(file, shipped.replace(from, to)).filter((call) => call.fn === 'shellEditor');
            expect(changed.length, to).toBeGreaterThan(0);
            expect(passes(changed), to).toBe(false);
        }
    });

    it('pins every delete by its whole call, so changing what it deletes fails the rail (item 52, D1 and D2)', () => {
        for (const [file, fn, from, to] of [
            // D1: removeSetAside removing the photo's folder instead of the aside it set.
            ['lib/catalog/retention.ts', 'removeSetAside', 'await fs.promises.rm(aside, { recursive: true, force: true });', 'await fs.promises.rm(path.dirname(aside), { recursive: true, force: true });'],
            // D2: the staging clear removing all of staging/ instead of one entry: its `dir` is stagingRoot(root), and so is stagingRoot(root) written out.
            ['lib/identity/derivatives.ts', 'clearStagingEntry', 'await fs.promises.rm(target, { recursive: true, force: true });', 'await fs.promises.rm(dir, { recursive: true, force: true });'],
            ['lib/identity/derivatives.ts', 'clearStagingEntry', 'await fs.promises.rm(target, { recursive: true, force: true });', 'await fs.promises.rm(stagingRoot(root), { recursive: true, force: true });'],
            // And an option added is a change too.
            ['lib/storage/lock.ts', 'withLock.release', 'fs.promises.rm(releasing, { force: true })', 'fs.promises.rm(releasing, { force: true, recursive: true })'],
        ]) {
            const shipped = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
            expect(shipped.split(from).length - 1, from).toBe(1);
            expect(passes(scanSource(file, shipped).filter((call) => call.fn === fn))).toBe(true);
            const changed = scanSource(file, shipped.replace(from, to)).filter((call) => call.fn === fn);
            expect(changed.length, to).toBeGreaterThan(0);
            expect(passes(changed), to).toBe(false);
        }
    });

    it('scans a source file that is new and not yet added, and leaves a git-ignored one out (item 54)', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-others-'));
        const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
        git('init', '--quiet');
        fs.mkdirSync(path.join(root, 'lib'));
        fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
        fs.writeFileSync(path.join(root, 'lib', 'tracked.ts'), 'export {};\n');
        git('add', 'lib/tracked.ts', '.gitignore');
        fs.writeFileSync(path.join(root, 'lib', 'untracked.ts'), 'export {};\n');
        fs.mkdirSync(path.join(root, 'ignored'));
        fs.writeFileSync(path.join(root, 'ignored', 'built.js'), 'export {};\n');
        expect(shippedFiles(root)).toEqual(['lib/tracked.ts', 'lib/untracked.ts']);
    });

    it('fails on a new process call in every scanned directory, whatever it runs (item 44\'s positive control)', () => {
        const spawning = [
            "import { spawn } from 'node:child_process';\nexport function later(): void {\n    spawn('ls', ['-l']);\n}\n",
            "import { execFileSync } from 'node:child_process';\nexport const version = () => execFileSync('node', ['--version']);\n",
            "import { spawn } from 'node:child_process';\nexport function shellEditor(): void {\n    spawn('sh', ['-c', 'true']);\n}\n",
        ];
        const dirs = [...new Set(SCANNED.map((file) => path.posix.dirname(file)))];
        expect(dirs).toEqual(expect.arrayContaining(['.', 'data', 'lib', 'lib/catalog', 'app', 'components', 'utils', 'scripts']));
        for (const dir of dirs) {
            for (const text of spawning) {
                const file = dir === '.' ? 'later.ts' : `${dir}/later.ts`;
                const found = scanSource(file, text);
                expect(found.length, `${file}: ${text}`).toBeGreaterThan(0);
                expect(passes(found), `${file}: ${text}`).toBe(false);
            }
        }
        // Under the allowlisted shellEditor's own file and name too.
        for (const text of spawning) expect(passes(scanSource('lib/catalog/edit-record.ts', text)), text).toBe(false);
    });

    it('lets past only globalSlot() as it is: another member on its alias fails the rail (item 48, R2)', () => {
        const file = 'lib/globalSlot.ts';
        const shipped = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
        expect(passes(scanSource(file, shipped))).toBe(true);
        for (const extra of ['    void holder.process;\n', '    void holder[key].constructor.constructor;\n', "    void (holder as unknown as Record<string, unknown>)['eval'];\n", '    const other = holder;\n    void other;\n']) {
            const changed = shipped.replace('    holder[key] ??= init();\n', `    holder[key] ??= init();\n${extra}`);
            expect(changed).not.toBe(shipped);
            expect(passes(scanSource(file, changed)), extra).toBe(false);
        }
        // And it is the only read entry: every module's state goes through it.
        expect(ALLOWLIST.filter((entry) => entry.kind === 'unresolvable-read').map(key)).toEqual(['lib/globalSlot.ts globalSlot']);
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
            ['tidyUp', 'fs.promises.rm(dir, { recursive: true, force: true })'],
            ['tidyUpSync', 'fs.unlinkSync(file)'],
            ['tidyUpSync', "fs['rmSync'](file)"],
            ['viaImport', 'rm(dir, { recursive: true })'],
            ['viaShell', 'runs a process: execSync(`rm -rf ${dir}`)'],
            ['viaShell', "runs a process: spawn('rm', ['-rf', dir])"],
            ['viaShell', "runs a process: spawn('find', [dir, '-name', '*.tmp', '-delete'])"],
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
            // Any load of node:vm (round 8, item 39), node:module or worker_threads (round 9, item 48).
            ['<module>', "module node:module, which the rail can't read"],
            ['<module>', "module node:vm, which the rail can't read"],
            ['<module>', "module node:worker_threads, which the rail can't read"],
            ['<module>', "module node:worker_threads, which the rail can't read"],
            ['<module>', "module node:vm, which the rail can't read"],
            ['viaArrayElement', "runs a process: spawnSync('sh', ['-c', 'rm -rf build/'])"],
            ['viaArrayElement', "runs a process: execFileSync('xargs', ['rm', dir])"],
            ['viaComputedCommand', 'runs a process: cp.spawn(command, args)'],
            ['viaComputedCommand', 'runs a process: cp.exec(`${command} --now`)'],
            ['viaShellScript', "runs a process: spawnSync('bash', ['-c', `${script}`])"],
            ['viaGitAndFind', "runs a process: execFileSync('git', ['clean', '-fdx'])"],
            ['viaGitAndFind', "runs a process: cp.execSync('git clean -fd')"],
            ['viaGitAndFind', "runs a process: spawnSync('find', ['.', '-name', '*.tmp', '-delete'])"],
            ['viaComputedAccess', "fs.promises['unlink'](file)"],
            ['viaComputedAccess', 'computed access fsp[name]'],
            ['viaComputedAccess', 'Reflect.get(fs, …)'],
            ['viaExtraNames', 'fse.remove(dir)'],
            ['viaExtraNames', 'fse.removeSync(dir)'],
            ['viaExtraNames', 'fse.emptyDir(dir)'],
            ['viaExtraNames', 'fse.emptyDirSync(dir)'],
            ['Janitor.sweep', 'fs.rmSync(file)'],
            // Round 4: git clean with options, and git with a list it can't read.
            ['viaGitOptions', 'runs a process: cp.execSync(`git -C ${dir} clean -fdx`)'],
            ['viaGitOptions', "runs a process: execFileSync('git', ['-C', dir, 'clean', '-fd'])"],
            ['viaGitOptions', "runs a process: execFileSync('git', args)"],
            // Shells and interpreters (item 24).
            ['viaInterpreters', "runs a process: spawnSync('bash', args)"],
            ['viaInterpreters', "runs a process: spawnSync('env', ['FOO=1', 'sh', '-c', code])"],
            ['viaInterpreters', "runs a process: spawnSync('node', ['-e', code])"],
            ['viaInterpreters', "runs a process: spawnSync('perl', ['-e', code])"],
            ['viaInterpreters', "runs a process: spawnSync('python3', ['-c', code])"],
            ['viaInterpreters', "runs a process: spawnSync('ls', [code], { shell: true })"],
            // The rm family as commands.
            ['viaRmFamily', 'runs a process: cp.execSync(\'\\\\rm -rf build\')'],
            ['viaRmFamily', 'runs a process: cp.execSync(\'"rm" -rf build\')'],
            ['viaRmFamily', "runs a process: execFileSync('rmdir', ['build'])"],
            ['viaRmFamily', "runs a process: execFileSync('unlink', ['build/x'])"],
            // child_process reached indirectly.
            ['viaIndirectProcess', 'runs a process: exec(command)'],
            ['viaIndirectProcess', "runs a process: loaded.execSync('rm -rf x')"],
            ['viaIndirectProcess', "runs a process: run('rm -rf y')"],
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
            ['viaQuotedRm', 'runs a process: cp.execSync(\'bash -c "rm -rf build"\')'],
            ['viaQuotedRm', 'runs a process: cp.execSync("eval \'rm -rf build\'")'],
            ['viaQuotedRm', 'runs a process: cp.execSync(`sh -c \\`rm -rf ${dir}\\``)'],
            // Element access on a process object, like fs.
            ['viaProcessElement', "runs a process: cp['execSync']('rm -rf x')"],
            ['viaProcessElement', 'computed access cp[name]'],
            // getBuiltinModule, module.require and a require alias.
            ['viaBuiltinLoaders', "runs a process: process.getBuiltinModule('node:child_process').execSync('rm -rf x')"],
            ['viaBuiltinLoaders', "process.getBuiltinModule, which the rail can't read"],
            ['viaBuiltinLoaders', "runs a process: module.require('node:child_process').execSync('rm -rf y')"],
            ['viaBuiltinLoaders', "runs a process: load('node:child_process').execSync('rm -rf z')"],
            // The escape rule: anything but .name access or literal-key destructuring fails closed.
            ['viaEscapes', 'escapes fs'],
            // The alias is followed, and each use of it escapes too.
            ['viaEscapes', "escapes import('node:fs')"],
            ['viaEscapes', "loaded.rmSync('x')"],
            ['viaEscapes', 'escapes cp'],
            ['viaEscapes', 'escapes fsp'],
            ['viaEscapes', 'escapes alias'],
            ['viaEscapes', 'escapes fs.promises'],
            ['<module>', 'escapes fsp'],
            // A shell or interpreter with no literal script, which may read one on stdin.
            ['viaStdin', "runs a process: spawnSync('sh', [], { input: 'rm -rf x' })"],
            ['viaStdin', "runs a process: spawnSync('python3', ['script.py'])"],
            // Options it can't read, with arguments that aren't literals.
            ['viaOptions', "runs a process: spawnSync('ls', [file], options)"],
            ['viaOptions', "runs a process: spawnSync('ls', [file], { ...options })"],
            ['viaOptions', "runs a process: spawnSync('ls', [file], { shell })"],
            // node -e scripts, a harmless one included, and other interpreters' scripts.
            ['viaNodeScript', 'runs a process: spawnSync(\'node\', [\'-e\', "require(\'fs\').rmSync(\'x\')"])'],
            ['viaNodeScript', 'runs a process: spawnSync(\'node22\', [\'-e\', \'require("fs").rmSync("x")\'])'],
            ['viaNodeScript', "runs a process: spawnSync('node', ['-e', 'console.log(1)'])"],
            ['viaInterpreterScripts', "runs a process: spawnSync('perl', ['-e', 'print 1'])"],
            ['viaInterpreterScripts', "runs a process: spawnSync('python', ['-c', 'print(1)'])"],
            ['viaInterpreterScripts', "runs a process: spawnSync('python3.12', ['-c', 'print(1)'])"],
            ['viaInterpreterScripts', "runs a process: spawnSync('ruby', ['-e', 'puts 1'])"],
            ['viaInterpreterScripts', "runs a process: spawnSync('bun', ['-e', '1'])"],
            ['viaInterpreterScripts', "runs a process: spawnSync('deno', ['eval', '1'])"],
            // eval, new Function and Worker eval.
            ['viaEval', "eval, which the rail can't read"],
            ['viaEval', "new Function, which the rail can't read"],
            ['viaEval', "new Worker, a Worker, which the rail can't read"],
            // The controls round 4 left out.
            ['viaMissingControls', 'computed destructure [name]: anything'],
            ['viaMissingControls', 'runs a process: spawnSync(\'sh\', [\'-c\', \'echo "$1"\', \'sh\', x])'],
            // env, sudo, xargs, nice, timeout and npx, resolved first.
            ['viaWrappers', "runs a process: execFileSync('sudo', ['-u', 'root', 'git', 'clean', '-fd'])"],
            ['viaWrappers', "runs a process: execFileSync('nice', ['-n', '10', 'git', 'clean', '-fd'])"],
            ['viaWrappers', "runs a process: execFileSync('timeout', ['5', 'git', 'rm', '-r', 'x'])"],
            ['viaWrappers', "runs a process: execFileSync('xargs', ['-0', 'git', 'worktree', 'remove'])"],
            ['viaWrappers', "runs a process: execFileSync('npx', ['--yes', 'rimraf', 'build'])"],
            ['viaWrappers', "runs a process: execFileSync('env', args)"],
            ['viaWrappers', "runs a process: execFileSync('sudo', args)"],
            ['viaWrappers', "runs a process: cp.execSync('npx rimraf build')"],
            // mkdtempDisposable removes its folder when disposed.
            ['viaDisposable', "disposable.mkdtempDisposableSync('x')"],
            ['viaDisposable', "disposable.mkdtempDisposable('y')"],
            // Round 6 (item 31): Reflect.get on child_process.
            ['viaReflectProcess', 'Reflect.get(cp, …)'],
            // exec string commands.
            ['viaExecWords', "runs a process: cp.execSync('bash -s', { input: 'echo hi' })"],
            ['viaExecWords', 'runs a process: cp.execSync(\'node -e "require(\\\'fs\\\').rmSync(1)"\')'],
            ['viaExecWords', 'runs a process: cp.execSync(\'python -c "print(1)"\')'],
            // A wrapper's own script flags, and a wrapper that names no command.
            ['viaWrapperFlags', "runs a process: execFileSync('npx', ['-c', 'echo hi'])"],
            ['viaWrapperFlags', 'runs a process: execFileSync(\'env\', [\'-S\', \'sh -c "echo hi"\'])'],
            ['viaWrapperFlags', "runs a process: execFileSync('sudo', ['-s'])"],
            ['viaWrapperFlags', "runs a process: execFileSync('sudo', ['-i'])"],
            ['viaWrapperFlags', "runs a process: execFileSync('xargs', ['-I', 'rm -rf {}'])"],
            // Quoted keys.
            ['viaQuotedKeys', "runs a process: spawnSync('ls', [file], { 'shell': true })"],
            ['viaQuotedKeys', "new Worker, a Worker, which the rail can't read"],
            ['viaNamespacedWorker', "new workers.Worker, a Worker, which the rail can't read"],
            // Indirect eval.
            ['viaIndirectEval', "eval, which the rail can't read"],
            ['viaIndirectEval', "globalThis.eval, which the rail can't read"],
            ['viaIndirectEval', "window.eval, which the rail can't read"],
            // More loaders.
            ['viaMoreLoaders', "runs a process: process['getBuiltinModule']('node:child_process').execSync('rm -rf a')"],
            ['viaMoreLoaders', "process['getBuiltinModule'], which the rail can't read"],
            ['viaMoreLoaders', "runs a process: globalThis.process.getBuiltinModule('node:child_process').execSync('rm -rf b')"],
            ['viaMoreLoaders', "globalThis.process.getBuiltinModule, which the rail can't read"],
            ['viaMoreLoaders', "runs a process: process.mainModule?.require('node:child_process').execSync('rm -rf c')"],
            // An absolute rm, and a !rm git alias.
            ['viaAbsoluteAndAlias', "runs a process: execFileSync('/usr/local/bin/rm', ['-rf', 'x'])"],
            ['viaAbsoluteAndAlias', "runs a process: cp.execSync('/usr/local/bin/rm -rf x')"],
            ['viaAbsoluteAndAlias', "runs a process: execFileSync('git', ['config', 'alias.wipe', '!rm -rf .'])"],
            // nohup, doas and busybox as wrappers, and npx running rm (M23).
            ['viaMoreWrappers', "runs a process: execFileSync('nohup', ['git', 'clean', '-fd'])"],
            ['viaMoreWrappers', "runs a process: execFileSync('doas', ['git', 'rm', 'x'])"],
            ['viaMoreWrappers', "runs a process: execFileSync('busybox', ['rm', '-rf', 'x'])"],
            ['viaMoreWrappers', "runs a process: execFileSync('npx', ['--yes', 'rm', '-rf', 'x'])"],
            // node:vm.
            ['viaVm', "vm.runInNewContext, which the rail can't read"],
            ['viaVm', "vm.runInThisContext, which the rail can't read"],
            ['viaVm', "new vm.Script, which the rail can't read"],
            // Round 7 (item 37): shell -c scripts, nested interpreters and stdin shells (X16 strengthened).
            ['viaNestedShellScripts', 'runs a process: spawnSync(\'sh\', [\'-c\', "node -e \\"require(\'fs\').rmSync(\'x\')\\""])'],
            ['viaNestedShellScripts', 'runs a process: spawnSync(\'bash\', [\'-c\', \'python3 -c "print(1)"\'])'],
            ['viaNestedShellScripts', "runs a process: spawnSync('sh', ['-c', 'sh -s'])"],
            ['viaNestedShellScripts', "runs a process: spawnSync('sh', ['-c', '/usr/local/bin/rm -rf x'])"],
            // The options' input strings.
            ['viaInputStrings', "runs a process: spawnSync('ls', [], { input: 'git clean -fdx' })"],
            // The loader's owner, bare.
            ['viaBareOwner', "runs a process: (process as NodeJS.Process).getBuiltinModule('node:child_process').execSync('rm -rf d')"],
            ['viaBareOwner', "(process as NodeJS.Process).getBuiltinModule, which the rail can't read"],
            // Wrapper script flags combined, or as --flag=, and busybox sh (X19 strengthened).
            ['viaWrapperFlagForms', "runs a process: execFileSync('sudo', ['-si'])"],
            ['viaWrapperFlagForms', "runs a process: execFileSync('env', ['--split-string=sh -c x'])"],
            ['viaWrapperFlagForms', "runs a process: execFileSync('npx', ['--call=echo hi'])"],
            ['viaWrapperFlagForms', "runs a process: execFileSync('busybox', ['sh'])"],
            // More eval and Worker forms.
            ['viaMoreEval', "globalThis['eval'], which the rail can't read"],
            ['viaMoreEval', "Reflect.get(globalThis, …), which the rail can't read"],
            ['viaMoreEval', "new (require('node:worker_threads').Worker), a Worker, which the rail can't read"],
            ['viaMoreEval', "module node:worker_threads, which the rail can't read"],
            ['viaMoreEval', "new Spawned, a Worker, which the rail can't read"],
            // Round 8 (item 39): every process call is a finding, whatever it runs, node --version included.
            ['nowFindings', "runs a process: cp.execSync('node --version')"],
            ['nowFindings', "runs a process: spawnSync('node', ['--version'])"],
            // The review's B1 forms: node reading stdin through input, --eval=, -pe, --import data:, -r and a script outside, and a list it can't read.
            ['viaNodeB1', 'runs a process: spawnSync(\'node\', [], { input: "require(\'fs\').rmSync(\'x\')" })'],
            ['viaNodeB1', 'runs a process: spawnSync(\'node\', [\'--eval=require("fs").rmSync("x")\'])'],
            ['viaNodeB1', 'runs a process: spawnSync(\'node\', [\'-pe\', \'require("fs").rmSync("x")\'])'],
            ['viaNodeB1', "runs a process: spawnSync('node', ['--import', 'data:text/javascript,1'])"],
            ['viaNodeB1', "runs a process: spawnSync('node', ['-r', '/opt/other/wipe.js', '-e', '1'])"],
            ['viaNodeB1', "runs a process: spawnSync('node', ['/opt/other/wipe.js'])"],
            ['viaNodeB1', "runs a process: spawnSync('node', [x])"],
            // Item 41: a variable given the global object, a member chain ending in one, and satisfies and <T> casts.
            ['viaGlobalForms', "g = globalThis, which the rail can't read"],
            ['viaGlobalForms', "alias = globalThis, which the rail can't read"],
            ['viaGlobalForms', "globalThis.globalThis[n as keyof typeof globalThis], which the rail can't read"],
            ['viaGlobalForms', "(globalThis satisfies typeof globalThis)[n as keyof typeof globalThis], which the rail can't read"],
            ['viaGlobalForms', "(<Record<string, unknown>>(globalThis as unknown))[n], which the rail can't read"],
            ['viaGlobalForms', "alias[n as keyof typeof globalThis], which the rail can't read"],
            // A Worker bound from worker_threads by another name, given options it can't read or code.
            ['viaWorkerForms', "new W, a Worker, which the rail can't read"],
            ['viaWorkerForms', "new NamedWorker, a Worker, which the rail can't read"],
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
            // Round 9 (item 48): loader and native members on any object, process escaping, members of a global alias, .constructor() and Function, and any Worker.
            ['viaLoaderMembers', 'escapes process'],
            ['viaLoaderMembers', "proc.binding, which the rail can't read"],
            ['viaLoaderMembers', "proc['_linkedBinding'], which the rail can't read"],
            ['viaLoaderMembers', "(process as unknown as { dlopen: unknown }).dlopen, which the rail can't read"],
            ['viaLoaderMembers', "(process as unknown as { execve: unknown }).execve, which the rail can't read"],
            ['viaLoaderMembers', "anything.getBuiltinModule, which the rail can't read"],
            ['viaLoaderMembers', "anything.createRequire, which the rail can't read"],
            ['viaLoaderMembers', "anything._load, which the rail can't read"],
            ['viaProcessEscapes', 'escapes process'],
            ['viaProcessEscapes', 'escapes process'],
            ['viaProcessEscapes', 'escapes process'],
            ['viaProcessEscapes', 'escapes globalThis.process'],
            ['viaProcessEscapes', 'escapes p'],
            ['viaGlobalAliasMembers', "g2 = globalThis, which the rail can't read"],
            ['viaGlobalAliasMembers', "g2.process, which the rail can't read"],
            ['viaGlobalAliasMembers', "g2.Function, which the rail can't read"],
            ['viaConstructor', "({}).constructor.constructor(…), which the rail can't read"],
            ['viaConstructor', "(globalThis as unknown as { Function: (code: string) => unknown }).Function, which the rail can't read"],
            ['viaAnyWorker', "new Worker, a Worker, which the rail can't read"],
            ['viaAnyWorker', "new workers.Worker, a Worker, which the rail can't read"],
        ]);
    });

    it('finds nothing in a Script class the same file declares, or in process read by a member or typeof (items 41 and 48)', () => {
        const fixture = 'test/fixtures/deleteRail/strayForms.ts';
        const found = scanSource(fixture, fs.readFileSync(path.join(REPO_ROOT, fixture), 'utf8'));
        expect(found.filter((call) => call.fn.startsWith('notFindings'))).toEqual([]);
    });

    it('bans the deleting packages by module name, default imports, require and import() included', () => {
        const fixture = 'test/fixtures/deleteRail/strayModules.ts.txt';
        const found = scanSource(fixture, fs.readFileSync(path.join(REPO_ROOT, fixture), 'utf8'));
        expect(found.map((call) => [call.fn, call.call])).toEqual([
            // Round 4: subpaths, re-exports, and an alias by import-equals.
            ['<module>', 'module rimraf'],
            ['<module>', 'module del'],
            ['<module>', 'module fs-extra'],
            ['<module>', 'module trash'],
            ['<module>', 'module fs-extra'],
            ['later', 'module rimraf'],
            ['<module>', 'module fs-extra/lib/remove'],
            ['<module>', 'module rimraf/dist/sync'],
            ['dyn', 'computed access fsAlias[name]'],
            // Round 6: default, as the module object itself; re-exports; a data: URL.
            ['viaNamedDefault', 'computed access fsNamed[name]'],
            ['viaDestructuredDefault', 'runs a process: whole.exec(command)'],
            ['viaDotDefault', "computed access (await import('node:fs')).default[name]"],
            // Round 9 (item 48): node:module, cluster, inspector, repl, wasi and worker_threads, however they're loaded.
            ['<module>', 're-exports node:fs'],
            ['<module>', 're-exports node:child_process'],
            ['viaData', "import() of a data: URL, which the rail can't read"],
            ['<module>', "module node:cluster, which the rail can't read"],
            ['<module>', "module inspector, which the rail can't read"],
            ['<module>', "module node:repl, which the rail can't read"],
            ['<module>', "module node:wasi, which the rail can't read"],
            ['<module>', "module module, which the rail can't read"],
            ['viaCodeModules', "module worker_threads, which the rail can't read"],
            ['viaCodeModules', "module node:inspector/promises, which the rail can't read"],
        ]);
    });
});

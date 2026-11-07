// @vitest-environment node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, runTsx, type TsxRun } from '../../../test/helpers/runTsx';
import { runPurge } from '../purge';
import { runGc } from '../retention';
import { readAuthoredRecord } from '../working-layer';
import { cleanupPurgeTemplates, purgeFixture, quiet, snapshot, tempLibrary, writeOpenEvent, type PurgeFixture } from './purgeFixtures';

/**
 * The A11 coordinator's round 3 rule, end to end: every command that takes a
 * lock or writes under the data root refuses as a non-owner before its first
 * lock, exit 1, WRONG_OWNER, writing nothing, locks/ included. Read-only
 * commands and dry runs still run. Each case spawns the real CLI, or the
 * watcher, as the npm scripts do, on its own copy of A10's purge fixture,
 * with test/helpers/fakeUid.cjs making the child's geteuid() answer another
 * uid than the temp root's owner, its real uid left as it is (round 4).
 *
 * These lists are the spec, written apart from lib/catalog/owner-gate.ts so
 * they pin what the gate does, not what its table says.
 */

afterAll(() => cleanupPurgeTemplates());

const posix = typeof process.geteuid === 'function' || typeof process.getuid === 'function';
const PRELOAD = path.join(REPO_ROOT, 'test', 'helpers', 'fakeUid.cjs');

interface World {
    built: PurgeFixture;
    owner: number;
    library: string;
    /** A file outside the data root, for --file, --import and --out. */
    outside: string;
    eventId: string;
    tombstoneId: string;
    /** D's asset-revision folder, which the tombstone takes down: one gc --set-aside takes. */
    downFolder: string;
    digest: string;
}

async function world(): Promise<World> {
    const built = await purgeFixture(413);
    const owner = fs.statSync(built.root).uid;
    const library = tempLibrary(built.root);
    const outside = fs.mkdtempSync(path.join(path.dirname(built.root), 'outside-'));
    fs.writeFileSync(path.join(outside, 'descriptions.csv'), `photoId,alt\n${built.a},A fixture description.\n`);
    fs.writeFileSync(path.join(outside, 'plan.json'), '{}\n');
    const record = await readAuthoredRecord(built.root, 'photo', built.a);
    fs.writeFileSync(path.join(outside, 'record.json'), `${JSON.stringify({ ...record, title: 'Retitled' }, null, 2)}\n`);
    // A path outside the data root by its name that leads into it (round 4).
    fs.symlinkSync(built.root, path.join(outside, 'root-link'));
    const event = writeOpenEvent(built.root, built.c, built.first[built.c]);
    const purged = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'r', actor: 'owner', yes: true, logger: quiet });
    if (purged.outcome !== 'PURGED') throw new Error(`The fixture's purge ended ${purged.outcome}.`);
    const planned = await runGc({ dataRoot: built.root, logger: quiet });
    if (!planned.plan) throw new Error('The fixture has no GC plan.');
    return {
        built, owner, library, outside,
        eventId: event.id,
        tombstoneId: purged.tombstone?.tombstoneId ?? '',
        downFolder: `assets/${built.d}/${built.first[built.d]}`,
        digest: planned.plan.digest,
    };
}

function run(w: World, script: string, args: string[], uid: number | null): Promise<TsxRun> {
    return runTsx(script, args, {
        env: {
            PHOTOGRAPHY_DATA_DIR: w.built.root,
            PHOTOGRAPHY_LIBRARY_DIR: w.library,
            PHOTOS_ACTOR: 'test',
            ...(uid === null ? {} : { NODE_OPTIONS: `--require ${PRELOAD}`, PHOTOS_TEST_UID: String(uid) }),
        },
    });
}

function locksState(root: string): { mtimeMs: number; entries: string[] } | null {
    const dir = path.join(root, 'locks');
    return fs.existsSync(dir) ? { mtimeMs: fs.statSync(dir).mtimeMs, entries: fs.readdirSync(dir).sort() } : null;
}

/** Everything a refusal must leave alone: the snapshot (which leaves locks/ out), and locks/ itself, its mtime and entries. */
function untouched(root: string): () => void {
    const before = snapshot(root);
    const locks = locksState(root);
    return () => {
        expect(snapshot(root)).toEqual(before);
        expect(locksState(root)).toEqual(locks);
        expect((locksState(root)?.entries ?? []).filter((name) => name.endsWith('.lock'))).toEqual([]);
    };
}

type Argv = (w: World) => string[];

/** Every command, subcommand and flag that takes a lock or writes under the data root, with arguments that would get it there. */
const WRITERS: { name: string; argv: Argv }[] = [
    { name: 'migrate --dry-run', argv: () => ['migrate', '--dry-run'] },
    { name: 'migrate --apply', argv: (w) => ['migrate', '--apply', '--plan', path.join(w.outside, 'plan.json')] },
    ...(['bind', 'new', 'archive', 'retry', 'reprofile'] as const).map((sub) => ({
        name: `identity ${sub}`,
        argv: (w: World) => ['identity', sub, ...(sub === 'bind' ? ['a.jpg', w.built.a] : sub === 'new' ? ['a.jpg'] : [w.built.a])],
    })),
    { name: 'draft:init', argv: () => ['draft:init'] },
    { name: 'describe --import', argv: (w) => ['describe', '--import', path.join(w.outside, 'descriptions.csv')] },
    { name: 'carry-over --apply', argv: () => ['carry-over', '--apply', '--actor', 'test'] },
    { name: 'edit', argv: (w) => ['edit', w.built.a, '--file', path.join(w.outside, 'record.json'), '--expect-version', '1'] },
    { name: 'sequence', argv: (w) => ['sequence', 'remove', w.built.seriesId, w.built.c] },
    { name: 'series', argv: () => ['series', 'featured', '--clear'] },
    { name: 'publish', argv: () => ['publish', '--actor', 'test'] },
    { name: 'publish --dry-run', argv: () => ['publish', '--actor', 'test', '--dry-run'] },
    { name: 'review', argv: (w) => ['review', 'chg_x', '--expect', w.built.revisions[3], '--expect-active', w.built.revisions[3]] },
    { name: 'rollback --yes', argv: (w) => ['rollback', '--to', '2', '--reason', 'r', '--actor', 'test', '--yes', '--expect-active', w.built.revisions[3]] },
    { name: 'verify', argv: () => ['verify'] },
    ...(['edit', 'approve', 'defer', 'dismiss', 'retry', 'reopen', 'confirm', 'bind', 'archive', 'resolve', 'confirm-missing'] as const).map((sub) => ({
        name: `curation ${sub}`,
        argv: (w: World) => ['curation', sub, w.eventId, '--version', '1', ...(sub === 'dismiss' ? ['--reason', 'r'] : sub === 'resolve' ? ['--as', 'new'] : [])],
    })),
    { name: 'purge --yes', argv: (w) => ['purge', w.built.c, '--reason', 'r', '--actor', 'test', '--yes'] },
    { name: 'purge --revoke --yes', argv: (w) => ['purge', '--revoke', w.tombstoneId, '--reason', 'r', '--actor', 'test', '--yes'] },
    { name: 'gc --apply', argv: (w) => ['gc', '--apply', w.digest] },
    { name: 'gc --set-aside', argv: (w) => ['gc', '--set-aside', w.downFolder] },
    // Round 3b: dry runs that take a lock to read write a lock file, so they refuse too.
    { name: 'purge (dry run, takes the catalog and authored locks)', argv: (w) => ['purge', w.built.c, '--reason', 'r', '--actor', 'test'] },
    { name: 'purge --revoke (dry run, takes the catalog lock)', argv: (w) => ['purge', '--revoke', w.tombstoneId, '--reason', 'r', '--actor', 'test'] },
    { name: 'gc (dry run, takes the catalog and authored locks)', argv: () => ['gc'] },
    // Round 4: an --out that resolves into the data root makes a writer of a reader, through a symlink too.
    { name: 'curation session-secret --out inside the data root, in locks/', argv: (w) => ['curation', 'session-secret', '--out', path.join(w.built.root, 'locks', 'stray.key')] },
    { name: 'migrate --dry-run --out through a symlink into the data root', argv: (w) => ['migrate', '--dry-run', '--out', path.join(w.outside, 'root-link', 'identity', 'migration-out')] },
    // Round 4: an identity or curation subcommand the table doesn't know fails closed; the owner gets the usage error.
    { name: 'identity <unknown>', argv: () => ['identity', 'frobnicate'] },
    { name: 'curation <unknown>', argv: () => ['curation', 'frobnicate'] },
    // Round 4, option (b): rollback without --yes takes the catalog lock to read, or to settle a crashed
    // activation when the target is live already, so it's a lock-taking read: the owner's alone.
    { name: 'rollback --to <the live revision> without --yes (settles under the catalog lock)', argv: () => ['rollback', '--to', '3', '--reason', 'r', '--actor', 'test'] },
    { name: 'rollback --to <an eligible revision> without --yes', argv: (w) => ['rollback', '--to', '2', '--reason', 'r', '--actor', 'test', '--expect-active', w.built.revisions[3]] },
    // It writes status/legacy-derivatives.json, and makes status/ when there is none, so --stdout writes too.
    { name: 'legacy-derivatives', argv: () => ['legacy-derivatives'] },
    { name: 'legacy-derivatives --stdout', argv: () => ['legacy-derivatives', '--stdout'] },
];

/**
 * Every command that takes no lock and writes nothing under the data root, traced (round 3b) with a write
 * tracer over each one's run and a read of each one's lock calls: as a non-owner it answers as it does for the owner.
 */
const READERS: { name: string; argv: Argv }[] = [
    { name: 'status', argv: () => ['status'] },
    { name: 'status --json --check', argv: () => ['status', '--json', '--check'] },
    { name: 'identity status', argv: () => ['identity', 'status', '--json'] },
    { name: 'list', argv: () => ['list', '--json'] },
    { name: 'validate', argv: () => ['validate'] },
    { name: 'diff', argv: () => ['diff', '--json'] },
    { name: 'history', argv: () => ['history', '--json', '--revisions'] },
    { name: 'describe --import --dry-run', argv: (w) => ['describe', '--import', path.join(w.outside, 'descriptions.csv'), '--dry-run'] },
    { name: 'carry-over (its plan)', argv: () => ['carry-over'] },
    { name: 'curation list', argv: () => ['curation', 'list', '--all', '--json'] },
    { name: 'curation show', argv: (w) => ['curation', 'show', w.eventId, '--json'] },
    { name: 'migrate --dry-run --out outside the data root', argv: (w) => ['migrate', '--dry-run', '--out', path.join(w.outside, 'migration')] },
    { name: 'curation session-secret --out outside the data root', argv: (w) => ['curation', 'session-secret', '--out', path.join(w.outside, `session-${Date.now()}.key`)] },
];

/** The other uid: root, as the mistake the gate exists for, unless the temp root is root's. */
const other = (w: World) => (w.owner === 0 ? 1 : 0);

const WRONG = /\[photos\] WRONG_OWNER: .* runs as uid (\d+), but uid (\d+) owns the data root, and web runs as that owner\..*Nothing was written\./;

describe.runIf(posix)('the owner gate, every writer (A11 round 3)', { timeout: 120_000 }, () => {
    for (const writer of WRITERS) {
        it(`photos ${writer.name} as another uid: exit 1, WRONG_OWNER, nothing written, locks/ untouched`, async () => {
            const w = await world();
            const check = untouched(w.built.root);
            const result = await run(w, 'scripts/photos.ts', writer.argv(w), other(w));
            expect(`${result.stdout}${result.stderr}`).toMatch(WRONG);
            expect(result.stderr).toContain(`runs as uid ${other(w)}, but uid ${w.owner} owns the data root`);
            // How to run it as the owner, with the compose line.
            expect(result.stderr).toContain(`user: "${w.owner}:${fs.statSync(w.built.root).gid}"`);
            expect(result.stderr).toMatch(/docker compose -f docker-compose\.prod\.yml run --rm --no-deps image-watcher node dist\/scripts\/photos\.mjs \S+/);
            expect(result.code).toBe(1);
            check();
        });
    }

    it('the watcher, --once, as another uid: exit 1, WRONG_OWNER, nothing written, locks/ untouched', async () => {
        const w = await world();
        const check = untouched(w.built.root);
        const result = await run(w, 'scripts/imageWatcher.ts', ['--once'], other(w));
        expect(result.stderr).toMatch(/\[ImageWatcher\] WRONG_OWNER: the image watcher runs as uid \d+, but uid \d+ owns the data root/);
        expect(result.code).toBe(1);
        check();
    });

    it('the watcher, --once, as the owner still runs its pass', async () => {
        const w = await world();
        const result = await run(w, 'scripts/imageWatcher.ts', ['--once'], w.owner);
        expect(`${result.stdout}${result.stderr}`).not.toMatch(/WRONG_OWNER/);
    });
});

/** The curator's startup hook, instrumentation.ts's register(), as the server runs it first, with CURATION_ENABLED=true. */
function startCurator(w: World, uid: number | null) {
    return new Promise<TsxRun>((resolve, reject) => {
        const child = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', '--input-type=module', '-e', "const m = await import('./instrumentation.ts'); await m.register(); console.log('[test] register() returned');"], {
            cwd: REPO_ROOT,
            env: {
                ...process.env,
                NEXT_RUNTIME: 'nodejs',
                CURATION_ENABLED: 'true',
                HOSTNAME: '127.0.0.1',
                PHOTOGRAPHY_DATA_DIR: w.built.root,
                PHOTOGRAPHY_LIBRARY_DIR: w.library,
                ...(uid === null ? {} : { NODE_OPTIONS: `--require ${PRELOAD}`, PHOTOS_TEST_UID: String(uid) }),
            },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
}

describe.runIf(posix)('the owner gate, the curator at its start (A11 round 3b)', { timeout: 120_000 }, () => {
    it('refuses to start as another uid: non-zero, WRONG_OWNER, nothing written, locks/ untouched', async () => {
        const w = await world();
        const check = untouched(w.built.root);
        const result = await startCurator(w, other(w));
        expect(result.stderr).toMatch(/WRONG_OWNER: the curator runs as uid \d+, but uid \d+ owns the data root/);
        expect(result.stdout).not.toContain('register() returned');
        expect(result.code).not.toBe(0);
        check();
    });

    it('starts as the owner: no WRONG_OWNER', async () => {
        const w = await world();
        const result = await startCurator(w, w.owner);
        expect(`${result.stdout}${result.stderr}`).not.toMatch(/WRONG_OWNER/);
    });
});

describe.runIf(posix)('the owner gate, every reader and dry run (A11 round 3)', { timeout: 120_000 }, () => {
    for (const reader of READERS) {
        it(`photos ${reader.name} as another uid answers as it does for the owner`, async () => {
            const asOwner = await world();
            const owned = await run(asOwner, 'scripts/photos.ts', reader.argv(asOwner), asOwner.owner);
            const w = await world();
            // Round 4: a reader writes nothing either, a lock file included.
            const check = untouched(w.built.root);
            const result = await run(w, 'scripts/photos.ts', reader.argv(w), other(w));
            expect(`${result.stdout}${result.stderr}`).not.toMatch(/WRONG_OWNER/);
            expect(result.code).toBe(owned.code);
            check();
        });
    }

    it('photos identity and photos curation with an unknown subcommand, as the owner, still get the usage error', async () => {
        const w = await world();
        for (const argv of [['identity', 'frobnicate'], ['curation', 'frobnicate']]) {
            const result = await run(w, 'scripts/photos.ts', argv, w.owner);
            expect(`${result.stdout}${result.stderr}`).not.toMatch(/WRONG_OWNER/);
            expect(result.code).toBe(2);
        }
    });
});


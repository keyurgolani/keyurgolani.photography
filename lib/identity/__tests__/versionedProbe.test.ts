// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { noHardLinksNodeOptions, stubNoHardLinks } from '../../../test/helpers/noHardLinks';
import { runTsx } from '../../../test/helpers/runTsx';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { ApplyRefusedError, migrateApply } from '../apply';
import { buildDerivativeSet } from '../derivatives';
import { migrateDryRun } from '../migration';
import { currentProfileId } from '../profile';
import { createIdentityStep } from '../watcherStep';
import { createWorker } from '../worker';

// Every writer of a versioned document asks dataRootStatus() for `versioned`, so a data root whose
// filesystem can't hold the hard links each version commits with is refused before anything is written.

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const later = () => Date.now() + 3_600_000;
const HARD_LINKS = "can't hold hard links";

let image: Buffer;
const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
    image = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 40, g: 120, b: 200 } } }).jpeg().toBuffer();
});

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Context {
    lib: TempLibrary;
    data: TempDataRoot;
}

interface Writer {
    /** Anything the writer needs that is written before links fail, such as a dry-run plan. */
    prepare?: (c: Context) => Promise<string>;
    /** Runs the writer with every link() failing, and returns the reason it gave, or null when it gives none. */
    run: (c: Context, prepared: string | undefined) => Promise<string | null>;
}

const WRITERS: [string, Writer][] = [
    ['migrate --apply', {
        prepare: async () => (await migrateDryRun({ clock: later, logger: quiet })).planPath,
        run: async ({ data }, planPath) => {
            const error = await migrateApply({ planPath: planPath as string, clock: later, logger: quiet, dockerenvPath: path.join(data.root, '..', 'no-dockerenv') })
                .catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(ApplyRefusedError);
            return (error as ApplyRefusedError).message;
        },
    }],
    ['the derivative build', {
        run: async () => {
            const job = { photoId: 'ph_00000000-0000-4000-8000-000000000001', assetRevision: `sha256-${'0'.repeat(64)}`, profileId: currentProfileId(), path: 'photo.jpg' };
            const outcome = await buildDerivativeSet(job, { logger: quiet });
            expect(outcome).toEqual({ status: 'skipped', reason: 'data-root' });
            return null; // It gives no reason
        },
    }],
    ["the derivative worker's start", {
        run: async () => {
            const worker = createWorker({ logger: quiet });
            cleanups.push(() => worker.stop());
            const start = await worker.start();
            expect(start).toMatchObject({ started: false, reason: 'data-root', state: 'unwritable' });
            return (start as { detail?: string }).detail ?? '';
        },
    }],
    ["the watcher step's pass and check", {
        run: async () => {
            const lines: string[] = [];
            const push = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
            const step = createIdentityStep({ logger: { log: push, warn: push, error: push }, requestPass: () => undefined, pass: { clock: later } });
            cleanups.push(async () => {
                step.stop();
                await step.idle();
            });
            expect(await step.pass('startup')).toEqual({ status: 'off', state: 'unwritable' });
            await step.check();
            expect(lines.filter((line) => line.startsWith('[identity] Identity step on'))).toEqual([]);
            return lines.join('\n');
        },
    }],
    ['photos identity', {
        run: async ({ lib, data }) => {
            const run = await runTsx('scripts/photos.ts', ['identity', 'reprofile', '--all'], {
                env: { PHOTOGRAPHY_LIBRARY_DIR: lib.root, PHOTOGRAPHY_DATA_DIR: data.root, NODE_OPTIONS: noHardLinksNodeOptions() },
            });
            expect(run.code, run.stderr).toBe(1);
            expect(run.stderr).toContain('Nothing was written.');
            return run.stderr;
        },
    }],
];

describe("a data root whose filesystem can't hold hard links", { timeout: 60_000 }, () => {
    it.each(WRITERS)('is refused by %s before it writes anything', async (_, writer) => {
        const lib = await createTempLibrary();
        cleanups.push(() => lib.cleanup());
        fs.writeFileSync(lib.file('photo.jpg'), image);
        const data = createTempDataRoot();
        cleanups.push(() => data.cleanup());
        const prepared = await writer.prepare?.({ lib, data });
        const before = data.files();

        cleanups.push(stubNoHardLinks());
        const reason = await writer.run({ lib, data }, prepared);
        if (reason !== null) expect(reason).toContain(HARD_LINKS);
        expect(data.files()).toEqual(before);
    });
});

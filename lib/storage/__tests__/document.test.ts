// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTsx } from '../../../test/helpers/runTsx';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import {
    checkSchemaVersion,
    CorruptDocumentError,
    EditedInPlaceError,
    KEEP_VERSIONS,
    MAX_VERSION_DIGITS,
    MisnamedVersionError,
    pruneVersions,
    READ_ATTEMPTS,
    readJsonFile,
    readVersionedDocument,
    StaleVersionError,
    UnsupportedSchemaError,
    versionFile,
    writeVersionedDocument,
} from '../document';

interface Counter {
    schemaVersion: number;
    version: number;
    count: number;
}

let data: TempDataRoot;
let dir: string;

beforeEach(() => {
    data = createTempDataRoot({ state: 'uninitialized' });
    dir = data.file('counter');
});

afterEach(async () => {
    vi.restoreAllMocks();
    await data.cleanup();
});

const counter = (count: number): Counter => ({ schemaVersion: 1, version: 0, count });

/** Commit `count` on top of whatever is newest. */
async function commitNext(count: number): Promise<Counter> {
    const newest = (await readVersionedDocument(dir))?.version ?? 0;
    return writeVersionedDocument(dir, counter(count), newest);
}

/** The names in the document's folder, sorted, temps included. */
function names(): string[] {
    return fs.readdirSync(dir).sort();
}

const temps = () => names().filter((name) => name.endsWith('.tmp'));
const countIn = (version: number) => (JSON.parse(fs.readFileSync(versionFile(dir, version), 'utf8')) as Counter).count;

describe('checkSchemaVersion', () => {
    it('accepts the current and previous versions and says which', () => {
        expect(checkSchemaVersion('doc.json', { schemaVersion: 3 }, 3)).toBe('current');
        expect(checkSchemaVersion('doc.json', { schemaVersion: 2 }, 3)).toBe('previous');
    });

    it('rejects a future version as unsupported, flagged future', () => {
        let error: unknown;
        try {
            checkSchemaVersion('doc.json', { schemaVersion: 4 }, 3);
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(UnsupportedSchemaError);
        expect(error).toMatchObject({ found: 4, current: 3, future: true });
    });

    it('rejects an older version than the previous one, and malformed ones', () => {
        expect(() => checkSchemaVersion('doc.json', { schemaVersion: 1 }, 3)).toThrow(UnsupportedSchemaError);
        expect(() => checkSchemaVersion('doc.json', { schemaVersion: '1' }, 1)).toThrow(CorruptDocumentError);
        expect(() => checkSchemaVersion('doc.json', [], 1)).toThrow(CorruptDocumentError);
        expect(() => checkSchemaVersion('doc.json', null, 1)).toThrow(CorruptDocumentError);
    });
});

describe('readJsonFile', () => {
    it('returns null for a missing file and throws for one that is not JSON', async () => {
        expect(await readJsonFile(data.file('missing.json'))).toBeNull();
        fs.writeFileSync(data.file('bad.json'), '{"truncated": ');
        await expect(readJsonFile(data.file('bad.json'))).rejects.toThrow(CorruptDocumentError);
    });
});

describe('readVersionedDocument', () => {
    it('reads the newest version by number, and null for a folder with none or no folder', async () => {
        expect(await readVersionedDocument(dir)).toBeNull();
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, '.DS_Store'), '');
        fs.writeFileSync(path.join(dir, '.v1.123.abc.tmp'), '{}');
        expect(await readVersionedDocument(dir)).toBeNull();

        fs.writeFileSync(versionFile(dir, 2), JSON.stringify({ schemaVersion: 1, version: 2, count: 2 }));
        fs.writeFileSync(versionFile(dir, 10), JSON.stringify({ schemaVersion: 1, version: 10, count: 10 }));
        expect(await readVersionedDocument(dir)).toMatchObject({ version: 10, value: { count: 10, version: 10 }, file: versionFile(dir, 10) });
    });

    it("refuses a name that looks like a version but isn't spelled as one, which a case-insensitive disk could hand a writer", async () => {
        await commitNext(1);
        fs.writeFileSync(path.join(dir, 'V2.JSON'), '{}');
        await expect(readVersionedDocument(dir)).rejects.toBeInstanceOf(MisnamedVersionError);
        fs.rmSync(path.join(dir, 'V2.JSON'));
        fs.writeFileSync(path.join(dir, 'v02.json'), '{}');
        await expect(readVersionedDocument(dir)).rejects.toThrow('looks like a version');
    });

    it('refuses a name that folds to a version only under Unicode case folding, as APFS folds v2.jſon to v2.json', async () => {
        await commitNext(1);
        fs.writeFileSync(path.join(dir, 'v2.jſon'), '{}');
        await expect(readVersionedDocument(dir)).rejects.toBeInstanceOf(MisnamedVersionError);
    });

    it('refuses a version number too long to read exactly as misnamed, not as a folder that kept changing', async () => {
        await commitNext(1);
        const huge = 'v99999999999999999999.json';
        fs.writeFileSync(path.join(dir, huge), '{}');
        const error = await readVersionedDocument(dir).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(MisnamedVersionError);
        expect(error).toMatchObject({ file: path.join(dir, huge), message: expect.stringContaining(`at most ${MAX_VERSION_DIGITS} digits`) });
        // The longest number it reads is still a version.
        fs.rmSync(path.join(dir, huge));
        const longest = Number('9'.repeat(MAX_VERSION_DIGITS));
        expect(Number.isSafeInteger(longest)).toBe(true);
        fs.writeFileSync(versionFile(dir, longest), JSON.stringify(counter(5)));
        expect(await readVersionedDocument(dir)).toMatchObject({ version: longest, value: { count: 5 } });
        await expect(writeVersionedDocument(dir, counter(6), longest)).rejects.toThrow(RangeError);
    });

    it('throws CorruptDocumentError for a newest version that is not a JSON object', async () => {
        fs.mkdirSync(dir);
        fs.writeFileSync(versionFile(dir, 1), '{"truncated": ');
        await expect(readVersionedDocument(dir)).rejects.toBeInstanceOf(CorruptDocumentError);
        fs.writeFileSync(versionFile(dir, 2), '[1]');
        await expect(readVersionedDocument(dir)).rejects.toThrow('expected a JSON object');
    });
});

describe('writeVersionedDocument', () => {
    it('commits each version as its own stamped file, readable by its owner only, and keeps the newest two', async () => {
        const first = await writeVersionedDocument(dir, counter(1), 0);
        expect(first).toEqual({ schemaVersion: 1, version: 1, count: 1 });
        await writeVersionedDocument(dir, counter(2), 1);
        await writeVersionedDocument(dir, counter(3), 2);
        expect(KEEP_VERSIONS).toBe(2);
        expect(names()).toEqual(['v2.json', 'v3.json']);
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(versionFile(dir, 3)).mode & 0o777).toBe(0o600);

        const raw = JSON.parse(fs.readFileSync(versionFile(dir, 3), 'utf8')) as Record<string, unknown>;
        expect(raw).toMatchObject({ count: 3, version: 3, stamp: { version: 3, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
        expect(await readVersionedDocument(dir)).toEqual({ version: 3, value: { schemaVersion: 1, version: 3, count: 3 }, file: versionFile(dir, 3), handMade: false });
    });

    it('lets exactly one of many writers at one version commit, and fails the rest as stale', async () => {
        await writeVersionedDocument(dir, counter(0), 0);
        const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => writeVersionedDocument(dir, counter(index + 1), 1)));
        const won = results.filter((result) => result.status === 'fulfilled');
        const lost = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(19);
        for (const result of lost) expect(result.reason).toBeInstanceOf(StaleVersionError);
        expect((await readVersionedDocument(dir))?.value).toEqual((won[0] as PromiseFulfilledResult<Counter>).value);
        expect(temps()).toEqual([]);
    });

    it('fails as stale and commits nothing when the newest is not the version it expected', async () => {
        await writeVersionedDocument(dir, counter(1), 0);
        await expect(writeVersionedDocument(dir, counter(9), 0)).rejects.toMatchObject({ name: 'StaleVersionError', expected: 0, found: 1 });
        await expect(writeVersionedDocument(dir, counter(9), 3)).rejects.toMatchObject({ name: 'StaleVersionError', expected: 3, found: 1 });
        expect(names()).toEqual(['v1.json']);
    });

    it('never commits a pruned number again: a writer that read an old version stops at its listing', async () => {
        for (let count = 1; count <= 5; count++) await commitNext(count);
        expect(names()).toEqual(['v4.json', 'v5.json']);
        // It read version 2 long ago. v3.json is free again, so only the listing before the link stops it.
        await expect(writeVersionedDocument(dir, counter(99), 2)).rejects.toMatchObject({ name: 'StaleVersionError', expected: 2, found: 5 });
        expect(names()).toEqual(['v4.json', 'v5.json']);
        expect((await readVersionedDocument(dir))?.value.count).toBe(5);
    });

    it('fails a writer paused between its listing and its link while others commit and prune past its number', async () => {
        await commitNext(1);
        const paused = writeVersionedDocument(dir, counter(99), 1, {
            hooks: {
                async beforeLink() {
                    // Others commit 2, 3, and 4. The prune after 4 frees v2.json, the number this writer is about to link.
                    for (let count = 2; count <= 4; count++) await commitNext(count);
                    expect(names()).toEqual(['v3.json', 'v4.json']);
                },
            },
        });
        await expect(paused).rejects.toMatchObject({ name: 'StaleVersionError', expected: 1, found: 4 });
        expect(names()).toEqual(['v3.json', 'v4.json']);
        expect((await readVersionedDocument(dir))?.value.count).toBe(4);
    });

    it('fails a writer paused before its link while another commits its number', async () => {
        await commitNext(1);
        let other: Promise<Counter> | undefined;
        let release!: () => void;
        const paused = writeVersionedDocument(dir, counter(99), 1, {
            hooks: {
                beforeLink: () => new Promise<void>((linked) => {
                    // The other writer links version 2 and stops before its prune, so this one's temp is still there.
                    other = writeVersionedDocument(dir, counter(2), 1, {
                        hooks: { afterLink: () => new Promise<void>((resume) => { release = resume; linked(); }) },
                    });
                }),
            },
        });
        await expect(paused).rejects.toMatchObject({ name: 'StaleVersionError', expected: 1, found: 2 });
        release();
        await expect(other).resolves.toMatchObject({ version: 2, count: 2 });
        expect(countIn(2)).toBe(2);
        expect(temps()).toEqual([]);
    });

    it('reports a commit paused right after its link done, though others commit and prune it before it resumes', async () => {
        await commitNext(1);
        const paused = writeVersionedDocument(dir, counter(10), 1, {
            hooks: {
                async afterLink() {
                    await commitNext(20);
                    await commitNext(30);
                    // Its own v2.json is pruned, and its temp swept, before it goes on.
                    expect(names()).toEqual(['v3.json', 'v4.json']);
                },
            },
        });
        await expect(paused).resolves.toEqual({ schemaVersion: 1, version: 2, count: 10 });
        expect((await readVersionedDocument(dir))?.value.count).toBe(30);
    });

    it("removes a crashed writer's temp at the next commit's prune, and no prune removes a temp above the newest", { timeout: 30_000 }, async () => {
        await commitNext(1);
        const run = await runTsx('test/helpers/storageWorker.ts', ['crash-version', JSON.stringify({ dir, value: counter(2), expected: 1 })]);
        expect(run.signal, run.stderr).toBe('SIGKILL');
        expect(temps()).toHaveLength(1);
        expect(temps()[0]).toMatch(/^\.v2\.\d+\.[0-9a-f-]+\.tmp$/);
        expect((await readVersionedDocument(dir))?.value.count).toBe(1);

        // A writer may still be committing version 2 with it.
        expect(await pruneVersions(dir)).toEqual([]);
        expect(temps()).toHaveLength(1);

        await commitNext(2);
        expect(names()).toEqual(['v1.json', 'v2.json']);
    });

    it('creates only the document folder, never a missing parent', async () => {
        await expect(writeVersionedDocument(data.file('missing', 'doc'), counter(1), 0)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(fs.existsSync(data.file('missing'))).toBe(false);
    });
});

describe('pruneVersions', () => {
    it('sweeps the temps at or below the newest before it deletes anything, then keeps the newest two by number', async () => {
        fs.mkdirSync(dir);
        for (const version of [1, 2, 3, 4]) fs.writeFileSync(versionFile(dir, version), JSON.stringify({ ...counter(version), version }));
        fs.writeFileSync(path.join(dir, '.v3.77.aaaa.tmp'), '{}');
        fs.writeFileSync(path.join(dir, '.v5.77.bbbb.tmp'), '{}');
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'left alone');

        expect(await pruneVersions(dir)).toEqual(['.v3.77.aaaa.tmp', 'v2.json', 'v1.json']);
        expect(names()).toEqual(['.v5.77.bbbb.tmp', 'notes.txt', 'v3.json', 'v4.json']);
        expect(await pruneVersions(dir, { keep: 1 })).toEqual(['v3.json']);
        await expect(pruneVersions(dir, { keep: 0 })).rejects.toThrow(RangeError);
    });
});

describe('a reader against commits and prunes', () => {
    it('lists again when the version it picked is pruned before it opens it, and returns the newest', async () => {
        await commitNext(1);
        let pauses = 0;
        const read = await readVersionedDocument(dir, {
            hooks: {
                async afterList(file) {
                    if (pauses++ > 0) return;
                    expect(path.basename(file)).toBe('v1.json');
                    // KEEP_VERSIONS commits and their prune land between its listing and its open.
                    await commitNext(2);
                    await commitNext(3);
                    expect(fs.existsSync(file)).toBe(false);
                },
            },
        });
        expect(pauses).toBe(2);
        expect(read).toMatchObject({ version: 3, value: { count: 3 } });
    });

    it('reads a version it has open whole, though a prune unlinks it meanwhile', async () => {
        await commitNext(1);
        const read = await readVersionedDocument(dir, {
            hooks: {
                async afterOpen(file) {
                    await commitNext(2);
                    await commitNext(3);
                    expect(fs.existsSync(file)).toBe(false);
                },
            },
        });
        expect(read).toMatchObject({ version: 1, value: { count: 1 }, handMade: false });
    });

    it(`gives up after ${READ_ATTEMPTS} listings when every version it picks is pruned first`, async () => {
        await commitNext(0);
        let listings = 0;
        const read = readVersionedDocument(dir, {
            hooks: {
                async afterList() {
                    listings++;
                    await commitNext(listings * 10);
                    await commitNext(listings * 10 + 1);
                },
            },
        });
        await expect(read).rejects.toThrow(`its newest version was pruned ${READ_ATTEMPTS} times`);
        expect(listings).toBe(READ_ATTEMPTS);
    });
});

describe('the stamp', () => {
    it('refuses an in-place edit of the newest version, and names the copy step', async () => {
        await commitNext(1);
        await commitNext(2);
        const file = versionFile(dir, 2);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"count": 2', '"count": 7'));

        const error = await readVersionedDocument(dir).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(EditedInPlaceError);
        expect(error).toBeInstanceOf(CorruptDocumentError);
        expect(error).toMatchObject({ version: 2, message: expect.stringContaining('cp -n v2.json v3.json') });
    });

    it('accepts a hand-made copy at the next number, reads it as that number, and stamps the next write again', async () => {
        await commitNext(1);
        await commitNext(2);
        // The documented hand edit: copy the newest to the next number, then edit the copy.
        fs.copyFileSync(versionFile(dir, 2), versionFile(dir, 3), fs.constants.COPYFILE_EXCL);
        fs.writeFileSync(versionFile(dir, 3), fs.readFileSync(versionFile(dir, 3), 'utf8').replace('"count": 2', '"count": 7'));

        expect(await readVersionedDocument(dir)).toMatchObject({ version: 3, value: { count: 7, version: 3 }, handMade: true });
        await writeVersionedDocument(dir, counter(8), 3);
        const raw = JSON.parse(fs.readFileSync(versionFile(dir, 4), 'utf8')) as { stamp: { version: number } };
        expect(raw.stamp.version).toBe(4);
        expect(await readVersionedDocument(dir)).toMatchObject({ version: 4, value: { count: 8 }, handMade: false });
        expect(names()).toEqual(['v3.json', 'v4.json']);
    });

    it('reads an edit made in place again once it is copied to the next number, as the refusal says', async () => {
        await commitNext(1);
        const file = versionFile(dir, 1);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"count": 1', '"count": 5'));
        await expect(readVersionedDocument(dir)).rejects.toBeInstanceOf(EditedInPlaceError);

        fs.copyFileSync(file, versionFile(dir, 2), fs.constants.COPYFILE_EXCL);
        expect(await readVersionedDocument(dir)).toMatchObject({ version: 2, value: { count: 5 }, handMade: true });
    });

    it('ignores formatting and key order, and checks only the newest version', async () => {
        await commitNext(1);
        await commitNext(2);
        const newest = JSON.parse(fs.readFileSync(versionFile(dir, 2), 'utf8')) as Record<string, unknown>;
        const reordered = Object.fromEntries(Object.entries(newest).reverse());
        fs.writeFileSync(versionFile(dir, 2), JSON.stringify(reordered));
        fs.writeFileSync(versionFile(dir, 1), fs.readFileSync(versionFile(dir, 1), 'utf8').replace('"count": 1', '"count": 9'));
        expect(await readVersionedDocument(dir)).toMatchObject({ version: 2, value: { count: 2 }, handMade: false });
    });
});

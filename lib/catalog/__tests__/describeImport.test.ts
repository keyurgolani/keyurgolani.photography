// @vitest-environment node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LockLostError, withLock } from '../../storage/lock';
import { FIELD_LIMITS, IMPORT_FILE_MAX_BYTES, importDescriptions, parseCsvRecords, parseDescriptions, quoteCell, runDescribeImport } from '../describe-import';
import { createTestCatalog, type TestCatalog } from '../testing';
import { authoredPaths, readAuthoredRecord } from '../working-layer';
import { newestRecordFile } from './catalogFixtures';
import { AUTHORED_LOCK, AuthoredWriteError, writeAuthoredRecord } from '../working-layer-writer';

let catalog: TestCatalog;
let dir: string;
let ids: string[];

beforeEach(async () => {
    catalog = await createTestCatalog({ seed: 1301, photos: 3, series: 1 });
    ids = catalog.photos.map((photo) => photo.id);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg13d-import-'));
});

afterEach(async () => {
    fs.chmodSync(catalog.root, 0o700);
    await catalog.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
});

function file(name: string, content: string | Buffer): string {
    const target = path.join(dir, name);
    fs.writeFileSync(target, content);
    return target;
}

/** Every authored photo record's newest version, as bytes, by ID. */
function recordBytes(): Record<string, string> {
    return Object.fromEntries(ids.map((id) => [id, fs.readFileSync(newestRecordFile(catalog.root, 'photo', id), 'utf8')]));
}

const csvRows = (header: string, rows: string[]) => [header, ...rows].join('\n');
const errorsOf = (text: string, format: 'csv' | 'json' = 'csv') => {
    const parsed = parseDescriptions(text, format);
    if (parsed.ok) throw new Error(`Expected problems, got ${JSON.stringify(parsed.rows)}`);
    return parsed.errors;
};
const rowsOf = (text: string, format: 'csv' | 'json' = 'csv') => {
    const parsed = parseDescriptions(text, format);
    if (!parsed.ok) throw new Error(`Expected rows, got ${parsed.errors.join('\n')}`);
    return parsed.rows;
};
const ID = 'ph_00000000-0000-4000-8000-000000000001';
const ID2 = 'ph_00000000-0000-4000-8000-000000000002';

describe('parseCsvRecords', () => {
    it.each([
        ['LF', 'a,b\n1,2\n3,4\n'],
        ['CRLF', 'a,b\r\n1,2\r\n3,4\r\n'],
        ['CR only', 'a,b\r1,2\r3,4\r'],
        ['a BOM', '\uFEFFa,b\n1,2\n3,4'],
        ['trailing blank lines', 'a,b\n1,2\n3,4\n\n\r\n'],
    ])('splits %s records', (_, text) => {
        const parsed = parseCsvRecords(text);
        expect(parsed).toEqual({ records: [{ line: 1, fields: ['a', 'b'] }, { line: 2, fields: ['1', '2'] }, { line: 3, fields: ['3', '4'] }] });
    });

    it('reads quoted commas, line breaks, and doubled quotes', () => {
        expect(parseCsvRecords('a,b\n"x, y","say ""hi""\nthere"\n')).toEqual({ records: [{ line: 1, fields: ['a', 'b'] }, { line: 2, fields: ['x, y', 'say "hi"\nthere'] }] });
    });

    it.each([
        ['an unterminated quote', 'a,b\n1,"open\n2,3\n', 'the quoted field that starts on line 2 never ends.'],
        ['text after a closing quote', 'a,b\n"1"x,2\n', 'line 2 has text after a closing quote.'],
        ['a quote mid-field', 'a,b\n1x"y,2\n', 'line 2 has a quote inside an unquoted field.'],
    ])('refuses %s', (_, text, message) => {
        const parsed = parseCsvRecords(text);
        expect('error' in parsed && parsed.error).toContain(message);
    });

    it.each([
        ['LF', '\n'],
        ['CRLF', '\r\n'],
        ['CR only', '\r'],
    ])('counts lines inside a quoted field with %s breaks', (_, br) => {
        const parsed = parseCsvRecords(['a,b', `1,"two${br}lines${br}here"`, '3,4', '5,6'].join(br));
        expect('records' in parsed && parsed.records.map((record) => record.line)).toEqual([1, 2, 5, 6]);
    });
});

describe('parseDescriptions', () => {
    it.each([
        ['an unknown column', csvRows('photoId,alt,notes', []), 'The header names "notes", which isn\'t one of'],
        ['a duplicate column', csvRows('photoId,alt,alt', []), 'The header names "alt" twice.'],
        ['no photoId column', csvRows('alt,title', []), 'The header has no photoId column.'],
        ['an empty file', '', 'The CSV is empty.'],
    ])('refuses a header with %s', (_, text, message) => {
        expect(errorsOf(text).join('\n')).toContain(message);
    });

    it.each([
        ['an object', '{"photoId":"x"}', 'The JSON must be an array of objects'],
        ['a non-object item', '[1]', 'item 1 is not an object.'],
        ['a __proto__ key', `[{"photoId":"${ID}","__proto__":{"alt":"x"}}]`, 'item 1 names "__proto__"'],
        ['a constructor key', `[{"photoId":"${ID}","constructor":"x"}]`, 'item 1 names "constructor"'],
        ['a number for alt', `[{"photoId":"${ID}","alt":5}]`, 'item 1: alt must be text, not 5.'],
        ['invalid JSON', '[{', 'The file is not valid JSON'],
    ])('refuses JSON with %s', (_, text, message) => {
        expect(errorsOf(text, 'json').join('\n')).toContain(message);
        expect(Object.prototype).not.toHaveProperty('alt');
    });

    it('reads decorative as true or false in any case, and refuses anything else', () => {
        expect(rowsOf(csvRows('photoId,decorative', [`${ID},TRUE`, `${ID2},False`])).map((row) => row.decorative)).toEqual([true, false]);
        expect(errorsOf(csvRows('photoId,decorative', [`${ID},yes`]))).toEqual(['line 2: decorative is "yes", but it takes true or false.']);
        expect(errorsOf(csvRows('photoId,alt,decorative', [`${ID},A fixture,true`]))[0]).toContain('described or decorative, not both');
    });

    it('refuses a duplicate photo ID and a malformed one', () => {
        expect(errorsOf(csvRows('photoId,alt', [`${ID},One`, `${ID},Two`]))).toEqual([`line 3: ${ID} is also on line 2. Give each photo one row.`]);
        expect(errorsOf(csvRows('photoId,alt', ['photo-1,One']))).toEqual(['line 2: "photo-1" is not a photo ID.']);
    });

    it('accepts a JSON file that starts with a byte order mark', () => {
        expect(rowsOf(`\uFEFF[{"photoId":"${ID}","alt":"A fixture"}]`, 'json')).toEqual([{ at: 'item 1', photoId: ID, alt: 'A fixture' }]);
    });

    it.each([
        ['NUL', 0x00],
        ['a tab', 0x09],
        ['ESC', 0x1b],
        ['DEL', 0x7f],
        ['C1 CSI', 0x9b],
        ['NEL', 0x85],
        ['a bidi embedding', 0x202a],
        ['a bidi override', 0x202e],
        ['a bidi isolate', 0x2066],
        ['pop directional isolate', 0x2069],
        ['a zero-width space', 0x200b],
        ['a word joiner', 0x2060],
        ['an interior byte order mark', 0xfeff],
        ['a line separator', 0x2028],
        ['a replacement character', 0xfffd],
    ])('refuses %s in a cell, naming its code point without echoing it', (_, codePoint) => {
        const char = String.fromCodePoint(codePoint);
        const name = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
        const errors = errorsOf(JSON.stringify([{ photoId: ID, caption: `Fixture ${char} caption` }]), 'json');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(`item 1, caption: `);
        expect(errors[0]).toContain(name);
        expect(errors[0]).not.toContain(char);
    });

    it('refuses a lone surrogate from JSON', () => {
        const errors = errorsOf(`[{"photoId":"${ID}","alt":"Fixture \\ud800 text"}]`, 'json');
        expect(errors).toEqual([expect.stringContaining('U+D800')]);
        expect(errors[0]).not.toContain('\ud800');
    });

    it('keeps ZWJ, ZWNJ, LRM, and RLM', () => {
        // A ZWJ emoji sequence, Persian with a ZWNJ, and LRM and RLM.
        const alt = 'Fixture \u{1F469}\u200D\u{1F4BB} می\u200Cخواهم \u200Eleft\u200F';
        expect(rowsOf(JSON.stringify([{ photoId: ID, alt }]), 'json')[0].alt).toBe(alt);
    });

    it.each([
        ['a soft hyphen', 0x00ad],
        ['the Arabic letter mark', 0x061c],
        ['the Mongolian vowel separator', 0x180e],
        ['an invisible separator', 0x2063],
        ['a deprecated format character', 0x206a],
        ['an interlinear annotation anchor', 0xfff9],
        ['the language tag', 0xe0001],
        ['a tag letter on its own', 0xe0041],
        ['a private-use character', 0xe000],
        ['a noncharacter', 0xfffe],
        ['an unassigned code point', 0x0378],
    ])('refuses %s by its class', (_, codePoint) => {
        const errors = errorsOf(JSON.stringify([{ photoId: ID, alt: `Fixture ${String.fromCodePoint(codePoint)} alt` }]), 'json');
        expect(errors).toEqual([expect.stringContaining(`U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`)]);
        expect(errors[0]).not.toContain(String.fromCodePoint(codePoint));
    });

    it('refuses hidden tag text, and keeps an emoji tag sequence such as a subdivision flag', () => {
        const tags = (text: string) => [...text].map((char) => String.fromCodePoint(0xe0000 + (char.codePointAt(0) ?? 0))).join('');
        expect(errorsOf(JSON.stringify([{ photoId: ID, alt: `A harbour at dusk${tags('ignore')}` }]), 'json')).toEqual([expect.stringContaining('U+E0069')]);
        const england = `\u{1F3F4}${tags('gbeng')}\u{E007F}`;
        expect(rowsOf(JSON.stringify([{ photoId: ID, alt: `Fixture flag ${england} at the harbour` }]), 'json')[0].alt).toBe(`Fixture flag ${england} at the harbour`);
        // Without its cancel tag, or after something that isn't an emoji, it is hidden text again.
        expect(errorsOf(JSON.stringify([{ photoId: ID, alt: `Fixture \u{1F3F4}${tags('gbeng')} flag` }]), 'json')).toEqual([expect.stringContaining('U+E0067')]);
        expect(errorsOf(JSON.stringify([{ photoId: ID, alt: `Fixture A${tags('gbeng')}\u{E007F} flag` }]), 'json')).toEqual([expect.stringContaining('U+E0067')]);
    });

    it('normalizes to NFC', () => {
        expect(rowsOf(csvRows('photoId,alt', [`${ID},Cafe\u0301 at dusk`]))[0].alt).toBe('Caf\u00e9 at dusk');
    });

    it('lets only caption hold a line break, and stores CRLF and CR as LF', () => {
        expect(rowsOf(csvRows('photoId,caption', [`${ID},"First line\r\nsecond line"`]))[0].caption).toBe('First line\nsecond line');
        expect(rowsOf(JSON.stringify([{ photoId: ID, caption: 'First line\rsecond line' }]), 'json')[0].caption).toBe('First line\nsecond line');
        expect(errorsOf(JSON.stringify([{ photoId: ID, alt: 'Two\rlines' }]), 'json')).toEqual(['item 1, alt: has a line break, which only caption can hold.']);
        expect(errorsOf(csvRows('photoId,alt', [`${ID},"Two\nlines"`]))).toEqual(['line 2, alt: has a line break, which only caption can hold.']);
        expect(errorsOf(csvRows('photoId,title', [`${ID},"Two\nlines"`]))).toEqual(['line 2, title: has a line break, which only caption can hold.']);
    });

    it.each(Object.entries({ alt: 1000, title: 200, caption: 2000 }))('caps %s at %i characters', (column, limit) => {
        expect(FIELD_LIMITS[column as keyof typeof FIELD_LIMITS]).toBe(limit);
        // Astral characters count once each.
        expect(rowsOf(JSON.stringify([{ photoId: ID, [column]: '\u{1F4F7}'.repeat(limit) }]), 'json')).toHaveLength(1);
        expect(errorsOf(JSON.stringify([{ photoId: ID, [column]: 'x'.repeat(limit + 1) }]), 'json')).toEqual([`item 1, ${column}: is ${limit + 1} characters long, over its limit of ${limit}.`]);
    });

    it('cuts a long cell short in a message and escapes what a terminal would act on', () => {
        const [long] = errorsOf(csvRows('photoId,decorative', [`${ID},${'y'.repeat(1_000_000)}`]));
        expect(long.length).toBeLessThan(200);
        expect(long).toContain('...');
        const [bidi] = errorsOf(csvRows('photoId,alt', ['ph_\u202Eevil,One']));
        expect(bidi).toBe('line 2: "ph_\\u{202E}evil" is not a photo ID.');
        expect(quoteCell('a"b\\c\u001b')).toBe('"a\\"b\\\\c\\u{1B}"');
    });
});

describe('runDescribeImport', () => {
    const layer = () => ({ dataRoot: catalog.root, waitMs: 200 });

    it('refuses text that is not UTF-8, naming the line, and writes nothing', async () => {
        const before = recordBytes();
        const latin1 = Buffer.concat([Buffer.from(`photoId,alt\n${ids[0]},Fixture one\n${ids[1]},Caf`), Buffer.from([0xe9]), Buffer.from(' at dusk\n')]);
        const result = await runDescribeImport(layer(), { file: file('cp1252.csv', latin1) });
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain('line 3 is not UTF-8 text');
        expect(result.output).toContain('"CSV UTF-8"');
        expect(recordBytes()).toEqual(before);
    });

    it('refuses a file over the size cap, a folder, and a FIFO, without reading them', { timeout: 15_000 }, async () => {
        expect(IMPORT_FILE_MAX_BYTES).toBe(5 * 1024 * 1024);
        const big = path.join(dir, 'big.csv');
        fs.writeFileSync(big, 'photoId,alt\n');
        fs.truncateSync(big, IMPORT_FILE_MAX_BYTES + 1);
        const tooBig = await runDescribeImport(layer(), { file: big });
        expect(tooBig.exitCode).toBe(1);
        expect(tooBig.output).toContain('is larger than 5 MiB');
        const folder = await runDescribeImport(layer(), { file: dir });
        expect(folder).toMatchObject({ exitCode: 1, output: expect.stringContaining('is not a regular file') });
        const fifo = path.join(dir, 'pipe.csv');
        execFileSync('mkfifo', [fifo]);
        const piped = await runDescribeImport(layer(), { file: fifo });
        expect(piped).toMatchObject({ exitCode: 1, output: expect.stringContaining('is not a regular file') });
    });

    it('updates the rows it lists, marks the descriptions reviewed, and leaves other records as they were', async () => {
        const before = recordBytes();
        const result = await runDescribeImport(layer(), { file: file('d.csv', csvRows('photoId,alt,title,caption', [`${ids[0]},Fixture alt one,,`, `${ids[1]},,Fixture title,"Line one\nline two"`])) });
        expect(result).toEqual({ exitCode: 0, output: `Updated 2 photo records, and 0 rows change nothing.\n  ${ids[0]}\n  ${ids[1]}\n` });
        expect((await readAuthoredRecord(catalog.root, 'photo', ids[0]))?.alt).toEqual({ kind: 'described', text: 'Fixture alt one', reviewed: true });
        expect(await readAuthoredRecord(catalog.root, 'photo', ids[1])).toMatchObject({ title: 'Fixture title', caption: 'Line one\nline two', alt: catalog.photos[1].alt });
        expect(recordBytes()[ids[2]]).toBe(before[ids[2]]);
        const again = await runDescribeImport(layer(), { file: path.join(dir, 'd.csv') });
        expect(again.output).toBe('Updated 0 photo records, and 2 rows change nothing.\n');
    });

    it('imports JSON', async () => {
        const result = await runDescribeImport(layer(), { file: file('d.json', JSON.stringify([{ photoId: ids[2], decorative: true }])) });
        expect(result.exitCode).toBe(0);
        expect((await readAuthoredRecord(catalog.root, 'photo', ids[2]))?.alt).toEqual({ kind: 'decorative' });
    });

    it('writes nothing when one row names an unknown photo', async () => {
        const before = recordBytes();
        const unknown = 'ph_ffffffff-ffff-4fff-bfff-ffffffffffff';
        const result = await runDescribeImport(layer(), { file: file('d.csv', csvRows('photoId,alt', [`${ids[0]},Fixture one`, `${unknown},Fixture two`])) });
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain(`line 3: there is no photo record ${unknown}.`);
        expect(recordBytes()).toEqual(before);
    });

    it('runs a dry run without the authored lock, so it writes nothing and works on a read-only data root', async () => {
        const before = recordBytes();
        fs.rmSync(path.join(catalog.root, 'locks'), { recursive: true, force: true });
        fs.chmodSync(catalog.root, 0o555);
        const result = await runDescribeImport(layer(), { file: file('d.csv', csvRows('photoId,alt', [`${ids[0]},Fixture one`])), dryRun: true });
        fs.chmodSync(catalog.root, 0o700);
        expect(result).toEqual({ exitCode: 0, output: `Would update 1 photo record, and 0 rows change nothing.\n  ${ids[0]}\nNothing was written. Run it again without --dry-run to write it.\n` });
        expect(fs.existsSync(path.join(catalog.root, 'locks'))).toBe(false);
        expect(recordBytes()).toEqual(before);
    });

    it('runs a dry run while another writer holds the authored lock', async () => {
        const result = await withLock(AUTHORED_LOCK, { root: catalog.root }, () => runDescribeImport(layer(), { file: file('d.csv', csvRows('photoId,alt', [`${ids[0]},Fixture one`])), dryRun: true }));
        expect(result.exitCode).toBe(0);
    });

    it('exits 3 while another writer holds the authored lock', async () => {
        const result = await withLock(AUTHORED_LOCK, { root: catalog.root }, () => runDescribeImport(layer(), { file: file('d.csv', csvRows('photoId,alt', [`${ids[0]},Fixture one`])) }));
        expect(result.exitCode).toBe(3);
        expect(result.output).toContain('authored-locked');
    });

    it('says how many records a failed write left written, and a rerun finishes the import', async () => {
        const rows = csvRows('photoId,caption', ids.map((id, index) => `${id},Fixture caption ${index}`));
        const target = file('d.csv', rows);
        let writes = 0;
        const hooks = { afterStage() { if (++writes === 2) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); } };
        const result = await runDescribeImport(layer(), { file: target, hooks });
        expect(result.exitCode).toBe(4);
        expect(result.output).toContain('ENOSPC');
        expect(result.output).toContain(`It wrote 1 of 3 records before it stopped at ${ids[1]} (line 3).`);
        expect(result.output).toContain('Run the same import again to finish it');
        const captions = async () => Promise.all(ids.map(async (id) => (await readAuthoredRecord(catalog.root, 'photo', id))?.caption ?? null));
        expect(await captions()).toEqual(['Fixture caption 0', null, null]);
        const rerun = await runDescribeImport(layer(), { file: target });
        expect(rerun.output).toBe(`Updated 2 photo records, and 1 row changes nothing.\n  ${ids[1]}\n  ${ids[2]}\n`);
        expect(await captions()).toEqual(['Fixture caption 0', 'Fixture caption 1', 'Fixture caption 2']);
    });

    it('un-flags a decorative photo on decorative=false with no alt, so it has no description until one is set', async () => {
        await runDescribeImport(layer(), { file: file('flag.csv', csvRows('photoId,decorative', [`${ids[0]},true`])) });
        expect((await readAuthoredRecord(catalog.root, 'photo', ids[0]))?.alt).toEqual({ kind: 'decorative' });
        const result = await runDescribeImport(layer(), { file: file('unflag.csv', csvRows('photoId,decorative', [`${ids[0]},false`, `${ids[1]},false`])) });
        // The second photo is described, so false changes nothing there.
        expect(result.output).toBe(`Updated 1 photo record, and 1 row changes nothing.\n  ${ids[0]}\n`);
        expect((await readAuthoredRecord(catalog.root, 'photo', ids[0]))?.alt).toBeNull();
        expect((await readAuthoredRecord(catalog.root, 'photo', ids[1]))?.alt).toEqual(catalog.photos[1].alt);
    });

    it('reads the records under the same hold it writes them in', async () => {
        const target = file('d.csv', csvRows('photoId,alt', [`${ids[0]},Fixture alt from the import`]));
        let pending: Promise<Awaited<ReturnType<typeof runDescribeImport>>> | undefined;
        await withLock(AUTHORED_LOCK, { root: catalog.root }, async (lock) => {
            pending = runDescribeImport({ dataRoot: catalog.root, waitMs: 10_000 }, { file: target });
            // Long enough for an import that read before taking the lock to have read.
            await sleep(500);
            const record = await readAuthoredRecord(catalog.root, 'photo', ids[0]);
            if (!record) throw new Error('no record');
            await writeAuthoredRecord({ ...record, title: 'Fixture title from another writer' }, { expectedVersion: record.version, lock, root: catalog.root });
        });
        const result = await pending;
        expect(result?.exitCode, result?.output).toBe(0);
        expect(await readAuthoredRecord(catalog.root, 'photo', ids[0])).toMatchObject({ title: 'Fixture title from another writer', alt: { kind: 'described', text: 'Fixture alt from the import', reviewed: true } });
    });

    it('imports a file of exactly the size cap', { timeout: 30_000 }, async () => {
        const head = `photoId,alt\n${ids[0]},Fixture alt at the cap\n`;
        const target = file('cap.csv', head + '\n'.repeat(IMPORT_FILE_MAX_BYTES - Buffer.byteLength(head)));
        expect(fs.statSync(target).size).toBe(IMPORT_FILE_MAX_BYTES);
        const result = await runDescribeImport(layer(), { file: target });
        expect(result.exitCode, result.output).toBe(0);
    });

    it('refuses a file that grows past the cap while it is read', async () => {
        const chunk = 1024 * 1024;
        const handle = {
            stat: async () => ({ isFile: () => true, size: 10 }),
            read: async (buffer: Buffer, offset: number, length: number) => {
                const bytes = Math.min(length, chunk);
                buffer.fill(0x61, offset, offset + bytes);
                return { bytesRead: bytes, buffer };
            },
            close: async () => undefined,
        };
        const open = vi.spyOn(fs.promises, 'open').mockResolvedValue(handle as unknown as fs.promises.FileHandle);
        try {
            const result = await runDescribeImport(layer(), { file: path.join(dir, 'growing.csv') });
            expect(result).toMatchObject({ exitCode: 1, output: expect.stringContaining('is larger than 5 MiB') });
        } finally {
            open.mockRestore();
        }
    });

    it('exits 3 on a version conflict part way', async () => {
        const hooks = { afterStage() { throw new AuthoredWriteError('VERSION_CONFLICT', { kind: 'photo', id: ids[0] }, `The photo record ${ids[0]} is at version 3, not 2.`); } };
        const result = await runDescribeImport(layer(), { file: file('d.csv', csvRows('photoId,caption', [`${ids[0]},Fixture caption`])), hooks });
        expect(result.exitCode).toBe(3);
        expect(result.output).toContain('Error (VERSION_CONFLICT)');
    });

    it('exits 3 when it loses the authored lock part way', async () => {
        const hooks = { afterStage() { throw new LockLostError(AUTHORED_LOCK, null); } };
        const result = await runDescribeImport(layer(), { file: file('d.csv', csvRows('photoId,caption', [`${ids[0]},Fixture caption`])), hooks });
        expect(result.exitCode).toBe(3);
        expect(result.output).toContain('Nothing was written.');
    });

    it('checks every row before the first write, through importDescriptions too', async () => {
        const before = recordBytes();
        await expect(importDescriptions(layer(), [{ at: 'line 2', photoId: ids[0], alt: 'Fixture' }, { at: 'line 3', photoId: 'ph_ffffffff-ffff-4fff-bfff-ffffffffffff', alt: 'Fixture' }])).rejects.toThrow('there is no photo record');
        expect(recordBytes()).toEqual(before);
        expect(fs.existsSync(authoredPaths(catalog.root).photosDir)).toBe(true);
    });
});

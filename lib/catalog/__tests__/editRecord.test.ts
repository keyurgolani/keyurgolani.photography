// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTsx } from '../../../test/helpers/runTsx';
import { editsDir, recordRef, runEditRecord, slugFor, type Editor } from '../edit-record';
import { references } from '../references';
import { createTestCatalog, type TestCatalog } from '../testing';
import { authoredRecordDir, readAuthoredRecord, readWorkingLayer } from '../working-layer';
import { writeAuthoredRecord } from '../working-layer-writer';
import { newestRecordFile } from './catalogFixtures';

let catalog: TestCatalog;
let dir: string;

beforeEach(async () => {
    catalog = await createTestCatalog({ seed: 1330, photos: 3, series: 1 });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg13d-edit-'));
});

afterEach(async () => {
    await catalog.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** An editor that rewrites the file's JSON with `change`, recording the text it was given. */
function editing(change: (value: Record<string, unknown>) => unknown, seen: string[] = []): Editor {
    return async (file) => {
        const text = fs.readFileSync(file, 'utf8');
        seen.push(text);
        const next = change(JSON.parse(text) as Record<string, unknown>);
        fs.writeFileSync(file, typeof next === 'string' ? next : `${JSON.stringify(next, null, 2)}\n`);
        return 0;
    };
}

const versions = (kind: 'photo' | 'series' | 'site', id: string) => {
    const folder = authoredRecordDir(catalog.root, kind, id);
    return fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => /^v\d+\.json$/.test(name)).sort() : [];
};
const keptEdits = () => (fs.existsSync(editsDir(catalog.root)) ? fs.readdirSync(editsDir(catalog.root)) : []);
/** The --file command an output prints, as its arguments. */
const printedCommand = (output: string) => /run photos edit (\S+) --file (\S+) --expect-version (\d+)\./.exec(output)?.slice(1) ?? [];

describe('recordRef and slugFor', () => {
    it('names a photo, a series, or the site, and nothing else', () => {
        expect(recordRef('site')).toEqual({ kind: 'site', id: 'site' });
        expect(recordRef('ph_00000000-0000-4000-8000-000000000001')).toEqual({ kind: 'photo', id: 'ph_00000000-0000-4000-8000-000000000001' });
        expect(recordRef('ser_harbour')).toEqual({ kind: 'series', id: 'ser_harbour' });
        expect(recordRef('../site')).toBeNull();
        expect(recordRef('ser_')).toBeNull();
    });

    it.each([
        ['ser_harbour', 'harbour'],
        ['ser_my_new', 'my-new'],
        ['ser_a__b-', 'a-b'],
        ['ser_2026_spring-light', '2026-spring-light'],
    ])('makes %s a valid slug', (id, slug) => {
        expect(slugFor(id)).toBe(slug);
        expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    });
});

describe('photos edit', () => {
    it('opens the newest version without its managed fields and commits the edit as the next version', async () => {
        const photo = catalog.photos[0];
        const before = await readAuthoredRecord(catalog.root, 'photo', photo.id);
        const seen: string[] = [];
        const result = await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id: photo.id }, { editor: editing((value) => ({ ...value, caption: 'Fixture caption from an edit.' }), seen) });
        expect(result).toEqual({ exitCode: 0, output: `Saved photo ${photo.id} as version ${(before?.version ?? 0) + 1}. photos validate checks it against the rest of the catalog.\n` });
        const shown = JSON.parse(seen[0]) as Record<string, unknown>;
        expect(shown).toMatchObject({ kind: 'photo', id: photo.id, assetRevision: photo.assetRevision });
        for (const managed of ['schemaVersion', 'version', 'baseRevisionId', 'stamp']) expect(shown).not.toHaveProperty(managed);
        expect(await readAuthoredRecord(catalog.root, 'photo', photo.id)).toMatchObject({ caption: 'Fixture caption from an edit.', version: (before?.version ?? 0) + 1, baseRevisionId: before?.baseRevisionId });
        // The working copy is gone once it's committed.
        expect(keptEdits()).toEqual([]);
    });

    it('edits the site record without showing its base Work order', async () => {
        const seen: string[] = [];
        const result = await runEditRecord({ dataRoot: catalog.root }, { kind: 'site', id: 'site' }, { editor: editing((value) => ({ ...value, featuredSeriesIds: [] }), seen) });
        expect(result.exitCode, result.output).toBe(0);
        expect(seen[0]).not.toContain('baseSeriesOrder');
        expect((await readAuthoredRecord(catalog.root, 'site', 'site'))?.featuredSeriesIds).toEqual([]);
    });

    it('writes nothing when the edit changes nothing or the editor fails', async () => {
        const id = catalog.photos[1].id;
        const before = versions('photo', id);
        expect(await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { editor: async () => 0 })).toEqual({ exitCode: 0, output: `No change to photo ${id}.\n` });
        expect(await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { editor: async () => 1 })).toEqual({ exitCode: 1, output: 'Error: The editor exited 1, so nothing was written.\n' });
        expect(versions('photo', id)).toEqual(before);
        expect(keptEdits()).toEqual([]);
    });

    it('keeps an edit it can\'t commit in edits/, private, where nothing reads it as a record, with the command that commits it', async () => {
        const id = catalog.photos[0].id;
        const before = versions('photo', id);
        const record = await readAuthoredRecord(catalog.root, 'photo', id);
        const referencesBefore = await references(catalog.root);
        const broken = await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { editor: editing(() => '{ "kind": "photo",') });
        expect(broken.exitCode).toBe(1);
        expect(broken.output).toContain('The edit is not valid JSON');
        const [printedId, kept, printedVersion] = printedCommand(broken.output);
        expect([printedId, printedVersion]).toEqual([id, String(record?.version)]);
        expect(path.dirname(kept)).toBe(editsDir(catalog.root));
        expect(fs.readFileSync(kept, 'utf8')).toBe('{ "kind": "photo",');
        expect(fs.statSync(editsDir(catalog.root)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(kept).mode & 0o777).toBe(0o600);
        expect((await readWorkingLayer(catalog.root)).problems).toEqual([]);
        expect(await references(catalog.root)).toEqual(referencesBefore);

        const unknown = await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { editor: editing((value) => ({ ...value, colour: 'red' })) });
        expect(unknown.exitCode).toBe(1);
        expect(unknown.output).toContain('Error (INVALID_RECORD)');
        const moved = await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { editor: editing((value) => ({ ...value, id: catalog.photos[1].id })) });
        expect(moved.output).toContain(`It has to stay photo ${id}.`);
        expect(versions('photo', id)).toEqual(before);

        // The kept edit, fixed, commits with the printed command. Its managed fields are ignored: the writer keeps its own.
        fs.writeFileSync(kept, JSON.stringify({ ...record, version: 99, baseRevisionId: null, title: 'Fixture title from a kept edit' }));
        const fixed = await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { file: kept, expectVersion: Number(printedVersion) });
        expect(fixed.exitCode, fixed.output).toBe(0);
        expect(await readAuthoredRecord(catalog.root, 'photo', id)).toMatchObject({ title: 'Fixture title from a kept edit', version: (record?.version ?? 0) + 1, baseRevisionId: record?.baseRevisionId });
    });

    it('exits 3 when the record changes while it is open, and the printed command exits 3 too instead of replacing the change', async () => {
        const series = catalog.series[0];
        const result = await runEditRecord({ dataRoot: catalog.root }, { kind: 'series', id: series.id }, {
            editor: editing((value) => ({ ...value, title: 'Fixture title from the edit' })),
            async afterEdit() {
                const record = await readAuthoredRecord(catalog.root, 'series', series.id);
                if (record) await writeAuthoredRecord({ ...record, statement: 'Fixture statement from another writer.' }, { expectedVersion: record.version, root: catalog.root });
            },
        });
        expect(result.exitCode).toBe(3);
        expect(result.output).toContain(`It changed while you edited it. series ${series.id} is at version ${series.version + 1}, not ${series.version}`);
        const [printedId, kept, printedVersion] = printedCommand(result.output);
        expect([printedId, printedVersion]).toEqual([series.id, String(series.version)]);

        const rerun = await runEditRecord({ dataRoot: catalog.root }, { kind: 'series', id: series.id }, { file: kept, expectVersion: Number(printedVersion) });
        expect(rerun.exitCode).toBe(3);
        expect(rerun.output).toContain(`is at version ${series.version + 1}, not ${series.version}`);
        expect(await readAuthoredRecord(catalog.root, 'series', series.id)).toMatchObject({ version: series.version + 1, statement: 'Fixture statement from another writer.', title: series.title });
        expect(versions('series', series.id)).not.toContain(`v${series.version + 2}.json`);
    });

    it('needs --expect-version with --file whenever the record exists', async () => {
        const id = catalog.photos[0].id;
        const record = await readAuthoredRecord(catalog.root, 'photo', id);
        const file = path.join(dir, 'edit.json');
        fs.writeFileSync(file, JSON.stringify({ ...record, caption: 'Fixture caption from a file.' }));
        expect(await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { file }))
            .toEqual({ exitCode: 2, output: `Error: --file needs --expect-version <N>, the version the edit started from, so it can't replace a newer one. photo ${id} is at version ${record?.version} now.\n` });
        expect((await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { file, expectVersion: (record?.version ?? 0) - 1 })).exitCode).toBe(3);
        expect((await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { file, expectVersion: record?.version })).exitCode).toBe(0);
    });

    it('takes a copy of a version file with its stamp, and treats an unchanged copy as no change', async () => {
        const id = catalog.photos[1].id;
        const record = await readAuthoredRecord(catalog.root, 'photo', id);
        const copy = path.join(dir, 'copy.json');
        fs.copyFileSync(newestRecordFile(catalog.root, 'photo', id), copy);
        expect(fs.readFileSync(copy, 'utf8')).toContain('"stamp"');
        expect(await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { file: copy, expectVersion: record?.version })).toEqual({ exitCode: 0, output: `No change to photo ${id}.\n` });
        const value = JSON.parse(fs.readFileSync(copy, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(copy, JSON.stringify({ caption: 'Fixture caption from a host copy.', ...value }));
        const saved = await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { file: copy, expectVersion: record?.version });
        expect(saved.exitCode, saved.output).toBe(0);
        expect((await readAuthoredRecord(catalog.root, 'photo', id))?.caption).toBe('Fixture caption from a host copy.');
    });

    it('holds its public text to the import\'s plain-text rules and caps', async () => {
        const photo = catalog.photos[0];
        const series = catalog.series[0];
        const refused = async (ref: { kind: 'photo' | 'series'; id: string }, change: (value: Record<string, unknown>) => unknown) => {
            const result = await runEditRecord({ dataRoot: catalog.root }, ref, { editor: editing(change) });
            expect(result.exitCode).toBe(1);
            return result.output;
        };
        expect(await refused({ kind: 'photo', id: photo.id }, (value) => ({ ...value, title: 'Fixture \u202Etitle' }))).toContain('  title has U+202E, a bidi embedding or override, at character 9.');
        expect(await refused({ kind: 'photo', id: photo.id }, (value) => ({ ...value, alt: { kind: 'described', text: `Fixture alt${'\u{E0069}'}`, reviewed: true } }))).toContain('  alt.text has U+E0069');
        expect(await refused({ kind: 'photo', id: photo.id }, (value) => ({ ...value, caption: 'x'.repeat(2001) }))).toContain('  caption is 2001 characters long, over its limit of 2000.');
        expect(await refused({ kind: 'series', id: series.id }, (value) => ({ ...value, statement: 'Fixture\u200Bstatement' }))).toContain('  statement has U+200B');
        expect(await refused({ kind: 'series', id: series.id }, (value) => ({ ...value, shortStatement: 'Two\nlines' }))).toContain('  shortStatement has a line break');
        expect(await refused({ kind: 'series', id: series.id }, (value) => ({ ...value, chapters: [{ id: 'ch_one', title: 'Fixture\u2060chapter', startPhotoId: series.photoIds[0] }] }))).toContain('  chapters[0].title has U+2060');
        // What passes is stored trimmed and NFC, and a statement keeps its line breaks.
        const saved = await runEditRecord({ dataRoot: catalog.root }, { kind: 'series', id: series.id }, { editor: editing((value) => ({ ...value, title: '  Fixture Cafe\u0301  ', statement: 'Fixture statement,\nover two lines.' })) });
        expect(saved.exitCode, saved.output).toBe(0);
        expect(await readAuthoredRecord(catalog.root, 'series', series.id)).toMatchObject({ title: 'Fixture Caf\u00e9', statement: 'Fixture statement,\nover two lines.' });
    });

    it('opens a new series as a draft, saves it as version 1, and creates nothing when the template is left as it is', async () => {
        const seen: string[] = [];
        const untouched = await runEditRecord({ dataRoot: catalog.root }, { kind: 'series', id: 'ser_my_new' }, { editor: async () => 0 });
        expect(untouched).toEqual({ exitCode: 0, output: 'No change, so series ser_my_new isn\'t created.\n' });
        expect(versions('series', 'ser_my_new')).toEqual([]);
        const result = await runEditRecord({ dataRoot: catalog.root }, { kind: 'series', id: 'ser_my_new' }, { editor: editing((value) => ({ ...value, title: 'New fixture series' }), seen) });
        expect(result).toEqual({ exitCode: 0, output: 'Saved series ser_my_new as version 1. photos validate checks it against the rest of the catalog.\n' });
        expect(JSON.parse(seen[0])).toEqual({ kind: 'series', id: 'ser_my_new', slug: 'my-new', title: '', statement: '', shortStatement: '', photoIds: [], chapters: [], cover: null, visibility: 'draft' });
        expect(await readAuthoredRecord(catalog.root, 'series', 'ser_my_new')).toMatchObject({ title: 'New fixture series', slug: 'my-new', visibility: 'draft', version: 1, baseRevisionId: null });
        expect(versions('series', 'ser_my_new')).toEqual(['v1.json']);
    });

    it('refuses a photo with no record and a record edited in place, naming the copy that recovers it', async () => {
        const missing = 'ph_ffffffff-ffff-4fff-bfff-ffffffffffff';
        expect(await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id: missing }, { editor: async () => 0 }))
            .toEqual({ exitCode: 1, output: `Error: There is no photo ${missing}. photos draft:init creates a record for every photo.\n` });
        const id = catalog.photos[2].id;
        const file = newestRecordFile(catalog.root, 'photo', id);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"kind": "photo"', '"kind": "photo", "title": "Edited in place"'));
        const result = await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { editor: async () => 0 });
        expect(result.exitCode).toBe(1);
        expect(result.output).toMatch(/edited in place.*cp -n v\d+\.json v\d+\.json/);
    });
});

describe('the shell editor', () => {
    it('passes the file as an argument, so a data root path with spaces, $(...) and backticks runs nothing', async () => {
        const marks = [path.join(dir, 'mark-1'), path.join(dir, 'mark-2')];
        const tricky = await createTestCatalog({ seed: 1331, photos: 1, series: 0, root: path.join(dir, 'a b $(touch "$KG13D_MARK_1") `touch "$KG13D_MARK_2"`') });
        const saved = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR, KG13D_MARK_1: process.env.KG13D_MARK_1, KG13D_MARK_2: process.env.KG13D_MARK_2 };
        Object.assign(process.env, {
            KG13D_MARK_1: marks[0],
            KG13D_MARK_2: marks[1],
            VISUAL: 'node -e \'const fs = require("fs"); const f = process.argv[1]; const v = JSON.parse(fs.readFileSync(f, "utf8")); v.caption = "Fixture caption from VISUAL."; fs.writeFileSync(f, JSON.stringify(v));\'',
        });
        try {
            const id = tricky.photos[0].id;
            const result = await runEditRecord({ dataRoot: tricky.root }, { kind: 'photo', id });
            expect(result.exitCode, result.output).toBe(0);
            expect((await readAuthoredRecord(tricky.root, 'photo', id))?.caption).toBe('Fixture caption from VISUAL.');
            expect(marks.map((mark) => fs.existsSync(mark))).toEqual([false, false]);
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            await tricky.cleanup();
        }
    });

    it('runs from the CLI with $EDITOR, and refuses an argument that names no record or a bad --expect-version', { timeout: 60_000 }, async () => {
        const id = catalog.photos[0].id;
        const env = { PHOTOGRAPHY_DATA_DIR: catalog.root, VISUAL: undefined, EDITOR: `node -e 'const fs = require("fs"); const f = process.argv[1]; const v = JSON.parse(fs.readFileSync(f, "utf8")); v.caption = "Fixture caption from EDITOR."; fs.writeFileSync(f, JSON.stringify(v));'` };
        const [run, usage, badVersion] = await Promise.all([
            runTsx('scripts/photos.ts', ['edit', id], { env }),
            runTsx('scripts/photos.ts', ['edit', '../site'], { env }),
            runTsx('scripts/photos.ts', ['edit', id, '--file', 'x.json', '--expect-version', 'latest'], { env }),
        ]);
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).toMatch(new RegExp(`^Saved photo ${id} as version \\d+\\.`));
        expect((await readAuthoredRecord(catalog.root, 'photo', id))?.caption).toBe('Fixture caption from EDITOR.');
        expect(usage.code).toBe(2);
        expect(usage.stderr).toContain('../site is not a photo ID, a series ID, or site.');
        expect(badVersion.code).toBe(2);
        expect(badVersion.stderr).toContain('--expect-version takes a version from 0.');
    });
});

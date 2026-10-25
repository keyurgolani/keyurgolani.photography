// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTsx } from '../../../test/helpers/runTsx';
import { recordRef, runEditRecord, type Editor } from '../edit-record';
import { createTestCatalog, type TestCatalog } from '../testing';
import { authoredRecordDir, readAuthoredRecord } from '../working-layer';
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

describe('recordRef', () => {
    it('names a photo, a series, or the site, and nothing else', () => {
        expect(recordRef('site')).toEqual({ kind: 'site', id: 'site' });
        expect(recordRef('ph_00000000-0000-4000-8000-000000000001')).toEqual({ kind: 'photo', id: 'ph_00000000-0000-4000-8000-000000000001' });
        expect(recordRef('ser_harbour')).toEqual({ kind: 'series', id: 'ser_harbour' });
        expect(recordRef('../site')).toBeNull();
        expect(recordRef('ser_')).toBeNull();
    });
});

describe('photos edit', () => {
    it('opens the newest version without its managed fields and commits the edit as the next version', async () => {
        const photo = catalog.photos[0];
        const before = await readAuthoredRecord(catalog.root, 'photo', photo.id);
        const seen: string[] = [];
        const workDir = path.join(dir, 'work');
        fs.mkdirSync(workDir);
        const result = await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id: photo.id }, { workDir, editor: editing((value) => ({ ...value, caption: 'Fixture caption from an edit.' }), seen) });
        expect(result).toEqual({ exitCode: 0, output: `Saved photo ${photo.id} as version ${(before?.version ?? 0) + 1}. photos validate checks it against the rest of the catalog.\n` });
        const shown = JSON.parse(seen[0]) as Record<string, unknown>;
        expect(shown).toMatchObject({ kind: 'photo', id: photo.id, assetRevision: photo.assetRevision });
        for (const managed of ['schemaVersion', 'version', 'baseRevisionId', 'stamp']) expect(shown).not.toHaveProperty(managed);
        expect(await readAuthoredRecord(catalog.root, 'photo', photo.id)).toMatchObject({ caption: 'Fixture caption from an edit.', version: (before?.version ?? 0) + 1, baseRevisionId: before?.baseRevisionId });
        // The working copy is gone once it's committed.
        expect(fs.readdirSync(workDir)).toEqual([]);
    });

    it('edits the site record without showing its base Work order', async () => {
        const seen: string[] = [];
        const result = await runEditRecord({ dataRoot: catalog.root }, { kind: 'site', id: 'site' }, { workDir: dir, editor: editing((value) => ({ ...value, featuredSeriesIds: [] }), seen) });
        expect(result.exitCode, result.output).toBe(0);
        expect(seen[0]).not.toContain('baseSeriesOrder');
        expect((await readAuthoredRecord(catalog.root, 'site', 'site'))?.featuredSeriesIds).toEqual([]);
    });

    it('writes nothing when the edit changes nothing or the editor fails', async () => {
        const id = catalog.photos[1].id;
        const before = versions('photo', id);
        expect(await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { workDir: dir, editor: async () => 0 })).toEqual({ exitCode: 0, output: `No change to photo ${id}.\n` });
        expect(await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { workDir: dir, editor: async () => 1 })).toEqual({ exitCode: 1, output: 'Error: The editor exited 1, so nothing was written.\n' });
        expect(versions('photo', id)).toEqual(before);
    });

    it('refuses invalid JSON, a field the schema doesn\'t know, and a changed id, keeping the edit for --file', async () => {
        const id = catalog.photos[0].id;
        const before = versions('photo', id);
        const broken = await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { editor: editing(() => '{ "kind": "photo",') });
        expect(broken.exitCode).toBe(1);
        expect(broken.output).toContain('The edit is not valid JSON');
        const kept = /Your edit is in (\S+)\. Fix it there and run photos edit \S+ --file \S+\./.exec(broken.output)?.[1];
        expect(kept && fs.readFileSync(kept, 'utf8')).toBe('{ "kind": "photo",');

        const unknown = await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { workDir: dir, editor: editing((value) => ({ ...value, colour: 'red' })) });
        expect(unknown.exitCode).toBe(1);
        expect(unknown.output).toContain('Error (INVALID_RECORD)');
        const moved = await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { workDir: dir, editor: editing((value) => ({ ...value, id: catalog.photos[1].id })) });
        expect(moved.output).toContain(`It has to stay photo ${id}.`);
        expect(versions('photo', id)).toEqual(before);

        // The kept edit, fixed, commits with --file.
        const record = await readAuthoredRecord(catalog.root, 'photo', id);
        // Managed fields in an edit are ignored: the writer keeps its own.
        fs.writeFileSync(kept ?? '', JSON.stringify({ ...record, version: 99, baseRevisionId: null, title: 'Fixture title from a kept edit' }));
        const fixed = await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, { file: kept });
        expect(fixed.exitCode, fixed.output).toBe(0);
        expect(await readAuthoredRecord(catalog.root, 'photo', id)).toMatchObject({ title: 'Fixture title from a kept edit', version: (record?.version ?? 0) + 1, baseRevisionId: record?.baseRevisionId });
        fs.rmSync(path.dirname(kept ?? ''), { recursive: true, force: true });
    });

    it('exits 3 when the record changes while it is open, and keeps the edit', async () => {
        const id = catalog.photos[0].id;
        const result = await runEditRecord({ dataRoot: catalog.root }, { kind: 'photo', id }, {
            workDir: dir,
            editor: editing((value) => ({ ...value, caption: 'Fixture caption from the edit.' })),
            async afterEdit() {
                const record = await readAuthoredRecord(catalog.root, 'photo', id);
                if (record) await writeAuthoredRecord({ ...record, title: 'Fixture title from another writer' }, { expectedVersion: record.version, root: catalog.root });
            },
        });
        expect(result.exitCode).toBe(3);
        expect(result.output).toContain('It changed while you edited it.');
        expect(result.output).toContain(`Your edit is in ${path.join(dir, 'photos-edit-')}`);
        expect(await readAuthoredRecord(catalog.root, 'photo', id)).toMatchObject({ title: 'Fixture title from another writer' });
        expect((await readAuthoredRecord(catalog.root, 'photo', id))?.caption).not.toBe('Fixture caption from the edit.');
    });

    it('opens a new series as a draft, and saves it as version 1', async () => {
        const seen: string[] = [];
        const result = await runEditRecord({ dataRoot: catalog.root }, { kind: 'series', id: 'ser_new-fixture' }, { workDir: dir, editor: editing((value) => ({ ...value, title: 'New fixture series' }), seen) });
        expect(result).toEqual({ exitCode: 0, output: 'Saved series ser_new-fixture as version 1. photos validate checks it against the rest of the catalog.\n' });
        expect(JSON.parse(seen[0])).toEqual({ kind: 'series', id: 'ser_new-fixture', slug: 'new-fixture', title: '', statement: '', shortStatement: '', photoIds: [], chapters: [], cover: null, visibility: 'draft' });
        expect(await readAuthoredRecord(catalog.root, 'series', 'ser_new-fixture')).toMatchObject({ title: 'New fixture series', visibility: 'draft', version: 1, baseRevisionId: null });
        expect(versions('series', 'ser_new-fixture')).toEqual(['v1.json']);
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

    it('runs from the CLI with $EDITOR, and refuses an argument that names no record', { timeout: 60_000 }, async () => {
        const id = catalog.photos[0].id;
        const env = { PHOTOGRAPHY_DATA_DIR: catalog.root, VISUAL: undefined, EDITOR: `node -e 'const fs = require("fs"); const f = process.argv[1]; const v = JSON.parse(fs.readFileSync(f, "utf8")); v.caption = "Fixture caption from EDITOR."; fs.writeFileSync(f, JSON.stringify(v));'` };
        const [run, usage] = await Promise.all([
            runTsx('scripts/photos.ts', ['edit', id], { env }),
            runTsx('scripts/photos.ts', ['edit', '../site'], { env }),
        ]);
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).toMatch(new RegExp(`^Saved photo ${id} as version \\d+\\.`));
        expect((await readAuthoredRecord(catalog.root, 'photo', id))?.caption).toBe('Fixture caption from EDITOR.');
        expect(usage.code).toBe(2);
        expect(usage.stderr).toContain('../site is not a photo ID, a series ID, or site.');
    });
});

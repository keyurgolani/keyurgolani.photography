// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    activationFileName,
    CatalogIntegrityError,
    lastCommitted,
    listActivations,
    nextSequence,
    readRevisionFile,
    revisionFilePath,
    revisionNumberFor,
    writeActivation,
    writeRevisionIfAbsent,
} from '../repository';
import { CATALOG_SCHEMA_VERSION, revisionIdOf } from '../schema';
import { createTestCatalog, type TestCatalog } from '../testing';
import type { Activation, RevisionContent, RevisionFile } from '../types';
import { catalogPaths } from '../working-layer';

let catalog: TestCatalog;

beforeEach(async () => {
    catalog = await createTestCatalog({ seed: 21, photos: 3, series: 1 });
});

afterEach(async () => {
    await catalog.cleanup();
});

function revisionOf(content: RevisionContent = catalog.content as RevisionContent): RevisionFile {
    return { revisionId: revisionIdOf(content), schemaVersion: CATALOG_SCHEMA_VERSION, baseRevisionId: null, compiledAt: '2026-02-01T00:00:00.000Z', content };
}

const REV_A = `rev_${'a'.repeat(64)}`;
const REV_B = `rev_${'b'.repeat(64)}`;
const REV_C = `rev_${'c'.repeat(64)}`;

function activation(sequence: number, overrides: Partial<Activation> = {}): Activation {
    return {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        activationId: `act_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
        sequence,
        kind: 'publish',
        status: 'committed',
        revisionId: REV_A,
        revisionNumber: sequence,
        previousRevisionId: null,
        previousActivationId: null,
        actor: 'test',
        reason: 'test',
        startedAt: '2026-02-01T00:00:00.000Z',
        committedAt: '2026-02-01T00:00:01.000Z',
        validation: { rulesetVersion: '0'.repeat(64), errors: 0, warnings: 0, diagnosticsDigest: '0'.repeat(64) },
        acceptedRules: [],
        lockTakeover: null,
        ...overrides,
    };
}

/** Run `fn` and return the CatalogIntegrityError it throws. */
async function integrityError(fn: () => Promise<unknown>): Promise<CatalogIntegrityError> {
    const error = await fn().then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CatalogIntegrityError);
    const integrity = error as CatalogIntegrityError;
    // It names the file from the data root, never by its absolute path.
    expect(integrity.message).not.toContain(catalog.root);
    return integrity;
}

describe('revision files', () => {
    it('reads null for a revision with no file', async () => {
        await expect(readRevisionFile(catalog.root, REV_A)).resolves.toBeNull();
    });

    it('writes a revision once and leaves the file alone after that', async () => {
        const revision = revisionOf();
        await expect(writeRevisionIfAbsent(catalog.root, revision)).resolves.toBe('written');
        const file = revisionFilePath(catalog.root, revision.revisionId);
        const before = fs.statSync(file);
        const bytes = fs.readFileSync(file);

        await expect(writeRevisionIfAbsent(catalog.root, { ...revision, compiledAt: '2026-03-01T00:00:00.000Z' })).resolves.toBe('present');
        expect(fs.readFileSync(file)).toEqual(bytes);
        expect(fs.statSync(file)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });
        await expect(readRevisionFile(catalog.root, revision.revisionId)).resolves.toEqual(revision);
        expect(fs.readdirSync(catalogPaths(catalog.root).revisionsDir)).toEqual([`${revision.revisionId}.json`]);
    });

    it.each([
        ['content edited after it was written', (revision: RevisionFile) => JSON.stringify({ ...revision, content: { ...revision.content, site: { featuredSeriesIds: [] } } }), /doesn't hash to its name/],
        ['another revision under its name', (revision: RevisionFile) => JSON.stringify({ ...revision, revisionId: REV_B }), new RegExp(`holds ${REV_B}`)],
        ['a field the strict schema refuses', (revision: RevisionFile) => JSON.stringify({ ...revision, sourcePath: 'fixture-0001.jpg' }), /is not a valid revision/],
        ['bytes that are not JSON', () => '{"revisionId": ', /is not valid JSON/],
    ])('fails closed on %s, and never rewrites it', async (_label, damage, message) => {
        const revision = revisionOf();
        const file = revisionFilePath(catalog.root, revision.revisionId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, damage(revision));
        const bytes = fs.readFileSync(file);

        const read = await integrityError(() => readRevisionFile(catalog.root, revision.revisionId));
        expect(read.file).toBe(`catalog/revisions/${revision.revisionId}.json`);
        expect(read.message).toMatch(message);
        await integrityError(() => writeRevisionIfAbsent(catalog.root, revision));
        expect(fs.readFileSync(file)).toEqual(bytes);
    });
});

describe('activation records', () => {
    const dir = () => catalogPaths(catalog.root).activationsDir;

    it('lists none before the first activation', async () => {
        await expect(listActivations(catalog.root)).resolves.toEqual([]);
    });

    it('lists every record by sequence and skips an interrupted write\'s temp file', async () => {
        for (const sequence of [3, 1, 2]) await writeActivation(catalog.root, activation(sequence));
        fs.writeFileSync(path.join(dir(), `.${activationFileName(activation(4))}.123.tmp`), '{"half": ');
        expect((await listActivations(catalog.root)).map((entry) => entry.sequence)).toEqual([1, 2, 3]);
        expect(fs.readdirSync(dir()).filter((name) => !name.startsWith('.'))).toEqual([1, 2, 3].map((sequence) => activationFileName(activation(sequence))));
    });

    it.each([
        ['a file not named like an activation', () => fs.writeFileSync(path.join(dir(), 'notes.json'), '{}'), /is not named/],
        ['a record that is not JSON', () => fs.writeFileSync(path.join(dir(), activationFileName(activation(2))), '{'), /is not valid JSON/],
        ['a record the schema refuses', () => fs.writeFileSync(path.join(dir(), activationFileName(activation(2))), JSON.stringify({ ...activation(2), status: 'maybe' })), /is not a valid activation/],
        ['a record whose name disagrees with what it holds', () => fs.writeFileSync(path.join(dir(), activationFileName(activation(2))), JSON.stringify(activation(5))), /holds activation 5/],
    ])('fails closed on %s', async (_label, damage, message) => {
        await writeActivation(catalog.root, activation(1));
        damage();
        const error = await integrityError(() => listActivations(catalog.root));
        expect(error.message).toMatch(message);
    });

    it('refuses to write a record it couldn\'t read back, and writes nothing', async () => {
        await expect(writeActivation(catalog.root, activation(1, { actor: '' }))).rejects.toThrow(/invalid activation: actor/);
        expect(fs.existsSync(dir())).toBe(false);
    });

    it('numbers sequences past every record, abandoned ones included, so names never repeat', () => {
        expect(nextSequence([])).toBe(1);
        expect(nextSequence([activation(1), activation(2, { status: 'abandoned' })])).toBe(3);
    });

    it('finds the newest committed activation', () => {
        const committed = activation(1);
        expect(lastCommitted([])).toBeNull();
        expect(lastCommitted([committed, activation(2, { status: 'abandoned' }), activation(3, { status: 'pending' })])).toEqual(committed);
    });

    it('gives a revision the number of its first committed activation, and a new one the next number', () => {
        const history = [
            activation(1, { revisionId: REV_A, revisionNumber: 1 }),
            activation(2, { revisionId: REV_B, revisionNumber: 2, status: 'abandoned' }),
            activation(3, { revisionId: REV_B, revisionNumber: 2 }),
            activation(4, { revisionId: REV_C, revisionNumber: 3, status: 'pending' }),
        ];
        // Abandoned and pending activations take no number.
        expect(revisionNumberFor(history, REV_C)).toBe(3);
        // A rollback to an older revision keeps that revision's number.
        expect(revisionNumberFor(history, REV_A)).toBe(1);
        expect(revisionNumberFor([], REV_A)).toBe(1);
    });
});

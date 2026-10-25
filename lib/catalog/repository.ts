import fs from 'node:fs';
import path from 'node:path';
import { atomicCreateJson, atomicWriteJson, type AtomicWriteFaults } from '../storage/atomicWrite';
import { StaleVersionError, writeVersionedDocument, type VersionedWriteHooks } from '../storage/document';
import { hasErrorCode, PRIVATE_DIR_MODE } from '../storage/fsx';
import { CATALOG_SCHEMA_VERSION, parseActivation, parseRevisionFile, revisionIdOf, ACTIVATION_ID_RE, REVISION_ID_RE } from './schema';
import type { Activation, ActivePointer, CandidateFile, Issue, RevisionFile } from './types';
import { catalogPaths } from './working-layer';

/**
 * Catalog storage under `catalog/`: revision files, which are never
 * rewritten, activation records, the active pointer's version folder,
 * candidates, and diagnostics. Only the CLI writes here, holding the catalog lock, and only
 * publish.ts's commitActivation() writes the pointer. Readers on the web side
 * go through slice C's public reader instead.
 */

export const CATALOG_LOCK = 'catalog';

/** A stored file that isn't what its name says. Names the file relative to the data root, never an absolute path. */
export class CatalogIntegrityError extends Error {
    readonly file: string;

    constructor(file: string, message: string) {
        super(message);
        this.name = 'CatalogIntegrityError';
        this.file = file;
    }
}

const ACTIVATION_FILE_RE = new RegExp(`^(\\d{6,})-(${ACTIVATION_ID_RE.source.replace(/^\^/, '').replace(/\$$/, '')})\\.json$`);

const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');

async function ensureDir(dir: string): Promise<void> {
    await fs.promises.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/** A JSON file's value, `{json: false}` when it isn't JSON, or null when it doesn't exist. */
async function readJson(file: string): Promise<{ json: true; value: unknown } | { json: false } | null> {
    let text: string;
    try {
        text = await fs.promises.readFile(file, 'utf8');
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return null;
        throw error;
    }
    try {
        return { json: true, value: JSON.parse(text) as unknown };
    } catch {
        return { json: false };
    }
}

/** Throw a TypeError for anything but a revision ID, so a caller's value never names another path. */
export function assertRevisionId(revisionId: unknown): asserts revisionId is string {
    if (typeof revisionId !== 'string' || !REVISION_ID_RE.test(revisionId)) throw new TypeError(`A revision ID is rev_ plus 64 hex, not ${JSON.stringify(revisionId)}.`);
}

/** Where `revisionId`'s file lives. Throws a TypeError for anything but a revision ID. */
export function revisionFilePath(root: string, revisionId: string): string {
    assertRevisionId(revisionId);
    return path.join(catalogPaths(root).revisionsDir, `${revisionId}.json`);
}

/**
 * The revision file for `revisionId`, checked whole: it parses with the
 * strict revision schema, names itself, and its content hashes to its ID.
 * Null when there is none. Throws CatalogIntegrityError for anything else.
 */
export async function readRevisionFile(root: string, revisionId: string): Promise<RevisionFile | null> {
    const file = revisionFilePath(root, revisionId);
    const read = await readJson(file);
    if (read === null) return null;
    const name = relative(root, file);
    if (!read.json) throw new CatalogIntegrityError(name, `${name} is not valid JSON.`);
    const parsed = parseRevisionFile(read.value);
    if (!parsed.ok) {
        const issues = parsed.error.issues.slice(0, 3).map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join('; ');
        throw new CatalogIntegrityError(name, `${name} is not a valid revision: ${issues}.`);
    }
    if (parsed.value.revisionId !== revisionId) throw new CatalogIntegrityError(name, `${name} holds ${parsed.value.revisionId}.`);
    const hashed = revisionIdOf(parsed.value.content);
    if (hashed !== revisionId) throw new CatalogIntegrityError(name, `${name} doesn't hash to its name: its content is ${hashed}.`);
    return parsed.value;
}

/**
 * Write a revision file unless one exists. An existing file is never
 * rewritten: it is re-hashed instead, and one that isn't this revision throws
 * CatalogIntegrityError. Resolves 'written' or 'present'.
 */
export async function writeRevisionIfAbsent(root: string, revision: RevisionFile, faults?: AtomicWriteFaults): Promise<'written' | 'present'> {
    const file = revisionFilePath(root, revision.revisionId);
    if ((await readRevisionFile(root, revision.revisionId)) !== null) return 'present';
    await ensureDir(path.dirname(file));
    if (await atomicCreateJson(file, revision, { faults })) return 'written';
    // Another writer created it between the read and the link, so check theirs.
    if ((await readRevisionFile(root, revision.revisionId)) === null) throw new CatalogIntegrityError(relative(root, file), `${relative(root, file)} vanished while it was written.`);
    return 'present';
}

export function activationFileName(activation: Pick<Activation, 'sequence' | 'activationId'>): string {
    return `${String(activation.sequence).padStart(6, '0')}-${activation.activationId}.json`;
}

/**
 * Every activation record, sorted by sequence. Fails closed: a file named
 * like an activation that doesn't parse, or whose name disagrees with what it
 * holds, throws CatalogIntegrityError, since nobody can tell what it says.
 */
export async function listActivations(root: string): Promise<Activation[]> {
    const dir = catalogPaths(root).activationsDir;
    let names: string[];
    try {
        names = await fs.promises.readdir(dir);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return [];
        throw error;
    }
    const activations: Activation[] = [];
    // Dot-files are temp files from an interrupted atomic write.
    for (const name of names.filter((entry) => !entry.startsWith('.') && entry.endsWith('.json')).sort()) {
        const file = `${relative(root, dir)}/${name}`;
        const match = ACTIVATION_FILE_RE.exec(name);
        if (!match) throw new CatalogIntegrityError(file, `${file} is not named NNNNNN-<activationId>.json.`);
        const read = await readJson(path.join(dir, name));
        if (read === null) continue;
        if (!read.json) throw new CatalogIntegrityError(file, `${file} is not valid JSON.`);
        const parsed = parseActivation(read.value);
        if (!parsed.ok) throw new CatalogIntegrityError(file, `${file} is not a valid activation: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join('; ')}.`);
        if (parsed.value.sequence !== Number(match[1]) || parsed.value.activationId !== match[2]) {
            throw new CatalogIntegrityError(file, `${file} holds activation ${parsed.value.sequence} ${parsed.value.activationId}.`);
        }
        activations.push(parsed.value);
    }
    return activations.sort((a, b) => a.sequence - b.sequence);
}

/**
 * Create or replace an activation record. Only its status and committedAt
 * ever change after it is first written. Refuses a record listActivations()
 * would refuse, since one such file stops every later publish.
 */
export async function writeActivation(root: string, activation: Activation, faults?: AtomicWriteFaults): Promise<void> {
    const parsed = parseActivation(activation);
    if (!parsed.ok) throw new Error(`Refusing to write an invalid activation: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join('; ')}.`);
    const dir = catalogPaths(root).activationsDir;
    await ensureDir(dir);
    await atomicWriteJson(path.join(dir, activationFileName(activation)), activation, { faults });
}

/** The sequence the next activation takes: one past the highest, abandoned ones included, so file names never repeat. */
export function nextSequence(activations: readonly Activation[]): number {
    return activations.reduce((highest, activation) => Math.max(highest, activation.sequence), 0) + 1;
}

/** The newest committed activation, or null before the first. */
export function lastCommitted(activations: readonly Activation[]): Activation | null {
    for (let index = activations.length - 1; index >= 0; index--) {
        if (activations[index].status === 'committed') return activations[index];
    }
    return null;
}

/**
 * "Revision N": the number `revisionId` got at its first committed
 * activation, or the highest committed number plus one for a revision never
 * committed before. Abandoned and pending activations don't count.
 */
export function revisionNumberFor(activations: readonly Activation[], revisionId: string): number {
    const committed = activations.filter((activation) => activation.status === 'committed');
    const earlier = committed.find((activation) => activation.revisionId === revisionId);
    if (earlier) return earlier.revisionNumber;
    return committed.reduce((highest, activation) => Math.max(highest, activation.revisionNumber), 0) + 1;
}

/** A pointer write found another version in `catalog/active/` than the one its caller read. */
export class ActivePointerMovedError extends Error {
    readonly expected: number;
    readonly found: number;

    constructor(expected: number, found: number) {
        super(`The active pointer is at version ${found}, not ${expected}: another process moved it.`);
        this.name = 'ActivePointerMovedError';
        this.expected = expected;
        this.found = found;
    }
}

/**
 * Commit the active pointer as the next version in `catalog/active/`, only if
 * its newest version is still `expectedVersion` (0 before the first). The
 * link() that commits it never replaces a version, so of two processes that
 * read one version only one moves the pointer, and the other gets
 * ActivePointerMovedError, writing nothing. publish.ts's commitActivation()
 * is its only production caller.
 */
export async function writeActivePointer(
    root: string,
    pointer: Pick<ActivePointer, 'revisionId' | 'activationId'>,
    expectedVersion: number,
    hooks?: VersionedWriteHooks,
): Promise<ActivePointer> {
    await ensureDir(catalogPaths(root).dir);
    const next: ActivePointer = { schemaVersion: CATALOG_SCHEMA_VERSION, version: expectedVersion, revisionId: pointer.revisionId, activationId: pointer.activationId };
    try {
        return await writeVersionedDocument(catalogPaths(root).active, next, expectedVersion, { hooks });
    } catch (error) {
        if (error instanceof StaleVersionError) throw new ActivePointerMovedError(error.expected, error.found);
        throw error;
    }
}

/** `catalog/candidates/<candidateId>.json`, which #16's preview reads. Same content, same name, so a rewrite changes only compiledAt. */
export async function writeCandidate(root: string, candidate: CandidateFile): Promise<void> {
    const dir = catalogPaths(root).candidatesDir;
    await ensureDir(dir);
    await atomicWriteJson(path.join(dir, `${candidate.revisionId}.json`), candidate);
}

/** What `catalog/diagnostics/<candidateId>.json` holds: every issue, for #16, not just the 200 the CLI prints. */
export interface DiagnosticsFile {
    schemaVersion: typeof CATALOG_SCHEMA_VERSION;
    candidateId: string;
    rulesetVersion: string;
    checkedAt: string;
    errors: number;
    warnings: number;
    issues: Issue[];
}

export async function writeDiagnostics(root: string, diagnostics: DiagnosticsFile): Promise<void> {
    const dir = catalogPaths(root).diagnosticsDir;
    await ensureDir(dir);
    await atomicWriteJson(path.join(dir, `${diagnostics.candidateId}.json`), diagnostics);
}

/**
 * `catalog/diagnostics/last-publish.json`: how the last publish attempt that
 * held the catalog lock ended, for `photos status` and #16. A publish that
 * never got the lock, or lost it, writes none.
 */
export interface LastPublishFile {
    schemaVersion: typeof CATALOG_SCHEMA_VERSION;
    outcome: string;
    at: string;
    actor: string;
    candidateId: string | null;
    revisionId: string | null;
    revisionNumber: number | null;
    errors: number;
    warnings: number;
    message: string;
}

export async function writeLastPublish(root: string, summary: LastPublishFile): Promise<void> {
    const dir = catalogPaths(root).diagnosticsDir;
    await ensureDir(dir);
    await atomicWriteJson(path.join(dir, 'last-publish.json'), summary);
}

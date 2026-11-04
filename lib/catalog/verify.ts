import fs from 'node:fs';
import path from 'node:path';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { assetDir } from '../media/path';
import { dataRootStatus } from '../storage/config';
import { CorruptDocumentError } from '../storage/document';
import { hasErrorCode } from '../storage/fsx';
import { verifyDirectory, type AssetIdentity } from '../storage/publish';
import { historyState, knownGood } from './history';
import { blockingIssues, validateStored } from './publish';
import { assertRevisionId, CatalogIntegrityError, listActivations, readRevisionFile } from './repository';
import { errorText } from './rollback';
import { registeredRules } from './ruleset';
import { REVISION_ID_RE } from './schema';
import type { Activation, ActivePointer, Issue } from './types';
import { catalogPaths, readActivePointer } from './working-layer';

/**
 * #117's `photos verify` checks and the record's reader. A run reads the
 * data root only, never the library, takes no lock, and writes nothing
 * here: verify-cli.ts holds the run and the one write, `status/verify.json`.
 *
 * It checks every revision file in `catalog/revisions/`, and every revision
 * an activation or the active pointer names: the file parses, names itself
 * and hashes to its ID; every rule passes on it, where an `integrity` error
 * fails it and an `editorial` one, which a rollback can accept, only warns;
 * and every derivative set it publishes passes verifyDirectory(), digests
 * included. Each set is hashed once per run, since most revisions share most
 * sets. Then the pointer chain: the pointer names a record for its revision,
 * every previousActivationId names a record, and committed records always
 * have a pointer.
 *
 * lastKnownGood() is the Publish screen's gate for its rollback-ready line.
 * It runs the cheap part on the live revision, without digests, then reads
 * the record: any evidence of a problem, a failed live check, a recorded
 * failure of that revision from any run, or a damaged record, means no.
 */

export const VERIFY_RECORD_SCHEMA_VERSION = 1;
/** How many problems and warnings the record keeps per revision. */
export const MAX_RECORDED_PROBLEMS = 20;

export type VerifyOutcome = 'VERIFIED' | 'VERIFY_FAILED' | 'DATA_ROOT_NOT_READY' | 'INTEGRITY_MISMATCH' | 'STORAGE_ERROR';

/** 0 when the live revision and the chain pass, older failures only warning; 1 when either fails; 3 for a data root that isn't ready; 4 when it couldn't finish. Usage errors, 2, are the CLI's. */
export const VERIFY_EXIT_CODES: Record<VerifyOutcome, 0 | 1 | 3 | 4> = {
    VERIFIED: 0,
    VERIFY_FAILED: 1,
    DATA_ROOT_NOT_READY: 3,
    INTEGRITY_MISMATCH: 4,
    STORAGE_ERROR: 4,
};

export interface RevisionCheck {
    revisionId: string;
    /** The number it went live under, or null for one never active. */
    revisionNumber: number | null;
    /** The active pointer names it. */
    live: boolean;
    /** It was active before, so a rollback may go back to it (knownGood()). */
    eligible: boolean;
    ok: boolean;
    /** What fails it, the first MAX_RECORDED_PROBLEMS. */
    problems: string[];
    problemCount: number;
    /** Editorial errors, which a rollback can accept. */
    warnings: string[];
    /** The derivative sets that failed, as folders relative to the data root: `assets/<photoId>/<assetRevision>/<profileId>`. */
    failedSets: string[];
    /** What to do about it, or null when it passes. */
    fix: string | null;
}

export interface ChainCheck {
    ok: boolean;
    problems: string[];
    warnings: string[];
}

/** `status/verify.json`: one full run. */
export interface VerifyRecord {
    schemaVersion: typeof VERIFY_RECORD_SCHEMA_VERSION;
    checkedAt: string;
    durationMs: number;
    /** The active pointer as the run read it at the start, or null. */
    pointer: Pick<ActivePointer, 'revisionId' | 'activationId' | 'version'> | null;
    chain: ChainCheck;
    revisions: RevisionCheck[];
    sets: { checked: number; failed: number };
}

export interface VerifyReport {
    outcome: VerifyOutcome;
    message: string;
    /** Null when it stopped before checking anything. */
    record: VerifyRecord | null;
    /** A run over everything, which the CLI records. `--revision` checks one and records nothing. */
    full: boolean;
}

export type SetCheck = (dir: string, identity: AssetIdentity) => Promise<string[]>;

export interface VerifyOptions {
    dataRoot: string;
    /** Check this revision alone, without the chain. */
    revisionId?: string;
    clock?: () => number;
    /** How a derivative set is checked. verifyDirectory() unless a test counts the calls. */
    checkSet?: SetCheck;
}

/** `status/verify.json` in `root`. */
export function verifyRecordPath(root: string): string {
    return path.join(/*turbopackIgnore: true*/ root, 'status', 'verify.json');
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
const ARCHIVE = 'the archive the rest of the data root came from';

/** `text` with the data root's absolute path made relative, so no message names a host path. */
export function scrubRoot(text: string, root: string): string {
    const bases = new Set([root]);
    try {
        bases.add(fs.realpathSync(/*turbopackIgnore: true*/ root));
    } catch {
        // A root that can't be resolved has no other spelling to scrub.
    }
    let out = text;
    for (const base of [...bases].sort((a, b) => b.length - a.length)) out = out.split(`${base}${path.sep}`).join('').split(base).join('the data root');
    return out;
}

/** The rule IDs whose errors a rollback can accept. */
function editorialRuleIds(): string[] {
    return registeredRules().filter((rule) => rule.rollbackClass === 'editorial').map((rule) => rule.id);
}

const issueText = (issue: Issue) => `${issue.code} on ${issue.record.kind} ${issue.record.id}, ${issue.field}: ${issue.message.replace(/\.$/, '')}`;

/** Each derivative set's problems, checked once per run, by photo, asset revision, and profile. */
function setChecker(root: string, check: SetCheck) {
    const results = new Map<string, Promise<string[]>>();
    return {
        problems(identity: AssetIdentity): Promise<string[]> {
            const key = `${identity.photoId}/${identity.assetRevision}/${identity.profileId}`;
            let result = results.get(key);
            if (!result) {
                result = check(assetDir(identity, root), identity).then((problems) => problems.map((problem) => scrubRoot(problem, root)));
                results.set(key, result);
            }
            return result;
        },
        async counts(): Promise<{ checked: number; failed: number }> {
            const all = await Promise.all(results.values());
            return { checked: all.length, failed: all.filter((problems) => problems.length > 0).length };
        },
    };
}

interface Checked {
    problems: string[];
    warnings: string[];
    failedSets: string[];
    /** The file itself is missing or damaged. */
    fileProblem: boolean;
}

/**
 * One revision: its file, its rules, and, with `sets`, its derivative sets'
 * digests. Throws only for an I/O error; a damaged file is a problem.
 */
async function checkRevision(root: string, revisionId: string, registry: Registry, sets: ReturnType<typeof setChecker> | null): Promise<Checked> {
    const checked: Checked = { problems: [], warnings: [], failedSets: [], fileProblem: false };
    let revision;
    try {
        revision = await readRevisionFile(root, revisionId);
    } catch (error) {
        if (!(error instanceof CatalogIntegrityError)) throw error;
        return { ...checked, problems: [error.message.replace(/\.$/, '')], fileProblem: true };
    }
    if (revision === null) return { ...checked, problems: [`catalog/revisions/${revisionId}.json is missing`], fileProblem: true };

    const { issues } = validateStored(root, revision, registry);
    const blocking = blockingIssues(issues, editorialRuleIds());
    checked.problems.push(...blocking.map(issueText));
    checked.warnings.push(...issues.filter((issue) => issue.severity === 'error' && !blocking.includes(issue)).map(issueText));
    const folder = (photo: AssetIdentity) => `assets/${photo.photoId}/${photo.assetRevision}/${photo.profileId}`;
    const identities = new Map(revision.content.photos.map((photo) => [photo.id, { photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId }]));
    const failed = new Set<string>();
    for (const issue of blocking) {
        const identity = issue.record.kind === 'photo' && /^assets\.(?:manifest|variant|size)$/.test(issue.code) ? identities.get(issue.record.id) : undefined;
        if (identity) failed.add(folder(identity));
    }
    if (sets) {
        for (const identity of identities.values()) {
            const problems = await sets.problems(identity);
            if (problems.length === 0) continue;
            failed.add(folder(identity));
            checked.problems.push(...problems.map((problem) => `${identity.photoId}: ${problem}`));
        }
    }
    checked.failedSets = [...failed].sort();
    return checked;
}

/**
 * What to do about a revision that fails, in the CLI's words. A set is
 * never rebuilt in place, and `photos identity retry` requeues only a
 * failed build, never a set the registry calls ready, so a broken set comes
 * back from the archive; the live revision can also roll back.
 */
function fixFor(revisionId: string, checked: Checked, live: boolean): string | null {
    if (checked.problems.length === 0) return null;
    const back = live ? ' Or roll back to a revision that passes.' : '';
    if (checked.fileProblem) return `Put catalog/revisions/${revisionId}.json back from ${ARCHIVE}.${back}`;
    const sets = checked.failedSets;
    if (sets.length === 1) return `Put ${sets[0]}/ back from ${ARCHIVE}.${back}`;
    if (sets.length > 1) {
        const more = sets.length > MAX_RECORDED_PROBLEMS ? `, and ${sets.length - MAX_RECORDED_PROBLEMS} more` : '';
        return `Put each of these sets back from ${ARCHIVE}: ${sets.slice(0, MAX_RECORDED_PROBLEMS).map((dir) => `${dir}/`).join(', ')}${more}.${back}`;
    }
    return live ? 'Roll back to a revision that passes.' : "A rollback can't return to it while these fail.";
}

/** The pointer chain. `pointerProblem`: why the pointer couldn't be read. */
function checkChain(activations: readonly Activation[], pointer: ActivePointer | null, pointerProblem: string | null, strays: readonly string[] = []): ChainCheck {
    const problems: string[] = [];
    const warnings = strays.map((name) => `catalog/revisions/${name} isn't named like a revision file, so nothing reads it.`);
    if (pointerProblem !== null) {
        problems.push(`The active pointer can't be read: ${pointerProblem.replace(/\.$/, '')}. Put catalog/active/ back from ${ARCHIVE}.`);
    } else if (pointer === null) {
        const committed = activations.filter((activation) => activation.status === 'committed').length;
        if (committed > 0) problems.push(`${count(committed, 'activation')} ${committed === 1 ? 'is' : 'are'} committed, but there is no active pointer, so the site serves nothing. Put catalog/active/ back from ${ARCHIVE}.`);
    } else {
        const named = activations.find((activation) => activation.activationId === pointer.activationId);
        const repair = 'The next publish or rollback records a repair activation for it.';
        if (!named) problems.push(`The active pointer names ${pointer.activationId}, which no activation record holds. ${repair}`);
        else if (named.revisionId !== pointer.revisionId) problems.push(`The active pointer names ${pointer.revisionId} through #${named.sequence}, which records ${named.revisionId}. Put catalog/ back from ${ARCHIVE}.`);
        else if (named.status === 'abandoned') problems.push(`The active pointer names #${named.sequence}, which was set aside. ${repair}`);
        else if (historyState(named, pointer).unsettled) warnings.push(`The active pointer names #${named.sequence}, which is still pending. The next publish or rollback records it as committed.`);
    }
    const ids = new Set(activations.map((activation) => activation.activationId));
    for (const activation of activations) {
        if (activation.previousActivationId !== null && !ids.has(activation.previousActivationId)) {
            problems.push(`#${activation.sequence} names ${activation.previousActivationId} as the activation before it, which no record holds. History can't say what it replaced: put catalog/activations/ back from ${ARCHIVE}.`);
        }
    }
    return { ok: problems.length === 0, problems, warnings };
}

const REVISION_FILE_RE = new RegExp(`^${REVISION_ID_RE.source.replace(/^\^/, '').replace(/\$$/, '')}\\.json$`);

/** Every revision to check, oldest first: those activations name, in sequence order, the pointer's, then the rest of `catalog/revisions/`. */
async function revisionIds(root: string, activations: readonly Activation[], pointer: ActivePointer | null): Promise<{ ids: string[]; strays: string[] }> {
    const ids: string[] = [];
    const add = (revisionId: string) => {
        if (!ids.includes(revisionId)) ids.push(revisionId);
    };
    for (const activation of activations) add(activation.revisionId);
    if (pointer) add(pointer.revisionId);
    let names: string[] = [];
    try {
        names = await fs.promises.readdir(/*turbopackIgnore: true*/ catalogPaths(root).revisionsDir);
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
    const strays: string[] = [];
    // Dot-files are temp files from an interrupted atomic write.
    for (const name of names.filter((entry) => !entry.startsWith('.')).sort()) {
        if (REVISION_FILE_RE.test(name)) add(name.slice(0, -'.json'.length));
        else strays.push(name);
    }
    return { ids, strays };
}

const nameOf = (entry: Pick<RevisionCheck, 'revisionId' | 'revisionNumber'>) => (entry.revisionNumber === null ? entry.revisionId : `Revision ${entry.revisionNumber}`);

function verdict(record: VerifyRecord, full: boolean): { outcome: VerifyOutcome; message: string } {
    if (!full) {
        const [only] = record.revisions;
        return only.ok ? { outcome: 'VERIFIED', message: `${nameOf(only)} passes.` } : { outcome: 'VERIFY_FAILED', message: `${nameOf(only)} fails. ${only.fix ?? ''}`.trim() };
    }
    const live = record.revisions.find((entry) => entry.live);
    const older = record.revisions.filter((entry) => !entry.live && !entry.ok).length;
    const olderNote = older === 0 ? '' : ` ${older} older ${older === 1 ? "revision fails, so don't roll back to it" : "revisions fail, so don't roll back to them"} until ${older === 1 ? 'it passes' : 'they pass'}.`;
    const failures = [
        ...(live && !live.ok ? [`${nameOf(live)}, the live one, fails`] : []),
        ...(record.chain.ok ? [] : ['the activation chain fails']),
    ];
    if (failures.length > 0) {
        const text = failures.join(', and ');
        return { outcome: 'VERIFY_FAILED', message: `${text.charAt(0).toUpperCase()}${text.slice(1)}. Fix what's listed above.${olderNote}` };
    }
    if (!live) return { outcome: 'VERIFIED', message: `Nothing is live yet, and the activation chain passes.${olderNote}` };
    return { outcome: 'VERIFIED', message: `${nameOf(live)} and the activation chain pass.${olderNote}` };
}

/**
 * Check the data root. Never throws for a damaged file or an I/O error:
 * an activation record or the registry that can't be read is
 * INTEGRITY_MISMATCH or STORAGE_ERROR, a damaged revision or pointer a
 * failure the record keeps.
 */
export async function verifyCatalog(options: VerifyOptions): Promise<VerifyReport> {
    const root = path.resolve(/*turbopackIgnore: true*/ options.dataRoot);
    const full = options.revisionId === undefined;
    const status = dataRootStatus({ root });
    if (status.state !== 'ready') {
        return { outcome: 'DATA_ROOT_NOT_READY', message: `The data root is ${status.state}${status.detail ? `: ${scrubRoot(status.detail, root)}` : ''}. Nothing was checked.`, record: null, full };
    }
    if (options.revisionId !== undefined) assertRevisionId(options.revisionId);
    try {
        return await run(root, options, full);
    } catch (error) {
        const outcome: VerifyOutcome = error instanceof CatalogIntegrityError || error instanceof CorruptDocumentError ? 'INTEGRITY_MISMATCH' : 'STORAGE_ERROR';
        return { outcome, message: `${sentence(scrubRoot(errorText(error, root), root))} Verify couldn't finish, so nothing was recorded.`, record: null, full };
    }
}

async function run(root: string, options: VerifyOptions, full: boolean): Promise<VerifyReport> {
    const clock = options.clock ?? Date.now;
    const start = clock();
    let pointer: ActivePointer | null = null;
    let pointerProblem: string | null = null;
    try {
        pointer = await readActivePointer(root);
    } catch (error) {
        pointerProblem = scrubRoot(errorText(error, root), root);
    }
    const activations = await listActivations(root);
    const registry = await readRegistry(root);
    const good = knownGood(activations, pointer);
    const sets = setChecker(root, options.checkSet ?? verifyDirectory);
    const { ids, strays } = full ? await revisionIds(root, activations, pointer) : { ids: [options.revisionId as string], strays: [] };

    const revisions: RevisionCheck[] = [];
    for (const revisionId of ids) {
        const checked = await checkRevision(root, revisionId, registry, sets);
        const live = pointer?.revisionId === revisionId;
        revisions.push({
            revisionId,
            revisionNumber: good.get(revisionId) ?? null,
            live,
            eligible: good.has(revisionId),
            ok: checked.problems.length === 0,
            problems: checked.problems.slice(0, MAX_RECORDED_PROBLEMS),
            problemCount: checked.problems.length,
            warnings: checked.warnings.slice(0, MAX_RECORDED_PROBLEMS),
            failedSets: checked.failedSets.slice(0, MAX_RECORDED_PROBLEMS),
            fix: fixFor(revisionId, checked, live),
        });
    }
    const chain = full ? checkChain(activations, pointer, pointerProblem, strays) : { ok: true, problems: [], warnings: [] };
    const record: VerifyRecord = {
        schemaVersion: VERIFY_RECORD_SCHEMA_VERSION,
        checkedAt: new Date(start).toISOString(),
        durationMs: Math.max(0, clock() - start),
        pointer: pointer ? { revisionId: pointer.revisionId, activationId: pointer.activationId, version: pointer.version } : null,
        chain,
        revisions,
        sets: await sets.counts(),
    };
    return { ...verdict(record, full), record, full };
}

// The record's reader.

export type VerifyRecordRead = { state: 'none' } | { state: 'damaged' } | { state: 'ok'; record: VerifyRecord };

const isEntry = (value: unknown): value is Pick<RevisionCheck, 'revisionId' | 'ok'> => {
    if (typeof value !== 'object' || value === null) return false;
    const entry = value as Record<string, unknown>;
    return typeof entry.revisionId === 'string' && REVISION_ID_RE.test(entry.revisionId) && typeof entry.ok === 'boolean';
};

const isRecord = (value: unknown): value is VerifyRecord => {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return record.schemaVersion === VERIFY_RECORD_SCHEMA_VERSION && typeof record.checkedAt === 'string' && Array.isArray(record.revisions) && record.revisions.every(isEntry);
};

/** The last full run's record: none before the first, damaged when it can't be read or isn't one this build reads. Never throws. */
export async function readVerifyRecord(root: string): Promise<VerifyRecordRead> {
    let text: string;
    try {
        text = await fs.promises.readFile(/*turbopackIgnore: true*/ verifyRecordPath(root), 'utf8');
    } catch (error) {
        return hasErrorCode(error, 'ENOENT', 'ENOTDIR') ? { state: 'none' } : { state: 'damaged' };
    }
    try {
        const value: unknown = JSON.parse(text);
        return isRecord(value) ? { state: 'ok', record: value } : { state: 'damaged' };
    } catch {
        return { state: 'damaged' };
    }
}

// The Publish screen's gate.

export type FailedReason = 'live-check' | 'last-verify' | 'record-damaged';

export type Readiness =
    /** The live checks pass, and the last full verify passed it. */
    | { state: 'verified'; revisionId: string; revisionNumber: number }
    /** The live checks pass, and no verify has checked it. */
    | { state: 'live-ok'; revisionId: string; revisionNumber: number }
    | { state: 'failed'; reason: FailedReason; revisionId: string | null; revisionNumber: number | null }
    /** Nothing is live, or no record numbers the revision. */
    | { state: 'none' };

/**
 * Whether the live revision, or `revisionId`, which must have been live, is
 * rollback-ready: the live check, its file, its hash, its integrity rules
 * (sizes and manifests, no digests) and the chain, then the record. Read
 * only, no lock, and it never throws: anything it can't read is a failure.
 * `registry`: one the caller already read, so the check reads it once.
 */
export async function rollbackReadiness(root: string, { revisionId, registry }: { revisionId?: string; registry?: Registry } = {}): Promise<Readiness> {
    const resolved = path.resolve(/*turbopackIgnore: true*/ root);
    let pointer: ActivePointer | null;
    let activations: Activation[];
    try {
        pointer = await readActivePointer(resolved);
        activations = await listActivations(resolved);
    } catch {
        return { state: 'failed', reason: 'live-check', revisionId: revisionId ?? null, revisionNumber: null };
    }
    if (pointer === null) return { state: 'none' };
    const target = revisionId ?? pointer.revisionId;
    const revisionNumber = knownGood(activations, pointer).get(target);
    if (revisionNumber === undefined) return { state: 'none' };
    const failed = (reason: FailedReason): Readiness => ({ state: 'failed', reason, revisionId: target, revisionNumber });
    try {
        const checked = await checkRevision(resolved, target, registry ?? (await readRegistry(resolved)), null);
        if (checked.problems.length > 0 || !checkChain(activations, pointer, null).ok) return failed('live-check');
    } catch {
        return failed('live-check');
    }
    const read = await readVerifyRecord(resolved);
    if (read.state === 'damaged') return failed('record-damaged');
    // From any run, one made while another revision was live included: a restore can bring back a revision whose sets failed.
    const entries = read.state === 'ok' ? read.record.revisions.filter((entry) => entry.revisionId === target) : [];
    if (entries.some((entry) => !entry.ok)) return failed('last-verify');
    return { state: entries.length > 0 ? 'verified' : 'live-ok', revisionId: target, revisionNumber };
}

/** The live revision's number when it's rollback-ready, else null (#117, AC 14). Read only. */
export async function lastKnownGood(root: string): Promise<number | null> {
    const readiness = await rollbackReadiness(root);
    return readiness.state === 'verified' || readiness.state === 'live-ok' ? readiness.revisionNumber : null;
}

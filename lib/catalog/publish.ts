import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { dataRootStatus, libraryRoot } from '../storage/config';
import { LockTimeoutError, withLock, type LockContext, type LockHooks, type LockRecord } from '../storage/lock';
import './asset-rules';
import { candidateFile, compileCandidate, type CompileResult } from './compile';
import { LAUNCH_ORDER_RULE_IDS } from './order-rules';
import { rebaseWorkingLayer, type RebaseReport } from './rebase';
import {
    CATALOG_LOCK,
    CatalogIntegrityError,
    lastCommitted,
    listActivations,
    nextSequence,
    readRevisionFile,
    revisionNumberFor,
    writeActivation,
    writeActivePointer,
    writeCandidate,
    writeDiagnostics,
    writeLastPublish,
    writeRevisionIfAbsent,
} from './repository';
import { registeredRules, rulesetVersion, runRules } from './rules';
import { CATALOG_SCHEMA_VERSION, canonicalJson, parseRevisionFile } from './schema';
import type { Activation, ActivePointer, Issue, RevisionFile, WorkingLayer } from './types';
import { AUTHORED_LEASE_MS, AUTHORED_LOCK, AUTHORED_WAIT_MS } from './working-layer-writer';
import { readActivePointer, readWorkingLayer } from './working-layer';

export { rebaseWorkingLayer, type RebaseOptions, type RebaseReport } from './rebase';

/**
 * The publish transaction. publish() compiles the working layer, validates
 * the candidate under the catalog lock, writes its revision file, and
 * activates it, in thirteen steps:
 *
 *   1. Recover an interrupted activation, then rebase if the working layer
 *      is on another base.
 *   2. Snapshot the working layer under the authored lock, and read #10's
 *      registry.
 *   3. Compile the candidate and write it to `catalog/candidates/`.
 *   4. Stop with CANDIDATE_CHANGED when it isn't the one the caller expects.
 *   5. Stop with NO_CHANGES when it is already active.
 *   6. Run every rule, write the diagnostics, and stop with
 *      VALIDATION_FAILED on any error.
 *   7. Before the first activation, stop with LAUNCH_RULES_MISSING unless
 *      #8's order rules are registered, then with
 *      LAUNCH_CONFIRMATION_REQUIRED unless `confirmLaunch`.
 *   8. With `dryRun`, stop with DRY_RUN_OK.
 *   9. Write `revisions/<id>.json`, or re-hash the one already there.
 *  10. Write the pending activation.
 *  11. Re-read the lock, stop with LOCK_LOST unless it is still ours, and
 *      point `active.json` at the revision.
 *  12. Mark the activation committed.
 *  13. Rebase the working layer onto the new revision.
 *
 * Steps 10 to 12 are commitActivation(), the only writer of `active.json`.
 * Through step 9 a stop writes at most the candidate, its diagnostics, and
 * `last-publish.json`, so `active.json` changes only when a publish lands,
 * or when step 1 settles an interrupted one. A retry after a crash at any
 * step gets the same revision ID and at most one committed activation.
 */

export type PublishOutcome =
    | 'PUBLISHED'
    | 'NO_CHANGES'
    | 'DRY_RUN_OK'
    | 'VALIDATION_FAILED'
    | 'CANDIDATE_CHANGED'
    | 'LAUNCH_RULES_MISSING'
    | 'LAUNCH_CONFIRMATION_REQUIRED'
    | 'CATALOG_LOCKED'
    | 'AUTHORED_LOCKED'
    | 'LOCK_LOST'
    | 'DATA_ROOT_NOT_READY'
    | 'INTEGRITY_MISMATCH'
    | 'STORAGE_ERROR';

export type ActivateOutcome = 'ACTIVATED' | 'NOTHING_ACTIVE' | 'ACTIVE_CHANGED' | 'LOCK_LOST' | 'INTEGRITY_MISMATCH';

/** The CLI's exit code for each outcome. Usage errors, 2, are the CLI's own. */
export const PUBLISH_EXIT_CODES: Record<PublishOutcome, 0 | 1 | 3 | 4> = {
    PUBLISHED: 0,
    NO_CHANGES: 0,
    DRY_RUN_OK: 0,
    VALIDATION_FAILED: 1,
    CANDIDATE_CHANGED: 3,
    LAUNCH_RULES_MISSING: 3,
    LAUNCH_CONFIRMATION_REQUIRED: 3,
    CATALOG_LOCKED: 3,
    AUTHORED_LOCKED: 3,
    LOCK_LOST: 3,
    DATA_ROOT_NOT_READY: 3,
    INTEGRITY_MISMATCH: 4,
    STORAGE_ERROR: 4,
};

export const CATALOG_LEASE_MS = 60_000;

/** One JSON line per event, as `catalog.publish.started` and the rest. */
export interface CatalogLogger {
    log(line: string): void;
}

export interface PublishHooks {
    /** Runs after each numbered step. A test throws here to crash the publish at that point. */
    afterStep?(step: number): void | Promise<void>;
    /** Passed to the catalog lock, so a test can pause renewals. */
    lock?: LockHooks;
}

export interface PublishOptions {
    dataRoot: string;
    actor: string;
    /** Defaults to `publish`. */
    reason?: string;
    confirmLaunch?: boolean;
    /** #16's candidate ID: stop with CANDIDATE_CHANGED unless the candidate gets it. */
    expectedRevisionId?: string;
    reprofile?: boolean;
    dryRun?: boolean;
    hooks?: PublishHooks;
    logger?: CatalogLogger;
    clock?: () => number;
    /** The catalog lock's lease. Tests shorten it. */
    leaseMs?: number;
    /** The rules a first activation needs registered. Defaults to #8's launch order rules. */
    launchRuleIds?: readonly string[];
    /** #10's current profile, for tests. */
    profileId?: string;
    /** How long steps 1, 2, and 13 wait for the authored lock. Tests shorten it. */
    authoredWaitMs?: number;
}

/** What a first publish replaces, for its confirmation and its dry run. */
export interface LaunchImpact {
    /** Photographs the candidate publishes. */
    published: number;
    /** Photographs #10 knows, with a present source, that the candidate leaves out. They leave the site at launch. */
    gone: number;
}

export interface PublishResult {
    outcome: PublishOutcome;
    message: string;
    candidateId: string | null;
    /** The active revision when the publish ended. */
    revisionId: string | null;
    revisionNumber: number | null;
    activationId: string | null;
    issues: Issue[];
    errors: number;
    warnings: number;
    /** For CATALOG_LOCKED and AUTHORED_LOCKED. */
    holder?: LockRecord | null;
    /** For LAUNCH_RULES_MISSING. */
    missingRules?: string[];
    /** Before the first activation. */
    launch?: LaunchImpact;
    reprofiled?: CompileResult['reprofiled'];
    /** False when step 13 couldn't get the authored lock. The next publish's recovery rebases. */
    rebased?: boolean;
    recovery?: RecoveryReport;
}

export interface RecoveryReport {
    /** The pending activation active.json names, now committed. */
    committed: string | null;
    abandoned: string[];
    /** A repair activation for a pointer that named an abandoned or missing one. */
    repaired: string | null;
    rebased: RebaseReport | null;
}

class Stop extends Error {
    constructor(readonly outcome: PublishOutcome, message: string, readonly details: Partial<PublishResult> = {}) {
        super(message);
    }
}

const jsonLogger: CatalogLogger = { log: (line) => console.log(line) };

function logEvent(logger: CatalogLogger, event: string, fields: Record<string, unknown>): void {
    logger.log(JSON.stringify({ event, ...fields }));
}

const iso = (ms: number) => new Date(ms).toISOString();
const photographs = (count: number) => `${count} ${count === 1 ? 'photograph' : 'photographs'}`;
const digestOf = (issues: readonly Issue[]) => createHash('sha256').update(canonicalJson(issues)).digest('hex');
const countOf = (issues: readonly Issue[], severity: Issue['severity']) => issues.filter((issue) => issue.severity === severity).length;

function assertCatalogHold(lock: LockContext, root: string): void {
    if (lock.name !== CATALOG_LOCK || path.resolve(lock.root) !== path.resolve(root) || lock.signal.aborted) {
        throw new Error('This needs a live hold on this data root\'s catalog lock.');
    }
}

interface CommitInput {
    root: string;
    lock: LockContext;
    revisionId: string;
    kind: Activation['kind'];
    actor: string;
    reason: string;
    validation: Activation['validation'];
    acceptedRules: string[];
    lockTakeover: Activation['lockTakeover'];
    clock: () => number;
    afterStep?: (step: number) => void | Promise<void>;
}

type CommitResult = { ok: true; activation: Activation } | { ok: false; outcome: 'LOCK_LOST'; message: string };

/**
 * Steps 10 to 12: write the pending activation, point `active.json` at its
 * revision if this process still holds the catalog lock, and mark it
 * committed. The only production writer of `active.json`. A crash between
 * them leaves a pending activation that recover() commits or abandons.
 */
async function commitActivation(input: CommitInput): Promise<CommitResult> {
    const { root, lock, clock, afterStep } = input;
    const activations = await listActivations(root);
    const pointer = await readActivePointer(root);
    const previous = pointer ? activations.find((activation) => activation.activationId === pointer.activationId) ?? null : null;
    const pending: Activation = {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        activationId: `act_${randomUUID()}`,
        sequence: nextSequence(activations),
        kind: input.kind,
        status: 'pending',
        revisionId: input.revisionId,
        revisionNumber: revisionNumberFor(activations, input.revisionId),
        previousRevisionId: pointer?.revisionId ?? null,
        previousActivationId: previous?.activationId ?? null,
        actor: input.actor,
        reason: input.reason,
        startedAt: iso(clock()),
        validation: input.validation,
        acceptedRules: input.acceptedRules,
        lockTakeover: input.lockTakeover,
    };
    await writeActivation(root, pending);
    await afterStep?.(10);

    if (lock.signal.aborted || !(await lock.isHeld())) {
        return { ok: false, outcome: 'LOCK_LOST', message: 'Another process took over the catalog lock, so nothing was activated. The next publish abandons the pending activation.' };
    }
    await writeActivePointer(root, { schemaVersion: CATALOG_SCHEMA_VERSION, revisionId: pending.revisionId, activationId: pending.activationId });
    await afterStep?.(11);

    const committed: Activation = { ...pending, status: 'committed', committedAt: iso(clock()) };
    await writeActivation(root, committed);
    await afterStep?.(12);
    return { ok: true, activation: committed };
}

/** Run every rule over a stored revision, as a rollback or a repair records it. */
function validateStored(root: string, revision: RevisionFile, registry: Registry | null): Activation['validation'] {
    const issues = runRules({ candidate: revision.content, authored: null, active: revision, registry, roots: { dataRoot: root, libraryRoot: libraryRoot() } });
    return { rulesetVersion: rulesetVersion(), errors: countOf(issues, 'error'), warnings: countOf(issues, 'warning'), diagnosticsDigest: digestOf(issues) };
}

export interface RecoverOptions {
    dataRoot: string;
    /** The catalog lock the caller holds. */
    lock: LockContext;
    logger?: CatalogLogger;
    clock?: () => number;
    /** Rebase the working layer when it is on another base. Defaults to true. */
    rebase?: boolean;
    /** How long the rebase waits for the authored lock. */
    authoredWaitMs?: number;
}

/**
 * Settle an interrupted activation, under the caller's catalog hold: commit
 * the pending activation `active.json` names and abandon every other pending
 * one. If `active.json` names an abandoned or missing activation, record a
 * repair activation for its revision through commitActivation(). Then rebase
 * the working layer onto the active revision if any record is on another
 * base. Throws LockTimeoutError when that rebase can't get the authored lock.
 */
export async function recover(options: RecoverOptions): Promise<RecoveryReport> {
    const root = path.resolve(options.dataRoot);
    const { lock, logger = jsonLogger, clock = Date.now } = options;
    assertCatalogHold(lock, root);
    const report: RecoveryReport = { committed: null, abandoned: [], repaired: null, rebased: null };
    const pointer = await readActivePointer(root);
    let activations = await listActivations(root);
    for (const activation of activations.filter((entry) => entry.status === 'pending')) {
        const named = pointer !== null && activation.activationId === pointer.activationId && activation.revisionId === pointer.revisionId;
        if (named) {
            await writeActivation(root, { ...activation, status: 'committed', committedAt: iso(clock()) });
            report.committed = activation.activationId;
        } else {
            await writeActivation(root, { ...activation, status: 'abandoned' });
            report.abandoned.push(activation.activationId);
        }
    }
    if (report.committed || report.abandoned.length) activations = await listActivations(root);

    if (pointer !== null) {
        const named = activations.find((activation) => activation.activationId === pointer.activationId);
        if (!named || named.status !== 'committed' || named.revisionId !== pointer.revisionId) {
            const revision = await readRevisionFile(root, pointer.revisionId);
            if (revision === null) throw new CatalogIntegrityError('catalog/active.json', `catalog/active.json names ${pointer.revisionId}, which has no revision file.`);
            const registry = await readRegistry(root).catch(() => null);
            const result = await commitActivation({
                root,
                lock,
                revisionId: pointer.revisionId,
                kind: 'publish',
                actor: 'recover',
                reason: named ? `repair: active.json named the ${named.status} activation ${named.activationId}` : `repair: active.json named the missing activation ${pointer.activationId}`,
                validation: validateStored(root, revision, registry),
                acceptedRules: [],
                lockTakeover: lock.takeover,
                clock,
            });
            if (!result.ok) throw new Error(result.message);
            report.repaired = result.activation.activationId;
            logEvent(logger, 'catalog.recover.repaired', { activationId: result.activation.activationId, revisionId: pointer.revisionId, replaced: pointer.activationId });
        }
    }

    const active = await readActivePointer(root);
    if (active !== null && options.rebase !== false) {
        const layer = await readWorkingLayer(root);
        const behind = [layer.site, ...layer.series, ...layer.photos].some((record) => record !== null && record.baseRevisionId !== active.revisionId);
        if (behind) report.rebased = await rebaseWorkingLayer({ root, targetRevisionId: active.revisionId, waitMs: options.authoredWaitMs });
    }
    return report;
}

interface Snapshot {
    layer: WorkingLayer;
    registry: Registry;
    pointer: ActivePointer | null;
    active: RevisionFile | null;
    compiled: CompileResult;
}

/**
 * Steps 2 and 3 without the writes: the working layer, read under the
 * authored lock so no tool write lands halfway, #10's registry, the active
 * revision, and the compiled candidate. Throws Stop for a busy working layer
 * and CatalogIntegrityError for a pointer to a missing revision.
 */
async function snapshotAndCompile(root: string, options: { authoredWaitMs?: number; reprofile?: boolean; profileId?: string }): Promise<Snapshot> {
    let layer: WorkingLayer;
    try {
        layer = await withLock(AUTHORED_LOCK, { root, leaseMs: AUTHORED_LEASE_MS, waitMs: options.authoredWaitMs ?? AUTHORED_WAIT_MS }, () => readWorkingLayer(root));
    } catch (error) {
        if (error instanceof LockTimeoutError) throw new Stop('AUTHORED_LOCKED', error.message, { holder: error.holder });
        throw error;
    }
    const registry = await readRegistry(root);
    const pointer = await readActivePointer(root);
    const active = pointer ? await readRevisionFile(root, pointer.revisionId) : null;
    if (pointer && active === null) throw new CatalogIntegrityError('catalog/active.json', `catalog/active.json names ${pointer.revisionId}, which has no revision file.`);
    const compiled = await compileCandidate({ layer, registry, root, active, reprofile: options.reprofile, profileId: options.profileId });
    return { layer, registry, pointer, active, compiled };
}

function ruleContext(root: string, snapshot: Snapshot) {
    return {
        candidate: snapshot.compiled.content,
        authored: snapshot.layer,
        active: snapshot.active,
        registry: snapshot.registry,
        roots: { dataRoot: root, libraryRoot: libraryRoot() },
        excluded: snapshot.compiled.excluded,
    };
}

export type ValidateOutcome = 'VALID' | 'VALIDATION_FAILED' | 'AUTHORED_LOCKED' | 'DATA_ROOT_NOT_READY' | 'INTEGRITY_MISMATCH' | 'STORAGE_ERROR';

export const VALIDATE_EXIT_CODES: Record<ValidateOutcome, 0 | 1 | 3 | 4> = {
    VALID: 0,
    VALIDATION_FAILED: 1,
    AUTHORED_LOCKED: 3,
    DATA_ROOT_NOT_READY: 3,
    INTEGRITY_MISMATCH: 4,
    STORAGE_ERROR: 4,
};

export interface ValidateResult {
    outcome: ValidateOutcome;
    message: string;
    candidateId: string | null;
    issues: Issue[];
    errors: number;
    warnings: number;
    holder?: LockRecord | null;
}

/**
 * `photos:validate`: compile the working layer and run every rule, as
 * publish's steps 2, 3, and 6 do, without the catalog lock and without
 * writing anything. Warnings alone pass.
 */
export async function validateWorkingLayer(options: { dataRoot: string; reprofile?: boolean; profileId?: string; authoredWaitMs?: number }): Promise<ValidateResult> {
    const root = path.resolve(options.dataRoot);
    const result: ValidateResult = { outcome: 'STORAGE_ERROR', message: '', candidateId: null, issues: [], errors: 0, warnings: 0 };
    const status = dataRootStatus({ root });
    if (status.state !== 'ready') return { ...result, outcome: 'DATA_ROOT_NOT_READY', message: `The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}.` };
    try {
        const snapshot = await snapshotAndCompile(root, options);
        const issues = runRules(ruleContext(root, snapshot));
        const errors = countOf(issues, 'error');
        const warnings = countOf(issues, 'warning');
        const counts = `${errors} ${errors === 1 ? 'error' : 'errors'} and ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`;
        return {
            outcome: errors > 0 ? 'VALIDATION_FAILED' : 'VALID',
            message: errors > 0 ? `The working layer has ${counts}.` : `The working layer passes, with ${counts}.`,
            candidateId: snapshot.compiled.candidateId,
            issues,
            errors,
            warnings,
        };
    } catch (error) {
        if (error instanceof Stop) return { ...result, outcome: error.outcome as ValidateOutcome, message: error.message, holder: error.details.holder };
        if (error instanceof CatalogIntegrityError) return { ...result, outcome: 'INTEGRITY_MISMATCH', message: error.message };
        return { ...result, outcome: 'STORAGE_ERROR', message: error instanceof Error ? error.message : String(error) };
    }
}

export interface ActivateOptions {
    /** The catalog lock the caller holds. */
    lock: LockContext;
    dataRoot: string;
    revisionId: string;
    /** Return ACTIVE_CHANGED, writing nothing, unless this revision is active. */
    expectedActiveRevisionId: string;
    kind: Activation['kind'];
    actor: string;
    reason: string;
    /** Editorial rules a #15 rollback accepted. */
    acceptedRules?: string[];
    lockTakeover?: Activation['lockTakeover'];
    hooks?: Pick<PublishHooks, 'afterStep'>;
    clock?: () => number;
}

export interface ActivateResult {
    outcome: ActivateOutcome;
    message: string;
    activation: Activation | null;
}

/**
 * Point `active.json` at a stored revision through commitActivation(), under
 * the caller's catalog hold: #15's rollback, and later reactivations. Refuses
 * with NOTHING_ACTIVE before the first activation, and returns
 * ACTIVE_CHANGED, writing nothing, if `expectedActiveRevisionId` isn't the
 * active revision. The caller rebases the working layer afterwards.
 */
export async function activateRevision(options: ActivateOptions): Promise<ActivateResult> {
    const root = path.resolve(options.dataRoot);
    const { lock, clock = Date.now } = options;
    assertCatalogHold(lock, root);
    assertActorAndReason(options.actor, options.reason);
    const pointer = await readActivePointer(root);
    if (pointer === null || lastCommitted(await listActivations(root)) === null) {
        return { outcome: 'NOTHING_ACTIVE', message: 'Nothing is active yet, so there is nothing to roll back from. Publish first.', activation: null };
    }
    if (pointer.revisionId !== options.expectedActiveRevisionId) {
        return { outcome: 'ACTIVE_CHANGED', message: `${pointer.revisionId} is active, not ${options.expectedActiveRevisionId}. Nothing was activated.`, activation: null };
    }
    let revision: RevisionFile | null;
    try {
        revision = await readRevisionFile(root, options.revisionId);
    } catch (error) {
        if (error instanceof CatalogIntegrityError) return { outcome: 'INTEGRITY_MISMATCH', message: error.message, activation: null };
        throw error;
    }
    if (revision === null) return { outcome: 'INTEGRITY_MISMATCH', message: `${options.revisionId} has no revision file.`, activation: null };
    const registry = await readRegistry(root).catch(() => null);
    const result = await commitActivation({
        root,
        lock,
        revisionId: revision.revisionId,
        kind: options.kind,
        actor: options.actor,
        reason: options.reason,
        validation: validateStored(root, revision, registry),
        acceptedRules: options.acceptedRules ?? [],
        lockTakeover: options.lockTakeover ?? lock.takeover,
        clock,
        afterStep: options.hooks?.afterStep,
    });
    if (!result.ok) return { outcome: result.outcome, message: result.message, activation: null };
    return { outcome: 'ACTIVATED', message: `Activated ${revision.revisionId} as revision ${result.activation.revisionNumber}.`, activation: result.activation };
}

/** What a first activation takes away: present photographs #10 knows that the candidate doesn't publish. */
function launchImpact(registry: Registry, published: number, publishedIds: ReadonlySet<string>): LaunchImpact {
    const gone = Object.values(registry.photos).filter((photo) => photo.sourceHealth === 'present' && !publishedIds.has(photo.photoId)).length;
    return { published, gone };
}

/** Who and why, which every activation records. Blank ones are a caller's bug. */
function assertActorAndReason(actor: string, reason: string): void {
    if (!/\S/.test(actor)) throw new TypeError('An activation needs an actor.');
    if (!/\S/.test(reason)) throw new TypeError('An activation needs a reason.');
}

/** Publish the working layer. Never throws for an expected stop; see PublishOutcome. */
export async function publish(options: PublishOptions): Promise<PublishResult> {
    const root = path.resolve(options.dataRoot);
    const { actor, confirmLaunch = false, dryRun = false, hooks = {}, logger = jsonLogger, clock = Date.now } = options;
    const reason = options.reason ?? 'publish';
    assertActorAndReason(actor, reason);
    const result: PublishResult = { outcome: 'STORAGE_ERROR', message: '', candidateId: null, revisionId: null, revisionNumber: null, activationId: null, issues: [], errors: 0, warnings: 0 };
    const finish = async (outcome: PublishOutcome, message: string, details: Partial<PublishResult> = {}): Promise<PublishResult> => {
        Object.assign(result, details, { outcome, message });
        try {
            const pointer = await readActivePointer(root);
            if (pointer && result.revisionId === null) {
                result.revisionId = pointer.revisionId;
                result.revisionNumber = (await listActivations(root)).find((activation) => activation.activationId === pointer.activationId)?.revisionNumber ?? null;
            }
        } catch {
            // The outcome already says what went wrong.
        }
        try {
            await writeLastPublish(root, {
                schemaVersion: CATALOG_SCHEMA_VERSION,
                outcome,
                at: iso(clock()),
                actor,
                candidateId: result.candidateId,
                revisionId: result.revisionId,
                revisionNumber: result.revisionNumber,
                errors: result.errors,
                warnings: result.warnings,
                message,
            });
        } catch {
            // A summary that can't be written changes nothing about the publish.
        }
        const fields = { outcome, candidateId: result.candidateId, revisionId: result.revisionId, revisionNumber: result.revisionNumber, activationId: result.activationId };
        if (outcome === 'PUBLISHED') logEvent(logger, 'catalog.publish.activated', fields);
        else if (PUBLISH_EXIT_CODES[outcome] !== 0) logEvent(logger, 'catalog.publish.failed', fields);
        return result;
    };

    const status = dataRootStatus({ write: true, root });
    if (status.state !== 'ready') return finishWithoutRoot('DATA_ROOT_NOT_READY', `The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}.`, result, logger);
    logEvent(logger, 'catalog.publish.started', { actor, reason, dryRun });

    try {
        return await withLock(CATALOG_LOCK, { root, leaseMs: options.leaseMs ?? CATALOG_LEASE_MS, waitMs: 0, hooks: hooks.lock }, async (lock) => {
            const step = async (number: number) => hooks.afterStep?.(number);
            if (lock.takeover) logEvent(logger, 'catalog.lock.takeover', { lock: CATALOG_LOCK, ...lock.takeover });

            // 1. Recover.
            try {
                result.recovery = await recover({ dataRoot: root, lock, logger, clock, authoredWaitMs: options.authoredWaitMs });
            } catch (error) {
                if (error instanceof LockTimeoutError) throw new Stop('AUTHORED_LOCKED', error.message, { holder: error.holder });
                throw error;
            }
            await step(1);

            // 2. Snapshot the working layer and the registry, and compile them.
            const snapshot = await snapshotAndCompile(root, options);
            const { layer, registry, pointer, compiled } = snapshot;
            await step(2);

            // 3. Write the candidate, for #16.
            result.candidateId = compiled.candidateId;
            result.reprofiled = compiled.reprofiled;
            const compiledAt = iso(clock());
            const candidate = candidateFile(compiled, { baseRevisionId: pointer?.revisionId ?? null, compiledAt });
            await writeCandidate(root, candidate);
            await step(3);

            // 4. The candidate the caller reviewed.
            if (options.expectedRevisionId !== undefined && options.expectedRevisionId !== compiled.candidateId) {
                throw new Stop('CANDIDATE_CHANGED', `The working layer compiles to ${compiled.candidateId}, not ${options.expectedRevisionId}. Review the new candidate first.`);
            }
            await step(4);

            // 5. Already active.
            if (pointer?.revisionId === compiled.candidateId) throw new Stop('NO_CHANGES', `${compiled.candidateId} is already active.`);
            await step(5);

            // 6. Validate.
            const issues = runRules(ruleContext(root, snapshot));
            const errors = countOf(issues, 'error');
            const warnings = countOf(issues, 'warning');
            const ruleset = rulesetVersion();
            Object.assign(result, { issues, errors, warnings });
            await writeDiagnostics(root, { schemaVersion: CATALOG_SCHEMA_VERSION, candidateId: compiled.candidateId, rulesetVersion: ruleset, checkedAt: iso(clock()), errors, warnings, issues });
            logEvent(logger, 'catalog.publish.validated', { candidateId: compiled.candidateId, errors, warnings, rulesetVersion: ruleset });
            if (errors > 0) throw new Stop('VALIDATION_FAILED', `${errors} ${errors === 1 ? 'error blocks' : 'errors block'} the publish.`);
            await step(6);

            // 7. The first activation replaces the legacy site.
            const activations = await listActivations(root);
            if (lastCommitted(activations) === null) {
                const registered = new Set(registeredRules().map((rule) => rule.id));
                const missingRules = (options.launchRuleIds ?? LAUNCH_ORDER_RULE_IDS).filter((id) => !registered.has(id));
                if (missingRules.length > 0) throw new Stop('LAUNCH_RULES_MISSING', `The first publish needs these rules registered: ${missingRules.join(', ')}.`, { missingRules });
                result.launch = launchImpact(registry, compiled.content.photos.length, new Set(compiled.content.photos.map((photo) => photo.id)));
                if (!confirmLaunch && !dryRun) {
                    const { published, gone } = result.launch;
                    const leaving = gone > 0 ? `, and ${photographs(gone)} in the library ${gone === 1 ? 'leaves' : 'leave'} the site` : '';
                    throw new Stop('LAUNCH_CONFIRMATION_REQUIRED', `This is the first publish: ${photographs(published)} ${published === 1 ? 'replaces' : 'replace'} the legacy Home and Gallery${leaving}. Confirm the launch to go ahead.`);
                }
            }
            await step(7);

            // 8. A dry run stops here.
            if (dryRun) throw new Stop('DRY_RUN_OK', `${compiled.candidateId} passes validation. Nothing was written but the candidate and its diagnostics.`);
            await step(8);

            // 9. The revision file, written once.
            const parsed = parseRevisionFile({ revisionId: compiled.candidateId, schemaVersion: CATALOG_SCHEMA_VERSION, baseRevisionId: pointer?.revisionId ?? null, compiledAt, content: compiled.content });
            if (!parsed.ok) throw new Error(`The candidate passed validation but isn't a valid revision: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
            await writeRevisionIfAbsent(root, parsed.value);
            await step(9);

            // 10 to 12. Activate.
            const committed = await commitActivation({
                root,
                lock,
                revisionId: compiled.candidateId,
                kind: 'publish',
                actor,
                reason,
                validation: { rulesetVersion: ruleset, errors, warnings, diagnosticsDigest: digestOf(issues) },
                acceptedRules: [],
                lockTakeover: lock.takeover,
                clock,
                afterStep: step,
            });
            if (!committed.ok) throw new Stop('LOCK_LOST', committed.message);
            Object.assign(result, { revisionId: committed.activation.revisionId, revisionNumber: committed.activation.revisionNumber, activationId: committed.activation.activationId });

            // 13. Rebase onto the new revision, merging against the snapshot.
            try {
                await rebaseWorkingLayer({ root, targetRevisionId: compiled.candidateId, snapshot: layer, registry, waitMs: options.authoredWaitMs });
                result.rebased = true;
            } catch (error) {
                if (!(error instanceof LockTimeoutError)) throw error;
                result.rebased = false;
            }
            await step(13);
            const rebaseNote = result.rebased ? '' : ' The working layer was busy, so the next publish rebases it.';
            return finish('PUBLISHED', `Published ${compiled.candidateId} as revision ${committed.activation.revisionNumber}.${rebaseNote}`);
        });
    } catch (error) {
        if (error instanceof Stop) return finish(error.outcome, error.message, error.details);
        if (error instanceof LockTimeoutError) {
            const who = error.holder ? `${error.holder.owner} (pid ${error.holder.pid} on ${error.holder.hostname}, since ${error.holder.acquiredAt})` : 'another process';
            return finish('CATALOG_LOCKED', `Another publish holds the catalog lock: ${who}.`, { holder: error.holder });
        }
        if (error instanceof CatalogIntegrityError) return finish('INTEGRITY_MISMATCH', error.message);
        // After step 11 the new revision is live even though the publish didn't finish.
        const pointer = await readActivePointer(root).catch(() => null);
        const live = pointer !== null && pointer.revisionId === result.candidateId ? await liveNote(root, pointer) : '';
        return finish('STORAGE_ERROR', `${error instanceof Error ? error.message : String(error)}${live}`);
    }
}

async function liveNote(root: string, pointer: ActivePointer): Promise<string> {
    const activation = (await listActivations(root).catch(() => [])).find((entry) => entry.activationId === pointer.activationId);
    return ` ${pointer.revisionId}${activation ? `, revision ${activation.revisionNumber},` : ''} is live.`;
}

/** A stop before the data root can hold `last-publish.json`. */
function finishWithoutRoot(outcome: PublishOutcome, message: string, result: PublishResult, logger: CatalogLogger): PublishResult {
    Object.assign(result, { outcome, message });
    logEvent(logger, 'catalog.publish.failed', { outcome });
    return result;
}

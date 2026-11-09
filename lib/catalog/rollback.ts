import path from 'node:path';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { dataRootStatus } from '../storage/config';
import type { VersionedWriteHooks } from '../storage/document';
import { LockTimeoutError, MAX_LEASE_MS, withLock, type LockContext, type LockHooks, type LockRecord } from '../storage/lock';
import { errorText } from './error-text';
import { changesBetween, historyState, knownGood, type RevisionChanges } from './history';
import { activateRevision, blockingIssues, CATALOG_LEASE_MS, rebaseWorkingLayer, recover, validateStored, type CatalogLogger, type RebaseReport, type RecoveryReport } from './publish';
import { assertRevisionId, CATALOG_LOCK, CatalogIntegrityError, listActivations, readRevisionFile } from './repository';
import { registeredRules } from './ruleset';
import type { Activation, Issue, RevisionContent, RevisionFile } from './types';
import { damagedText, recordedVerifyFailure, type RecordedVerifyFailure, type VerifyRecordRead } from './verify';
import { readActivePointer } from './working-layer';

export { errorText };

/**
 * #15's rollback: make a revision that was active before the active one
 * again, as a new activation.
 *
 * planRollback() reads without a lock and writes nothing: the target, the
 * active revision, what the target brings back or removes against it, and
 * whether the target may go live. rollback() then takes the catalog lock,
 * waiting up to `waitMs` for a holder and taking a lease over only once it
 * has expired, plans again under it, and activates the target through
 * #13's activateRevision(), which settles an interrupted activation first
 * and moves the pointer only while `expectedActiveRevisionId` is still
 * active. Last it rebases the working layer onto the target under the
 * authored lock, and a crash before that leaves it to the next publish's
 * recover().
 *
 * The target must have been active before, and every rule runs on its
 * stored revision: an error from an `integrity` rule blocks it, the asset
 * and privacy rules included, so a rollback can't bring back a set that
 * broke or a published string the rules now refuse. Errors from `editorial`
 * rules print with the plan, and #117 makes the caller accept each one: a
 * rollback without an accept for every flagged rule ends
 * ACCEPTANCE_REQUIRED and writes nothing. The activation records exactly the
 * flagged rules in `acceptedRules`, never an accept for a rule that isn't
 * flagged.
 *
 * #181's A7: a target `status/verify.json` records a failed `photos verify`
 * for, or any target while that record can't be read, ends VERIFY_FAILED and
 * writes nothing, as rollbackReadiness() reads the record. Only the CLI's
 * `--accept verify.failed` brings it back, as the typed `verifyOverride`,
 * which only runRollbackCommand() sets: the string in `acceptedRules` does
 * nothing, so no other caller gets the override by passing it. The
 * activation records VERIFY_FAILED_ACCEPT after the editorial accepts. A
 * passing `photos verify --revision <id>` clears the entry. No record at
 * all refuses nothing (#117).
 *
 * The rollback copies, edits, renumbers, and erases nothing: the target
 * keeps the number it first went live under.
 */

export type RollbackOutcome =
    | 'READY'
    | 'ROLLED_BACK'
    | 'NO_CHANGES'
    | 'NOT_ELIGIBLE'
    | 'VALIDATION_FAILED'
    | 'ACCEPTANCE_REQUIRED'
    | 'VERIFY_FAILED'
    | 'CONFIRMATION_REQUIRED'
    | 'DECLINED'
    | 'NOTHING_ACTIVE'
    | 'ACTIVE_CHANGED'
    | 'CATALOG_LOCKED'
    | 'LOCK_LOST'
    | 'DATA_ROOT_NOT_READY'
    | 'INTEGRITY_MISMATCH'
    | 'STORAGE_ERROR';

/** The CLI's exit codes, #13's: 1 for a target that may not go live (or not without an accept, VERIFY_FAILED included), 4 for a damaged file or I/O, 3 for any other stop. Usage errors, 2, are the CLI's own. */
export const ROLLBACK_EXIT_CODES: Record<RollbackOutcome, 0 | 1 | 3 | 4> = {
    READY: 0,
    ROLLED_BACK: 0,
    NO_CHANGES: 0,
    NOT_ELIGIBLE: 1,
    VALIDATION_FAILED: 1,
    ACCEPTANCE_REQUIRED: 1,
    VERIFY_FAILED: 1,
    CONFIRMATION_REQUIRED: 3,
    DECLINED: 3,
    NOTHING_ACTIVE: 3,
    ACTIVE_CHANGED: 3,
    CATALOG_LOCKED: 3,
    LOCK_LOST: 3,
    DATA_ROOT_NOT_READY: 3,
    INTEGRITY_MISMATCH: 4,
    STORAGE_ERROR: 4,
};

/** The accept that overrides a recorded `photos verify` failure. The CLI's alone: History drops it from a post. */
export const VERIFY_FAILED_ACCEPT = 'verify.failed';

/** How long a rollback waits for another command's catalog lock. */
export const ROLLBACK_WAIT_MS = 30_000;

/** `--to`: a revision number from `photos history`, or a revision ID. */
export type RollbackTarget = { revisionNumber: number } | { revisionId: string };

export interface RevisionRef {
    revisionId: string;
    /** Null only for an active revision no record numbers, which recover() repairs. */
    revisionNumber: number | null;
}

export interface RollbackPlan {
    outcome: RollbackOutcome;
    message: string;
    target: RevisionRef | null;
    active: RevisionRef | null;
    /**
     * What the target brings back, removes, and changes against the active
     * revision. When the active revision can't be read, everything the target
     * publishes counts as brought back.
     */
    impact: RevisionChanges | null;
    /** Why the active revision's file can't be read. The rollback still plans, since moving off it is what a rollback is for. */
    activeProblem?: string;
    /** Series titles from both revisions, by ID, for the impact list. */
    seriesTitles: Record<string, string>;
    /** Every issue on the stored target, the blocking ones first. */
    issues: Issue[];
    /** The errors that keep the target from going live. */
    blocking: Issue[];
    /** The editorial rules with errors on the target, which a rollback brings back only when each one is accepted. */
    editorial: string[];
    /**
     * VERIFY_FAILED's cause: the record's failed entry for the target, or a
     * record that can't be read. Null when the record refuses nothing, and
     * on every plan that stopped before it was read.
     */
    verify: RecordedVerifyFailure | null;
}

export interface RollbackHooks {
    /** Runs after activateRevision()'s steps 10 to 12 and after the rebase, 13. A test throws here to crash the rollback. */
    afterStep?(step: number): void | Promise<void>;
    /** Runs once the catalog lock is held, before the plan under it (#181's fault matrix). */
    afterLock?(): void | Promise<void>;
    /** Runs once the plan under the lock and its accepts pass, before the pending record. */
    afterEligibility?(plan: RollbackPlan): void | Promise<void>;
    lock?: LockHooks;
    /** Passed to step 11's pointer write: its temp, its link, and ENOSPC on it. */
    pointer?: VersionedWriteHooks;
}

export interface RollbackOptions {
    dataRoot: string;
    revisionId: string;
    /** The active revision the curator confirmed against. The rollback writes nothing if another one is active. */
    expectedActiveRevisionId: string;
    actor: string;
    reason: string;
    /**
     * The editorial rule IDs the curator accepts. Every rule flagged on the
     * target must be here, or the rollback ends ACCEPTANCE_REQUIRED and writes
     * nothing. None by default, so a caller that names none is refused.
     */
    acceptedRules?: readonly string[];
    /**
     * #181's A7: go on past a recorded `photos verify` failure, or a record
     * that can't be read. `photos rollback --accept verify.failed` is the only
     * caller that sets it. VERIFY_FAILED_ACCEPT in `acceptedRules` is ignored.
     */
    verifyOverride?: boolean;
    hooks?: RollbackHooks;
    logger?: CatalogLogger;
    clock?: () => number;
    leaseMs?: number;
    /** How long to wait for another command's catalog lock. Defaults to ROLLBACK_WAIT_MS. */
    waitMs?: number;
    /** How long the rebase waits for the authored lock. */
    authoredWaitMs?: number;
}

export interface RollbackResult {
    outcome: RollbackOutcome;
    message: string;
    /** The plan made under the lock, once it got that far. */
    plan: RollbackPlan | null;
    activation: Activation | null;
    /** False when the rebase couldn't get the authored lock. The next publish rebases. */
    rebased?: boolean;
    /** The working-layer conflicts the rebase raised, which stop the next publish until they're settled. */
    conflicts?: RebaseReport['conflicts'];
    holder?: LockRecord | null;
    recovery?: RecoveryReport;
    issues: Issue[];
    /** ACCEPTANCE_REQUIRED: the flagged editorial rules the caller didn't accept. */
    unaccepted?: string[];
}

const jsonLogger: CatalogLogger = { log: (line) => console.log(line) };
const logEvent = (logger: CatalogLogger, event: string, fields: Record<string, unknown>) => logger.log(JSON.stringify({ event, ...fields }));
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
const EMPTY_CONTENT: RevisionContent = { site: { featuredSeriesIds: [] }, series: [], photos: [] };

/** What a rebase's conflicts mean for the owner, or nothing when it raised none. */
function conflictNote(conflicts: RebaseReport['conflicts'] | undefined): string {
    const n = conflicts?.length ?? 0;
    if (n === 0) return '';
    return ` The rebase raised ${n} working-layer ${n === 1 ? 'conflict' : 'conflicts'}, so the next publish stops until ${n === 1 ? "it's" : "they're"} settled.`;
}

const named = (ref: RevisionRef) => (ref.revisionNumber === null ? ref.revisionId : `revision ${ref.revisionNumber} (${ref.revisionId})`);

function emptyPlan(outcome: RollbackOutcome, message: string, fields: Partial<RollbackPlan> = {}): RollbackPlan {
    return { outcome, message, target: null, active: null, impact: null, seriesTitles: {}, issues: [], blocking: [], editorial: [], verify: null, ...fields };
}

/** A stored revision, or the plan that stops because it can't be read. */
async function stored(root: string, revisionId: string): Promise<RevisionFile | RollbackPlan> {
    try {
        const revision = await readRevisionFile(root, revisionId);
        return revision ?? emptyPlan('INTEGRITY_MISMATCH', `${revisionId} has no revision file. Nothing was rolled back.`);
    } catch (error) {
        if (error instanceof CatalogIntegrityError) return emptyPlan('INTEGRITY_MISMATCH', `${sentence(error.message)} Nothing was rolled back.`);
        throw error;
    }
}

/** The rule IDs whose errors a rollback brings back once they're accepted, one by one. Every other rule's error blocks it. */
export function editorialRuleIds(): Set<string> {
    return new Set(registeredRules().filter((rule) => rule.rollbackClass === 'editorial').map((rule) => rule.id));
}

/** The editorial rules flagged on the plan's target that `accepted` doesn't name, sorted. */
export function unacceptedRules(plan: Pick<RollbackPlan, 'editorial'>, accepted: readonly string[]): string[] {
    const given = new Set(accepted);
    return plan.editorial.filter((rule) => !given.has(rule)).sort();
}

/**
 * Whether the plan's acceptances hold: null when every flagged editorial
 * rule is accepted, ACCEPTANCE_REQUIRED when any isn't, whatever else the
 * plan says, and STORAGE_ERROR for a READY plan that names no target, which
 * planRollback() never returns, so the rollback fails closed on it.
 */
export function acceptanceCheck(plan: Pick<RollbackPlan, 'editorial' | 'target'>, accepted: readonly string[], revisionId: string): { outcome: 'ACCEPTANCE_REQUIRED'; message: string; unaccepted: string[] } | { outcome: 'STORAGE_ERROR'; message: string } | null {
    const unaccepted = unacceptedRules(plan, accepted);
    if (unaccepted.length > 0) return { outcome: 'ACCEPTANCE_REQUIRED', message: acceptanceMessage(plan.target ?? { revisionId, revisionNumber: null }, unaccepted), unaccepted };
    if (plan.target === null) return { outcome: 'STORAGE_ERROR', message: `The rollback's plan for ${revisionId} names no target. Nothing was rolled back.` };
    return null;
}

/** ACCEPTANCE_REQUIRED's message, which the CLI prints as it is. */
export function acceptanceMessage(target: RevisionRef, unaccepted: readonly string[]): string {
    // "Revision 3 (rev_…)" leads the sentence; a bare revision ID keeps its lower-case prefix.
    const name = target.revisionNumber === null ? target.revisionId : `Revision ${target.revisionNumber} (${target.revisionId})`;
    return `${name} has editorial errors a rollback brings back only when you accept each one: ${unaccepted.join(', ')}. Run it again with ${unaccepted.map((rule) => `--accept ${rule}`).join(' ')}. Nothing was rolled back.`;
}

/**
 * What rolling back to `to` would do, read without a lock and writing
 * nothing. READY when the target may go live; otherwise the outcome says
 * why not. Never throws for a damaged catalog file or an I/O error: those
 * are INTEGRITY_MISMATCH and STORAGE_ERROR.
 */
export async function planRollback(options: { dataRoot: string; to: RollbackTarget; verifyRecord?: VerifyRecordRead }): Promise<RollbackPlan> {
    const root = path.resolve(options.dataRoot);
    const status = dataRootStatus({ root });
    if (status.state !== 'ready') return emptyPlan('DATA_ROOT_NOT_READY', `The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}.`);
    if ('revisionId' in options.to) assertRevisionId(options.to.revisionId);
    try {
        return await plan(root, options.to, options.verifyRecord);
    } catch (error) {
        if (error instanceof CatalogIntegrityError) return emptyPlan('INTEGRITY_MISMATCH', `${sentence(error.message)} Nothing was rolled back.`);
        return emptyPlan('STORAGE_ERROR', `${sentence(errorText(error, root))} Nothing was rolled back.`);
    }
}

/** `verifyRecord`: the record as a caller planning several revisions read it once. rollback() never passes one, so it reads it fresh under the lock. */
async function plan(root: string, to: RollbackTarget, verifyRecord?: VerifyRecordRead): Promise<RollbackPlan> {
    const activations = await listActivations(root);
    const pointer = await readActivePointer(root);
    const good = knownGood(activations, pointer);
    if (pointer === null || good.size === 0) return emptyPlan('NOTHING_ACTIVE', 'Nothing is active yet, so there is nothing to roll back from. Publish first.');
    const active: RevisionRef = { revisionId: pointer.revisionId, revisionNumber: good.get(pointer.revisionId) ?? null };

    let target: RevisionRef;
    if ('revisionNumber' in to) {
        const found = [...good].find(([, number]) => number === to.revisionNumber);
        if (!found) return emptyPlan('NOT_ELIGIBLE', `No revision ${to.revisionNumber} has been active. photos history lists the ones that have.`, { active });
        target = { revisionId: found[0], revisionNumber: found[1] };
    } else {
        const number = good.get(to.revisionId);
        if (number === undefined) return emptyPlan('NOT_ELIGIBLE', `${to.revisionId} has never been active, so a rollback can't go back to it. photos history lists the revisions that have.`, { active });
        target = { revisionId: to.revisionId, revisionNumber: number };
    }
    if (target.revisionId === active.revisionId) return emptyPlan('NO_CHANGES', `${named(target)} is already active.`, { target, active });

    const targetRevision = await stored(root, target.revisionId);
    if (!('content' in targetRevision)) return { ...targetRevision, target, active };
    // A live revision that can't be read is a reason to roll back, not to refuse: warn, list everything the target
    // publishes, and leave the decision to activateRevision(), which reads the revision it replaces only for #5's
    // route rules, and goes on without it.
    let activeProblem: string | undefined;
    let activeContent: RevisionContent = EMPTY_CONTENT;
    let replaces: RevisionFile | null = null;
    try {
        const activeRevision = await stored(root, active.revisionId);
        if ('content' in activeRevision) {
            activeContent = activeRevision.content;
            replaces = activeRevision;
        } else activeProblem = activeRevision.message.replace(/\.? Nothing was rolled back\.$/, '');
    } catch (error) {
        activeProblem = errorText(error, root);
    }
    const impact = changesBetween(activeContent, targetRevision.content);
    const seriesTitles = Object.fromEntries([...activeContent.series, ...targetRevision.content.series].map((series) => [series.id, series.title]));
    const base = { target, active, impact, seriesTitles, ...(activeProblem === undefined ? {} : { activeProblem }) };

    // Without #10's registry the readiness and source-name rules can't run, so refuse, as activateRevision() does.
    let registry: Registry;
    try {
        registry = await readRegistry(root);
    } catch (error) {
        const reason = errorText(error, root);
        return emptyPlan('STORAGE_ERROR', `The identity registry can't be read, so ${target.revisionId}'s sets can't be checked: ${sentence(reason)} Nothing was rolled back.`, base);
    }
    // Against the live revision, so #5's route rules flag a rollback across a rename. Off a live revision that can't
    // be read they have nothing to compare against, and activateRevision() reads it the same way.
    const { issues } = validateStored(root, targetRevision, registry, replaces);
    const editorialIds = editorialRuleIds();
    const editorial = [...new Set(issues.filter((issue) => issue.severity === 'error' && editorialIds.has(issue.code)).map((issue) => issue.code))].sort();
    const blocking = blockingIssues(issues, editorial);
    const ordered = [...blocking, ...issues.filter((issue) => !blocking.includes(issue))];
    if (blocking.length > 0) {
        const codes = [...new Set(blocking.map((issue) => issue.code))].sort().join(', ');
        return {
            ...base,
            outcome: 'VALIDATION_FAILED',
            message: `${blocking.length} ${blocking.length === 1 ? 'error keeps' : 'errors keep'} ${named(target)} from going live again (${codes}). Nothing was rolled back.`,
            issues: ordered,
            blocking,
            editorial,
            verify: null,
        };
    }
    // #181's A7: then the verify record, after the rules, so an integrity error still reads as VALIDATION_FAILED.
    const verify = await recordedVerifyFailure(root, target.revisionId, verifyRecord);
    if (verify) return { ...base, outcome: 'VERIFY_FAILED', message: verifyFailedMessage(target, verify), issues: ordered, blocking, editorial, verify };
    return { ...base, outcome: 'READY', message: `Ready to roll back from ${named(active)} to ${named(target)}.`, issues: ordered, blocking, editorial, verify: null };
}

/** VERIFY_FAILED's message, which the CLI prints as it is: what the record says, and the two ways on. */
export function verifyFailedMessage(target: RevisionRef, verify: RecordedVerifyFailure): string {
    const name = target.revisionNumber === null ? target.revisionId : `Revision ${target.revisionNumber} (${target.revisionId})`;
    const accept = `or accept it with --accept ${VERIFY_FAILED_ACCEPT}. Nothing was rolled back.`;
    if (verify.reason === 'record-damaged') {
        const lower = target.revisionNumber === null ? target.revisionId : `revision ${target.revisionNumber} (${target.revisionId})`;
        const why = verify.cause ? `: ${damagedText(verify.cause)}` : '.';
        return `status/verify.json can't be read${why} Nothing shows whether ${lower} passed its last photos verify. Run photos verify to record a new check, ${accept}`;
    }
    // The record trims a big catalog's problems, so an entry can count some and list none.
    if (verify.problems.length === 0 && verify.problemCount > 0) {
        return `${name} failed its last photos verify with ${verify.problemCount} ${verify.problemCount === 1 ? 'problem' : 'problems'}; photos verify --revision ${target.revisionId} lists them. Fix them and run it again, ${accept}`;
    }
    const [first] = verify.problems;
    const more = verify.problemCount > 1 ? `, and ${verify.problemCount - 1} more ${verify.problemCount === 2 ? 'problem' : 'problems'}` : '';
    const what = first === undefined ? '' : `: ${first.replace(/\.$/, '')}${more}`;
    return `${name} failed its last photos verify${what}. Fix it and run photos verify --revision ${target.revisionId}, ${accept}`;
}

/** Who holds a lock, for a message. */
export function holderText(holder: LockRecord | null): string {
    if (!holder) return 'another process';
    return `${holder.owner} (pid ${holder.pid} on ${holder.hostname}, since ${holder.acquiredAt})`;
}

/** When a holder's lease runs out unless it renews, for a message. */
function leaseEnd(holder: LockRecord | null, ownLeaseMs: number): string {
    const heartbeat = holder ? Date.parse(holder.heartbeatAt) : Number.NaN;
    if (!holder || Number.isNaN(heartbeat)) return '';
    // withLock() judges a lease by the holder's claim capped at MAX_LEASE_MS, or by the waiter's own lease when the
    // record claims none, so the time printed is that one.
    const lease = typeof holder.leaseMs === 'number' && holder.leaseMs > 0 ? Math.min(holder.leaseMs, MAX_LEASE_MS) : ownLeaseMs;
    return ` Its lease runs until ${new Date(heartbeat + lease).toISOString()} unless it renews it. If that command crashed, run the rollback again after then.`;
}

/**
 * Roll back to `revisionId` under the catalog lock. Never throws for an
 * expected stop; see RollbackOutcome. CATALOG_LOCKED names the holder, and
 * no option breaks a live lock.
 */
export async function rollback(options: RollbackOptions): Promise<RollbackResult> {
    const root = path.resolve(options.dataRoot);
    const { actor, reason, hooks = {}, logger = jsonLogger, clock = Date.now } = options;
    // VERIFY_FAILED_ACCEPT is the typed verifyOverride's to record, never an accept a caller passes as a string.
    const acceptedRules = [...new Set(options.acceptedRules ?? [])].filter((rule) => rule !== VERIFY_FAILED_ACCEPT);
    if (!/\S/.test(actor)) throw new TypeError('A rollback needs an actor.');
    if (!/\S/.test(reason)) throw new TypeError('A rollback needs a reason.');
    assertRevisionId(options.revisionId);
    assertRevisionId(options.expectedActiveRevisionId);
    const result: RollbackResult = { outcome: 'STORAGE_ERROR', message: '', plan: null, activation: null, issues: [] };
    const finish = (outcome: RollbackOutcome, message: string, details: Partial<RollbackResult> = {}): RollbackResult => {
        Object.assign(result, details, { outcome, message });
        const fields = { outcome, revisionId: options.revisionId, revisionNumber: result.activation?.revisionNumber ?? result.plan?.target?.revisionNumber ?? null, activationId: result.activation?.activationId ?? null };
        if (outcome === 'ROLLED_BACK') logEvent(logger, 'catalog.rollback.activated', { ...fields, previousRevisionId: result.activation?.previousRevisionId ?? null, acceptedRules: result.activation?.acceptedRules ?? [] });
        else if (ROLLBACK_EXIT_CODES[outcome] !== 0) logEvent(logger, 'catalog.rollback.failed', { ...fields, ...(result.unaccepted ? { unaccepted: result.unaccepted } : {}) });
        return result;
    };

    const status = dataRootStatus({ write: true, root });
    if (status.state !== 'ready') return finish('DATA_ROOT_NOT_READY', `The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}. Nothing was rolled back.`);
    logEvent(logger, 'catalog.rollback.started', { actor, reason, revisionId: options.revisionId, expectedActiveRevisionId: options.expectedActiveRevisionId, acceptedRules, verifyOverride: options.verifyOverride === true });

    let held: RollbackResult | null = null;
    // Set once the work under the lock has its answer, so a release that fails after it can't undo that answer.
    let answered: RollbackResult | null = null;
    try {
        held = await withLock(CATALOG_LOCK, { root, leaseMs: options.leaseMs ?? CATALOG_LEASE_MS, waitMs: options.waitMs ?? ROLLBACK_WAIT_MS, hooks: hooks.lock }, async (lock) => {
            try {
                answered = await rollbackHeld(lock);
            } catch (error) {
                answered = await failed(error);
            }
            return answered;
        });
    } catch (error) {
        if (error instanceof LockTimeoutError) {
            return finish('CATALOG_LOCKED', `Another command holds the catalog lock: ${holderText(error.holder)}.${leaseEnd(error.holder, options.leaseMs ?? CATALOG_LEASE_MS)} Nothing was rolled back.`, { holder: error.holder });
        }
        // #181: the release failed after the answer. What the rollback did stands; the lock file stays until its lease runs out.
        const done = answered as RollbackResult | null;
        if (done !== null) {
            done.message = `${done.message} The catalog lock couldn't be released (${errorText(error, root)}), so the next publish or rollback may wait until its lease runs out.`;
            logEvent(logger, 'catalog.lock.release-failed', { lock: CATALOG_LOCK, outcome: done.outcome, error: errorText(error, root) });
            return done;
        }
        return failed(error);
    }
    return held;

    /** An error that ended the rollback, as an outcome. */
    async function failed(error: unknown): Promise<RollbackResult> {
        const message = sentence(errorText(error, root));
        // After the pointer moved, the target is live even though the rollback didn't finish. A target that was
        // already live before, as when a rerun settles a crashed rollback, says so too.
        const pointer = await readActivePointer(root).catch(() => null);
        const live = pointer?.revisionId === options.revisionId ? ` ${options.revisionId} is live, and the next publish or rollback finishes recording it.` : ' Nothing was rolled back.';
        return finish(error instanceof CatalogIntegrityError ? 'INTEGRITY_MISMATCH' : 'STORAGE_ERROR', `${message}${live}`);
    }

    /**
     * The target is already live: finish what an interrupted activation left,
     * as the next publish would. recover() commits a pending record the
     * pointer names, sets aside the others, and rebases the working layer, so
     * running the rollback again after a crash settles it.
     */
    async function settle(lock: LockContext, message: string): Promise<RollbackResult> {
        const pointer = await readActivePointer(root);
        const unsettled = pointer !== null && (await listActivations(root)).some((activation) => historyState(activation, pointer).unsettled);
        let recovery: RecoveryReport;
        try {
            recovery = await recover({ dataRoot: root, lock, logger, clock, authoredWaitMs: options.authoredWaitMs });
        } catch (error) {
            if (error instanceof LockTimeoutError) {
                // recover() records the activations before it rebases, so only the rebase is left.
                const committed = unsettled ? ' Recorded the interrupted activation as committed.' : '';
                return finish('NO_CHANGES', `${message}${committed} The working layer was busy, so the next publish rebases it.`, { rebased: false });
            }
            // recover() refuses to record a pointer moved by hand to a revision the rules block, and says what to do.
            if (error instanceof CatalogIntegrityError) return finish('INTEGRITY_MISMATCH', error.message);
            if (!(await lock.isHeld().catch(() => false))) return finish('LOCK_LOST', `${sentence(errorText(error, root))} Nothing was rolled back.`);
            throw error;
        }
        const done = [
            recovery.committed ? 'Recorded the interrupted activation as committed' : '',
            recovery.abandoned.length ? `set aside ${recovery.abandoned.length === 1 ? 'an interrupted activation' : `${recovery.abandoned.length} interrupted activations`}` : '',
            recovery.repaired ? 'recorded a repair activation for the active pointer' : '',
            recovery.rebased ? 'rebased the working layer onto it' : '',
        ].filter(Boolean);
        const note = done.length ? ` ${done.join(', ').replace(/^./, (first) => first.toUpperCase()).replace(/, ([^,]+)$/, ', and $1')}.` : '';
        const conflicts = recovery.rebased?.conflicts ?? [];
        return finish('NO_CHANGES', `${message}${note}${conflictNote(conflicts)}`, { recovery, conflicts, ...(recovery.rebased ? { rebased: true } : {}) });
    }

    async function rollbackHeld(lock: LockContext): Promise<RollbackResult> {
        if (lock.takeover) logEvent(logger, 'catalog.lock.takeover', { lock: CATALOG_LOCK, ...lock.takeover });
        await hooks.afterLock?.();
        // Plan again under the lock: the target is still one that was active, its sets and rules still pass.
        const planned = await planRollback({ dataRoot: root, to: { revisionId: options.revisionId } });
        result.plan = planned;
        result.issues = planned.issues;
        if (planned.outcome === 'NO_CHANGES') return settle(lock, planned.message);
        if (planned.active && planned.active.revisionId !== options.expectedActiveRevisionId) {
            // With the target as the expected revision, the caller only meant to settle what was already live.
            const why = options.expectedActiveRevisionId === options.revisionId
                ? `${named(planned.active)} went live since ${options.revisionId} was checked, so nothing was settled or rolled back. Run the rollback again to see what it would change now.`
                : `${named(planned.active)} is active now, not ${options.expectedActiveRevisionId}, so the impact you confirmed is out of date. Nothing was rolled back. Check it again.`;
            return finish('ACTIVE_CHANGED', why);
        }
        // #181's A7: a recorded verify failure goes on only with the CLI's accept for it, read under the lock too.
        const verifyAccepted = planned.outcome === 'VERIFY_FAILED' && options.verifyOverride === true;
        if (planned.outcome !== 'READY' && !verifyAccepted) return finish(planned.outcome, planned.message);
        // #117: every editorial rule flagged on the target needs its own accept, checked under the lock against the
        // plan made there, so rules that changed since the caller looked can't slip through. Nothing is written yet.
        const refused = acceptanceCheck(planned, acceptedRules, options.revisionId);
        if (refused) return finish(refused.outcome, refused.message, 'unaccepted' in refused ? { unaccepted: refused.unaccepted } : {});
        await hooks.afterEligibility?.(planned);

        // Exactly the flagged rules, every one accepted above, then verify.failed when the record refused the target.
        // An accept for a rule that isn't flagged, or for a verify failure the record doesn't hold, isn't recorded.
        const activated = await activateRevision({
            lock,
            dataRoot: root,
            revisionId: options.revisionId,
            expectedActiveRevisionId: options.expectedActiveRevisionId,
            kind: 'rollback',
            actor,
            reason,
            acceptedRules: [...planned.editorial, ...(verifyAccepted ? [VERIFY_FAILED_ACCEPT] : [])],
            hooks: { afterStep: hooks.afterStep, pointer: hooks.pointer },
            logger,
            clock,
        });
        result.recovery = activated.recovery;
        if (activated.issues) result.issues = activated.issues;
        if (activated.outcome !== 'ACTIVATED' || activated.activation === null) {
            const outcome = activated.outcome === 'ACTIVATED' ? 'STORAGE_ERROR' : activated.outcome;
            return finish(outcome, /Nothing was activated\.$/.test(activated.message) ? activated.message.replace(/Nothing was activated\.$/, 'Nothing was rolled back.') : activated.message);
        }
        result.activation = activated.activation;

        let rebased: boolean;
        let conflicts: RebaseReport['conflicts'] = [];
        try {
            conflicts = (await rebaseWorkingLayer({ root, targetRevisionId: options.revisionId, waitMs: options.authoredWaitMs })).conflicts;
            rebased = true;
        } catch (error) {
            if (!(error instanceof LockTimeoutError)) throw error;
            rebased = false;
        }
        await hooks.afterStep?.(13);
        const target: RevisionRef = { revisionId: options.revisionId, revisionNumber: activated.activation.revisionNumber };
        const from = planned.active ? ` from ${named(planned.active)}` : '';
        const note = rebased ? '' : ' The working layer was busy, so the next publish rebases it.';
        return finish('ROLLED_BACK', `Rolled back to ${named(target)}${from}.${note}${conflictNote(conflicts)}`, { rebased, conflicts });
    }
}

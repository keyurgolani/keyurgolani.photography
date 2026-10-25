import path from 'node:path';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { dataRootStatus } from '../storage/config';
import { LockTimeoutError, MAX_LEASE_MS, withLock, type LockContext, type LockHooks, type LockRecord } from '../storage/lock';
import { changesBetween, historyState, knownGood, type RevisionChanges } from './history';
import { activateRevision, blockingIssues, CATALOG_LEASE_MS, rebaseWorkingLayer, recover, validateStored, type CatalogLogger, type RebaseReport, type RecoveryReport } from './publish';
import { assertRevisionId, CATALOG_LOCK, CatalogIntegrityError, listActivations, readRevisionFile } from './repository';
import { registeredRules } from './ruleset';
import type { Activation, Issue, RevisionContent, RevisionFile } from './types';
import { readActivePointer } from './working-layer';

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
 * rules print with the plan and don't block, and the activation records
 * them in `acceptedRules`. The rollback copies, edits, renumbers, and erases
 * nothing: the target keeps the number it first went live under.
 */

export type RollbackOutcome =
    | 'READY'
    | 'ROLLED_BACK'
    | 'NO_CHANGES'
    | 'NOT_ELIGIBLE'
    | 'VALIDATION_FAILED'
    | 'CONFIRMATION_REQUIRED'
    | 'DECLINED'
    | 'NOTHING_ACTIVE'
    | 'ACTIVE_CHANGED'
    | 'CATALOG_LOCKED'
    | 'LOCK_LOST'
    | 'DATA_ROOT_NOT_READY'
    | 'INTEGRITY_MISMATCH'
    | 'STORAGE_ERROR';

/** The CLI's exit codes, #13's: 1 for a target that may not go live, 4 for a damaged file or I/O, 3 for any other stop. Usage errors, 2, are the CLI's own. */
export const ROLLBACK_EXIT_CODES: Record<RollbackOutcome, 0 | 1 | 3 | 4> = {
    READY: 0,
    ROLLED_BACK: 0,
    NO_CHANGES: 0,
    NOT_ELIGIBLE: 1,
    VALIDATION_FAILED: 1,
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
    /** The editorial rules with errors on the target, which a rollback accepts. */
    editorial: string[];
}

export interface RollbackHooks {
    /** Runs after activateRevision()'s steps 10 to 12 and after the rebase, 13. A test throws here to crash the rollback. */
    afterStep?(step: number): void | Promise<void>;
    lock?: LockHooks;
}

export interface RollbackOptions {
    dataRoot: string;
    revisionId: string;
    /** The active revision the curator confirmed against. The rollback writes nothing if another one is active. */
    expectedActiveRevisionId: string;
    actor: string;
    reason: string;
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
}

const jsonLogger: CatalogLogger = { log: (line) => console.log(line) };
const logEvent = (logger: CatalogLogger, event: string, fields: Record<string, unknown>) => logger.log(JSON.stringify({ event, ...fields }));
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
const EMPTY_CONTENT: RevisionContent = { site: { featuredSeriesIds: [] }, series: [], photos: [] };

/**
 * An error for a message, without the absolute path a Node fs error carries:
 * its code and the path relative to the data root, or "a path outside the
 * data root". Other errors keep their message, which catalog code writes
 * relative already.
 */
export function errorText(error: unknown, root: string): string {
    const errno = error as NodeJS.ErrnoException;
    if (error instanceof Error && typeof errno.code === 'string' && typeof errno.path === 'string') {
        return `${errno.code} on ${relativeName(root, errno.path)}`;
    }
    // The storage layer's document errors, such as a damaged registry's, start with the file's absolute path.
    const file = (error as { file?: unknown } | null)?.file;
    if (error instanceof Error && typeof file === 'string' && path.isAbsolute(file)) return error.message.split(file).join(relativeName(root, file));
    return error instanceof Error ? error.message : String(error);
}

/** A path relative to the data root, POSIX style, or a stand-in for one outside it. */
function relativeName(root: string, file: string): string {
    const relative = path.relative(root, path.resolve(file));
    if (relative === '') return 'the data root';
    if (relative.startsWith('..') || path.isAbsolute(relative)) return 'a path outside the data root';
    return relative.split(path.sep).join('/');
}

/** What a rebase's conflicts mean for the owner, or nothing when it raised none. */
function conflictNote(conflicts: RebaseReport['conflicts'] | undefined): string {
    const n = conflicts?.length ?? 0;
    if (n === 0) return '';
    return ` The rebase raised ${n} working-layer ${n === 1 ? 'conflict' : 'conflicts'}, so the next publish stops until ${n === 1 ? "it's" : "they're"} settled.`;
}

const named = (ref: RevisionRef) => (ref.revisionNumber === null ? ref.revisionId : `revision ${ref.revisionNumber} (${ref.revisionId})`);

function emptyPlan(outcome: RollbackOutcome, message: string, fields: Partial<RollbackPlan> = {}): RollbackPlan {
    return { outcome, message, target: null, active: null, impact: null, seriesTitles: {}, issues: [], blocking: [], editorial: [], ...fields };
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

/** The rule IDs whose errors a rollback prints and doesn't block on. */
function editorialRuleIds(): Set<string> {
    return new Set(registeredRules().filter((rule) => rule.rollbackClass === 'editorial').map((rule) => rule.id));
}

/**
 * What rolling back to `to` would do, read without a lock and writing
 * nothing. READY when the target may go live; otherwise the outcome says
 * why not. Never throws for a damaged catalog file or an I/O error: those
 * are INTEGRITY_MISMATCH and STORAGE_ERROR.
 */
export async function planRollback(options: { dataRoot: string; to: RollbackTarget }): Promise<RollbackPlan> {
    const root = path.resolve(options.dataRoot);
    const status = dataRootStatus({ root });
    if (status.state !== 'ready') return emptyPlan('DATA_ROOT_NOT_READY', `The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}.`);
    if ('revisionId' in options.to) assertRevisionId(options.to.revisionId);
    try {
        return await plan(root, options.to);
    } catch (error) {
        if (error instanceof CatalogIntegrityError) return emptyPlan('INTEGRITY_MISMATCH', `${sentence(error.message)} Nothing was rolled back.`);
        return emptyPlan('STORAGE_ERROR', `${sentence(errorText(error, root))} Nothing was rolled back.`);
    }
}

async function plan(root: string, to: RollbackTarget): Promise<RollbackPlan> {
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
    // publishes, and leave the decision to activateRevision(), which never reads the revision it replaces.
    let activeProblem: string | undefined;
    let activeContent: RevisionContent = EMPTY_CONTENT;
    try {
        const activeRevision = await stored(root, active.revisionId);
        if ('content' in activeRevision) activeContent = activeRevision.content;
        else activeProblem = activeRevision.message.replace(/\.? Nothing was rolled back\.$/, '');
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
    const { issues } = validateStored(root, targetRevision, registry);
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
        };
    }
    return { ...base, outcome: 'READY', message: `Ready to roll back from ${named(active)} to ${named(target)}.`, issues: ordered, blocking, editorial };
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
    if (!/\S/.test(actor)) throw new TypeError('A rollback needs an actor.');
    if (!/\S/.test(reason)) throw new TypeError('A rollback needs a reason.');
    assertRevisionId(options.revisionId);
    assertRevisionId(options.expectedActiveRevisionId);
    const result: RollbackResult = { outcome: 'STORAGE_ERROR', message: '', plan: null, activation: null, issues: [] };
    const finish = (outcome: RollbackOutcome, message: string, details: Partial<RollbackResult> = {}): RollbackResult => {
        Object.assign(result, details, { outcome, message });
        const fields = { outcome, revisionId: options.revisionId, revisionNumber: result.activation?.revisionNumber ?? result.plan?.target?.revisionNumber ?? null, activationId: result.activation?.activationId ?? null };
        if (outcome === 'ROLLED_BACK') logEvent(logger, 'catalog.rollback.activated', { ...fields, previousRevisionId: result.activation?.previousRevisionId ?? null });
        else if (ROLLBACK_EXIT_CODES[outcome] !== 0) logEvent(logger, 'catalog.rollback.failed', fields);
        return result;
    };

    const status = dataRootStatus({ write: true, root });
    if (status.state !== 'ready') return finish('DATA_ROOT_NOT_READY', `The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}. Nothing was rolled back.`);
    logEvent(logger, 'catalog.rollback.started', { actor, reason, revisionId: options.revisionId, expectedActiveRevisionId: options.expectedActiveRevisionId });

    let held: RollbackResult | null = null;
    try {
        held = await withLock(CATALOG_LOCK, { root, leaseMs: options.leaseMs ?? CATALOG_LEASE_MS, waitMs: options.waitMs ?? ROLLBACK_WAIT_MS, hooks: hooks.lock }, async (lock) => {
            try {
                return await rollbackHeld(lock);
            } catch (error) {
                return failed(error);
            }
        });
    } catch (error) {
        if (error instanceof LockTimeoutError) {
            return finish('CATALOG_LOCKED', `Another command holds the catalog lock: ${holderText(error.holder)}.${leaseEnd(error.holder, options.leaseMs ?? CATALOG_LEASE_MS)} Nothing was rolled back.`, { holder: error.holder });
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
        if (planned.outcome !== 'READY') return finish(planned.outcome, planned.message);

        const activated = await activateRevision({
            lock,
            dataRoot: root,
            revisionId: options.revisionId,
            expectedActiveRevisionId: options.expectedActiveRevisionId,
            kind: 'rollback',
            actor,
            reason,
            acceptedRules: planned.editorial,
            hooks: { afterStep: hooks.afterStep },
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

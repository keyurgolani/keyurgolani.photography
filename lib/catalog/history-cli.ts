import path from 'node:path';
import { dataRootStatus } from '../storage/config';
import { readHistory, type ChangeSet, type History, type HistoryRow, type RevisionChanges } from './history';
import { count, issueLines, parseFlags, PRINTED_ISSUES, UsageError } from './owner-cli';
import type { CatalogLogger } from './publish';
import { errorText, planRollback, rollback, ROLLBACK_EXIT_CODES, type RollbackOptions, type RollbackPlan, type RollbackResult, type RollbackTarget } from './rollback';
import { CatalogIntegrityError } from './repository';
import { REVISION_ID_RE } from './schema';
import type { CommandResult } from './sequence-commands';

/**
 * `photos history` and `photos rollback`, #15's 15-2: their argv parsing
 * and report text, kept here so tests can run them in-process. Nothing but
 * the CLI and its tests imports this module.
 */

export interface RollbackArgs {
    to: RollbackTarget;
    reason: string;
    actor: string;
    /** The active revision the rollback must replace. Required with `yes`. */
    expectActive?: string;
    yes: boolean;
}

/** `photos rollback --to <number | revisionId> --reason <text> [--actor <name>] [--expect-active <revisionId>] [--yes]`. */
export function rollbackArgs(args: string[], env: Record<string, string | undefined> = process.env): RollbackArgs {
    const { values } = parseFlags({
        args,
        options: { to: { type: 'string' }, reason: { type: 'string' }, actor: { type: 'string' }, 'expect-active': { type: 'string' }, yes: { type: 'boolean' } },
    });
    if (values.to === undefined) throw new UsageError('photos rollback needs --to <number | revisionId>: a revision number or ID from photos history.');
    let to: RollbackTarget;
    if (/^[1-9]\d{0,8}$/.test(values.to)) to = { revisionNumber: Number(values.to) };
    else if (REVISION_ID_RE.test(values.to)) to = { revisionId: values.to };
    else throw new UsageError(`--to takes a revision number from 1 or a revision ID, not ${values.to}.`);
    if (values.reason === undefined || !/\S/.test(values.reason)) throw new UsageError('photos rollback needs --reason <text>, which its activation records.');
    const actor = values.actor ?? env.PHOTOS_ACTOR ?? '';
    if (!/\S/.test(actor)) throw new UsageError('photos rollback needs --actor <name> or PHOTOS_ACTOR.');
    const expectActive = values['expect-active'];
    if (expectActive !== undefined && !REVISION_ID_RE.test(expectActive)) throw new UsageError(`--expect-active takes the active revision's ID, not ${expectActive}.`);
    if (values.yes && expectActive === undefined) throw new UsageError('--yes needs --expect-active <revisionId>, the active revision the impact list was made against.');
    return { to, reason: values.reason.trim(), actor: actor.trim(), ...(expectActive === undefined ? {} : { expectActive }), yes: values.yes === true };
}

// History.

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

const capped = (ids: readonly string[], label: (id: string) => string = (id) => id) =>
    `${ids.slice(0, PRINTED_ISSUES).map(label).join(', ')}${ids.length > PRINTED_ISSUES ? `, and ${ids.length - PRINTED_ISSUES} more` : ''}`;

function changeCounts(noun: string, set: ChangeSet): string | null {
    const parts = [
        set.added.length ? `${set.added.length} added` : '',
        set.removed.length ? `${set.removed.length} removed` : '',
        set.changed.length ? `${set.changed.length} changed` : '',
    ].filter(Boolean);
    return parts.length ? `${noun} ${parts.join(', ')}` : null;
}

/** "photos 2 added, 1 changed; series 1 removed; the site record changed", or null when nothing differs. */
export function changeSummary(changes: RevisionChanges): string | null {
    const parts = [changeCounts('series', changes.series), changeCounts('photos', changes.photos), changes.site ? 'the featured series or the Work order changed' : null].filter(Boolean);
    return parts.length ? parts.join('; ') : null;
}

function rowLines(row: HistoryRow): string[] {
    const { activation } = row;
    const number = row.state === 'committed' ? `revision ${activation.revisionNumber}` : 'not activated';
    const flags = [activation.kind, row.state === 'committed' ? 'committed' : 'interrupted', ...(row.live ? ['LIVE'] : [])].join(', ');
    const lines = [`#${activation.sequence} ${number}: ${flags}`, `    ${activation.revisionId}`];
    const at = activation.committedAt ?? activation.startedAt;
    lines.push(`    ${at} by ${activation.actor}: ${activation.reason}`);
    if (row.unsettled) lines.push('    The active pointer names it, but its record still says pending. The next publish or rollback records it as committed.');
    if (row.state === 'interrupted') {
        lines.push(activation.status === 'abandoned'
            ? '    Interrupted: it never moved the active pointer, and a later command set it aside.'
            : '    Interrupted: it never moved the active pointer. The next publish or rollback sets it aside.');
    }
    const { errors, warnings, rulesetVersion } = activation.validation;
    lines.push(`    Validation: ${count(errors, 'error')} and ${count(warnings, 'warning')}, ruleset ${rulesetVersion.slice(0, 12)}`);
    if (activation.acceptedRules.length) lines.push(`    Accepted editorial errors: ${activation.acceptedRules.join(', ')}`);
    if (activation.kind === 'rollback' && activation.previousRevisionId) lines.push(`    Rolled back from ${activation.previousRevisionId}`);
    if (activation.lockTakeover) lines.push(`    Took over the catalog lock from ${activation.lockTakeover.previousOwner}, held since ${activation.lockTakeover.previousAcquiredAt}, after its lease expired`);
    if (row.summary === null) {
        lines.push(`    Its revision can't be read: ${row.problem ?? 'unknown'}.`);
        return lines;
    }
    const { seriesCount, photoCount, parentRevisionId, changes, parentProblem } = row.summary;
    const size = `${seriesCount} series and ${count(photoCount, 'photo')}`;
    if (parentRevisionId === null) lines.push(`    ${size}, the first revision`);
    else if (changes === null) lines.push(`    ${size}. Its parent ${parentRevisionId} can't be read: ${parentProblem ?? 'unknown'}.`);
    else lines.push(`    ${size}. Against its parent ${parentRevisionId}: ${changeSummary(changes) ?? 'no changes'}`);
    return lines;
}

/** The lines `photos history` prints. */
export function historyLines(history: History): string[] {
    const { pointer, rows } = history;
    if (rows.length === 0) return ['[photos] Nothing has been published yet.'];
    const live = rows.find((row) => row.live);
    const head = live
        ? `[photos] ${count(rows.length, 'activation')}, oldest first. Live: revision ${live.activation.revisionNumber}, ${live.activation.revisionId}, from #${live.activation.sequence}.`
        : `[photos] ${count(rows.length, 'activation')}, oldest first. No committed activation is live.`;
    const lines = [head];
    if (!live && pointer) lines.push(`The active pointer names ${pointer.revisionId} through ${pointer.activationId}, which no committed activation records. The next publish repairs it or says what blocks it.`);
    for (const row of rows) lines.push(...rowLines(row));
    return lines;
}

/**
 * `photos history`: read without a lock and writing nothing. Exits 0, 3 when
 * the data root isn't ready, and 4 when an activation record, the active
 * pointer, or a revision file is damaged or can't be read, after printing
 * what it could.
 */
export async function runHistoryCommand(dataRoot: string): Promise<CommandResult> {
    const root = path.resolve(dataRoot);
    const status = dataRootStatus({ root });
    if (status.state !== 'ready') return { exitCode: 3, output: `[photos] DATA_ROOT_NOT_READY: The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}.\n` };
    let history: History;
    try {
        history = await readHistory(root);
    } catch (error) {
        // A damaged record is INTEGRITY_MISMATCH, anything else, such as a folder it can't read, STORAGE_ERROR. Both exit 4.
        const outcome = error instanceof CatalogIntegrityError ? 'INTEGRITY_MISMATCH' : 'STORAGE_ERROR';
        return { exitCode: 4, output: `[photos] ${outcome}: ${sentence(errorText(error, root))}\n` };
    }
    const lines = historyLines(history);
    const damaged = history.rows.filter((row) => row.summary === null).length;
    if (damaged > 0) lines.push(`[photos] INTEGRITY_MISMATCH: ${count(damaged, 'activation')} ${damaged === 1 ? 'names' : 'name'} a revision that can't be read.`);
    return { exitCode: damaged > 0 ? 4 : 0, output: `${lines.join('\n')}\n` };
}

// Rollback.

function changeLines(plan: RollbackPlan): string[] {
    const { impact } = plan;
    if (!impact) return [];
    const title = (id: string) => {
        const text = plan.seriesTitles[id];
        return text ? `${id} "${text}"` : id;
    };
    const lines: string[] = [];
    if (plan.activeProblem !== undefined) {
        // Nothing to compare against, so list everything the target publishes.
        lines.push(`The live revision can't be read (${plan.activeProblem}), so this lists everything the target publishes.`);
        if (impact.series.added.length) lines.push(`Publishes ${impact.series.added.length} series: ${capped(impact.series.added, title)}`);
        if (impact.photos.added.length) lines.push(`Publishes ${count(impact.photos.added.length, 'photo')}: ${capped(impact.photos.added)}`);
        if (lines.length === 1) lines.push('It publishes no series and no photos.');
        return lines;
    }
    if (impact.series.added.length) lines.push(`Brings back ${impact.series.added.length} series: ${capped(impact.series.added, title)}`);
    if (impact.photos.added.length) lines.push(`Brings back ${count(impact.photos.added.length, 'photo')}: ${capped(impact.photos.added)}`);
    if (impact.series.removed.length) lines.push(`Removes ${impact.series.removed.length} series: ${capped(impact.series.removed, title)}`);
    if (impact.photos.removed.length) lines.push(`Removes ${count(impact.photos.removed.length, 'photo')}: ${capped(impact.photos.removed)}`);
    if (impact.series.changed.length) lines.push(`Changes ${impact.series.changed.length} series: ${capped(impact.series.changed, title)}`);
    if (impact.photos.changed.length) lines.push(`Changes ${count(impact.photos.changed.length, 'photo')}: ${capped(impact.photos.changed)}`);
    if (impact.site) lines.push('Changes the featured series or the Work order.');
    if (lines.length === 0) lines.push('Its series and photos are the same as the active revision\'s.');
    return lines;
}

/** The Active and Target lines. */
function refLines(plan: RollbackPlan): string[] {
    const lines: string[] = [];
    if (plan.active) lines.push(`Active: ${plan.active.revisionId}${plan.active.revisionNumber === null ? '' : `, revision ${plan.active.revisionNumber}`}`);
    if (plan.target) lines.push(`Target: ${plan.target.revisionId}${plan.target.revisionNumber === null ? '' : `, revision ${plan.target.revisionNumber}`}`);
    return lines;
}

/** The plan's lines: the two revisions, the impact list, and the issues on the target. */
export function planLines(plan: RollbackPlan): string[] {
    const lines = [`[photos] ${plan.outcome}: ${plan.message}`, ...refLines(plan)];
    if (plan.outcome === 'READY' || plan.outcome === 'VALIDATION_FAILED') lines.push(...changeLines(plan));
    if (plan.editorial.length) lines.push(`Editorial errors, which a rollback doesn't block on and its activation records: ${plan.editorial.join(', ')}`);
    lines.push(...issueLines(plan.issues, 'Fix the first ones, then plan the rollback again.'));
    return lines;
}

function resultLines(result: RollbackResult): string[] {
    const lines = [`[photos] ${result.outcome}: ${result.message}`];
    if (result.activation) lines.push(`Active: ${result.activation.revisionId}, revision ${result.activation.revisionNumber}`, `Activation: #${result.activation.sequence} ${result.activation.activationId}`);
    if (result.outcome === 'VALIDATION_FAILED') lines.push(...issueLines(result.issues, ''));
    return lines;
}

export interface RollbackIo {
    out(line: string): void;
    err(line: string): void;
    /** Ask the curator, in a terminal. Null when there is none, so only --yes confirms. */
    confirm: ((question: string) => Promise<boolean>) | null;
    logger?: CatalogLogger;
}

/**
 * `photos rollback`: plan, print the impact list, confirm, then roll back.
 * The confirmation is the curator's answer in a terminal, or `--yes` with
 * `--expect-active`, the active revision the impact list was made against,
 * so a rollback never runs on an impact nobody saw. Returns the exit code.
 */
export async function runRollbackCommand(dataRoot: string, args: RollbackArgs, io: RollbackIo, options: Partial<Omit<RollbackOptions, 'dataRoot' | 'revisionId' | 'expectedActiveRevisionId' | 'actor' | 'reason'>> = {}): Promise<number> {
    const root = path.resolve(dataRoot);
    const plan = await planRollback({ dataRoot: root, to: args.to });
    const planExit = ROLLBACK_EXIT_CODES[plan.outcome];
    // The target is live already. Nothing changes what visitors see, so no confirmation, but rollback() still takes
    // the lock and finishes what a crashed activation left: a pending record, or a working layer on another base.
    if (plan.outcome === 'NO_CHANGES' && plan.target) {
        const settled = await rollback({ ...options, dataRoot: root, revisionId: plan.target.revisionId, expectedActiveRevisionId: plan.target.revisionId, actor: args.actor, reason: args.reason, logger: io.logger ?? options.logger });
        const exitCode = ROLLBACK_EXIT_CODES[settled.outcome];
        const shown = settled.plan ?? plan;
        for (const line of [...resultLines(settled), ...refLines(shown)]) (exitCode === 0 ? io.out : io.err)(line);
        return exitCode;
    }
    for (const line of planLines(plan)) (planExit === 0 ? io.out : io.err)(line);
    if (plan.outcome !== 'READY' || !plan.target || !plan.active) return planExit;

    const expected = args.expectActive ?? plan.active.revisionId;
    if (expected !== plan.active.revisionId) {
        io.err(`[photos] ACTIVE_CHANGED: ${plan.active.revisionId} is active, not ${expected}, so the impact you confirmed is out of date. Nothing was rolled back. Check the list above.`);
        return ROLLBACK_EXIT_CODES.ACTIVE_CHANGED;
    }
    if (!args.yes) {
        if (io.confirm === null) {
            io.err(`[photos] CONFIRMATION_REQUIRED: A rollback needs confirmation. Run it in a terminal to answer, or run it again with --yes --expect-active ${plan.active.revisionId} to roll back exactly this. --expect-active stops it if another revision goes live first.`);
            return ROLLBACK_EXIT_CODES.CONFIRMATION_REQUIRED;
        }
        const number = plan.target.revisionNumber === null ? plan.target.revisionId : `revision ${plan.target.revisionNumber}`;
        if (!(await io.confirm(`Roll back to ${number}? Type yes to confirm: `))) {
            io.err('[photos] DECLINED: Nothing was rolled back.');
            return ROLLBACK_EXIT_CODES.DECLINED;
        }
    }
    const result = await rollback({
        ...options,
        dataRoot: root,
        revisionId: plan.target.revisionId,
        expectedActiveRevisionId: expected,
        actor: args.actor,
        reason: args.reason,
        logger: io.logger ?? options.logger,
    });
    const exitCode = ROLLBACK_EXIT_CODES[result.outcome];
    for (const line of resultLines(result)) (exitCode === 0 ? io.out : io.err)(line);
    return exitCode;
}

import path from 'node:path';
import { dataRootStatus } from '../storage/config';
import { readHistory, type ChangeSet, type History, type HistoryRow, type RevisionChanges } from './history';
import { count, issueLines, parseFlags, PRINTED_ISSUES, UsageError } from './owner-cli';
import type { CatalogLogger } from './publish';
import { knownGood } from './history';
import { acceptanceMessage, editorialRuleIds, errorText, planRollback, rollback, ROLLBACK_EXIT_CODES, unacceptedRules, VERIFY_FAILED_ACCEPT, type RollbackOptions, type RollbackOutcome, type RollbackPlan, type RollbackResult, type RollbackTarget } from './rollback';
import { CatalogIntegrityError } from './repository';
import { AUTHORED_ONLY_RULE_IDS, registeredRules } from './ruleset';
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
    /** `--accept <ruleId>`, once per editorial rule the curator accepts, and `verify.failed` (#181), deduplicated. */
    accept: string[];
    yes: boolean;
}

/**
 * `--accept`: registered editorial rule IDs, and `verify.failed` for a
 * target whose recorded `photos verify` failed (#181's A7). Anything else is
 * a usage error, so a typo never reads as an accept.
 */
function acceptArgs(values: readonly string[]): string[] {
    const editorial = editorialRuleIds();
    const registered = new Set(registeredRules().map((rule) => rule.id));
    // The ones a rollback can flag, for the message: #16's review rules are editorial, but only ever report on a draft.
    const flaggable = [...editorial].filter((id) => !AUTHORED_ONLY_RULE_IDS.has(id)).sort();
    for (const id of values) {
        if (!/\S/.test(id)) throw new UsageError(`--accept needs a rule ID, such as --accept ${flaggable[0] ?? 'accent.contrast'}.`);
        if (editorial.has(id) || id === VERIFY_FAILED_ACCEPT) continue;
        if (registered.has(id)) throw new UsageError(`${id} is an integrity rule, which no rollback can accept.`);
        throw new UsageError(`--accept takes an editorial rule ID (${flaggable.join(', ')}) or ${VERIFY_FAILED_ACCEPT}, not ${id}.`);
    }
    return [...new Set(values)];
}

/** `photos rollback --to <number | revisionId> --reason <text> [--actor <name>] [--accept <ruleId>]... [--expect-active <revisionId>] [--yes]`. */
export function rollbackArgs(args: string[], env: Record<string, string | undefined> = process.env): RollbackArgs {
    const { values } = parseFlags({
        args,
        options: { to: { type: 'string' }, reason: { type: 'string' }, actor: { type: 'string' }, accept: { type: 'string', multiple: true }, 'expect-active': { type: 'string' }, yes: { type: 'boolean' } },
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
    const accept = acceptArgs(values.accept ?? []);
    return { to, reason: values.reason.trim(), actor: actor.trim(), ...(expectActive === undefined ? {} : { expectActive }), accept, yes: values.yes === true };
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
    const editorialAccepts = activation.acceptedRules.filter((rule) => rule !== VERIFY_FAILED_ACCEPT);
    if (editorialAccepts.length) lines.push(`    Accepted editorial errors: ${editorialAccepts.join(', ')}`);
    if (activation.acceptedRules.includes(VERIFY_FAILED_ACCEPT)) lines.push(`    Accepted a failed photos verify: ${VERIFY_FAILED_ACCEPT}`);
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

/** The lines `photos history` prints. `limit`: show only the newest that many, still oldest first. */
export function historyLines(history: History, limit: number | null = null): string[] {
    const { pointer, rows } = history;
    if (rows.length === 0) return ['[photos] Nothing has been published yet.'];
    const shown = shownRows(rows, limit);
    const live = rows.find((row) => row.live);
    const showing = shown.length < rows.length ? `, showing the newest ${shown.length}` : '';
    const head = live
        ? `[photos] ${count(rows.length, 'activation')}, oldest first${showing}. Live: revision ${live.activation.revisionNumber}, ${live.activation.revisionId}, from #${live.activation.sequence}.`
        : `[photos] ${count(rows.length, 'activation')}, oldest first${showing}. No committed activation is live.`;
    const lines = [head];
    if (!live && pointer) lines.push(`The active pointer names ${pointer.revisionId} through ${pointer.activationId}, which no committed activation records. The next publish repairs it or says what blocks it.`);
    for (const row of shown) lines.push(...rowLines(row));
    return lines;
}

const shownRows = (rows: readonly HistoryRow[], limit: number | null): readonly HistoryRow[] => (limit === null ? rows : rows.slice(-limit));

export interface HistoryArgs {
    json: boolean;
    /** `--limit <n>`: the newest n activations. Null shows them all. */
    limit: number | null;
    /** `--revisions`: each revision's rollback eligibility and reasons. */
    revisions: boolean;
}

/** `photos history [--json] [--limit <n>] [--revisions]`. */
export function historyArgs(args: string[]): HistoryArgs {
    const { values } = parseFlags({ args, options: { json: { type: 'boolean' }, limit: { type: 'string' }, revisions: { type: 'boolean' } } });
    let limit: number | null = null;
    if (values.limit !== undefined) {
        if (!/^[1-9]\d{0,8}$/.test(values.limit)) throw new UsageError(`--limit takes a number of activations from 1, not ${values.limit}.`);
        limit = Number(values.limit);
    }
    return { json: values.json === true, limit, revisions: values.revisions === true };
}

/** One revision's rollback eligibility, as `--revisions` prints it. */
export interface RevisionEligibility {
    revisionId: string;
    revisionNumber: number;
    live: boolean;
    /** A rollback can go back to it: READY, with --accept for each editorial rule `accept` names. */
    eligible: boolean;
    /** planRollback()'s outcome: NO_CHANGES for the live one. */
    outcome: RollbackOutcome;
    /** Why it isn't eligible, in the CLI's words. Empty when it is, and for the live one. */
    reasons: string[];
    /** The --accept values a rollback to it needs: its flagged editorial rules, then verify.failed for a refused verify. */
    accept: string[];
}

const withoutTail = (message: string) => message.replace(/ Nothing was rolled back\.$/, '');

/**
 * Each revision that has been active, newest first by number, once, through
 * planRollback() as a rollback to it would plan: read only, no lock. With a
 * limit, only the revisions the shown activations name.
 */
export async function revisionEligibility(root: string, history: History, limit: number | null = null): Promise<RevisionEligibility[]> {
    const good = knownGood(history.rows.map((row) => row.activation), history.pointer);
    const named = new Set(shownRows(history.rows, limit).map((row) => row.activation.revisionId));
    const targets = [...good].filter(([revisionId]) => named.has(revisionId)).sort((a, b) => b[1] - a[1]);
    const out: RevisionEligibility[] = [];
    for (const [revisionId, revisionNumber] of targets) {
        const plan = await planRollback({ dataRoot: root, to: { revisionId } });
        const live = plan.outcome === 'NO_CHANGES';
        const eligible = plan.outcome === 'READY';
        const accept = plan.outcome === 'READY' || plan.outcome === 'VERIFY_FAILED' ? [...plan.editorial, ...(plan.outcome === 'VERIFY_FAILED' ? [VERIFY_FAILED_ACCEPT] : [])] : [];
        let reasons: string[] = [];
        if (plan.outcome === 'VALIDATION_FAILED') reasons = [...new Set(plan.blocking.map((issue) => `${issue.code} on ${issue.record.kind} ${issue.record.id}: ${issue.message.replace(/\.$/, '')}`))].slice(0, PRINTED_ISSUES);
        else if (!eligible && !live) reasons = [withoutTail(plan.message)];
        out.push({ revisionId, revisionNumber, live, eligible, outcome: plan.outcome, reasons, accept });
    }
    return out;
}

/** The `--revisions` lines: a head, then one line per revision and its reasons, indented. */
export function eligibilityLines(revisions: readonly RevisionEligibility[]): string[] {
    const lines = ['[photos] Rollback eligibility, newest first:'];
    for (const entry of revisions) {
        const name = `revision ${entry.revisionNumber}, ${entry.revisionId}`;
        const editorial = entry.accept.filter((rule) => rule !== VERIFY_FAILED_ACCEPT);
        let text: string;
        if (entry.live) text = 'LIVE, so there is nothing to roll back to.';
        else if (entry.eligible) text = editorial.length ? `a rollback can return to it with --accept for each editorial error: ${editorial.join(', ')}.` : 'a rollback can return to it.';
        else if (entry.outcome === 'VERIFY_FAILED') text = `VERIFY_FAILED, so a rollback returns to it only with ${entry.accept.map((rule) => `--accept ${rule}`).join(' ')}.`;
        else text = `${entry.outcome}, so a rollback can't return to it.`;
        lines.push(`${name}: ${text}`, ...entry.reasons.map((reason) => `    ${reason}`));
    }
    return lines;
}

/** The `--json` row: the activation's fields and its history state. No absolute path: every message is relative already. */
function rowJson(row: HistoryRow) {
    const { activation } = row;
    return {
        sequence: activation.sequence,
        activationId: activation.activationId,
        kind: activation.kind,
        status: activation.status,
        state: row.state,
        unsettled: row.unsettled,
        live: row.live,
        revisionId: activation.revisionId,
        revisionNumber: activation.revisionNumber,
        previousRevisionId: activation.previousRevisionId,
        previousActivationId: activation.previousActivationId,
        actor: activation.actor,
        reason: activation.reason,
        startedAt: activation.startedAt,
        committedAt: activation.committedAt ?? null,
        validation: activation.validation,
        acceptedRules: activation.acceptedRules,
        lockTakeover: activation.lockTakeover,
        summary: row.summary,
        ...(row.problem === undefined ? {} : { problem: row.problem }),
    };
}

/** The `--json` shape's version. A field may be added; one is never renamed or removed without a bump. */
export const HISTORY_JSON_SCHEMA_VERSION = 1;

/**
 * `photos history [--json] [--limit <n>] [--revisions]`: read without a lock
 * and writing nothing. `--limit` shows the newest n activations, still
 * oldest first; `--revisions` adds each revision's rollback eligibility
 * (#181's A7), planned as a rollback would plan it; `--json` prints both as
 * one versioned object. Exits 0, 3 when the data root isn't ready, and 4
 * when an activation record, the active pointer, or a revision file is
 * damaged or can't be read, after printing what it could.
 */
export async function runHistoryCommand(dataRoot: string, args: HistoryArgs = { json: false, limit: null, revisions: false }): Promise<CommandResult> {
    const root = path.resolve(dataRoot);
    const stop = (exitCode: CommandResult['exitCode'], outcome: string, message: string): CommandResult => ({
        exitCode,
        output: args.json ? `${JSON.stringify({ schemaVersion: HISTORY_JSON_SCHEMA_VERSION, outcome, message }, null, 2)}\n` : `[photos] ${outcome}: ${message}\n`,
    });
    const status = dataRootStatus({ root });
    if (status.state !== 'ready') return stop(3, 'DATA_ROOT_NOT_READY', `The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}.`);
    let history: History;
    let revisions: RevisionEligibility[] | null = null;
    try {
        history = await readHistory(root);
        if (args.revisions) revisions = await revisionEligibility(root, history, args.limit);
    } catch (error) {
        // A damaged record is INTEGRITY_MISMATCH, anything else, such as a folder it can't read, STORAGE_ERROR. Both exit 4.
        return stop(4, error instanceof CatalogIntegrityError ? 'INTEGRITY_MISMATCH' : 'STORAGE_ERROR', sentence(errorText(error, root)));
    }
    const shown = shownRows(history.rows, args.limit);
    const damaged = shown.filter((row) => row.summary === null).length;
    const exitCode = damaged > 0 ? 4 : 0;
    if (args.json) {
        const pointer = history.pointer ? { revisionId: history.pointer.revisionId, activationId: history.pointer.activationId, version: history.pointer.version } : null;
        const out = { schemaVersion: HISTORY_JSON_SCHEMA_VERSION, total: history.rows.length, shown: shown.length, pointer, rows: shown.map(rowJson), ...(revisions ? { revisions } : {}) };
        return { exitCode, output: `${JSON.stringify(out, null, 2)}\n` };
    }
    const lines = historyLines(history, args.limit);
    if (revisions) lines.push(...eligibilityLines(revisions));
    if (damaged > 0) lines.push(`[photos] INTEGRITY_MISMATCH: ${count(damaged, 'activation')} ${damaged === 1 ? 'names' : 'name'} a revision that can't be read.`);
    return { exitCode, output: `${lines.join('\n')}\n` };
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

const refName = (ref: NonNullable<RollbackPlan['target']>) => (ref.revisionNumber === null ? ref.revisionId : `revision ${ref.revisionNumber} (${ref.revisionId})`);

/** The Active and Target lines. */
function refLines(plan: RollbackPlan): string[] {
    const lines: string[] = [];
    if (plan.active) lines.push(`Active: ${plan.active.revisionId}${plan.active.revisionNumber === null ? '' : `, revision ${plan.active.revisionNumber}`}`);
    if (plan.target) lines.push(`Target: ${plan.target.revisionId}${plan.target.revisionNumber === null ? '' : `, revision ${plan.target.revisionNumber}`}`);
    return lines;
}

/** The plan's lines: the two revisions, the impact list, the editorial rules and whether each is accepted, and the issues on the target. */
export function planLines(plan: RollbackPlan, accepted: readonly string[] = []): string[] {
    const lines = [`[photos] ${plan.outcome}: ${plan.message}`, ...refLines(plan)];
    if (plan.outcome === 'READY' || plan.outcome === 'VALIDATION_FAILED' || plan.outcome === 'VERIFY_FAILED') lines.push(...changeLines(plan));
    // #181's A7: what the recorded verify found, past the first, which the message names.
    const found = plan.verify?.problems ?? [];
    for (const problem of found.slice(1, PRINTED_ISSUES)) lines.push(`Its last photos verify also found: ${problem}`);
    if (plan.editorial.length) {
        const marked = plan.editorial.map((rule) => `${rule} (${accepted.includes(rule) ? 'accepted' : 'not accepted'})`);
        lines.push(`Editorial errors, which a rollback brings back only with --accept for each: ${marked.join(', ')}`);
    }
    lines.push(...issueLines(plan.issues, 'Fix the first ones, then plan the rollback again.'));
    return lines;
}

function resultLines(result: RollbackResult): string[] {
    const lines = [`[photos] ${result.outcome}: ${result.message}`];
    if (result.activation) lines.push(`Active: ${result.activation.revisionId}, revision ${result.activation.revisionNumber}`, `Activation: #${result.activation.sequence} ${result.activation.activationId}`);
    if (result.outcome === 'VALIDATION_FAILED') lines.push(...issueLines(result.issues, ''));
    const conflicts = result.conflicts ?? [];
    for (const conflict of conflicts.slice(0, PRINTED_ISSUES)) lines.push(`Conflict: ${conflict.kind} ${conflict.id} ${conflict.field}`);
    if (conflicts.length > PRINTED_ISSUES) lines.push(`${count(conflicts.length - PRINTED_ISSUES, 'more conflict')} not shown. photos validate lists them all.`);
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
    const accept = args.accept ?? [];
    // #181's A7: --accept verify.failed takes a target the verify record refuses on as if it were READY. rollback()
    // checks the record again under the lock.
    const verifyAccepted = plan.outcome === 'VERIFY_FAILED' && accept.includes(VERIFY_FAILED_ACCEPT) && plan.target !== null && plan.active !== null;
    const shown: RollbackPlan = verifyAccepted && plan.target && plan.active
        ? { ...plan, outcome: 'READY', message: `Ready to roll back from ${refName(plan.active)} to ${refName(plan.target)}, which ${plan.verify?.reason === 'record-damaged' ? "status/verify.json can't vouch for" : 'failed its last photos verify'}.` }
        : plan;
    const shownExit = ROLLBACK_EXIT_CODES[shown.outcome];
    for (const line of planLines(shown, accept)) (shownExit === 0 ? io.out : io.err)(line);
    if (verifyAccepted) {
        io.out(plan.verify?.reason === 'record-damaged'
            ? `Accepted: status/verify.json can't be read, so nothing shows its last photos verify passed (${VERIFY_FAILED_ACCEPT}). The activation records that you accepted it.`
            : `Accepted: its last photos verify failed (${VERIFY_FAILED_ACCEPT}). The activation records that you accepted it.`);
    }
    if (shown.outcome !== 'READY' || !plan.target || !plan.active) return planExit;

    const expected = args.expectActive ?? plan.active.revisionId;
    if (expected !== plan.active.revisionId) {
        io.err(`[photos] ACTIVE_CHANGED: ${plan.active.revisionId} is active, not ${expected}, so the impact you confirmed is out of date. Nothing was rolled back. Check the list above.`);
        return ROLLBACK_EXIT_CODES.ACTIVE_CHANGED;
    }
    // #117: each editorial rule flagged on the target needs its own --accept, refused here before anything is asked.
    // rollback() checks again under the lock, against the plan it makes there.
    const number = plan.target.revisionNumber === null ? plan.target.revisionId : `revision ${plan.target.revisionNumber}`;
    for (const rule of accept) {
        if (rule === VERIFY_FAILED_ACCEPT) {
            if (!verifyAccepted) io.out(`${rule} isn't flagged on ${number}: no photos verify has failed it, so there's nothing to accept.`);
        } else if (!plan.editorial.includes(rule)) {
            io.out(`${rule} isn't flagged on ${number}, so there's nothing to accept.`);
        }
    }
    const unaccepted = unacceptedRules(plan, accept);
    if (unaccepted.length > 0) {
        io.err(`[photos] ACCEPTANCE_REQUIRED: ${acceptanceMessage(plan.target, unaccepted)}`);
        return ROLLBACK_EXIT_CODES.ACCEPTANCE_REQUIRED;
    }
    if (!args.yes) {
        if (io.confirm === null) {
            io.err(`[photos] CONFIRMATION_REQUIRED: A rollback needs confirmation. Run it in a terminal to answer, or run it again with --yes --expect-active ${plan.active.revisionId}${accept.map((rule) => ` --accept ${rule}`).join('')} to roll back exactly this. --expect-active stops it if another revision goes live first.`);
            return ROLLBACK_EXIT_CODES.CONFIRMATION_REQUIRED;
        }
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
        acceptedRules: accept,
        logger: io.logger ?? options.logger,
    });
    const exitCode = ROLLBACK_EXIT_CODES[result.outcome];
    for (const line of resultLines(result)) (exitCode === 0 ? io.out : io.err)(line);
    return exitCode;
}

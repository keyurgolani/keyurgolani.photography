import { readRegistry } from '../identity/registry';
import { dataRootStatus } from '../storage/config';
import { compileCandidate } from './compile';
import { diffCatalog, EMPTY_DIFF_MESSAGE, type CatalogChange, type CatalogDiff } from './diff';
import { parseFlags, UsageError } from './owner-cli';
import { CatalogIntegrityError, listActivations, readRevisionFile, revisionNumberFor } from './repository';
import { hashValue, inboxReviewOf, type FieldReviewState, type ReviewContext } from './review';
import { readReviewContext } from './review-context';
import { INBOX_REASONS, inConflict, isGeneratedAlt, restampReason } from './review-reasons';
import { markAllReviewed, ReviewRefusedError, type MarkReviewedInput } from './review-write';
import { errorText } from './rollback';
import { REVISION_ID_RE, type AuthoredKind } from './schema';
import type { CommandResult } from './sequence-commands';
import type { AuthoredRecord, IssueRecord, RevisionFile, WorkingLayer } from './types';
import { ACTIVE_POINTER_NAME, readActivePointer, readWorkingLayer } from './working-layer';
import { AuthoredWriteError } from './working-layer-writer';

/**
 * `photos diff` and `photos review`, #16's publish ledger on the command
 * line, for a host without the curator. Kept here so tests run them
 * in-process; nothing but the CLI and its tests imports this module.
 *
 * `photos diff` reads what `photos validate` reads, takes no lock and writes
 * nothing, and prints diffCatalog()'s rows grouped as the Publish screen
 * groups them, with the candidate ID and the live revision. `photos review`
 * marks rows reviewed through markFieldsReviewed(), the Publish screen's
 * writer, and only against the candidate and the live revision `photos diff`
 * printed, so a review always covers what the owner saw. It never clears a
 * suggested description, a row its Inbox item settles, or a rebase conflict,
 * and has no `--all` (#182's owner choice): each row is named on its own.
 */

const CHANGE_ID_RE = /^[0-9a-f]{16}$/;

export interface DiffArgs {
    json: boolean;
}

export interface ReviewArgs {
    /** In the order given, once each. */
    changeIds: string[];
    /** The candidate `photos diff` printed. */
    expect: string;
    /** The live revision `photos diff` printed, null for none. */
    expectActive: string | null;
    actor: string;
}

/** `photos diff [--json]`. */
export function diffArgs(args: string[]): DiffArgs {
    const { values } = parseFlags({ args, options: { json: { type: 'boolean' } } });
    return { json: values.json === true };
}

/** `photos review <changeId>... --expect <candidateId> --expect-active <revisionId | none> [--actor <name>]`. */
export function reviewArgs(args: string[], env: Record<string, string | undefined> = process.env): ReviewArgs {
    const { values, positionals } = parseFlags({
        args,
        options: { expect: { type: 'string' }, 'expect-active': { type: 'string' }, actor: { type: 'string' } },
        allowPositionals: true,
    });
    if (positionals.length === 0) throw new UsageError('photos review needs at least one change ID from photos diff.');
    for (const id of positionals) if (!CHANGE_ID_RE.test(id)) throw new UsageError(`${id} is not a change ID: photos diff prints them, 16 hex characters each.`);
    if (values.expect === undefined) throw new UsageError('photos review needs --expect <candidateId>, the candidate photos diff printed.');
    if (!REVISION_ID_RE.test(values.expect)) throw new UsageError(`--expect takes the candidate ID photos diff printed, not ${values.expect}.`);
    const active = values['expect-active'];
    if (active === undefined) throw new UsageError('photos review needs --expect-active <revisionId | none>, the live revision photos diff printed.');
    if (active !== 'none' && !REVISION_ID_RE.test(active)) throw new UsageError(`--expect-active takes the live revision's ID, or none, not ${active}.`);
    const actor = values.actor ?? env.PHOTOS_ACTOR ?? '';
    if (!/\S/.test(actor)) throw new UsageError('photos review needs --actor <name> or PHOTOS_ACTOR.');
    return { changeIds: [...new Set(positionals)], expect: values.expect, expectActive: active === 'none' ? null : active, actor: actor.trim() };
}

/** One read of the data root, as `photos validate` reads it. */
interface Ledger {
    layer: WorkingLayer;
    active: RevisionFile | null;
    /** The live revision's number, null with none. */
    number: number | null;
    candidateId: string;
    review: ReviewContext;
    diff: CatalogDiff;
}

async function readLedger(root: string): Promise<Ledger> {
    const layer = await readWorkingLayer(root);
    const registry = await readRegistry(root);
    const pointer = await readActivePointer(root);
    const active = pointer ? await readRevisionFile(root, pointer.revisionId) : null;
    if (pointer && active === null) throw new CatalogIntegrityError(ACTIVE_POINTER_NAME, `${ACTIVE_POINTER_NAME} names ${pointer.revisionId}, which has no revision file.`);
    const compiled = await compileCandidate({ layer, registry, root, active });
    const review = await readReviewContext(root, layer, pointer?.revisionId ?? null);
    const diff = diffCatalog({ active, candidate: compiled.content, authored: layer, registry, review });
    const number = active ? revisionNumberFor(await listActivations(root), active.revisionId) || null : null;
    return { layer, active, number, candidateId: compiled.candidateId, review, diff };
}

/** The data root, or the command's stop: 3 when it isn't ready, 4 when a catalog file can't be read. */
async function ledgerOf(root: string): Promise<Ledger | CommandResult> {
    const status = dataRootStatus({ root });
    if (status.state !== 'ready') return { exitCode: 3, output: `[photos] DATA_ROOT_NOT_READY: The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}.\n` };
    try {
        return await readLedger(root);
    } catch (error) {
        const outcome = error instanceof CatalogIntegrityError ? 'INTEGRITY_MISMATCH' : 'STORAGE_ERROR';
        return { exitCode: 4, output: `[photos] ${outcome}: ${errorText(error, root)}\n` };
    }
}

const isResult = (value: Ledger | CommandResult): value is CommandResult => 'exitCode' in value;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const against = (ledger: Pick<Ledger, 'active' | 'number'>) => (ledger.active ? `revision ${ledger.number ?? '?'}` : 'an empty site');

function recordIn(layer: WorkingLayer, record: IssueRecord): AuthoredRecord | null {
    if (record.kind === 'site') return layer.site;
    return (record.kind === 'series' ? layer.series : layer.photos).find((entry) => entry.id === record.id) ?? null;
}

/** The Publish screen's groups: source health, derived rows with new bytes, and every other change. */
type Group = 'authored' | 'derived' | 'health';
const GROUPS: { group: Group; heading: string }[] = [{ group: 'authored', heading: 'Authored' }, { group: 'derived', heading: 'Derived' }, { group: 'health', heading: 'Source health' }];
const groupOf = (change: CatalogChange): Group => (change.category === 'missing' ? 'health' : change.category === 'derived' || change.category === 'asset' ? 'derived' : 'authored');

/** What `photos review` can do for a row. */
type Assessment =
    | { kind: 'done'; why: 'already reviewed' | 'needs no review' }
    | { kind: 'clear'; targets: { record: IssueRecord; fields: string[] }[] }
    | { kind: 'refused'; why: string };

/** What a reason the review can't clear needs instead. */
const HINTS: Partial<Record<NonNullable<FieldReviewState['reason']>, string>> = {
    'no-record': 'Its record is gone from the working layer. Restore it from a backup, or publish without the change.',
    'backfill-unreadable': "authored/review-backfill.json can't be read. Restore it from the data-root backup; never edit or delete it.",
};

/**
 * Whether `photos review` may clear a row, by the Publish screen's rules: a
 * rebase conflict is the edit's to settle, an Inbox item that needs a
 * decision again is the Inbox's, whatever reason reads first, and a
 * suggested description is its own fix. Every other open field must wait
 * for a reason a stamp-only review may clear.
 */
function assess(change: CatalogChange, ledger: Ledger): Assessment {
    const conflicted = (record: IssueRecord, field: string) => inConflict(recordIn(ledger.layer, record), field);
    const open = change.review.fields.filter((entry) => entry.state !== 'reviewed');
    if (conflicted(change.record, change.field) || open.some((entry) => conflicted(entry.record, entry.field))) {
        return { kind: 'refused', why: `A restore's rebase left it in conflict with the live revision. Keep one value with photos edit ${change.record.kind === 'site' ? 'site' : change.record.id}, which clears the conflict.` };
    }
    if (change.review.state === 'not-required') return { kind: 'done', why: 'needs no review' };
    if (open.length === 0) return { kind: 'done', why: 'already reviewed' };
    const env = { layer: ledger.layer, active: null, review: ledger.review };
    for (const entry of open) {
        const inbox = entry.reason && INBOX_REASONS.has(entry.reason) ? entry : inboxReviewOf(entry, env);
        if (inbox) {
            return { kind: 'refused', why: inbox.eventId ? `Its Inbox item needs a decision again. Decide it in the Inbox first: curation show ${inbox.eventId}.` : "The inbox couldn't be read. Run photos diff again." };
        }
    }
    for (const entry of open) {
        if (isGeneratedAlt(entry)) return { kind: 'refused', why: `Its description is a suggestion nobody has reviewed. Read it, then write the one you want with photos edit ${entry.record.id}.` };
        if (!restampReason(entry)) return { kind: 'refused', why: HINTS[entry.reason ?? 'no-record'] ?? 'Make the change with photos edit, which reviews what it writes.' };
    }
    const targets = new Map<string, { record: IssueRecord; fields: string[] }>();
    for (const entry of open) {
        const key = `${entry.record.kind}:${entry.record.id}`;
        const target = targets.get(key) ?? { record: entry.record, fields: [] };
        if (!target.fields.includes(entry.field)) target.fields.push(entry.field);
        targets.set(key, target);
    }
    return { kind: 'clear', targets: [...targets.values()] };
}

/**
 * The rows that rest on the same stamps, row by row: two moves in one
 * series share its `photoIds` stamp, and so does a new photograph placed
 * there, so marking one row reviewed marks the others. photos review wants
 * every one of them named. Each row's list holds the others, in ledger
 * order, through any chain of shared fields.
 */
function sharingOf(diff: CatalogDiff): Map<string, string[]> {
    const parent = new Map(diff.changes.map((change) => [change.id, change.id]));
    const find = (id: string): string => {
        const up = parent.get(id) as string;
        if (up === id) return id;
        const top = find(up);
        parent.set(id, top);
        return top;
    };
    const firstWith = new Map<string, string>();
    for (const change of diff.changes) {
        for (const entry of change.review.fields) {
            if (entry.state === 'reviewed') continue;
            const key = `${entry.record.kind}:${entry.record.id}:${entry.field}`;
            const other = firstWith.get(key);
            if (other === undefined) firstWith.set(key, change.id);
            else parent.set(find(change.id), find(other));
        }
    }
    const groups = new Map<string, string[]>();
    for (const change of diff.changes) groups.set(find(change.id), [...(groups.get(find(change.id)) ?? []), change.id]);
    return new Map(diff.changes.map((change) => [change.id, (groups.get(find(change.id)) ?? []).filter((id) => id !== change.id)]));
}

/** Text over this many characters is cut, and the line says how long it was. */
const SHOWN_CHARACTERS = 200;

/** A before or after value as the ledger shows it: text quoted, a description by its words, anything else as compact JSON. */
function shown(value: unknown): string {
    if (value === null || value === undefined) return '(none)';
    const object = typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    if (object && Object.keys(object).length === 1 && typeof object.kind === 'string') return `(${object.kind})`;
    const words = typeof value === 'string' ? value : object?.kind === 'described' && typeof object.text === 'string' ? object.text : null;
    const text = [...(words ?? JSON.stringify(value))];
    const cut = text.length > SHOWN_CHARACTERS;
    const body = cut ? `${text.slice(0, SHOWN_CHARACTERS).join('')}…` : text.join('');
    return `${words === null ? body : JSON.stringify(body)}${cut ? ` (${SHOWN_CHARACTERS} of ${text.length} characters)` : ''}`;
}

/** `photos diff --json`'s schema version. A field it gains keeps it; one it loses or changes moves it on. */
export const DIFF_JSON_SCHEMA_VERSION = 1;

/** One row of `photos diff --json`. */
export interface DiffJsonRow {
    id: string;
    group: Group;
    record: IssueRecord;
    field: string;
    category: CatalogChange['category'];
    before: CatalogChange['before'];
    after: CatalogChange['after'];
    fields?: string[];
    causedBy?: string;
    visible: boolean;
    surfaces: CatalogChange['surfaces'];
    provenance: CatalogChange['provenance'];
    review: { state: CatalogChange['review']['state']; fields: { record: IssueRecord; field: string; state: FieldReviewState['state']; reason: string | null; detail: string | null }[] };
    stale: boolean;
    summary: string;
    /** Whether photos review can mark it, named with `sharedWith`. */
    reviewable: boolean;
    /** Why it can't, or that it needs nothing; null when reviewable. */
    reason: string | null;
    /** The rows marked with it, which photos review wants named too. */
    sharedWith: string[];
}

function jsonRow(change: CatalogChange, assessment: Assessment, sharedWith: string[]): DiffJsonRow {
    return {
        id: change.id,
        group: groupOf(change),
        record: change.record,
        field: change.field,
        category: change.category,
        before: change.before,
        after: change.after,
        ...(change.fields ? { fields: change.fields } : {}),
        ...(change.causedBy ? { causedBy: change.causedBy } : {}),
        visible: change.visible,
        surfaces: change.surfaces,
        provenance: change.provenance,
        review: { state: change.review.state, fields: change.review.fields.map((entry) => ({ record: entry.record, field: entry.field, state: entry.state, reason: entry.reason ?? null, detail: entry.detail ?? null })) },
        stale: change.stale,
        summary: change.summary,
        reviewable: assessment.kind === 'clear',
        reason: assessment.kind === 'clear' ? null : assessment.why,
        sharedWith,
    };
}

/** `photos diff`: the ledger, grouped, with what each row waits on. Exits 0 once it reads, 3 when the data root isn't ready, 4 when a file can't be read. */
export async function runDiffCommand(root: string, args: DiffArgs): Promise<CommandResult> {
    const ledger = await ledgerOf(root);
    if (isResult(ledger)) return ledger;
    const { diff, candidateId, active } = ledger;
    const assessed = new Map(diff.changes.map((change) => [change.id, assess(change, ledger)]));
    const sharing = sharingOf(diff);
    if (args.json) {
        const rows = diff.changes.map((change) => jsonRow(change, assessed.get(change.id) as Assessment, sharing.get(change.id) ?? []));
        const out = { schemaVersion: DIFF_JSON_SCHEMA_VERSION, candidateId, activeRevisionId: active?.revisionId ?? null, activeRevisionNumber: ledger.number, empty: diff.empty, rows };
        return { exitCode: 0, output: `${JSON.stringify(out, null, 2)}\n` };
    }
    const lines: string[] = [];
    const visible = diff.changes.filter((change) => change.visible);
    const waiting = visible.filter((change) => change.review.state === 'unreviewed' || change.review.state === 'stale' || assessed.get(change.id)?.kind === 'refused');
    if (active && candidateId === active.revisionId) {
        lines.push(`[photos] NO_CHANGES: The draft is the live revision, ${against(ledger)}. Nothing to publish.`);
    } else if (diff.empty) {
        lines.push(`[photos] NO_VISIBLE_CHANGES: ${EMPTY_DIFF_MESSAGE}`);
    } else {
        const authored = visible.filter((change) => groupOf(change) === 'authored').length;
        const need = waiting.length === 0 ? 'Nothing needs a review.' : `${plural(waiting.length, 'needs', 'need')} a review.`;
        lines.push(`[photos] DIFF: ${plural(visible.length, 'change', 'changes')} for visitors against ${against(ledger)}: ${authored} authored, ${visible.length - authored} derived. ${need}`);
    }
    lines.push(`Candidate: ${candidateId}`);
    lines.push(active ? `Live: ${active.revisionId} (revision ${ledger.number ?? '?'})` : 'Live: none (nothing is published yet)');
    const command = (ids: string[]) => `photos review ${ids.join(' ')} --expect ${candidateId} --expect-active ${active?.revisionId ?? 'none'}`;
    for (const { group, heading } of GROUPS) {
        const rows = diff.changes.filter((change) => groupOf(change) === group);
        if (rows.length === 0) continue;
        lines.push('', `${heading} (${rows.length})`);
        for (const change of rows) {
            lines.push(`  ${change.id}  ${change.category}  ${change.review.state}  ${change.summary}`);
            if (change.category === 'authored' || change.category === 'route') lines.push(`      Before: ${shown(change.before)}`, `      After:  ${shown(change.after)}`);
            const assessment = assessed.get(change.id);
            const open = change.review.fields.find((entry) => entry.state !== 'reviewed');
            if (open?.detail) lines.push(`      ${open.detail}`);
            if (assessment?.kind === 'clear') lines.push(`      Once it's checked: ${command([change.id, ...(sharing.get(change.id) ?? [])])}`);
            if (assessment?.kind === 'refused') lines.push(`      photos review can't clear it: ${assessment.why}`);
        }
    }
    return { exitCode: 0, output: `${lines.join('\n')}\n` };
}

/** Test hooks for runReviewCommand(). */
export interface ReviewHooks {
    /** After the draft is read and the rows checked, before the authored lock is taken. */
    afterRead?: () => Promise<unknown>;
}

/**
 * `photos review`: mark the named rows reviewed, or none of them. Every
 * record is checked under one hold on the authored lock before any is
 * written. Exits 0 when they're marked or need nothing, 1 when one can't be
 * cleared here, 3 when the draft, the live revision or a record changed
 * since `photos diff` printed them, or the authored lock stays busy, and 4
 * when a file can't be read or written.
 */
export async function runReviewCommand(root: string, args: ReviewArgs, hooks: ReviewHooks = {}): Promise<CommandResult> {
    const ledger = await ledgerOf(root);
    if (isResult(ledger)) return ledger;
    const live = ledger.active?.revisionId ?? null;
    if (live !== args.expectActive) {
        return { exitCode: 3, output: `[photos] CHANGED: The live revision is ${live ?? 'none'} now, not ${args.expectActive ?? 'none'}, so photos diff compared against another one. Nothing was written. Run photos diff again.\n` };
    }
    if (ledger.candidateId !== args.expect) {
        return { exitCode: 3, output: `[photos] CHANGED: The draft changed since photos diff printed it: it compiles to ${ledger.candidateId}, not ${args.expect}. Nothing was written. Run photos diff again and check what changed.\n` };
    }
    const byId = new Map(ledger.diff.changes.map((change) => [change.id, change]));
    const sharing = sharingOf(ledger.diff);
    const named = new Set(args.changeIds);
    const refused: string[] = [];
    const done: string[] = [];
    const clear: { change: CatalogChange; targets: { record: IssueRecord; fields: string[] }[] }[] = [];
    for (const id of args.changeIds) {
        const change = byId.get(id);
        if (!change) {
            refused.push(`  ${id}  photos diff has no such row. Run photos diff and use an ID it prints.`);
            continue;
        }
        const assessment = assess(change, ledger);
        if (assessment.kind === 'refused') refused.push(`  ${id}  ${assessment.why}`);
        else if (assessment.kind === 'done') done.push(`  ${id}  ${assessment.why}: ${change.summary}`);
        else {
            // No --all: a row that shares its stamps with others is marked only with all of them named.
            const missing = (sharing.get(id) ?? []).filter((other) => !named.has(other));
            if (missing.length > 0) refused.push(`  ${id}  It shares its review with ${missing.join(', ')}, so marking it would mark them too. Name them too, once you've checked them.`);
            else clear.push({ change, targets: assessment.targets });
        }
    }
    if (refused.length > 0) {
        const n = args.changeIds.length;
        const which = refused.length === n ? (n === 1 ? 'this row' : 'these rows') : `${refused.length} of the ${n} rows`;
        return { exitCode: 1, output: `[photos] REFUSED: photos review can't mark ${which} reviewed, so nothing was written.\n${refused.join('\n')}\n` };
    }
    if (clear.length === 0) {
        return { exitCode: 0, output: `[photos] NOTHING_TO_REVIEW: ${args.changeIds.length === 1 ? 'The row needs' : 'The rows need'} nothing more. Nothing was written.\n${done.join('\n')}\n` };
    }

    // One write per record, stamping every field the rows wait on there, with the values the draft holds now.
    const records = new Map<string, { record: IssueRecord; fields: Set<string> }>();
    for (const { targets } of clear) {
        for (const target of targets) {
            const key = `${target.record.kind}:${target.record.id}`;
            const entry = records.get(key) ?? { record: target.record, fields: new Set<string>() };
            for (const field of target.fields) entry.fields.add(field);
            records.set(key, entry);
        }
    }
    const inputs: MarkReviewedInput[] = [];
    for (const { record: ref, fields } of records.values()) {
        const record = recordIn(ledger.layer, ref);
        if (record === null) return stopped(1, `The ${ref.kind} record ${ref.id} is gone from the working layer.`);
        const hashes = Object.fromEntries([...fields].map((field) => [field, hashValue((record as unknown as Record<string, unknown>)[field])]));
        inputs.push({ root, record: { kind: ref.kind as AuthoredKind, id: ref.id }, version: record.version, hashes, baseRevisionId: live, actor: args.actor });
    }
    await hooks.afterRead?.();
    try {
        await markAllReviewed(inputs);
    } catch (error) {
        if (error instanceof ReviewRefusedError) return stopped(error.code === 'active-moved' ? 3 : 1, error.message);
        if (error instanceof AuthoredWriteError) {
            if (error.code === 'VERSION_CONFLICT') return stopped(3, `The ${error.record.kind} record ${error.record.id} changed since photos diff read it.`);
            if (error.code === 'AUTHORED_LOCKED') return stopped(3, `Another write holds the working catalog. ${errorText(error, root)}`);
            if (error.code === 'INVALID_RECORD') return stopped(1, errorText(error, root));
        }
        return stopped(4, errorText(error, root), inputs.map((input) => `${input.record.kind}:${input.record.id}`));
    }
    const lines = [
        `[photos] REVIEWED: Marked ${plural(clear.length, 'row', 'rows')} reviewed against ${against(ledger)}. Nothing was published.`,
        ...clear.map(({ change }) => `  ${change.id}  ${change.summary}`),
        ...done,
        `Run photos diff to see what still needs a review, then photos publish --expect ${ledger.candidateId}.`,
    ];
    return { exitCode: 0, output: `${lines.join('\n')}\n` };
}

/**
 * A review that stopped. Every check runs before the first write, so a
 * refusal, a moved record or a busy lock wrote nothing. An I/O error part way
 * through the writes may have left some of `maybe` marked.
 */
function stopped(exitCode: 1 | 3 | 4, why: string, maybe: readonly string[] = []): CommandResult {
    const outcome = exitCode === 3 ? 'CHANGED' : exitCode === 1 ? 'REFUSED' : 'STORAGE_ERROR';
    const after = maybe.length === 0 ? 'Nothing was written.' : `It may have marked some of ${maybe.join(', ')} before it stopped; photos diff shows which.`;
    return { exitCode, output: `[photos] ${outcome}: ${sentence(why)} ${after} Run photos diff again.\n` };
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

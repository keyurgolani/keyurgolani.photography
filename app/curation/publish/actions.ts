'use server';

import { revalidatePath } from 'next/cache';
import { publish, type PublishResult } from '@/lib/catalog/publish';
import { previewDraftId } from '@/lib/catalog/preview-reader';
import { listActivations, readRevisionFile, revisionNumberFor } from '@/lib/catalog/repository';
import { rollback } from '@/lib/catalog/rollback';
import { REVISION_ID_RE } from '@/lib/catalog/schema';
import { hashValue } from '@/lib/catalog/review';
import type { AuthoredKind } from '@/lib/catalog/schema';
import { checkReviewable, markFieldsReviewed, ReviewRefusedError } from '@/lib/catalog/review-write';
import { readActivePointer, readAuthoredRecord } from '@/lib/catalog/working-layer';
import { AuthoredWriteError, writeAuthoredRecord } from '@/lib/catalog/working-layer-writer';
import { requireCurator } from '@/lib/curation/auth';
import { WEB_ACTOR } from '@/lib/curation/inbox-form';
import { countLine, rollbackStakes, type Answer, type Intent, type Publisher, type PublishState } from '@/lib/curation/publish-facts';
import { blockingReasons, editorialWords, restoreResult, type RestoreAnswer, type RestoreState } from '@/lib/curation/publish-history';
import { dataRootStatus } from '@/lib/storage/config';
import { loadHistoryView, numberFrom } from './history-load';
import { ledgerOf, pointerFacts, readinessOf, readSnapshot, type Snapshot } from './load';

/**
 * The Publish screen's one server action (16-3). Every intent calls
 * requireCurator() first, before it reads its arguments, as the Inbox's
 * actions do, so a request the boundary refuses gets its answer and writes
 * nothing. Validate and Publish run the same publish() the CLI runs, with the
 * candidate the page previewed as `expectedRevisionId`, so publish() stops
 * with CANDIDATE_CHANGED if anything moved after the page loaded (Keep 9).
 * The two review fixes write stamps only, through #13's one authored write
 * path, and refuse when the value or the record's version moved.
 */

const REASON = 'Publish screen';
const INTENTS: readonly Intent[] = ['validate', 'publish', 'mark-description', 'mark-reviewed'];
const AUTHORED_KINDS: readonly AuthoredKind[] = ['site', 'series', 'photo'];

const text = (form: FormData, name: string): string | null => {
    const value = form.get(name);
    return typeof value === 'string' ? value : null;
};

const integer = (form: FormData, name: string): number | null => {
    const value = text(form, name);
    return value !== null && /^\d{1,9}$/.test(value) ? Number(value) : null;
};

function next(previous: PublishState, intent: Intent | null, answer: Answer): PublishState {
    const result = answer.kind === 'fixed' ? null : answer.kind === 'fix-refused' ? previous.result : answer;
    return { serial: previous.serial + 1, intent, answer, result };
}

/** Who made the active revision live, from its activation. The screen words it, in the browser's time zone. */
function publisherOf(activation: { actor: string; kind: 'publish' | 'rollback'; committedAt?: string; startedAt: string } | null): Publisher | null {
    return activation ? { actor: activation.actor, kind: activation.kind, at: activation.committedAt ?? activation.startedAt } : null;
}

/** The working catalog read again for an answer's ledger: null when it can't be read, or now compiles to another candidate than publish() checked. */
async function snapshotFor(result: PublishResult): Promise<Snapshot | 'moved' | null> {
    try {
        const snapshot = await readSnapshot();
        if (snapshot === null) return null;
        return result.candidateId !== null && snapshot.compiled.candidateId !== result.candidateId ? 'moved' : snapshot;
    } catch (error) {
        console.error('[curation] The Publish screen could not read the working catalog again for an answer:', error);
        return null;
    }
}

const changedBody = (live: number | undefined) => `It changed after this page loaded, so nothing was published.${live ? ` Revision ${live} stays live.` : ''}`;

/** An answer for what publish() returned, for Validate (`dryRun`) or Publish. */
async function answerFor(result: PublishResult, intent: 'validate' | 'publish', draftId: string, pageActive: string | null): Promise<Answer> {
    const root = dataRootStatus().root;
    const pointer = root ? await pointerFacts(root).catch(() => null) : null;
    switch (result.outcome) {
        case 'DRY_RUN_OK': {
            const snapshot = await snapshotFor(result);
            if (snapshot === 'moved') return { kind: 'changed', body: changedBody(pointer?.live.number) };
            const counted = snapshot ? countLine(ledgerOf(snapshot, null).ledger, 0) : '';
            const n = Number(/^(\d+)/.exec(counted)?.[1] ?? 0);
            // #117: the clause follows the rollback-ready line's gate, and names the fix in its place on evidence of a problem.
            const ready = root && pointer ? await readinessOf(root, pointer.live.revisionId, snapshot?.registry) : null;
            const stakes = pointer && ready ? rollbackStakes(pointer.live.number, ready) : '';
            return { kind: 'valid', stakes: `Publishing makes ${n === 1 ? 'this change' : `these ${n} changes`} live on every page.${stakes}` };
        }
        case 'VALIDATION_FAILED': {
            // The diagnostics join onto a ledger of the candidate publish() checked, never a newer one.
            const snapshot = await snapshotFor(result);
            if (snapshot === 'moved') return { kind: 'changed', body: changedBody(pointer?.live.number) };
            if (snapshot === null) break;
            const { ledger, blockers } = ledgerOf(snapshot, result.issues);
            const k = blockers.length;
            const live = pointer?.live.number;
            const stays = live ? ` Revision ${live} stays live.` : '';
            if (intent === 'validate') {
                const number = await draftNumberOf(root, draftId);
                return { kind: 'blocked', lead: `${k} ${k === 1 ? 'change needs' : 'changes need'} you before revision ${number} can publish.${stays}`, blockers, ledger };
            }
            return { kind: 'blocked-at-publish', lead: `${k} ${k === 1 ? 'change' : 'changes'} went stale since you validated.${stays}`, blockers, ledger };
        }
        case 'CANDIDATE_CHANGED':
            if (pointer && pointer.live.revisionId !== pageActive) {
                return { kind: 'someone-published', live: pointer.live, previous: pointer.previous, by: publisherOf(pointer.activation) };
            }
            return { kind: 'changed', body: changedBody(pointer?.live.number) };
        case 'NO_CHANGES':
            if (pointer) return { kind: 'already-live', live: pointer.live, previous: pointer.previous, by: publisherOf(pointer.activation) };
            break;
        case 'PUBLISHED':
            if (pointer) return { kind: 'published', live: pointer.live, previous: pointer.previous };
            break;
        case 'CATALOG_LOCKED':
        case 'AUTHORED_LOCKED':
            return { kind: 'busy', lock: result.outcome === 'CATALOG_LOCKED' ? 'catalog' : 'authored', since: result.holder?.acquiredAt ?? null, retry: intent };
        default:
            break;
    }
    // Every other stop: the screen read the pointer again, so the facts say whether the new revision went live.
    const number = await draftNumberOf(root, draftId);
    if (intent === 'publish' && pointer && pointer.live.revisionId === draftId) {
        return { kind: 'failed', heading: `Revision ${pointer.live.number} is live, but the publish didn't finish`, body: 'The server log names what failed. Publish again to finish it.', live: pointer.live, previous: pointer.previous, retry: 'publish' };
    }
    const live = pointer ? `Revision ${pointer.live.number} is still live, and visitors see no change. ` : '';
    if (intent === 'validate') {
        const still = pointer ? `Revision ${pointer.live.number} is still live. ` : '';
        return { kind: 'failed', heading: `Validating revision ${number} stopped`, body: `${still}The server log names what failed. Validate again to retry.`, live: null, previous: null, retry: 'validate' };
    }
    return { kind: 'failed', heading: `The publish stopped before revision ${number} went live`, body: `${live}The server log names what failed. Publish again to retry.`, live: null, previous: null, retry: 'publish' };
}

/** The number the page's candidate would get, read again for an answer's sentence. */
async function draftNumberOf(root: string | null, draftId: string): Promise<number> {
    if (root === null) return 0;
    return revisionNumberFor(await listActivations(root).catch(() => []), draftId);
}

async function validateOrPublish(previous: PublishState, form: FormData, intent: 'validate' | 'publish'): Promise<PublishState> {
    const draftId = previewDraftId(text(form, 'draftId'));
    const pageActive = previewDraftId(text(form, 'active'));
    if (draftId === null) return next(previous, intent, { kind: 'changed', body: 'The page sent no draft it previewed, so nothing was published. Load the updated ledger.' });
    // Publish waits for a validation of this exact candidate on this page. publish() runs every rule again anyway.
    if (intent === 'publish' && text(form, 'validated') !== draftId) return next(previous, intent, { kind: 'not-validated' });
    const status = dataRootStatus({ write: true });
    if (status.state !== 'ready' || status.root === null) {
        return next(previous, intent, { kind: 'failed', heading: "The data root isn't ready", body: 'Nothing was published. The server log names what failed.', live: null, previous: null, retry: intent });
    }
    const result = await publish({ dataRoot: status.root, actor: WEB_ACTOR, reason: REASON, dryRun: intent === 'validate', expectedRevisionId: draftId });
    // No revalidatePath here: the site reads the active pointer per request, as after a CLI publish, and revalidating
    // would render this page again from the new pointer, as Nothing to publish, in place of the answer.
    try {
        return next(previous, intent, await withHistory(await answerFor(result, intent, draftId, pageActive), status.root, form));
    } catch (error) {
        // An answer's own read failed. The pointer is read again in the answer, so this says nothing about it either way.
        console.error('[curation] The Publish screen could not word an answer:', error);
        const live = result.outcome === 'PUBLISHED' || result.outcome === 'NO_CHANGES' ? 'It may have gone live. ' : '';
        return next(previous, intent, { kind: 'failed', heading: "The screen couldn't read the result", body: `${live}The server log names what failed. Load the page again to see what is live.`, live: null, previous: null, retry: intent });
    }
}

/**
 * 15-4: an answer that moved the pointer, or found it moved, carries History
 * read again, so the section below marks the new live revision and drops
 * Restore from it (spec, History by 16-3 state). Changed meanwhile moved only
 * the candidate, so its History still holds.
 */
async function withHistory(answer: Answer, root: string, form: FormData): Promise<Answer> {
    const moved = answer.kind === 'published' || answer.kind === 'already-live' || answer.kind === 'someone-published' || (answer.kind === 'failed' && answer.live !== null);
    if (!moved) return answer;
    try {
        // Someone else's publish leaves this page's draft pending; this page's own leaves nothing. The bar's form
        // posts how many entries the page shows and the revision it checked, so the answer keeps History as it was.
        const history = await loadHistoryView(root, { draftPending: answer.kind === 'someone-published', shown: numberFrom(text(form, 'historyShown')), check: numberFrom(text(form, 'historyCheck')) });
        return { ...answer, history };
    } catch (error) {
        // The answer stands without it, and History stays as loaded; Restore's precondition still refuses a stale one.
        console.error('[curation] History could not be read again for the answer:', error);
        return answer;
    }
}

const refused = (previous: PublishState, intent: Intent, rowId: string, what: string) =>
    next(previous, intent, { kind: 'fix-refused', rowId, text: `${what} changed since the page loaded, so nothing was written.` });

/** A review fix the screen's own rules refuse: the text says why. */
class FixRefused extends Error {}

/**
 * Write `record` as it is, stamping what the curator reviewed, or say why
 * nothing was written. The stamp's base is the live revision the page
 * compared against, so a fix refuses once the pointer has moved since.
 */
async function stamp(previous: PublishState, form: FormData, intent: Intent, rowId: string, what: string, write: (root: string, base: string | null) => Promise<unknown>): Promise<PublishState> {
    const status = dataRootStatus({ write: true });
    if (status.state !== 'ready' || status.root === null) return next(previous, intent, { kind: 'fix-refused', rowId, text: "The data root isn't ready, so nothing was written." });
    const pageActive = previewDraftId(text(form, 'active'));
    try {
        const pointer = await readActivePointer(status.root);
        if (pageActive === null || pointer?.revisionId !== pageActive) throw new FixRefused('The live revision changed since the page loaded, so nothing was written.');
        await write(status.root, pageActive);
    } catch (error) {
        if (error instanceof FixRefused) return next(previous, intent, { kind: 'fix-refused', rowId, text: error.message });
        if (error instanceof ReviewRefusedError) return reviewRefused(previous, intent, rowId, what, error);
        if (error instanceof AuthoredWriteError && error.code === 'VERSION_CONFLICT') return refused(previous, intent, rowId, what);
        if (error instanceof AuthoredWriteError && error.code === 'AUTHORED_LOCKED') return next(previous, intent, { kind: 'fix-refused', rowId, text: 'Another write holds the working catalog, so nothing was written. Try again in a moment.' });
        console.error('[curation] A Publish screen review could not be written:', error);
        return next(previous, intent, { kind: 'fix-refused', rowId, text: "The review couldn't be written, so nothing changed. The server log names what failed." });
    }
    // A fix changes the review context, so the page reads the ledger again and the curator validates again.
    revalidatePath('/curation/publish');
    return next(previous, intent, { kind: 'fixed', rowId });
}

/**
 * `reviewedAt` is taken before the fresh read that checks the fields, so an
 * inbox replacement observed after that read is newer than the stamp and
 * still reads as `newer-item` (high review N2).
 */
const reviewInputs = (base: string | null, reviewedAt: string, extra: { reviewedValues?: Record<string, string> } = {}) => ({ baseRevisionId: base, origin: 'curator' as const, actor: WEB_ACTOR, reviewedAt, ...extra });

const INBOX_FIRST = 'Its Inbox item needs a decision again, so nothing was written. Decide it in the Inbox first.';

/**
 * The fixes table, enforced in lib/catalog/review-write.ts as well as on the
 * screen (spec decision 3), in the screen's words: no inbox item a stamp
 * names may need a decision, and each field must wait for a reason the fix
 * may clear.
 */
function reviewRefused(previous: PublishState, intent: Intent, rowId: string, what: string, error: ReviewRefusedError): PublishState {
    if (error.code === 'inbox') return next(previous, intent, { kind: 'fix-refused', rowId, text: INBOX_FIRST });
    if (error.code === 'active-moved') return next(previous, intent, { kind: 'fix-refused', rowId, text: 'The live revision changed since the page loaded, so nothing was written.' });
    if (error.code === 'conflict') return next(previous, intent, { kind: 'fix-refused', rowId, text: 'This field changed both here and in the live revision, so nothing was written. Keep one value with photos edit, which clears the conflict.' });
    return refused(previous, intent, rowId, what);
}

/** Review and mark description ready: the same photo record with `alt.reviewed: true`, refused when the alt isn't the one shown. */
async function markDescriptionReady(previous: PublishState, form: FormData): Promise<PublishState> {
    const rowId = text(form, 'rowId') ?? '';
    const photoId = text(form, 'photoId') ?? '';
    const version = integer(form, 'version');
    const valueHash = text(form, 'valueHash');
    if (version === null || valueHash === null) return refused(previous, 'mark-description', rowId, 'The description');
    return stamp(previous, form, 'mark-description', rowId, 'The description', async (root, base) => {
        const record = await readAuthoredRecord(root, 'photo', photoId);
        if (record === null || record.version !== version || record.alt?.kind !== 'described' || hashValue(record.alt) !== valueHash) {
            throw new AuthoredWriteError('VERSION_CONFLICT', { kind: 'photo', id: photoId }, 'The description moved.');
        }
        const reviewedAt = new Date().toISOString();
        await checkReviewable(root, { kind: 'photo', id: photoId }, ['alt'], (state) => state.reason === 'generated');
        // The description came from an inbox item, so its new stamp still names that item, and reopening it makes the description stale again.
        const event = record.review?.fields.alt?.event;
        await writeAuthoredRecord({ ...record, alt: { ...record.alt, reviewed: true } }, { expectedVersion: version, root, review: { ...reviewInputs(base, reviewedAt), ...(event ? { event } : {}) } });
    });
}

/** Still right, mark reviewed: the same record, its listed fields stamped against the active revision, refused when a value or the version moved. */
async function markReviewed(previous: PublishState, form: FormData): Promise<PublishState> {
    const rowId = text(form, 'rowId') ?? '';
    const what = `The ${text(form, 'field') ?? 'change'}`;
    const kind = text(form, 'kind') as AuthoredKind | null;
    const id = text(form, 'id') ?? '';
    const version = integer(form, 'version');
    let hashes: Record<string, string> | null = null;
    try {
        const parsed: unknown = JSON.parse(text(form, 'hashes') ?? 'null');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.values(parsed).every((value) => typeof value === 'string')) hashes = parsed as Record<string, string>;
    } catch {
        hashes = null;
    }
    if (kind === null || !AUTHORED_KINDS.includes(kind) || version === null || hashes === null || Object.keys(hashes).length === 0) return refused(previous, 'mark-reviewed', rowId, what);
    const shown = hashes;
    // The fields are the client's to name, so markFieldsReviewed() checks each waits for a reason a review may clear, as photos review's do.
    return stamp(previous, form, 'mark-reviewed', rowId, what, (root, base) => markFieldsReviewed({ root, record: { kind, id }, version, hashes: shown, baseRevisionId: base, actor: WEB_ACTOR }));
}

/** The screen's one action: the form's `intent` picks Validate, Publish, or a review fix. */
export async function publishAction(previous: PublishState, form: FormData): Promise<PublishState> {
    await requireCurator();
    const raw = text(form, 'intent');
    const intent = INTENTS.find((entry) => entry === raw) ?? null;
    if (intent === 'validate' || intent === 'publish') return validateOrPublish(previous, form, intent);
    if (intent === 'mark-description') return markDescriptionReady(previous, form);
    if (intent === 'mark-reviewed') return markReviewed(previous, form);
    return previous;
}

// 15-4's restore.

const RESTORE_REASON_MAX = 500;
/** A rule ID's shape, `accent.contrast`; the dialog posts one `accept` per box it showed checked. */
const RULE_ID_RE = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/;
const ACCEPT_LENGTH_MAX = 64;
const ACCEPTS_MAX = 16;

/**
 * The `accept` fields as rollback()'s acceptedRules: strings shaped like a
 * rule ID, at most 64 characters and at most 16 of them, deduplicated. The
 * rest are dropped, never echoed. rollback() then accepts only the flagged
 * editorial rules among them, so this shapes the input and isn't the gate.
 */
function acceptedFrom(form: FormData): string[] {
    const ids = form.getAll('accept').filter((value): value is string => typeof value === 'string' && value.length <= ACCEPT_LENGTH_MAX && RULE_ID_RE.test(value));
    return [...new Set(ids)].slice(0, ACCEPTS_MAX);
}

const restoreState = (previous: RestoreState, answer: RestoreAnswer): RestoreState => ({ serial: previous.serial + 1, answer });

/**
 * History's restore: 15-2's rollback(), as `photos rollback --to <id>
 * --expect-active <id> --yes` runs it, with the actor `curator:web` and the
 * owner's reason. requireCurator() first, before any field is read: a server
 * action is always a mutation, so the boundary checks the session and the
 * Origin. The active revision the dialog showed is the compare-and-swap
 * precondition, and the catalog lock isn't waited for (`waitMs: 0`, as
 * publish() takes it), so a held lock answers at once. A done restore
 * returns the new activation's sequence, and the screen loads
 * `?restored=<sequence>`; every other outcome is an answer in the dialog.
 * #117: the dialog's checked boxes post as `accept`, and rollback() is the
 * gate: a post missing an accept for any flagged editorial rule answers
 * ACCEPTANCE_REQUIRED and writes nothing, whatever the dialog did.
 */
export async function restoreAction(previous: RestoreState, form: FormData): Promise<RestoreState> {
    await requireCurator();
    const revisionId = text(form, 'revisionId') ?? '';
    const expected = text(form, 'expectedActive') ?? '';
    const reason = (text(form, 'reason') ?? '').trim();
    const acceptedRules = acceptedFrom(form);
    const status = dataRootStatus({ write: true });
    const root = status.root;
    const activations = root ? await listActivations(root).catch(() => []) : [];
    const numberOf = (id: string) => (REVISION_ID_RE.test(id) ? revisionNumberFor(activations, id) : 0);
    const facts = { target: numberOf(revisionId), active: numberOf(expected), activeRevisionId: expected, targetRevisionId: revisionId, pointer: null, liveBy: null, holderSince: null, reasons: [], settled: false };
    if (!REVISION_ID_RE.test(revisionId) || !REVISION_ID_RE.test(expected)) return restoreState(previous, { kind: 'result', result: restoreResult('NOT_ELIGIBLE', facts) });
    if (!/\S/.test(reason) || reason.length > RESTORE_REASON_MAX) return restoreState(previous, { kind: 'reason-missing' });
    if (status.state !== 'ready' || root === null) return restoreState(previous, { kind: 'result', result: restoreResult('DATA_ROOT_NOT_READY', facts) });

    const result = await rollback({ dataRoot: root, revisionId, expectedActiveRevisionId: expected, actor: WEB_ACTOR, reason, acceptedRules, waitMs: 0 });
    if (result.outcome === 'ROLLED_BACK' && result.activation) return restoreState(previous, { kind: 'restored', sequence: result.activation.sequence, rebased: result.rebased !== false });

    // Every other answer reads the pointer again, as Publish's do, so the dialog says what's live now.
    const pointer = await pointerFacts(root).catch(() => null);
    const live = pointer?.activation ?? null;
    let reasons: string[] = [];
    if (result.outcome === 'VALIDATION_FAILED') {
        const target = await readRevisionFile(root, revisionId).catch(() => null);
        const titles = new Map((target?.content.photos ?? []).map((photo) => [photo.id, photo.title ?? '']));
        const blocking = result.plan?.blocking ?? result.issues.filter((issue) => issue.severity === 'error');
        reasons = blockingReasons(blocking, (photoId) => titles.get(photoId) || `Photograph ${photoId.slice(3, 11)}`);
    }
    if (result.outcome === 'ACCEPTANCE_REQUIRED') {
        const titles = result.plan?.seriesTitles ?? {};
        reasons = editorialWords(result.plan?.issues ?? [], result.unaccepted ?? [], (seriesId) => titles[seriesId] || `Series ${seriesId.slice(4, 12)}`);
    }
    // The expected stops, which the dialog explains, aren't logged.
    const expectedStops = ['NO_CHANGES', 'ACTIVE_CHANGED', 'CATALOG_LOCKED', 'VALIDATION_FAILED', 'ACCEPTANCE_REQUIRED'];
    if (!expectedStops.includes(result.outcome)) {
        console.error(`[curation] A restore from the Publish screen stopped: ${result.outcome}: ${result.message}`);
    }
    return restoreState(previous, {
        kind: 'result',
        result: restoreResult(result.outcome, {
            ...facts,
            pointer: pointer ? { revisionId: pointer.live.revisionId, number: pointer.live.number || null } : null,
            liveBy: live ? { actor: live.actor, kind: live.kind, at: live.committedAt ?? live.startedAt } : null,
            holderSince: result.holder?.acquiredAt ?? null,
            reasons,
            settled: Boolean(result.recovery?.committed),
        }),
    });
}

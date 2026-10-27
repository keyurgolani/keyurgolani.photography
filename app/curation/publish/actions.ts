'use server';

import { revalidatePath } from 'next/cache';
import { publish, type PublishResult } from '@/lib/catalog/publish';
import { previewDraftId } from '@/lib/catalog/preview-reader';
import { listActivations, revisionNumberFor } from '@/lib/catalog/repository';
import { hashValue } from '@/lib/catalog/review';
import type { AuthoredKind } from '@/lib/catalog/schema';
import type { AuthoredRecord } from '@/lib/catalog/types';
import { readActivePointer, readAuthoredRecord } from '@/lib/catalog/working-layer';
import { AuthoredWriteError, writeAuthoredRecord } from '@/lib/catalog/working-layer-writer';
import { requireCurator } from '@/lib/curation/auth';
import { WEB_ACTOR } from '@/lib/curation/inbox-form';
import { countLine, timeOf, type Answer, type Intent, type PublishState } from '@/lib/curation/publish-facts';
import { dataRootStatus } from '@/lib/storage/config';
import { ledgerOf, pointerFacts, readSnapshot } from './load';

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

/** Who published the active revision, and when, in the owner's words. */
function publishedBy(activation: { actor: string; committedAt?: string; startedAt: string } | null, sentence: 'live' | 'cli'): string {
    if (activation === null) return sentence === 'live' ? 'It is live now.' : 'It went live from the command line.';
    const at = timeOf(activation.committedAt ?? activation.startedAt);
    if (activation.actor === WEB_ACTOR) return `It went live from this screen at ${at}.`;
    return `${activation.actor} published it at ${at}, with photos publish.`;
}

/** An answer for what publish() returned, for Validate (`dryRun`) or Publish. */
async function answerFor(result: PublishResult, intent: 'validate' | 'publish', draftId: string, pageActive: string | null): Promise<Answer> {
    const root = dataRootStatus().root;
    const pointer = root ? await pointerFacts(root).catch(() => null) : null;
    switch (result.outcome) {
        case 'DRY_RUN_OK': {
            const snapshot = await readSnapshot();
            const counted = snapshot ? countLine(ledgerOf(snapshot, null).ledger, 0) : '';
            const n = Number(/^(\d+)/.exec(counted)?.[1] ?? 0);
            const live = pointer?.live.number;
            return { kind: 'valid', stakes: `Publishing makes ${n === 1 ? 'this change' : `these ${n} changes`} live on every page.${live ? ` Revision ${live} stays rollback-ready.` : ''}` };
        }
        case 'VALIDATION_FAILED': {
            const snapshot = await readSnapshot();
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
                return { kind: 'someone-published', live: pointer.live, previous: pointer.previous, by: publishedBy(pointer.activation, 'cli') };
            }
            return { kind: 'changed', body: `It changed after this page loaded, so nothing was published.${pointer ? ` Revision ${pointer.live.number} stays live.` : ''}` };
        case 'NO_CHANGES':
            if (pointer) return { kind: 'already-live', live: pointer.live, previous: pointer.previous, by: publishedBy(pointer.activation, 'live') };
            break;
        case 'PUBLISHED':
            if (pointer) return { kind: 'published', live: pointer.live, previous: pointer.previous };
            break;
        case 'CATALOG_LOCKED':
        case 'AUTHORED_LOCKED': {
            const since = result.holder?.acquiredAt ? ` It started at ${timeOf(result.holder.acquiredAt)}.` : '';
            const again = intent === 'validate' ? 'Validate again when it finishes.' : 'Publish again when it finishes.';
            return { kind: 'busy', body: `${since.trim()} Nothing changed here. ${again}`.trim(), retry: intent };
        }
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
        return { kind: 'failed', heading: `Validating revision ${number} stopped`, body: `Nothing was published. ${live}The server log names what failed. Validate again to retry.`, live: null, previous: null, retry: 'validate' };
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
        return next(previous, intent, { kind: 'failed', heading: 'The data root isn’t ready', body: 'Nothing was published. The server log names what failed.', live: null, previous: null, retry: intent });
    }
    const result = await publish({ dataRoot: status.root, actor: WEB_ACTOR, reason: REASON, dryRun: intent === 'validate', expectedRevisionId: draftId });
    // No revalidatePath here: the site reads the active pointer per request, as after a CLI publish, and revalidating
    // would render this page again from the new pointer, as Nothing to publish, in place of the answer.
    return next(previous, intent, await answerFor(result, intent, draftId, pageActive));
}

const refused = (previous: PublishState, intent: Intent, rowId: string, what: string) =>
    next(previous, intent, { kind: 'fix-refused', rowId, text: `${what} changed since the page loaded, so nothing was written.` });

/** Write `record` as it is, stamping what the curator reviewed, or say why nothing was written. */
async function stamp(previous: PublishState, intent: Intent, rowId: string, what: string, write: (root: string, base: string | null) => Promise<unknown>): Promise<PublishState> {
    const status = dataRootStatus({ write: true });
    if (status.state !== 'ready' || status.root === null) return next(previous, intent, { kind: 'fix-refused', rowId, text: 'The data root isn’t ready, so nothing was written.' });
    try {
        const pointer = await readActivePointer(status.root);
        await write(status.root, pointer?.revisionId ?? null);
    } catch (error) {
        if (error instanceof AuthoredWriteError && error.code === 'VERSION_CONFLICT') return refused(previous, intent, rowId, what);
        if (error instanceof AuthoredWriteError && error.code === 'AUTHORED_LOCKED') return next(previous, intent, { kind: 'fix-refused', rowId, text: 'Another write holds the working catalog, so nothing was written. Try again in a moment.' });
        console.error('[curation] A Publish screen review could not be written:', error);
        return next(previous, intent, { kind: 'fix-refused', rowId, text: 'The review couldn’t be written, so nothing changed. The server log names what failed.' });
    }
    // A fix changes the review context, so the page reads the ledger again and the curator validates again.
    revalidatePath('/curation/publish');
    return next(previous, intent, { kind: 'fixed', rowId });
}

const reviewInputs = (base: string | null, extra: { reviewedValues?: Record<string, string> } = {}) => ({ baseRevisionId: base, origin: 'curator' as const, actor: WEB_ACTOR, reviewedAt: new Date().toISOString(), ...extra });

/** Review and mark description ready: the same photo record with `alt.reviewed: true`, refused when the alt isn't the one shown. */
async function markDescriptionReady(previous: PublishState, form: FormData): Promise<PublishState> {
    const rowId = text(form, 'rowId') ?? '';
    const photoId = text(form, 'photoId') ?? '';
    const version = integer(form, 'version');
    const valueHash = text(form, 'valueHash');
    if (version === null || valueHash === null) return refused(previous, 'mark-description', rowId, 'The description');
    return stamp(previous, 'mark-description', rowId, 'The description', async (root, base) => {
        const record = await readAuthoredRecord(root, 'photo', photoId);
        if (record === null || record.version !== version || record.alt?.kind !== 'described' || hashValue(record.alt) !== valueHash) {
            throw new AuthoredWriteError('VERSION_CONFLICT', { kind: 'photo', id: photoId }, 'The description moved.');
        }
        await writeAuthoredRecord({ ...record, alt: { ...record.alt, reviewed: true } }, { expectedVersion: version, root, review: reviewInputs(base) });
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
    return stamp(previous, 'mark-reviewed', rowId, what, async (root, base) => {
        const record = (await readAuthoredRecord(root, kind, id)) as AuthoredRecord | null;
        const moved = record === null || record.version !== version || Object.entries(shown).some(([field, hash]) => hashValue((record as unknown as Record<string, unknown>)[field]) !== hash);
        if (moved) throw new AuthoredWriteError('VERSION_CONFLICT', { kind, id }, 'The value moved.');
        await writeAuthoredRecord(record as never, { expectedVersion: version, root, review: reviewInputs(base, { reviewedValues: shown }) });
    });
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

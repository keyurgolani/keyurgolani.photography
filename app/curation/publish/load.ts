import 'server-only';
import { compileCandidate, type CompileResult } from '@/lib/catalog/compile';
import { diffCatalog, type CatalogDiff } from '@/lib/catalog/diff';
import { previewBasePath, previewFrameHref, previewRoutes } from '@/lib/catalog/preview-reader';
import { listActivations, readRevisionFile, revisionNumberFor } from '@/lib/catalog/repository';
import { readReviewContext } from '@/lib/catalog/review-context';
import { createRouteBuilder } from '@/lib/catalog/routes';
import { fieldReview, inboxReviewOf, type FieldReviewState, type ReviewEnv } from '@/lib/catalog/review';
import type { ActivePointer, Activation, Issue, IssueRecord, RevisionFile, WorkingLayer } from '@/lib/catalog/types';
import { readActivePointer, readWorkingLayer } from '@/lib/catalog/working-layer';
import type { ReviewContext } from '@/lib/catalog/review';
import { readRegistry } from '@/lib/identity/registry';
import type { Registry } from '@/lib/identity/types';
import { dataRootStatus } from '@/lib/storage/config';
import type { Blocker, Ledger, RevisionFacts, ScreenView } from '@/lib/curation/publish-facts';
import { buildLedger, Names, panelLines, panelTarget } from '@/lib/curation/publish-view';
import type { HistoryView } from '@/lib/curation/publish-history';
import { loadHistoryView, type HistoryLoadOptions } from './history-load';

/**
 * The Publish screen's read (16-3): the data root's status, #13's snapshot
 * read without a lock and compileCandidate() (as 16-2's preview reader
 * compiles), the active pointer and the activations, the review context, and
 * diffCatalog(). Writes nothing. Each page and action calls requireCurator()
 * before anything here.
 */

export type PublishPage =
    | { state: 'ready'; view: ScreenView; previewHref: string; history: HistoryView }
    | { state: 'not-launched' }
    | { state: 'unreadable' };

/** Everything one read of the data root gives, for the page and for an action's answer. */
export interface Snapshot {
    root: string;
    pointer: ActivePointer;
    layer: WorkingLayer;
    registry: Registry;
    active: RevisionFile;
    activations: Activation[];
    compiled: CompileResult;
    review: ReviewContext;
    diff: CatalogDiff;
}

/** A revision as the page names it. */
export function revisionFacts(activations: readonly Activation[], revisionId: string): RevisionFacts {
    return { revisionId, number: revisionNumberFor(activations, revisionId), hash: revisionId.slice(4, 12) };
}

/** The active revision and the one `photos rollback` returns to now, from the active pointer's activation. */
export async function pointerFacts(root: string): Promise<{ live: RevisionFacts; previous: RevisionFacts | null; activation: Activation | null } | null> {
    const pointer = await readActivePointer(root);
    if (pointer === null) return null;
    const activations = await listActivations(root);
    const activation = activations.find((entry) => entry.activationId === pointer.activationId) ?? null;
    const previousId = activation?.previousRevisionId ?? null;
    return { live: revisionFacts(activations, pointer.revisionId), previous: previousId ? revisionFacts(activations, previousId) : null, activation };
}

/** One read of the data root, or null before the first activation. Throws when something can't be read. */
export async function readSnapshot(): Promise<Snapshot | null> {
    const status = dataRootStatus();
    if (status.state !== 'ready' || status.root === null) throw new Error(`The data root is ${status.state}.`);
    const root = status.root;
    const pointer = await readActivePointer(root);
    if (pointer === null) return null;
    const layer = await readWorkingLayer(root);
    const registry = await readRegistry(root);
    const active = await readRevisionFile(root, pointer.revisionId);
    if (active === null) throw new Error('The active pointer names a revision with no file.');
    const activations = await listActivations(root);
    const compiled = await compileCandidate({ layer, registry, root, active });
    const review = await readReviewContext(root, layer, active.revisionId);
    const diff = diffCatalog({ active, candidate: compiled.content, authored: layer, registry, review });
    return { root, pointer, layer, registry, active, activations, compiled, review, diff };
}

/**
 * Each of `fields` of one record as review reads it now, from a fresh read:
 * fieldReview()'s state, and what the inbox item its stamp names says on its
 * own, which a stale base would hide behind its own reason. The screen's
 * review writes check both before they write (16-3).
 */
export async function reviewNow(root: string, record: IssueRecord, fields: readonly string[]): Promise<{ field: string; state: FieldReviewState; inbox: FieldReviewState | null }[]> {
    const pointer = await readActivePointer(root);
    const layer = await readWorkingLayer(root);
    const active = pointer ? await readRevisionFile(root, pointer.revisionId) : null;
    if (pointer && active === null) throw new Error('The active pointer names a revision with no file.');
    const review = await readReviewContext(root, layer, active?.revisionId ?? null);
    const env: ReviewEnv = { layer, active: active ? { revisionId: active.revisionId, content: active.content } : null, review };
    return fields.map((field) => ({ field, state: fieldReview({ record, field }, env), inbox: inboxReviewOf({ record, field }, env) }));
}

/** The ledger and its blockers for a snapshot: predicted on a page load (`issues` null), or from an answer's diagnostics. */
export function ledgerOf(snapshot: Snapshot, issues: readonly Issue[] | null): { ledger: Ledger; blockers: Blocker[] } {
    const routes = previewRoutes(snapshot.compiled.candidateId);
    return buildLedger({
        diff: snapshot.diff,
        layer: snapshot.layer,
        active: snapshot.active.content,
        candidate: snapshot.compiled.content,
        registry: snapshot.registry,
        review: snapshot.review,
        activations: snapshot.activations,
        issues,
        media: { draft: (url) => routes.mediaHref(url), live: (url) => url },
    });
}

/** The view for a snapshot, as a page load shows it. */
export function viewOf(snapshot: Snapshot): ScreenView {
    const { compiled, active, activations, diff } = snapshot;
    const draftId = compiled.candidateId;
    // What `photos rollback` returns to now: the revision the active pointer's activation replaced.
    const previousId = activations.find((entry) => entry.activationId === snapshot.pointer.activationId)?.previousRevisionId ?? null;
    const names = new Names({ active: active.content, candidate: compiled.content, layer: snapshot.layer, registry: snapshot.registry });
    const target = panelTarget(diff, compiled.content, active.content);
    const series = target.seriesId ? compiled.content.series.find((entry) => entry.id === target.seriesId) ?? active.content.series.find((entry) => entry.id === target.seriesId) : undefined;
    const preview = previewRoutes(draftId);
    const live = createRouteBuilder();
    // The series page, scrolled inside the frame to the changed photograph: the Viewer would bring its own Close and Zoom,
    // which an inert frame can't use, and a `#photo-` fragment scrolls the Publish page too (round 2 of the mockup).
    const at = (routes: typeof live) => (series ? routes.seriesHref(series.slug) : routes.workHref());
    const kind: ScreenView['kind'] = draftId === active.revisionId ? 'nothing' : diff.empty ? 'no-visible-change' : 'ledger';
    // The Nothing states show the live site as it is: its own series, at the top.
    const liveSeries = kind === 'ledger' ? series : active.content.series[0];
    const lines = kind === 'ledger' ? panelLines(diff, compiled.content, active.content, target.seriesId, names) : liveLines(active, names);
    const { ledger, blockers } = kind === 'ledger' ? ledgerOf(snapshot, null) : { ledger: { authored: [], derived: [], health: [] }, blockers: [] };
    return {
        draftId,
        draftNumber: revisionNumberFor(activations, draftId),
        draftHash: draftId.slice(4, 12),
        active: revisionFacts(activations, active.revisionId),
        previous: previousId ? revisionFacts(activations, previousId) : null,
        kind,
        ledger,
        blockers,
        panel: {
            ...lines,
            draftSrc: kind === 'ledger' ? at(preview) : null,
            liveSrc: kind === 'ledger' ? at(live) : liveSeries ? live.seriesHref(liveSeries.slug) : live.workHref(),
            ...(kind === 'ledger' && series && target.photoId ? { scrollToId: `photo-${target.photoId}` } : {}),
        },
    };
}

function liveLines(active: RevisionFile, names: Names): { count: string; copyLine: string } {
    const first = active.content.series[0];
    if (!first) return { count: 'Work: nothing published yet.', copyLine: 'What visitors see now.' };
    const n = first.derived.photoCount;
    return { count: `${names.series(first.id)}: ${n} ${n === 1 ? 'photograph' : 'photographs'}`, copyLine: 'What visitors see now.' };
}

/** The ledger rows a restore's rebase left in conflict, with their records' names, for History's done notice. */
export function conflictRows(view: ScreenView): { rowId: string; record: string }[] {
    const rows = [...view.ledger.authored, ...view.ledger.derived].filter((row) => row.review === 'conflict');
    return rows.map((row) => ({ rowId: row.id, record: view.blockers.find((blocker) => blocker.rowId === row.id)?.record ?? row.summary }));
}

/** The page's query: 15-4's `?history=`, `?check=` and `?restored=`. */
export type PageQuery = Pick<HistoryLoadOptions, 'shown' | 'check' | 'restored'>;

/** The page's read. A read error is logged without its details on the page, which can name a host path. */
export async function loadPublishPage(query: PageQuery = {}): Promise<PublishPage> {
    let snapshot: Snapshot | null;
    let view: ScreenView;
    let history: HistoryView;
    try {
        snapshot = await readSnapshot();
        if (snapshot === null) return { state: 'not-launched' };
        view = viewOf(snapshot);
        history = await loadHistoryView(snapshot.root, { ...query, draftPending: view.kind === 'ledger', conflicts: conflictRows(view) });
    } catch (error) {
        console.error('[curation] The Publish screen could not be read:', error);
        return { state: 'unreadable' };
    }
    return { state: 'ready', view, previewHref: previewFrameHref(snapshot.compiled.candidateId), history };
}

/** The visitor site's base inside the preview of `draftId`, re-exported for the screen's frame. */
export const previewSiteBase = previewBasePath;

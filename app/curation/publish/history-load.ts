import 'server-only';
import { canonicalJson } from '@/lib/identity/ids';
import { changesBetween, readHistory, type History, type RevisionChanges } from '@/lib/catalog/history';
import { readRevisionFile } from '@/lib/catalog/repository';
import { planRollback, type RollbackPlan } from '@/lib/catalog/rollback';
import type { RevisionContent } from '@/lib/catalog/types';
import {
    blockingReasons,
    doneView,
    draftNoteFor,
    editorialText,
    HISTORY_CAP,
    HISTORY_STEP,
    historyView,
    impactLines,
    PLAN_BUDGET,
    restorableRevisions,
    type EntryInput,
    type HistoryView,
    type PlanStatus,
    type PlanView,
    type SiteChange,
} from '@/lib/curation/publish-history';

/**
 * 15-4's read for History on the Publish screen: 15-2's `readHistory()`,
 * then `planRollback()` for the restorable revisions within the planning
 * budget, read without a lock and writing nothing. The page calls it after
 * requireCurator() and 16-3's snapshot read, and 16-3's publishAction calls
 * it again for an answer that moved the pointer (spec, History by 16-3
 * state). Throws when an activation record or the pointer can't be read,
 * which the page shows as 16-3's whole-page unreadable state.
 */

export interface HistoryLoadOptions {
    /** `?history=`: how many entries to show. Clamped to 10..100. */
    shown?: number | null;
    /** `?check=`: a revision number past the budget to plan as well. */
    check?: number | null;
    /** `?restored=`: the sequence of the restore the page shows as done. */
    restored?: number | null;
    /** `?rebased=0`: that restore's rebase waited for the next publish. Only its done notice reads it. */
    rebased?: boolean;
    /** A draft is pending, so the dialog says what happens to it. */
    draftPending: boolean;
    /** The conflicted ledger rows a restore left, for the done notice. */
    conflicts?: { rowId: string; record: string }[];
}

/** `?history=` as a count of entries: 10 by default, at most 100. */
export function shownFrom(value: string | null | undefined): number {
    const n = value && /^\d{1,3}$/.test(value) ? Number(value) : HISTORY_STEP;
    return Math.min(HISTORY_CAP, Math.max(HISTORY_STEP, n));
}

/** A positive integer query value, or null. */
export function numberFrom(value: string | null | undefined): number | null {
    return value && /^[1-9]\d{0,8}$/.test(value) ? Number(value) : null;
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const seriesOrder = (content: RevisionContent) => content.series.map((series) => series.id);
const shortId = (id: string) => id.replace(/^(?:ph|ser)_/, '').slice(0, 8);

export async function loadHistoryView(root: string, options: HistoryLoadOptions): Promise<HistoryView> {
    const history: History = await readHistory(root);
    const shown = shownFrom(options.shown === null || options.shown === undefined ? null : String(options.shown));

    // Revision files, read once each. One that can't be read is null, as readHistory() shows it.
    const contents = new Map<string, Promise<RevisionContent | null>>();
    const contentOf = (revisionId: string) => {
        let read = contents.get(revisionId);
        if (!read) {
            read = readRevisionFile(root, revisionId).then((file) => file?.content ?? null, () => null);
            contents.set(revisionId, read);
        }
        return read;
    };

    const newestShown = new Set(history.rows.slice(-shown).map((row) => row.activation.activationId));
    // Which of the site's two lists changed between two revisions, as the dialog reads them; undefined when one can't be read.
    const siteBetween = async (fromId: string, toId: string): Promise<SiteChange | undefined> => {
        const [before, after] = await Promise.all([contentOf(fromId), contentOf(toId)]);
        if (!before || !after) return undefined;
        return { featured: !same(before.site.featuredSeriesIds, after.site.featuredSeriesIds), order: !same(seriesOrder(before), seriesOrder(after)) };
    };
    const rows: EntryInput[] = await Promise.all(
        history.rows.map(async (row): Promise<EntryInput> => {
            const base: EntryInput = { activation: row.activation, state: row.state, live: row.live, summary: row.summary };
            if (row.state !== 'committed' || !newestShown.has(row.activation.activationId)) return base;
            if (row.activation.kind !== 'rollback') {
                const parent = row.summary?.parentRevisionId ?? null;
                if (!row.summary?.changes?.site || parent === null) return base;
                const site = await siteBetween(parent, row.activation.revisionId);
                return site ? { ...base, site } : base;
            }
            // A shown restore reads as what it changed against the revision it replaced, the impact the owner confirmed.
            const previous = row.activation.previousRevisionId;
            if (previous === null) return { ...base, replaced: null };
            const [before, after] = await Promise.all([contentOf(previous), contentOf(row.activation.revisionId)]);
            const replaced: RevisionChanges | null = before && after ? changesBetween(before, after) : null;
            const site = replaced?.site ? await siteBetween(previous, row.activation.revisionId) : undefined;
            return { ...base, replaced, ...(site ? { site } : {}) };
        }),
    );

    // The planning budget: the newest 10 restorable revisions, plus one asked for with Check revision N.
    const candidates = restorableRevisions(rows, shown);
    const toPlan = candidates.slice(0, PLAN_BUDGET);
    if (options.check !== null && options.check !== undefined) {
        const asked = candidates.find((revisionId) => rows.find((row) => row.activation.revisionId === revisionId)?.activation.revisionNumber === options.check);
        if (asked && !toPlan.includes(asked)) toPlan.push(asked);
    }

    const planned = new Map<string, PlanStatus>();
    const plans: Record<number, PlanView> = {};
    for (const revisionId of toPlan) {
        const plan = await planRollback({ dataRoot: root, to: { revisionId } });
        const names = await namesFor(plan, contentOf);
        if (plan.outcome === 'READY' && plan.target && plan.active) {
            planned.set(revisionId, { outcome: 'READY' });
            plans[plan.target.revisionNumber ?? 0] = await planView(plan, names, contentOf, options.draftPending);
        } else if (plan.outcome === 'VALIDATION_FAILED') {
            planned.set(revisionId, { outcome: 'VALIDATION_FAILED', reasons: blockingReasons(plan.blocking, names.photo) });
        } else {
            // A damaged file or an I/O error: the row says it can't be checked, and the log says why.
            console.error(`[curation] History couldn't plan a restore of ${revisionId}: ${plan.outcome}: ${plan.message}`);
            planned.set(revisionId, { outcome: plan.outcome } as PlanStatus);
        }
    }

    const restoredRow = options.restored ? rows.find((row) => row.activation.sequence === options.restored) : undefined;
    const replacedNumber = restoredRow?.activation.previousRevisionId ? (rows.find((row) => row.state === 'committed' && row.activation.revisionId === restoredRow.activation.previousRevisionId)?.activation.revisionNumber ?? null) : null;
    const conflicts = options.conflicts ?? [];
    const done = doneView(restoredRow, replacedNumber, conflicts[0] ?? null, conflicts.length, options.rebased !== false);

    return historyView({
        rows,
        shown,
        planned,
        plans,
        hrefs: {
            check: (revision, sequence) => `/curation/publish?history=${shown}&check=${revision}#entry-${sequence}-title`,
            more: (count, firstNew) => `/curation/publish?history=${count}#entry-${firstNew}-title`,
        },
        ...(done ? { done } : {}),
    });
}

interface Names {
    series: (id: string) => string;
    photo: (id: string) => string;
}

/** Names from the two revisions a plan compares: series titles from the plan, photo titles from their contents. */
async function namesFor(plan: RollbackPlan, contentOf: (revisionId: string) => Promise<RevisionContent | null>): Promise<Names> {
    const [target, active] = await Promise.all([plan.target ? contentOf(plan.target.revisionId) : null, plan.active ? contentOf(plan.active.revisionId) : null]);
    const photos = new Map<string, string>();
    for (const content of [active, target]) for (const photo of content?.photos ?? []) if (photo.title && !photos.has(photo.id)) photos.set(photo.id, photo.title);
    return {
        series: (id) => plan.seriesTitles[id] || shortId(id),
        photo: (id) => photos.get(id) ?? `Photograph ${shortId(id)}`,
    };
}

async function planView(plan: RollbackPlan, names: Names, contentOf: (revisionId: string) => Promise<RevisionContent | null>, draftPending: boolean): Promise<PlanView> {
    const target = plan.target as NonNullable<RollbackPlan['target']>;
    const active = plan.active as NonNullable<RollbackPlan['active']>;
    const [targetContent, activeContent] = await Promise.all([contentOf(target.revisionId), contentOf(active.revisionId)]);
    const order = (content: RevisionContent | null) => (content ? seriesOrder(content) : []);
    const impact = impactLines({
        impact: plan.impact ?? { series: { added: [], removed: [], changed: [] }, photos: { added: [], removed: [], changed: [] }, site: false },
        activeProblem: plan.activeProblem !== undefined,
        target: target.revisionNumber ?? 0,
        active: active.revisionNumber ?? 0,
        seriesName: names.series,
        photoName: names.photo,
        featuredChanged: Boolean(targetContent && activeContent && !same(targetContent.site.featuredSeriesIds, activeContent.site.featuredSeriesIds)),
        orderChanged: Boolean(targetContent && activeContent && !same(order(targetContent), order(activeContent))),
    });
    const editorial = editorialText(plan.issues, plan.editorial, names.series);
    return {
        revisionId: target.revisionId,
        revision: target.revisionNumber ?? 0,
        hash: target.revisionId.slice(4, 12),
        activeRevisionId: active.revisionId,
        active: active.revisionNumber ?? 0,
        activeHash: active.revisionId.slice(4, 12),
        impact: impact.lines,
        ...(impact.note ? { impactNote: impact.note } : {}),
        ...(editorial ? { editorial } : {}),
        ...(draftPending ? { draftNote: draftNoteFor(target.revisionNumber ?? 0) } : {}),
    };
}

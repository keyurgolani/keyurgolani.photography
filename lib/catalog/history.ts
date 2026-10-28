import { canonicalJson } from '../identity/ids';
import { CatalogIntegrityError, listActivations, readRevisionFile } from './repository';
import type { Activation, ActivePointer, RevisionContent, RevisionFile } from './types';
import { readActivePointer } from './working-layer';

/**
 * #15's history reader: the activation records in `catalog/activations/`,
 * read without a lock and without writing anything, so it runs on a
 * read-only data root too.
 *
 * History orders by `sequence`, never by time, since several containers
 * write the data root and their clocks can disagree. A record moves only
 * from `pending` to `committed` or `abandoned`, and recover() settles a
 * pending one at the next publish or rollback, so until then a `pending`
 * record counts as committed only when the active pointer names it. Every
 * other record that isn't committed shows as interrupted: its activation
 * never moved the pointer, or another one replaced it before it finished.
 */

export type HistoryState = 'committed' | 'interrupted';

export interface ChangeSet {
    added: string[];
    removed: string[];
    changed: string[];
}

/** What one revision changes against another: series and photos by ID, and whether the site record differs. */
export interface RevisionChanges {
    series: ChangeSet;
    photos: ChangeSet;
    site: boolean;
}

export interface RevisionSummary {
    /** The revision's `baseRevisionId`: what was active when it was compiled. */
    parentRevisionId: string | null;
    seriesCount: number;
    photoCount: number;
    /** Against the parent, or null for a first revision or a parent that can't be read. */
    changes: RevisionChanges | null;
    /** Why the changes are missing when there is a parent. */
    parentProblem?: string;
}

export interface HistoryRow {
    activation: Activation;
    state: HistoryState;
    /** A committed-looking record recover() hasn't marked committed yet. */
    unsettled: boolean;
    /** The record the active pointer names. */
    live: boolean;
    /** Null when the revision file can't be read; `problem` says why. */
    summary: RevisionSummary | null;
    problem?: string;
}

export interface History {
    pointer: ActivePointer | null;
    rows: HistoryRow[];
}

/** How a record reads in history, given the active pointer. */
export function historyState(activation: Activation, pointer: ActivePointer | null): { state: HistoryState; unsettled: boolean } {
    if (activation.status === 'committed') return { state: 'committed', unsettled: false };
    const named = activation.status === 'pending' && pointer !== null && pointer.activationId === activation.activationId && pointer.revisionId === activation.revisionId;
    return named ? { state: 'committed', unsettled: true } : { state: 'interrupted', unsettled: false };
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

function changeSet<T extends { id: string }>(from: readonly T[], to: readonly T[]): ChangeSet {
    const before = new Map(from.map((entry) => [entry.id, entry]));
    const after = new Map(to.map((entry) => [entry.id, entry]));
    return {
        added: [...after.keys()].filter((id) => !before.has(id)).sort(),
        removed: [...before.keys()].filter((id) => !after.has(id)).sort(),
        changed: [...after.keys()].filter((id) => before.has(id) && !same(before.get(id), after.get(id))).sort(),
    };
}

/**
 * What `to` changes against `from`: the series and photos it adds, removes,
 * and changes, by ID, and whether the site record differs. A series whose
 * Work position moved counts as changed only through the site's or its own
 * fields, since the revision lists series in Work order.
 */
export function changesBetween(from: RevisionContent, to: RevisionContent): RevisionChanges {
    const seriesOrder = (content: RevisionContent) => content.series.map((series) => series.id);
    return {
        series: changeSet(from.series, to.series),
        photos: changeSet(from.photos, to.photos),
        site: !same(from.site, to.site) || !same(seriesOrder(from), seriesOrder(to)),
    };
}

/** Read a revision file, or say why it can't be read. */
async function readRevision(root: string, revisionId: string): Promise<{ revision: RevisionFile } | { problem: string }> {
    try {
        const revision = await readRevisionFile(root, revisionId);
        return revision ? { revision } : { problem: `${revisionId} has no revision file` };
    } catch (error) {
        if (error instanceof CatalogIntegrityError) return { problem: error.message.replace(/\.$/, '') };
        throw error;
    }
}

/**
 * Every activation in sequence order, with its state, whether it is live,
 * and a summary of its revision against that revision's parent. Throws
 * CatalogIntegrityError when an activation record can't be used, and an
 * error when the active pointer can't be read. A revision file that is
 * missing or damaged doesn't stop it: that row says why instead.
 */
export async function readHistory(root: string): Promise<History> {
    const activations = await listActivations(root);
    const pointer = await readActivePointer(root);
    const revisions = new Map<string, Awaited<ReturnType<typeof readRevision>>>();
    const revisionOf = async (revisionId: string) => {
        let read = revisions.get(revisionId);
        if (!read) {
            read = await readRevision(root, revisionId);
            revisions.set(revisionId, read);
        }
        return read;
    };
    const summaries = new Map<string, RevisionSummary | { problem: string }>();
    const summaryOf = async (revisionId: string): Promise<RevisionSummary | { problem: string }> => {
        const cached = summaries.get(revisionId);
        if (cached) return cached;
        const read = await revisionOf(revisionId);
        let summary: RevisionSummary | { problem: string };
        if ('problem' in read) {
            summary = read;
        } else {
            const { content, baseRevisionId } = read.revision;
            summary = { parentRevisionId: baseRevisionId, seriesCount: content.series.length, photoCount: content.photos.length, changes: null };
            if (baseRevisionId !== null) {
                const parent = await revisionOf(baseRevisionId);
                if ('problem' in parent) summary.parentProblem = parent.problem;
                else summary.changes = changesBetween(parent.revision.content, content);
            }
        }
        summaries.set(revisionId, summary);
        return summary;
    };

    const rows: HistoryRow[] = [];
    for (const activation of activations) {
        const { state, unsettled } = historyState(activation, pointer);
        const summary = await summaryOf(activation.revisionId);
        rows.push({
            activation,
            state,
            unsettled,
            live: state === 'committed' && pointer !== null && pointer.activationId === activation.activationId && pointer.revisionId === activation.revisionId,
            ...('problem' in summary ? { summary: null, problem: summary.problem } : { summary }),
        });
    }
    return { pointer, rows };
}

/**
 * The revisions that were active at some point: each committed record, and
 * a pending one the pointer names. A rollback may only go back to one of
 * these. By revision ID, with the number it went live under.
 */
export function knownGood(activations: readonly Activation[], pointer: ActivePointer | null): Map<string, number> {
    const good = new Map<string, number>();
    for (const activation of activations) {
        if (historyState(activation, pointer).state !== 'committed') continue;
        if (!good.has(activation.revisionId)) good.set(activation.revisionId, activation.revisionNumber);
    }
    return good;
}

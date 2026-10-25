import { listEvents } from '../curation/repository';
import { readRevisionFile } from './repository';
import { coverAssetOf, stampsOf, type InboxItem, type ReviewContext } from './review';
import type { RevisionContent, WorkingLayer } from './types';

/**
 * What #16's review state reads besides the working layer: the revisions
 * the stamps were reviewed against and the curation inbox. Read-only, so
 * `photos validate` reads it too. Kept apart from review.ts so the writer,
 * which imports review.ts, never loads the inbox's modules.
 */
export async function readReviewContext(root: string, layer: WorkingLayer, activeRevisionId: string | null): Promise<ReviewContext> {
    const wanted = new Set<string>();
    for (const record of [layer.site, ...layer.series, ...layer.photos]) {
        if (record === null) continue;
        for (const stamp of Object.values(stampsOf(record, coverAssetOf(layer, record)))) {
            if (stamp.baseRevisionId !== null && stamp.baseRevisionId !== activeRevisionId) wanted.add(stamp.baseRevisionId);
        }
    }
    const bases = new Map<string, RevisionContent>();
    for (const revisionId of [...wanted].sort()) {
        // A revision that can't be read is left out, so every stamp reviewed against it reads as stale.
        const revision = await readRevisionFile(root, revisionId).catch(() => null);
        if (revision) bases.set(revisionId, revision.content);
    }
    const { events, problems } = await listEvents(root);
    const inbox = new Map<string, InboxItem>(events.map((event) => [event.id, { id: event.id, type: event.type, photoId: event.photoId, status: event.status, lastObservedAt: event.lastObservedAt }]));
    return { bases, inbox, unreadable: new Set(problems.map((problem) => problem.id)) };
}

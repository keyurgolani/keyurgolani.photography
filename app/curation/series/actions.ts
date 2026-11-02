'use server';

import { revalidatePath } from 'next/cache';
import { requireCurator } from '@/lib/curation/auth';
import { runSeriesAction } from '@/lib/curation/series-form';
import type { SeriesActionKind, SeriesActionState } from '@/lib/curation/series-view';

/**
 * The Series screen's server actions (#150's 2a): New series, and Save on a
 * series' page. Each calls requireCurator() first, before it reads its
 * form, so a request the boundary refuses (the flag, the bind, the `Host`,
 * the `Origin`, or the session) gets a 404 and writes nothing, however it
 * was posted. Then the form goes to lib/curation/series-form.ts, which
 * writes through `photos edit`'s path with the version the page showed.
 * Only a finished action refreshes the pages; a stale one leaves them as
 * they were, so the curator refreshes and edits again.
 */

async function settle(kind: SeriesActionKind, form: unknown): Promise<SeriesActionState> {
    const state = await runSeriesAction(kind, form);
    if (state.status === 'done') {
        revalidatePath('/curation/series');
        if (state.seriesId !== null) revalidatePath(`/curation/series/${state.seriesId}`);
    }
    return state;
}

export async function createSeries(_previous: SeriesActionState, form: FormData): Promise<SeriesActionState> {
    await requireCurator();
    return settle('create', form);
}

export async function saveSeries(_previous: SeriesActionState, form: FormData): Promise<SeriesActionState> {
    await requireCurator();
    return settle('edit', form);
}

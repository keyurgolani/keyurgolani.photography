'use server';

import { revalidatePath } from 'next/cache';
import { requireCurator } from '@/lib/curation/auth';
import { runSeriesAction } from '@/lib/curation/series-form';
import { runOrderAction } from '@/lib/curation/series-order';
import type { OrderActionState, SeriesActionKind, SeriesActionState } from '@/lib/curation/series-view';

/**
 * The Series screen's server actions (#150): New series, and Save on a
 * series' page (2a), and the ordering forms (2b): a series' sequence, cover,
 * opening photograph and chapters, and the Work order and featured series.
 * Each calls requireCurator() first, before it reads its form, so a request
 * the boundary refuses (the flag, the bind, the `Host`, the `Origin`, or the
 * session) gets a 404 and writes nothing, however it was posted. Then the
 * form goes to lib/curation/series-form.ts, which writes through `photos
 * edit`'s path, or lib/curation/series-order.ts, which writes through `photos
 * sequence`' and `photos series`', each with the version the page showed.
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

/** A series' page, and the list, which shows its photographs' count, read again once an order change lands. */
export async function orderSeries(_previous: OrderActionState, form: FormData): Promise<OrderActionState> {
    await requireCurator();
    const state = await runOrderAction('series', form);
    if (state.status === 'done') revalidatePath('/curation/series', 'layout');
    return state;
}

/** The Work order and featured series: the list, and each series' page, which says whether Work order lists it. */
export async function orderWork(_previous: OrderActionState, form: FormData): Promise<OrderActionState> {
    await requireCurator();
    const state = await runOrderAction('work', form);
    if (state.status === 'done') revalidatePath('/curation/series', 'layout');
    return state;
}

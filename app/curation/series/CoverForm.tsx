'use client';

import { useEffect, useRef } from 'react';
import styles from '../curator.module.css';
import { submitGate, useHydrated } from '../inbox/useHydrated';
import { orderSeries } from './actions';
import { errorFor, offWhile, useOrder } from './useOrder';
import SeriesAnswer from './SeriesAnswer';
import series from './series.module.css';
import { placeLabel, type SeriesOrderView } from '@/lib/curation/series-view';

/** A focal point as the page shows it: a percentage, to a tenth, from the record's 0 to 1. */
const percentOf = (value: number) => String(Math.round(value * 1000) / 10);

/**
 * A series' cover, with its focal point, and its opening photograph
 * (#150's 2b), each one of its photographs, chosen from a list and set with
 * a button. The focal point is two numbers, across and down, so nothing
 * here needs a pointer. Each form opens on what the series holds, and is
 * keyed by it, so the page's refresh after a change opens it on what was
 * stored.
 */
export default function CoverForm({ seriesId, order, activeRevisionId }: { seriesId: string; order: SeriesOrderView; activeRevisionId: string | null }) {
    const { state, pending, submit, answerRef } = useOrder(orderSeries, { seriesId, version: String(order.version), base: activeRevisionId ?? 'none' });
    // Both forms submit by hand, so each waits at the submit gate until it has mounted.
    const ready = useHydrated();
    const coverRef = useRef<HTMLSelectElement>(null);
    const focalRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (state.status === 'idle') return;
        const field = state.status === 'invalid' ? state.field : undefined;
        ((field === 'cover' ? coverRef.current : field === 'focal' ? focalRef.current : null) ?? answerRef.current)?.focus();
        // The refs are stable; only a new answer moves focus.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state]);
    const { photos, cover } = order;
    const focal = cover?.focalPoint ?? null;
    const coverError = errorFor(state, 'cover');
    const focalError = errorFor(state, 'focal');
    const options = photos.map((photo, index) => (
        <option key={photo.id} value={photo.id}>
            {placeLabel(index, photo.name)}
        </option>
    ));
    return (
        <section className={series.section} aria-labelledby="cover-heading">
            <h2 id="cover-heading">Cover and opening photograph</h2>
            {photos.length === 0 ? (
                <p className={series.empty}>Add photographs first: the cover and the opening photograph are two of them.</p>
            ) : (
                <>
                    {/* noValidate: the server words a refusal, by the field, rather than the browser. */}
                    <form key={`cover:${cover?.photoId ?? ''}:${focal ? `${focal.x},${focal.y}` : ''}`} className={series.subform} method="post" noValidate onSubmit={submit('cover')} aria-labelledby="cover-form-heading" {...submitGate(ready)}>
                        <h3 id="cover-form-heading">Cover</h3>
                        <label className={styles.label}>
                            Cover photograph
                            <select ref={coverRef} className={styles.control} name="photoId" defaultValue={cover?.photoId ?? ''} aria-invalid={coverError ? true : undefined} aria-describedby={coverError ? 'cover-error' : undefined}>
                                {cover === null ? <option value="">Choose the cover</option> : null}
                                {options}
                            </select>
                        </label>
                        {coverError ? (
                            <p className={styles.fieldError} id="cover-error" data-state="invalid">
                                {coverError}
                            </p>
                        ) : null}
                        {cover === null ? <p className={styles.hint}>The series has no cover. A published series needs one before a publish.</p> : null}
                        <fieldset className={`${styles.sequence} ${series.focal}`} aria-labelledby="focal-legend" aria-describedby="focal-hint">
                            <legend id="focal-legend">Focal point</legend>
                            <label className={styles.slot}>
                                <input type="radio" name="focal" value="none" defaultChecked={focal === null} />
                                None: crop around the middle
                            </label>
                            <label className={styles.slot}>
                                <input type="radio" name="focal" value="set" defaultChecked={focal !== null} />
                                At the point below
                            </label>
                            <div className={series.focalPoint}>
                                <label className={styles.label}>
                                    Across, %
                                    <input ref={focalRef} className={styles.control} type="number" name="focalX" min={0} max={100} step={0.1} inputMode="decimal" defaultValue={percentOf(focal?.x ?? 0.5)} aria-invalid={focalError ? true : undefined} aria-describedby={focalError ? 'focal-error' : undefined} />
                                </label>
                                <label className={styles.label}>
                                    Down, %
                                    <input className={styles.control} type="number" name="focalY" min={0} max={100} step={0.1} inputMode="decimal" defaultValue={percentOf(focal?.y ?? 0.5)} aria-invalid={focalError ? true : undefined} aria-describedby={focalError ? 'focal-error' : undefined} />
                                </label>
                            </div>
                        </fieldset>
                        {focalError ? (
                            <p className={styles.fieldError} id="focal-error" data-state="invalid">
                                {focalError}
                            </p>
                        ) : null}
                        <p className={styles.hint} id="focal-hint">
                            Where a crop of the cover keeps its centre: 0% across is the left edge, and 0% down the top.
                        </p>
                        <div className={styles.actions}>
                            <button type="submit" className={styles.button} {...offWhile(pending)}>
                                Set cover
                            </button>
                        </div>
                    </form>
                    <form key={`opening:${order.openingPhotoId ?? ''}`} className={series.subform} method="post" onSubmit={submit('opening')} aria-labelledby="opening-form-heading" {...submitGate(ready)}>
                        <h3 id="opening-form-heading">Opening photograph</h3>
                        <label className={styles.label}>
                            Opening photograph
                            <select className={styles.control} name="photoId" defaultValue={order.openingPhotoId ?? 'none'} aria-describedby="opening-hint">
                                <option value="none">None: open on the first photograph</option>
                                {options}
                            </select>
                        </label>
                        <p className={styles.hint} id="opening-hint">
                            The photograph Home opens on while this series is featured.
                        </p>
                        <div className={styles.actions}>
                            <button type="submit" className={styles.button} {...offWhile(pending)}>
                                Set opening photograph
                            </button>
                        </div>
                    </form>
                </>
            )}
            <SeriesAnswer state={state} regionRef={answerRef} refreshHref={`/curation/series/${seriesId}`} />
        </section>
    );
}

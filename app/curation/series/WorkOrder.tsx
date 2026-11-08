'use client';

import { useEffect, useRef } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import styles from '../curator.module.css';
import { submitGate, useHydrated } from '../inbox/useHydrated';
import { orderWork } from './actions';
import { offWhile, useOrder } from './useOrder';
import SeriesAnswer from './SeriesAnswer';
import series from './series.module.css';
import { VISIBILITY_LABEL, type WorkOrderView } from '@/lib/curation/series-view';

/** The control a row's last press was, so focus can go back to it on the series' new row. */
type Pressed = { seriesId: string; control: 'up' | 'down' };

/**
 * The Work order (#150's 2b): the series Work lists, in its order, each with
 * Move up, Move down and Take off Work, and Put on Work for the rest, last.
 * As in a series' sequence, a move keeps focus on the button pressed, on the
 * series' new row, and the answer is read out. Through `photos series
 * order`'s path, so Work order never ends up empty.
 */
export function WorkOrderEditor({ work, activeRevisionId }: { work: WorkOrderView; activeRevisionId: string | null }) {
    const { state, pending, send, submit, answerRef } = useOrder(orderWork, { version: String(work.version), base: activeRevisionId ?? 'none' });
    // Put on Work submits by hand, so it waits at the submit gate until it has mounted.
    const ready = useHydrated();
    const listRef = useRef<HTMLOListElement>(null);
    const pressed = useRef<Pressed | null>(null);
    const count = work.order.length;
    const move = (seriesId: string, index: number, control: 'up' | 'down') => {
        // A press while an action is out sends nothing, so it mustn't take over where the answer puts focus either.
        if (pending || (control === 'up' ? index === 0 : index === count - 1)) return;
        pressed.current = { seriesId, control };
        send('work-order', { seriesId, move: control });
    };
    useEffect(() => {
        if (state.status === 'idle') return;
        const last = pressed.current;
        pressed.current = null;
        if (state.status === 'done' && last) {
            const button = listRef.current?.querySelector<HTMLButtonElement>(`[data-series="${CSS.escape(last.seriesId)}"] [data-control="${last.control}"]`);
            if (button) return button.focus();
        }
        answerRef.current?.focus();
        // The refs are stable; only a new answer moves focus.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state]);
    return (
        <section className={`${styles.box} ${series.workBox}`} aria-labelledby="work-order-heading">
            <h2 className={styles.boxTitle} id="work-order-heading">
                Work order
            </h2>
            <p className={styles.hint}>The order Work lists the series in. A published series needs a place in it.</p>
            {count === 0 ? (
                <p className={series.empty}>Work lists no series yet.</p>
            ) : (
                <ol ref={listRef} className={series.workList} aria-label="Work order">
                    {work.order.map((entry, index) => {
                        // By place too, so two series titled alike never share a button's name (contract rule 2).
                        const place = `${index + 1}. ${entry.title}`;
                        return (
                            <li key={entry.id} className={series.workRow} data-series={entry.id}>
                                <span className={series.memberName}>{place}</span>
                                <span className={series.tag} data-visibility={entry.visibility}>
                                    {VISIBILITY_LABEL[entry.visibility]}
                                </span>
                                <span className={series.memberActions}>
                                    <button type="button" className={styles.button} data-control="up" aria-label={`Move up: ${place}`} onClick={() => move(entry.id, index, 'up')} {...offWhile(pending || index === 0)}>
                                        <ArrowUp size={16} aria-hidden="true" />
                                        Move up
                                    </button>
                                    <button type="button" className={styles.button} data-control="down" aria-label={`Move down: ${place}`} onClick={() => move(entry.id, index, 'down')} {...offWhile(pending || index === count - 1)}>
                                        <ArrowDown size={16} aria-hidden="true" />
                                        Move down
                                    </button>
                                    <button type="button" className={styles.button} aria-label={`Take off Work: ${place}`} onClick={() => send('work-order', { seriesId: entry.id, move: 'off' })} {...offWhile(pending)}>
                                        <X size={16} aria-hidden="true" />
                                        Take off Work
                                    </button>
                                </span>
                            </li>
                        );
                    })}
                </ol>
            )}
            {work.offWork.length > 0 ? (
                <form className={series.subform} method="post" onSubmit={submit('work-order', { move: 'on' })} aria-labelledby="put-on-work-heading" {...submitGate(ready)}>
                    <h3 id="put-on-work-heading">Put on Work</h3>
                    <label className={styles.label}>
                        Series
                        <select className={styles.control} name="seriesId" defaultValue={work.offWork[0].id}>
                            {work.offWork.map((entry) => (
                                <option key={entry.id} value={entry.id}>
                                    {`${entry.title}, ${VISIBILITY_LABEL[entry.visibility].toLowerCase()}`}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className={styles.actions}>
                        <button type="submit" className={styles.button} {...offWhile(pending)}>
                            <Plus size={16} aria-hidden="true" />
                            Put on Work, last
                        </button>
                    </div>
                </form>
            ) : null}
            <SeriesAnswer state={state} regionRef={answerRef} refreshHref="/curation/series" />
        </section>
    );
}

/**
 * The featured series (#150's 2b): a box for each published series, and
 * each one featured now, whatever its visibility, so it can be unticked.
 * Home opens on the first featured series a publish holds, so the order is
 * kept: those featured already stay first, then the new ones in the page's
 * order. Through `photos series featured`' path.
 */
export function FeaturedForm({ work, activeRevisionId }: { work: WorkOrderView; activeRevisionId: string | null }) {
    const { state, pending, submit, answerRef } = useOrder(orderWork, { version: String(work.version), base: activeRevisionId ?? 'none' });
    // The form submits by hand, so it waits at the submit gate until it has mounted.
    const ready = useHydrated();
    useEffect(() => {
        if (state.status === 'idle') return;
        answerRef.current?.focus();
        // The ref is stable; only a new answer moves focus.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state]);
    const offered = work.all.filter((entry) => entry.visibility === 'published' || work.featured.includes(entry.id));
    return (
        <section className={`${styles.box} ${series.workBox}`} aria-labelledby="featured-heading">
            <h2 className={styles.boxTitle} id="featured-heading">
                Featured on Home
            </h2>
            {offered.length === 0 ? (
                <p className={series.empty}>No series is published yet, so none can be featured.</p>
            ) : (
                <form key={work.featured.join(' ')} method="post" onSubmit={submit('featured')} aria-labelledby="featured-heading" {...submitGate(ready)}>
                    <fieldset className={styles.sequence} aria-describedby="featured-hint">
                        <legend>Featured series</legend>
                        {offered.map((entry) => (
                            <label key={entry.id} className={styles.slot}>
                                <input type="checkbox" name="featured" value={entry.id} defaultChecked={work.featured.includes(entry.id)} />
                                {entry.visibility === 'published' ? entry.title : `${entry.title}, ${VISIBILITY_LABEL[entry.visibility].toLowerCase()}`}
                            </label>
                        ))}
                    </fieldset>
                    <p className={styles.hint} id="featured-hint">
                        Home opens on the first featured series a publish holds. Only a published series can be featured.
                    </p>
                    <div className={styles.actions}>
                        <button type="submit" className={styles.button} {...offWhile(pending)}>
                            Save featured
                        </button>
                    </div>
                </form>
            )}
            <SeriesAnswer state={state} regionRef={answerRef} refreshHref="/curation/series" />
        </section>
    );
}

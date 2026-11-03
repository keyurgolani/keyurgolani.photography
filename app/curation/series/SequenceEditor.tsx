'use client';

import { useEffect, useRef } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import styles from '../curator.module.css';
import { orderSeries } from './actions';
import Thumbnail from './Thumbnail';
import { errorFor, offWhile, useOrder } from './useOrder';
import SeriesAnswer from './SeriesAnswer';
import series from './series.module.css';
import { NOTHING_PUBLIC, placeLabel, type SeriesOrderView } from '@/lib/curation/series-view';

/** The control a row's last press was, so focus can go back to it on the photograph's new row. */
type Pressed = { photoId: string; control: 'up' | 'down' };

/**
 * A series' sequence (#150's 2b): its photographs in order, each with Move
 * up, Move down and Remove, then Add a photograph and Move to a position.
 * Every control is a button or a form field, so the keyboard does all of
 * it; nothing is drag-only. A move keeps focus on the button pressed, on the
 * photograph's new row, so pressing it again moves it on, and the answer is
 * read out from the region; any other answer takes focus itself, or the
 * field it's about does. Each change goes to the draft only.
 */
export default function SequenceEditor({ seriesId, order, activeRevisionId }: { seriesId: string; order: SeriesOrderView; activeRevisionId: string | null }) {
    const { state, pending, send, submit, answerRef } = useOrder(orderSeries, { seriesId, version: String(order.version), base: activeRevisionId ?? 'none' });
    const listRef = useRef<HTMLOListElement>(null);
    const addRef = useRef<HTMLFormElement>(null);
    const addPhotoRef = useRef<HTMLSelectElement>(null);
    const addPositionRef = useRef<HTMLSelectElement>(null);
    const moveRef = useRef<HTMLSelectElement>(null);
    const pressed = useRef<Pressed | null>(null);
    const { photos } = order;
    const count = photos.length;
    const chapterAt = new Map(order.chapters.map((chapter) => [chapter.startPhotoId, chapter.title]));

    const move = (photoId: string, index: number, control: 'up' | 'down') => {
        // A press while an action is out sends nothing, so it mustn't take over where the answer puts focus either.
        if (pending || (control === 'up' ? index === 0 : index === count - 1)) return;
        pressed.current = { photoId, control };
        send('move', { photoId, position: String(control === 'up' ? index : index + 2) });
    };
    // Each answer is a new state, so this runs once for each.
    useEffect(() => {
        if (state.status === 'idle') return;
        const last = pressed.current;
        pressed.current = null;
        if (state.status === 'done' && state.action === 'insert') addRef.current?.reset();
        if (state.status === 'done' && state.action === 'move' && last) {
            const button = listRef.current?.querySelector<HTMLButtonElement>(`[data-photo="${CSS.escape(last.photoId)}"] [data-control="${last.control}"]`);
            if (button) return button.focus();
        }
        const field = state.status === 'invalid' ? state.field : undefined;
        const target = field === 'addPhoto' ? addPhotoRef.current : field === 'position' ? (state.action === 'insert' ? addPositionRef.current : moveRef.current) : null;
        (target ?? answerRef.current)?.focus();
        // The refs are stable; only a new answer moves focus.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state]);
    const addError = errorFor(state, 'addPhoto');
    // A position is refused by the form that sent it: Add's, or Move to a position's.
    const positionError = (kind: 'insert' | 'move') => (state.status !== 'idle' && state.action === kind ? errorFor(state, 'position') : null);
    const addPositionError = positionError('insert');
    const movePositionError = positionError('move');
    const inSeries = order.addable.filter((photo) => photo.heldBy === null);
    const elsewhere = order.addable.filter((photo) => photo.heldBy !== null);

    return (
        <section className={series.section} aria-labelledby="sequence-heading">
            <h2 id="sequence-heading">Sequence</h2>
            <p className={styles.hint}>The order visitors see the photographs in. Each change goes to the draft only. {NOTHING_PUBLIC}</p>
            {count === 0 ? (
                <p className={series.empty}>No photographs yet. Add one below.</p>
            ) : (
                <ol ref={listRef} className={series.sequenceList} aria-label="Photographs in order">
                    {photos.map((photo, index) => {
                        const chapter = chapterAt.get(photo.id);
                        const place = placeLabel(index, photo.name);
                        const notes = [order.cover?.photoId === photo.id ? 'Cover' : null, order.openingPhotoId === photo.id ? 'Opening photograph' : null, chapter !== undefined ? `Starts the chapter ${chapter}` : null].filter((note) => note !== null);
                        return (
                            <li key={photo.id} className={series.member} data-photo={photo.id}>
                                <Thumbnail url={photo.thumbnailUrl} />
                                <div className={series.memberText}>
                                    <span className={series.memberName}>{place}</span>
                                    {notes.length > 0 ? (
                                        <span className={series.memberNotes}>
                                            {notes.map((note) => (
                                                <span key={note} className={series.tag}>
                                                    {note}
                                                </span>
                                            ))}
                                        </span>
                                    ) : null}
                                </div>
                                {/* Each name starts with the button's words, then the photograph's place and name, so no two rows share one even when titles repeat (contract rule 2). */}
                                <div className={series.memberActions}>
                                    <button type="button" className={styles.button} data-control="up" aria-label={`Move up: ${place}`} onClick={() => move(photo.id, index, 'up')} {...offWhile(pending || index === 0)}>
                                        <ArrowUp size={16} aria-hidden="true" />
                                        Move up
                                    </button>
                                    <button type="button" className={styles.button} data-control="down" aria-label={`Move down: ${place}`} onClick={() => move(photo.id, index, 'down')} {...offWhile(pending || index === count - 1)}>
                                        <ArrowDown size={16} aria-hidden="true" />
                                        Move down
                                    </button>
                                    <button type="button" className={styles.button} aria-label={`Remove: ${place}`} onClick={() => send('remove', { photoId: photo.id })} {...offWhile(pending)}>
                                        <X size={16} aria-hidden="true" />
                                        Remove
                                    </button>
                                </div>
                            </li>
                        );
                    })}
                </ol>
            )}
            <SeriesAnswer state={state} regionRef={answerRef} refreshHref={`/curation/series/${seriesId}`} />

            <form ref={addRef} className={series.subform} method="post" onSubmit={submit('insert')} aria-labelledby="add-photo-heading">
                <h3 id="add-photo-heading">Add a photograph</h3>
                {order.addable.length === 0 ? (
                    <p className={styles.hint}>No approved photograph is free to add. Approve new ones in the Inbox first.</p>
                ) : (
                    <>
                        <label className={styles.label}>
                            Photograph
                            <select ref={addPhotoRef} className={styles.control} name="photoId" defaultValue="" aria-invalid={addError ? true : undefined} aria-describedby={addError ? 'add-photo-error add-photo-hint' : 'add-photo-hint'}>
                                <option value="">Choose a photograph</option>
                                {inSeries.length > 0 ? (
                                    <optgroup label="In no series">
                                        {inSeries.map((photo) => (
                                            <option key={photo.id} value={photo.id}>
                                                {photo.name}
                                            </option>
                                        ))}
                                    </optgroup>
                                ) : null}
                                {elsewhere.length > 0 ? (
                                    <optgroup label="In another series">
                                        {elsewhere.map((photo) => (
                                            <option key={photo.id} value={photo.id}>
                                                {`${photo.name}, in ${photo.heldBy}`}
                                            </option>
                                        ))}
                                    </optgroup>
                                ) : null}
                            </select>
                        </label>
                        {addError ? (
                            <p className={styles.fieldError} id="add-photo-error" data-state="invalid">
                                {addError}
                            </p>
                        ) : null}
                        <p className={styles.hint} id="add-photo-hint">
                            Approved photographs this series doesn&apos;t hold. One in another series stays there too.
                            {order.published ? ' A photograph belongs to one published series, so one another published series holds isn’t offered.' : ''}
                        </p>
                        <label className={styles.label}>
                            Position
                            {/* Keyed by the count, so the refresh after an Add opens it on the new end, and the form's reset keeps it there. */}
                            <select key={count} ref={addPositionRef} className={styles.control} name="position" defaultValue={String(count + 1)} aria-invalid={addPositionError ? true : undefined} aria-describedby={addPositionError ? 'add-position-error' : undefined}>
                                {Array.from({ length: count + 1 }, (_, index) => (
                                    <option key={index} value={String(index + 1)}>
                                        {index === 0 ? (count === 0 ? '1' : '1, the start') : index === count ? `${index + 1}, the end` : `${index + 1}, after ${photos[index - 1].name}`}
                                    </option>
                                ))}
                            </select>
                        </label>
                        {addPositionError ? (
                            <p className={styles.fieldError} id="add-position-error" data-state="invalid">
                                {addPositionError}
                            </p>
                        ) : null}
                        <div className={styles.actions}>
                            <button type="submit" className={styles.button} {...offWhile(pending)}>
                                <Plus size={16} aria-hidden="true" />
                                Add
                            </button>
                        </div>
                    </>
                )}
            </form>

            {count > 2 ? (
                <form className={series.subform} method="post" onSubmit={submit('move')} aria-labelledby="move-photo-heading">
                    <h3 id="move-photo-heading">Move to a position</h3>
                    <label className={styles.label}>
                        Photograph
                        <select className={styles.control} name="photoId" defaultValue={photos[0].id}>
                            {photos.map((photo, index) => (
                                <option key={photo.id} value={photo.id}>
                                    {placeLabel(index, photo.name)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className={styles.label}>
                        To position
                        <select ref={moveRef} className={styles.control} name="position" defaultValue="1" aria-invalid={movePositionError ? true : undefined} aria-describedby={movePositionError ? 'move-position-error' : undefined}>
                            {photos.map((_, index) => (
                                <option key={index} value={String(index + 1)}>
                                    {String(index + 1)}
                                </option>
                            ))}
                        </select>
                    </label>
                    {movePositionError ? (
                        <p className={styles.fieldError} id="move-position-error" data-state="invalid">
                            {movePositionError}
                        </p>
                    ) : null}
                    <div className={styles.actions}>
                        <button type="submit" className={styles.button} {...offWhile(pending)}>
                            Move
                        </button>
                    </div>
                </form>
            ) : null}
        </section>
    );
}

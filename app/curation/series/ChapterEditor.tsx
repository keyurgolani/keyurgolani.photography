'use client';

import { useEffect, useRef } from 'react';
import { Plus, X } from 'lucide-react';
import styles from '../curator.module.css';
import { submitGate, useHydrated } from '../inbox/useHydrated';
import { orderSeries } from './actions';
import { errorFor, offWhile, useOrder } from './useOrder';
import SeriesAnswer from './SeriesAnswer';
import series from './series.module.css';
import { placeLabel, type SeriesOrderView } from '@/lib/curation/series-view';

/**
 * A series' chapters (#150's 2b): each by its title and the photograph it
 * starts at, with Move start and Remove chapter, then Add a chapter. A
 * chapter runs from its start to the next one's, so a start is chosen from
 * the series' photographs. The new chapter's title is cleaned as `photos
 * sequence chapter add` cleans it, and a refusal about it or its start
 * shows by that field; a move's refusal shows in the answer.
 */
export default function ChapterEditor({ seriesId, order, activeRevisionId }: { seriesId: string; order: SeriesOrderView; activeRevisionId: string | null }) {
    const { state, pending, send, submit, answerRef } = useOrder(orderSeries, { seriesId, version: String(order.version), base: activeRevisionId ?? 'none' });
    // Each chapter's Move start and Add a chapter submit by hand, so each waits at the submit gate until it has mounted.
    const ready = useHydrated();
    const addRef = useRef<HTMLFormElement>(null);
    const titleRef = useRef<HTMLInputElement>(null);
    const startRef = useRef<HTMLSelectElement>(null);
    // Only the add form shows a refusal by its fields; one about a move's start goes in the answer, by the chapter it names.
    const adding = state.status !== 'idle' && state.action === 'chapter-add';
    const shown = state.status !== 'idle' && !adding && state.field !== undefined ? { ...state, field: undefined } : state;
    useEffect(() => {
        if (state.status === 'idle') return;
        if (state.status === 'done' && state.action === 'chapter-add') addRef.current?.reset();
        const field = adding && state.status === 'invalid' ? state.field : undefined;
        ((field === 'chapterTitle' ? titleRef.current : field === 'chapterStart' ? startRef.current : null) ?? answerRef.current)?.focus();
        // The refs are stable; only a new answer moves focus.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state]);
    const titleError = adding ? errorFor(state, 'chapterTitle') : null;
    const startError = adding ? errorFor(state, 'chapterStart') : null;
    const { photos, chapters } = order;
    const placeOf = new Map(photos.map((photo, index) => [photo.id, placeLabel(index, photo.name)]));
    const options = photos.map((photo, index) => (
        <option key={photo.id} value={photo.id}>
            {placeLabel(index, photo.name)}
        </option>
    ));
    return (
        <section className={series.section} aria-labelledby="chapters-heading">
            <h2 id="chapters-heading">Chapters</h2>
            <p className={styles.hint}>A chapter starts at a photograph and runs to the next chapter&apos;s start.</p>
            {chapters.length === 0 ? (
                <p className={series.empty}>No chapters.</p>
            ) : (
                <ol className={series.chapterList} aria-label="Chapters">
                    {chapters.map((chapter, index) => {
                        // Named by where it starts too, so two chapters titled alike never share a control's name (contract rule 2).
                        const at = photos.findIndex((photo) => photo.id === chapter.startPhotoId);
                        const named = `${chapter.title} (${at === -1 ? `chapter ${index + 1}` : `at ${at + 1}`})`;
                        return (
                            <li key={chapter.id} className={series.chapter}>
                                <p className={series.memberName}>{chapter.title}</p>
                                <p className={styles.hint}>Starts at {placeOf.get(chapter.startPhotoId) ?? 'a photograph the series no longer holds'}</p>
                                <form key={`${chapter.id}:${chapter.startPhotoId}`} method="post" onSubmit={submit('chapter-move', { chapterId: chapter.id })} aria-label={`Move the start of ${named}`} {...submitGate(ready)}>
                                    <label className={styles.label}>
                                        Starts at
                                        <select className={styles.control} name="startPhotoId" defaultValue={chapter.startPhotoId} aria-label={`Starts at: ${named}`}>
                                            {options}
                                        </select>
                                    </label>
                                    <div className={styles.actions}>
                                        <button type="submit" className={styles.button} aria-label={`Move start: ${named}`} {...offWhile(pending)}>
                                            Move start
                                        </button>
                                        <button type="button" className={styles.button} aria-label={`Remove chapter: ${named}`} onClick={() => send('chapter-remove', { chapterId: chapter.id })} {...offWhile(pending)}>
                                            <X size={16} aria-hidden="true" />
                                            Remove chapter
                                        </button>
                                    </div>
                                </form>
                            </li>
                        );
                    })}
                </ol>
            )}
            <SeriesAnswer state={shown} regionRef={answerRef} refreshHref={`/curation/series/${seriesId}`} />
            {photos.length === 0 ? null : (
                <form ref={addRef} className={series.subform} method="post" onSubmit={submit('chapter-add')} aria-labelledby="add-chapter-heading" {...submitGate(ready)}>
                    <h3 id="add-chapter-heading">Add a chapter</h3>
                    <label className={styles.label}>
                        Chapter title
                        <input ref={titleRef} className={styles.control} name="title" autoComplete="off" aria-invalid={titleError ? true : undefined} aria-describedby={titleError ? 'chapter-title-error' : undefined} />
                    </label>
                    {titleError ? (
                        <p className={styles.fieldError} id="chapter-title-error" data-state="invalid">
                            {titleError}
                        </p>
                    ) : null}
                    <label className={styles.label}>
                        Starts at
                        <select ref={startRef} className={styles.control} name="startPhotoId" defaultValue="" aria-invalid={startError ? true : undefined} aria-describedby={startError ? 'chapter-start-error' : undefined}>
                            <option value="">Choose a photograph</option>
                            {options}
                        </select>
                    </label>
                    {startError ? (
                        <p className={styles.fieldError} id="chapter-start-error" data-state="invalid">
                            {startError}
                        </p>
                    ) : null}
                    <div className={styles.actions}>
                        <button type="submit" className={styles.button} {...offWhile(pending)}>
                            <Plus size={16} aria-hidden="true" />
                            Add chapter
                        </button>
                    </div>
                </form>
            )}
        </section>
    );
}

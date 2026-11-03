import { checkChapterTitle, isFocalPoint, placementAt } from '../catalog/edit-fields';
import { codePointName } from '../catalog/plain-text';
import { REVISION_ID_RE, SERIES_ID_RE } from '../catalog/schema';
import { applySequenceOp, type Actor, type Consequence, type OrderError, type SequenceOp, type SeriesOp } from '../catalog/sequence';
import type { AuthoredPhoto, AuthoredSeries, AuthoredSite } from '../catalog/types';
import { readActivePointer, readAuthoredRecord, readAuthoredSeries, readWorkingLayer, RecordUnusableError } from '../catalog/working-layer';
import { AUTHORED_LEASE_MS, AUTHORED_LOCK, AUTHORED_WAIT_MS, AuthoredWriteError } from '../catalog/working-layer-writer';
import { PHOTO_ID_RE } from '../identity/ids';
import { currentProfileId } from '../identity/profile';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { configuredLibraryRoot, dataRootStatus } from '../storage/config';
import { LockLostError, LockTimeoutError, withLock, type LockContext } from '../storage/lock';
import { scrub } from './commands';
import { curatorThumbnailUrl } from './inbox';
import { WEB_ACTOR } from './inbox-form';
import { fileParts } from './inbox-view';
import {
    BUSY_ANSWER,
    NOTHING_PUBLIC,
    seriesName,
    STALE_ANSWER,
    type AddablePhoto,
    type OrderActionKind,
    type OrderActionState,
    type OrderField,
    type SeriesOrderKind,
    type SeriesOrderView,
    type SequencePhoto,
    type WorkOrderKind,
    type WorkOrderView,
    type WorkSeries,
} from './series-view';

/**
 * #150's 2b: a series' order, and the Work order and featured series, from
 * the curator's Series screen, written through `photos sequence` and `photos
 * series`' own path: #8's applySequenceOp(), as the editor, with the review
 * stamps New series and Save pass (lib/curation/series-form.ts).
 * app/curation/series/actions.ts calls runOrderAction() only after
 * requireCurator() lets the request in.
 *
 * Each form names one operation and carries the version of the record it
 * changes and the live revision the page showed. A position the page shows
 * becomes an anchor against the record at that version, as `--to <N>` does,
 * so it only stands while the record is still at it; applySequenceOp()
 * checks that under the authored lock, which this holds once for the
 * live-revision check, the photograph checks and the write. A form behind
 * either answers `stale` and nothing is written.
 *
 * It refuses what the CLI refuses, in the page's words, and one thing more:
 * a photograph joins a series only once the draft holds its photo record,
 * so one the Inbox hasn't approved, or whose source left the library, is
 * refused. Every answer names series by title and photographs by title or
 * file name, never by ID, and what the operation did besides what it was
 * asked (a cover or opening photograph cleared, a chapter's start moved)
 * follows it. Nothing is public until Publish.
 */

/** Who the screen acts as, to #8: the owner's editor, as the CLI is. Its review stamps say `curator:web`. */
const EDITOR: Actor = { kind: 'editor' };

const NOTHING = 'Nothing was written.';

class OrderFormError extends Error {
    /** The field the refusal is about, so the page shows it beside that field. */
    readonly field: OrderField | undefined;

    constructor(message: string, field?: OrderField) {
        super(message);
        this.field = field;
    }
}

/** Thrown for a record that moved or went since the page loaded. */
class StaleOrder extends Error {}
/** Thrown for a refusal the page words itself. */
class RefusedOrder extends Error {}
/** Thrown when another writer held the authored lock throughout. */
class BusyOrder extends Error {}

const invalid = (message: string, field?: OrderField): never => {
    throw new OrderFormError(message, field);
};

function field(form: FormData, name: string): string | null {
    const value = form.get(name);
    if (value === null) return null;
    // Not by its name: a form key is no word of the page's.
    if (typeof value !== 'string') return invalid("The form sent something that isn't text. Refresh the page.");
    return value;
}

/** The live revision the page showed: `none` before the first publish, or a revision ID. */
function baseFrom(form: FormData): string | null {
    const base = field(form, 'base') ?? '';
    if (base !== 'none' && !REVISION_ID_RE.test(base)) invalid('The form carries no live revision. Refresh the page.');
    return base === 'none' ? null : base;
}

const SERIES_KINDS: readonly SeriesOrderKind[] = ['insert', 'move', 'remove', 'cover', 'opening', 'chapter-add', 'chapter-move', 'chapter-remove'];
const WORK_KINDS: readonly WorkOrderKind[] = ['work-order', 'featured'];

const GONE = "This series isn't in the working layer any more, so nothing was written. Refresh the list.";
const MOVED = 'A publish or rollback happened since the page loaded, so nothing was written. Refresh the page and try again.';
const WORK_STALE = 'Work order or the featured series changed since the page loaded, so nothing was written. Refresh to see them as they are now, and try again.';
/** What a refusal says when its own words would name an ID, a field key, or a file. */
const REFUSED = "That can't be done as the draft stands, so nothing was written. The server log names the problem.";

/** A photograph the form names: its ID, which the page only ever sends back. */
function photoFrom(form: FormData, name: string, missing: { message: string; field: OrderField } | null): string {
    const photoId = field(form, name) ?? '';
    if (photoId === '' && missing) invalid(missing.message, missing.field);
    if (!PHOTO_ID_RE.test(photoId)) invalid('The form names no photograph. Refresh the page.');
    return photoId;
}

/** A 1-based position the page offered. */
function positionFrom(form: FormData): number {
    const position = field(form, 'position') ?? '';
    if (!/^[1-9]\d{0,5}$/.test(position)) invalid(`Choose a position from 1. ${NOTHING}`, 'position');
    return Number(position);
}

/** A chapter the form names. Chapter IDs are the record's own, so any the record could hold is taken, and the operation checks it's there. */
function chapterFrom(form: FormData): string {
    const chapterId = field(form, 'chapterId') ?? '';
    if (chapterId.trim() === '' || chapterId.length > 200) invalid('The form names no chapter. Refresh the page.');
    return chapterId;
}

/** A focal point percentage, 0 to 100, as the page asks for one. */
function percent(value: string | null): number {
    const text = (value ?? '').trim();
    return /^\d{1,3}(?:\.\d{1,2})?$/.test(text) ? Number(text) / 100 : Number.NaN;
}

/** A chapter title, cleaned by edit-fields.ts's checkChapterTitle(), as `photos sequence chapter add` cleans it. */
function chapterTitle(form: FormData): string {
    const checked = checkChapterTitle(field(form, 'title') ?? '');
    if (checked.ok) return checked.text;
    const { problem } = checked;
    if (problem.kind === 'empty') return invalid(`A chapter needs a title. ${NOTHING}`, 'chapterTitle');
    if (problem.kind === 'character') return invalid(`The chapter title has ${codePointName(problem.codePoint)}, ${problem.why}, at character ${problem.index}. ${NOTHING}`, 'chapterTitle');
    if (problem.kind === 'line-break') return invalid(`The chapter title has a line break, which it can't hold. ${NOTHING}`, 'chapterTitle');
    return invalid(`The chapter title is ${problem.length} characters long, over its limit of ${problem.limit}. ${NOTHING}`, 'chapterTitle');
}

/** What a series form asks for, read and checked before any record is: positions are turned into anchors later, against the record. */
type Request =
    | { kind: 'insert' | 'move'; photoId: string; position: number }
    | { kind: 'remove'; photoId: string }
    | { kind: 'cover'; photoId: string; focalPoint: { x: number; y: number } | null }
    | { kind: 'opening'; photoId: string | null }
    | { kind: 'chapter-add'; title: string; startPhotoId: string }
    | { kind: 'chapter-move'; chapterId: string; startPhotoId: string }
    | { kind: 'chapter-remove'; chapterId: string };

const START = { message: `Choose the photograph the chapter starts at. ${NOTHING}`, field: 'chapterStart' as const };

function requested(kind: SeriesOrderKind, form: FormData): Request {
    switch (kind) {
        case 'insert':
            return { kind, photoId: photoFrom(form, 'photoId', { message: `Choose a photograph to add. ${NOTHING}`, field: 'addPhoto' }), position: positionFrom(form) };
        case 'move':
            return { kind, photoId: photoFrom(form, 'photoId', null), position: positionFrom(form) };
        case 'remove':
            return { kind, photoId: photoFrom(form, 'photoId', null) };
        case 'cover': {
            const photoId = photoFrom(form, 'photoId', { message: `Choose the cover. ${NOTHING}`, field: 'cover' });
            const focal = field(form, 'focal');
            if (focal !== 'none' && focal !== 'set') return invalid('The form is missing a field. Refresh the page.');
            if (focal === 'none') return { kind, photoId, focalPoint: null };
            const point = { x: percent(field(form, 'focalX')), y: percent(field(form, 'focalY')) };
            // As `--focal x,y` takes it, each from 0 to 1, which the page shows as a percentage.
            if (!isFocalPoint(point)) invalid(`A focal point is two numbers from 0 to 100: how far across the photograph, and how far down. ${NOTHING}`, 'focal');
            return { kind, photoId, focalPoint: point };
        }
        case 'opening': {
            const value = field(form, 'photoId') ?? '';
            return { kind, photoId: value === 'none' ? null : photoFrom(form, 'photoId', null) };
        }
        case 'chapter-add':
            return { kind, title: chapterTitle(form), startPhotoId: photoFrom(form, 'startPhotoId', START) };
        case 'chapter-move':
            return { kind, chapterId: chapterFrom(form), startPhotoId: photoFrom(form, 'startPhotoId', START) };
        case 'chapter-remove':
            return { kind, chapterId: chapterFrom(form) };
    }
}

const photographs = (count: number) => `${count} photograph${count === 1 ? '' : 's'}`;

/** The operation a request is, with a position turned into an anchor against `record`, the version the form carried. */
function toOp(request: Request, record: AuthoredSeries): SeriesOp {
    const seriesId = record.id;
    switch (request.kind) {
        case 'insert':
        case 'move': {
            const at = placementAt(record.photoIds, request.photoId, request.position);
            if (at === null) {
                const length = record.photoIds.filter((id) => id !== request.photoId).length + 1;
                return invalid(`There's no position ${request.position} in this series, which would hold ${photographs(length)}. ${NOTHING}`, 'position');
            }
            return { kind: request.kind, seriesId, photoId: request.photoId, at };
        }
        case 'remove':
            return { kind: 'remove', seriesId, photoId: request.photoId };
        case 'cover':
            return { kind: 'setCover', seriesId, photoId: request.photoId, focalPoint: request.focalPoint };
        case 'opening':
            return { kind: 'setOpeningPhoto', seriesId, photoId: request.photoId };
        case 'chapter-add':
            return { kind: 'addChapter', seriesId, title: request.title, startPhotoId: request.startPhotoId };
        case 'chapter-move':
            return { kind: 'moveChapterStart', seriesId, chapterId: request.chapterId, startPhotoId: request.startPhotoId };
        case 'chapter-remove':
            return { kind: 'removeChapter', seriesId, chapterId: request.chapterId };
    }
}

/** A photograph's name on the page: its title, or its file's name. Never its ID. */
function nameOf(photo: Pick<AuthoredPhoto, 'title'> | null | undefined, registry: Registry | null, photoId: string): string {
    const title = photo?.title?.trim();
    if (title) return title;
    const source = registry?.photos[photoId]?.source.path;
    return source ? fileParts(source).name : 'A photograph';
}

/** Names photographs for an answer, reading each one's record once. A record that can't be read is named by its file. */
function photoNamer(root: string, registry: Registry | null): (photoId: string | undefined) => Promise<string> {
    const names = new Map<string, Promise<string>>();
    return (photoId) => {
        if (photoId === undefined) return Promise.resolve('A photograph');
        let name = names.get(photoId);
        if (!name) {
            name = readAuthoredRecord(root, 'photo', photoId).then((photo) => nameOf(photo, registry, photoId), () => nameOf(null, registry, photoId));
            names.set(photoId, name);
        }
        return name;
    };
}

type Namer = ReturnType<typeof photoNamer>;

const chapterName = (series: AuthoredSeries, chapterId: string | undefined) => series.chapters.find((chapter) => chapter.id === chapterId)?.title.trim() || 'A chapter';
const percentText = (value: number) => `${Math.round(value * 1000) / 10}%`;

/** What a done operation did, in the page's words. */
async function doneText(request: Request, before: AuthoredSeries, name: Namer): Promise<string> {
    switch (request.kind) {
        case 'insert':
            return `Added ${await name(request.photoId)} at position ${request.position} of ${before.photoIds.length + 1}.`;
        case 'move':
            return `Moved ${await name(request.photoId)} to position ${request.position} of ${before.photoIds.length}.`;
        case 'remove':
            return `Took ${await name(request.photoId)} out of the series.`;
        case 'cover': {
            const point = request.focalPoint;
            return `${await name(request.photoId)} is the cover now${point ? `, with its focal point ${percentText(point.x)} across and ${percentText(point.y)} down` : ', with no focal point'}.`;
        }
        case 'opening':
            return request.photoId === null ? 'The series has no opening photograph now, so it opens on its first photograph.' : `${await name(request.photoId)} is the opening photograph now.`;
        case 'chapter-add':
            return `Added the chapter ${request.title}, starting at ${await name(request.startPhotoId)}.`;
        case 'chapter-move':
            return `The chapter ${chapterName(before, request.chapterId)} starts at ${await name(request.startPhotoId)} now.`;
        case 'chapter-remove':
            return `Removed the chapter ${chapterName(before, request.chapterId)}. Its photographs stay where they are.`;
    }
}

/** What an operation that changed nothing says. */
const UNCHANGED: Record<SeriesOrderKind, string> = {
    insert: 'That photograph is there already, so nothing changed.',
    move: "That's where it is already, so nothing changed.",
    remove: 'Nothing changed.',
    cover: "That's the cover already, as it stands, so nothing changed.",
    opening: "That's the opening photograph already, so nothing changed.",
    'chapter-add': 'Nothing changed.',
    'chapter-move': 'The chapter starts there already, so nothing changed.',
    'chapter-remove': 'Nothing changed.',
};

/**
 * #8's consequences, in the page's words: the series is the page's own, a photograph is named, and a chapter by its
 * title, as the Inbox's archiveNotes() names them.
 */
async function consequenceText(consequence: Consequence, before: AuthoredSeries, name: Namer): Promise<string> {
    switch (consequence.kind) {
        case 'cover-cleared':
            return `${await name(consequence.fromPhotoId)} was the cover, so the series has no cover now. A published series needs one, so set another before you publish.`;
        case 'focal-point-dropped':
            return consequence.toPhotoId === undefined ? 'Its focal point went with it.' : `The focal point set for ${await name(consequence.fromPhotoId)}, the cover before, went with it.`;
        case 'opening-cleared':
            return `${await name(consequence.fromPhotoId)} was the opening photograph, so there is none now, and the series opens on its first photograph.`;
        case 'chapter-anchor-moved':
            return `The chapter ${chapterName(before, consequence.chapterId)} starts at ${await name(consequence.toPhotoId)} now, instead of ${await name(consequence.fromPhotoId)}.`;
    }
}

const roots = () => [dataRootStatus().root, configuredLibraryRoot()];

/** #8's own words name IDs and fields, so they stay in the server log. */
function logged(what: string, error: OrderError): void {
    console.warn(`[curation] The series screen's ${what} was refused: ${scrub(`${error.message} (${error.code}${error.field ? `, ${error.field}` : ''})`, roots())}`);
}

/** An operation #8 refused, as the page words it. */
async function seriesRefusal(error: OrderError, request: Request, op: SeriesOp, before: AuthoredSeries, name: Namer, root: string): Promise<Error> {
    const photoId = 'photoId' in op ? op.photoId ?? undefined : 'startPhotoId' in op ? op.startPhotoId : undefined;
    const photo = await name(photoId);
    switch (error.code) {
        case 'version-conflict':
            return new StaleOrder(STALE_ANSWER);
        case 'unknown-series':
            return new StaleOrder(GONE);
        case 'authored-locked':
            return new BusyOrder(BUSY_ANSWER);
        case 'unknown-photo':
            return new RefusedOrder(`The library doesn't know that photograph, so it can't join a series. ${NOTHING}`);
        case 'not-a-member':
            return new OrderFormError(`${photo} isn't in this series. Refresh the page.`);
        case 'already-a-member':
            return new OrderFormError(`${photo} is in this series already. Move it instead. ${NOTHING}`, 'addPhoto');
        case 'membership-conflict': {
            const { series } = await readAuthoredSeries(root);
            const others = series.filter((entry) => entry.id !== before.id && entry.visibility === 'published' && entry.photoIds.includes(photoId ?? '')).map((entry) => seriesName(entry.title));
            const where = others.length > 0 ? `the published series ${others.join(' and ')}` : 'another published series';
            return new RefusedOrder(`${photo} is in ${where} already, and a photograph belongs to one published series. Take it out of there first. ${NOTHING}`);
        }
        case 'series-unreadable':
            logged(request.kind, error);
            return new RefusedOrder(`A series can't be read, so nothing shows whether it holds ${photo}, and a photograph belongs to one published series. ${NOTHING} The server log names it.`);
        case 'anchor-not-found':
            if (error.field === 'chapterId') return new OrderFormError("That chapter isn't in this series. Refresh the page.");
            break;
        case 'anchor-conflict': {
            const starts = before.chapters.find((chapter) => chapter.startPhotoId === photoId && !('chapterId' in op && chapter.id === op.chapterId));
            return new OrderFormError(`${photo} starts the chapter ${starts?.title.trim() || 'another chapter'} already. Choose another photograph. ${NOTHING}`, 'chapterStart');
        }
        case 'anchor-order':
            // Only a chapter's move is refused for its order here: the screen never sets a whole sequence.
            return new OrderFormError(`The chapter ${'chapterId' in op ? chapterName(before, op.chapterId) : 'there'} would start out of order: each chapter starts after the one above it. ${NOTHING}`, 'chapterStart');
        case 'chapter-would-be-empty': {
            const started = before.chapters.find((chapter) => chapter.startPhotoId === photoId);
            return new RefusedOrder(`${photo} is the only photograph in the chapter ${started?.title.trim() || 'it starts'}. Move another photograph into it, or remove the chapter, first. ${NOTHING}`);
        }
        default:
            break;
    }
    logged(request.kind, error);
    return new RefusedOrder(REFUSED);
}

/**
 * The one check the CLI doesn't make: a photograph joins a series only while the draft holds its photo record (the
 * Inbox approved it) and its source is in the library. #8 then checks the registry knows it, under the same hold.
 */
async function checkAddable(root: string, registry: Registry, photoId: string, name: Namer): Promise<void> {
    const known = registry.photos[photoId];
    if (!known) throw new RefusedOrder(`The library doesn't know that photograph, so it can't join a series. ${NOTHING}`);
    if (known.mergedInto !== undefined || known.sourceHealth === 'archived') throw new RefusedOrder(`${await name(photoId)} was archived, so it can't join a series. ${NOTHING}`);
    if (known.sourceHealth !== 'present') throw new RefusedOrder(`${await name(photoId)}'s file isn't in the library now, so it can't join a series. Its Inbox item says what to do. ${NOTHING}`);
    if ((await readAuthoredRecord(root, 'photo', photoId)) === null) throw new RefusedOrder(`${await name(photoId)} isn't approved yet, so it can't join a series. Approve it in the Inbox first. ${NOTHING}`);
}

/** The version a form carries: from 1 for a series, from 0 for the site record, which may not exist yet. */
function versionFrom(form: FormData, from: 0 | 1, what: string): number {
    const version = field(form, 'version') ?? '';
    if (!(from === 0 ? /^(?:0|[1-9]\d{0,9})$/ : /^[1-9]\d{0,9}$/).test(version)) invalid(`The form carries no ${what} version. Refresh the page.`);
    return Number(version);
}

export interface OrderActionOptions {
    /** How long to wait for the authored lock. Defaults to the writer's 10 s. */
    waitMs?: number;
    /** Test hook: after the early version check, before the lock. */
    afterCheck?(): void | Promise<void>;
}

/** The review stamps every write passes, as New series and Save do: the web curator, against the live revision the page showed. */
const reviewOf = (base: string | null) => ({ baseRevisionId: base, origin: 'curator' as const, actor: WEB_ACTOR, reviewedAt: new Date().toISOString() });

/** Run `fn` under the authored lock, once the live revision is still the one the page showed. */
function underLock<T>(root: string, base: string | null, options: OrderActionOptions, fn: (lock: LockContext) => Promise<T>): Promise<T> {
    return withLock(AUTHORED_LOCK, { root, leaseMs: AUTHORED_LEASE_MS, waitMs: options.waitMs ?? AUTHORED_WAIT_MS }, async (lock) => {
        lock.signal.throwIfAborted();
        if (((await readActivePointer(root))?.revisionId ?? null) !== base) throw new StaleOrder(MOVED);
        return fn(lock);
    });
}

async function runSeriesOp(kind: SeriesOrderKind, form: FormData, root: string, base: string | null, options: OrderActionOptions): Promise<string> {
    const seriesId = field(form, 'seriesId') ?? '';
    if (!SERIES_ID_RE.test(seriesId)) invalid('The form names no series. Refresh the page.');
    const expectedVersion = versionFrom(form, 1, 'series');
    const request = requested(kind, form);
    // The early check: a form that's plainly behind answers refresh without the lock, and its positions are anchored
    // against this read. applySequenceOp() checks the version again under the lock, so the anchors stand or it's stale.
    const before = await readAuthoredRecord(root, 'series', seriesId);
    if (before === null) throw new StaleOrder(GONE);
    if (before.version !== expectedVersion) throw new StaleOrder(STALE_ANSWER);
    const op = toOp(request, before);
    await options.afterCheck?.();
    return underLock(root, base, options, async (lock) => {
        const registry = await readRegistry(root);
        const name = photoNamer(root, registry);
        if (op.kind === 'insert') await checkAddable(root, registry, op.photoId, name);
        const result = await applySequenceOp({ dataRoot: root }, op, { expectedVersion, actor: EDITOR, lock, review: reviewOf(base) });
        if (!result.ok) throw await seriesRefusal(result.error, request, op, before, name, root);
        if (!result.changed) throw new OrderFormError(UNCHANGED[kind]);
        const notes = await Promise.all(result.consequences.map((consequence) => consequenceText(consequence, before, name)));
        return [await doneText(request, before, name), ...notes, NOTHING_PUBLIC].join(' ');
    });
}

/**
 * The series a Work order or featured entry can name, read under the hold: those the screen can show, and those
 * whose record exists but can't be read, which stay where they are since the screen can't offer them. Any other ID
 * names a series the draft no longer holds, as a hand edit or a removed folder leaves it.
 */
async function knownSeries(root: string): Promise<{ readable: Map<string, AuthoredSeries>; kept: (id: string) => boolean }> {
    const { series, problems } = await readAuthoredSeries(root);
    const readable = new Map(series.map((entry) => [entry.id, entry]));
    // As sequenceContext() counts them: a misnamed folder entry is a problem but names no series.
    const unreadable = new Set(problems.filter((problem) => problem.kind === 'series' && SERIES_ID_RE.test(problem.id)).map((problem) => problem.id));
    return { readable, kept: (id) => readable.has(id) || unreadable.has(id) };
}

type Known = Awaited<ReturnType<typeof knownSeries>>;

/** Where a Work order move puts its series, among the series the screen shows; ones it can't show keep their places. */
function moved(order: readonly string[], seriesId: string, move: 'up' | 'down', shown: (id: string) => boolean): string[] | null {
    const at = order.indexOf(seriesId);
    const step = move === 'up' ? -1 : 1;
    let other = at + step;
    while (other >= 0 && other < order.length && !shown(order[other])) other += step;
    if (other < 0 || other >= order.length) return null;
    const rest = order.filter((id) => id !== seriesId);
    const anchor = rest.indexOf(order[other]);
    return [...rest.slice(0, move === 'up' ? anchor : anchor + 1), seriesId, ...rest.slice(move === 'up' ? anchor : anchor + 1)];
}

type SiteChange = { seriesIds: string[]; done: string } | { unchanged: string };

/** What a site form asks for, read before the lock. The change itself is worked out under it, from the records as the write finds them. */
type WorkRequest = { seriesId: string; move: 'up' | 'down' | 'off' | 'on' };

function workRequest(form: FormData): WorkRequest {
    const seriesId = field(form, 'seriesId') ?? '';
    if (!SERIES_ID_RE.test(seriesId)) invalid('The form names no series. Refresh the page.');
    const move = field(form, 'move');
    if (move !== 'up' && move !== 'down' && move !== 'off' && move !== 'on') return invalid('The form is missing a field. Refresh the page.');
    return { seriesId, move };
}

function featuredRequest(form: FormData): string[] {
    const ticked: string[] = [];
    for (const value of form.getAll('featured')) {
        if (typeof value !== 'string' || !SERIES_ID_RE.test(value)) return invalid('The form names no series. Refresh the page.');
        if (!ticked.includes(value)) ticked.push(value);
    }
    return ticked;
}

/** Said when a list named series the draft no longer holds, which this change leaves out, so the screen can mend it. */
function droppedNote(count: number, list: 'Work order' | 'The featured series'): string {
    if (count === 0) return '';
    const them = list === 'Work order' ? 'it' : 'them';
    return count === 1 ? ` ${list} also named a series the draft no longer holds, so that's gone from ${them}.` : ` ${list} also named ${count} series the draft no longer holds, so they're gone from ${them}.`;
}

/**
 * A Work order change: a series up or down past the next one shown, off Work, or on it, last. Entries for series the
 * draft no longer holds are left out, since `photos series order`'s rules refuse the whole list while any is there.
 */
function workChange({ seriesId, move }: WorkRequest, site: AuthoredSite | null, { readable, kept }: Known): SiteChange {
    const entry = readable.get(seriesId);
    // A series the screen can't read isn't one it offers, so it isn't one it moves.
    if (!entry) throw new StaleOrder(WORK_STALE);
    const title = seriesName(entry.title);
    const stored = site?.seriesOrder ?? [];
    const order = stored.filter(kept);
    const note = droppedNote(stored.length - order.length, 'Work order');
    // Nothing the curator asked for changes, but a dangling entry still goes, so the list can be saved again.
    const only = (unchanged: string): SiteChange => (note ? { seriesIds: order, done: note.trim() } : { unchanged });
    const listed = order.includes(seriesId);
    if (move === 'on') {
        if (listed) return only(`${title} is in Work order already, so nothing changed.`);
        return { seriesIds: [...order, seriesId], done: `Put ${title} on Work, last.${note}` };
    }
    if (!listed) throw new StaleOrder(WORK_STALE);
    if (move === 'off') {
        const rest = order.filter((id) => id !== seriesId);
        if (rest.length === 0) return invalid(`Work order needs at least one series, so ${title} stays. ${NOTHING}`);
        // The series as the write found it, under the hold.
        const needed = entry.visibility === 'published' ? ' A published series needs a place in Work order, so a publish waits until it has one again, or is a draft.' : '';
        return { seriesIds: rest, done: `Took ${title} off Work.${needed}${note}` };
    }
    const next = moved(order, seriesId, move, (id) => readable.has(id));
    if (next === null) return only(`${title} is ${move === 'up' ? 'first' : 'last'} in Work order already, so nothing changed.`);
    const shown = next.filter((id) => readable.has(id));
    return { seriesIds: next, done: `Moved ${title} to place ${shown.indexOf(seriesId) + 1} of ${shown.length} in Work order.${note}` };
}

/**
 * The featured choice: the boxes the form sent ticked, in the order the featured series hold now, then the page's.
 * One the screen can't read wasn't offered, so it stays featured as it was; one the draft no longer holds goes.
 */
function featuredChange(ticked: readonly string[], site: AuthoredSite | null, { readable, kept }: Known): SiteChange {
    if (ticked.some((id) => !readable.has(id))) throw new StaleOrder(WORK_STALE);
    const stored = site?.featuredSeriesIds ?? [];
    const current = stored.filter(kept);
    const note = droppedNote(stored.length - current.length, 'The featured series');
    const seriesIds = [...current.filter((id) => ticked.includes(id) || !readable.has(id)), ...ticked.filter((id) => !current.includes(id))];
    const titles = seriesIds.filter((id) => readable.has(id)).map((id) => seriesName(readable.get(id)!.title));
    if (seriesIds.length === 0) return { seriesIds, done: `No series is featured now, so Home has nothing to open on, and a publish waits until a published series is featured again.${note}` };
    if (titles.length === 0) {
        const one = seriesIds.length === 1;
        return { seriesIds, done: `None of the series shown here is featured now. Only ${one ? "one the screen can't read still is" : `${seriesIds.length} the screen can't read still are`}, so fix ${one ? 'that series' : 'them'} or feature a published one before you publish. The server log names ${one ? 'it' : 'them'}.${note}` };
    }
    const unpublished = seriesIds.flatMap((id) => {
        const entry = readable.get(id);
        return entry && entry.visibility !== 'published' ? [seriesName(entry.title)] : [];
    });
    const waits = unpublished.length > 0 ? ` Only a published series can be featured, so a publish waits until ${unpublished.join(' and ')} ${unpublished.length === 1 ? 'is' : 'are'} published or not featured.` : '';
    const lead = titles.length === 1 ? `${titles[0]} is featured now, so Home opens on it.` : `Featured now: ${titles.join(', then ')}. Home opens on the first of them a publish holds.`;
    return { seriesIds, done: `${lead}${waits}${note}` };
}

async function runSiteOp(kind: WorkOrderKind, form: FormData, root: string, base: string | null, options: OrderActionOptions): Promise<string> {
    const expectedVersion = versionFrom(form, 0, 'Work order');
    const request = kind === 'work-order' ? workRequest(form) : featuredRequest(form);
    // The early check, so a form that's plainly behind answers refresh without the lock.
    if (((await readAuthoredRecord(root, 'site', 'site'))?.version ?? 0) !== expectedVersion) throw new StaleOrder(WORK_STALE);
    await options.afterCheck?.();
    return underLock(root, base, options, async (lock) => {
        // The site record and the series as the write finds them, so the change, and what the answer says of it, are the write's.
        const site = await readAuthoredRecord(root, 'site', 'site');
        if ((site?.version ?? 0) !== expectedVersion) throw new StaleOrder(WORK_STALE);
        const known = await knownSeries(root);
        const change = kind === 'work-order' ? workChange(request as WorkRequest, site, known) : featuredChange(request as string[], site, known);
        if ('unchanged' in change) throw new OrderFormError(change.unchanged);
        const op: SequenceOp = { kind: kind === 'work-order' ? 'setSeriesOrder' : 'setFeaturedSeries', seriesIds: change.seriesIds };
        const result = await applySequenceOp({ dataRoot: root }, op, { expectedVersion, actor: EDITOR, lock, review: reviewOf(base) });
        if (!result.ok) {
            if (result.error.code === 'version-conflict') throw new StaleOrder(WORK_STALE);
            if (result.error.code === 'authored-locked') throw new BusyOrder(BUSY_ANSWER);
            logged(kind, result.error);
            // Only a series removed between the read above and the write, under this hold, by a hand edit, gets here.
            if (result.error.code === 'unknown-series') throw new RefusedOrder(`${kind === 'work-order' ? 'Work order' : 'The featured series'} names a series the draft doesn't hold, so it can't be saved. ${NOTHING} Refresh and try again; the server log names it.`);
            throw new RefusedOrder(REFUSED);
        }
        if (!result.changed) throw new OrderFormError('Nothing changed.');
        return `${change.done} ${NOTHING_PUBLIC}`;
    });
}

let serial = 0;

/**
 * Run one of a series' page's ordering forms (`series`), or the Series screen's Work order and featured forms
 * (`work`). Never throws for anything the form or the data holds; every answer is a state the page shows, with no
 * host path or ID in it.
 */
export async function runOrderAction(scope: 'series' | 'work', form: unknown, options: OrderActionOptions = {}): Promise<OrderActionState> {
    serial += 1;
    let kind: OrderActionKind = scope === 'series' ? 'move' : 'work-order';
    const answer = (status: Exclude<OrderActionState, { status: 'idle' }>['status'], message: string, extra: { field?: OrderField } = {}): OrderActionState => ({ status, action: kind, message: scrub(message, roots()), ...extra, serial });
    if (!(form instanceof FormData)) return answer('invalid', 'The form was empty. Refresh the page.');
    try {
        const named = field(form, 'op') ?? '';
        const kinds: readonly string[] = scope === 'series' ? SERIES_KINDS : WORK_KINDS;
        if (!kinds.includes(named)) return answer('invalid', 'The form names no change. Refresh the page.');
        kind = named as OrderActionKind;
        const base = baseFrom(form);
        const status = dataRootStatus({ versioned: true });
        if (status.state !== 'ready' || status.root === null) return answer('failed', `The data root is ${status.state}. ${NOTHING}`);
        const done = scope === 'series' ? await runSeriesOp(kind as SeriesOrderKind, form, status.root, base, options) : await runSiteOp(kind as WorkOrderKind, form, status.root, base, options);
        return answer('done', done);
    } catch (error) {
        if (error instanceof OrderFormError) return answer('invalid', error.message, error.field ? { field: error.field } : {});
        if (error instanceof StaleOrder) return answer('stale', error.message);
        if (error instanceof BusyOrder || error instanceof LockTimeoutError || error instanceof LockLostError) return answer('busy', BUSY_ANSWER);
        if (error instanceof RefusedOrder) return answer('refused', error.message);
        if (error instanceof RecordUnusableError) {
            console.warn(`[curation] The series screen's ${kind} found a record unusable: ${scrub(error.message, roots())}`);
            return answer('failed', `${scope === 'series' ? 'This series' : 'Work order'} can't be read, so nothing was written. The server log names the problem.`);
        }
        if (error instanceof AuthoredWriteError) {
            if (error.code === 'VERSION_CONFLICT') return answer('stale', scope === 'series' ? STALE_ANSWER : WORK_STALE);
            if (error.code === 'AUTHORED_LOCKED' || error.code === 'LOCK_NOT_HELD') return answer('busy', BUSY_ANSWER);
            if (error.code === 'DATA_ROOT_NOT_READY') return answer('failed', `The data root isn't ready, so ${NOTHING.toLowerCase()}`);
            // The writer's own words name the record by ID and its issues by field key, so they stay in the server log.
            const issues = error.issues?.map((issue) => `${issue.path || '(the record)'}: ${issue.message}`).join('; ') ?? '';
            console.warn(`[curation] The series screen's ${kind} was refused by the writer: ${scrub(`${error.message} ${issues}`, roots())}`);
            return answer('refused', REFUSED);
        }
        // Storage errors can name a host path, so only the kind of failure shows here. The server log keeps the rest.
        console.error(`[curation] The series screen's ${kind} failed:`, error);
        return answer('failed', `The curator couldn't finish that (${error instanceof Error ? error.name : 'an error'}). Refresh and check the series before trying again.`);
    }
}

/** The w400 thumbnail of the set a photograph pins, from the curator-only route, or null while none is ready. */
function thumbnailOf(registry: Registry | null, photoId: string, assetRevision: string | undefined): string | null {
    const known = registry?.photos[photoId];
    const revision = assetRevision ?? known?.source.observedRevision;
    if (!known || revision === undefined) return null;
    const profiles = known.revisions[revision]?.profiles ?? {};
    const profileId = profiles[currentProfileId()]?.state === 'ready' ? currentProfileId() : Object.entries(profiles).find(([, entry]) => entry.state === 'ready')?.[0];
    return profileId === undefined ? null : curatorThumbnailUrl(photoId, revision, profileId);
}

/**
 * A series' order for its page: its photographs in sequence, its cover, opening photograph and chapters, and the
 * photographs it can take. Two photographs the page would name alike are named by their library paths instead.
 */
export async function seriesOrderView(root: string, record: AuthoredSeries): Promise<SeriesOrderView> {
    const [layer, registry] = await Promise.all([readWorkingLayer(root), readRegistry(root).catch((error: unknown) => {
        console.warn(`[curation] The registry can't be read for a series' page, so its photographs are named without their files: ${scrub((error as Error).message, [root, configuredLibraryRoot()])}`);
        return null;
    })]);
    const photos = new Map(layer.photos.map((photo) => [photo.id, photo]));
    const holders = new Map<string, AuthoredSeries[]>();
    for (const entry of layer.series) for (const photoId of entry.photoIds) holders.set(photoId, [...(holders.get(photoId) ?? []), entry]);
    const shown = (photoId: string): SequencePhoto => ({ id: photoId, name: nameOf(photos.get(photoId), registry, photoId), thumbnailUrl: thumbnailOf(registry, photoId, photos.get(photoId)?.assetRevision) });
    const members = record.photoIds.map(shown);
    const published = record.visibility === 'published';
    const addable: AddablePhoto[] = layer.photos
        .filter((photo) => !record.photoIds.includes(photo.id))
        .filter((photo) => {
            const known = registry?.photos[photo.id];
            return known !== undefined && known.mergedInto === undefined && known.sourceHealth === 'present';
        })
        // A published series can't take one another published series holds, so the page doesn't offer it.
        .filter((photo) => !published || !(holders.get(photo.id) ?? []).some((entry) => entry.visibility === 'published'))
        .map((photo) => ({ ...shown(photo.id), heldBy: (holders.get(photo.id) ?? [])[0] ? seriesName(holders.get(photo.id)![0].title) : null }));
    // Unique names: two the page would name alike go by their library paths, which tell them apart.
    const counts = new Map<string, number>();
    for (const photo of [...members, ...addable]) counts.set(photo.name, (counts.get(photo.name) ?? 0) + 1);
    for (const photo of [...members, ...addable]) {
        const source = registry?.photos[photo.id]?.source.path;
        if ((counts.get(photo.name) ?? 0) > 1 && source && !photos.get(photo.id)?.title?.trim()) photo.name = source;
    }
    addable.sort((a, b) => Number(a.heldBy !== null) - Number(b.heldBy !== null) || a.name.localeCompare(b.name));
    return {
        version: record.version,
        published,
        photos: members,
        cover: record.cover ? { photoId: record.cover.photoId, focalPoint: record.cover.focalPoint ?? null } : null,
        openingPhotoId: record.openingPhotoId ?? null,
        chapters: record.chapters.map((chapter) => ({ id: chapter.id, title: chapter.title, startPhotoId: chapter.startPhotoId })),
        addable,
    };
}

/**
 * The Work order and featured series for the Series screen, or null when the site record can't be read, so the
 * screen offers neither rather than write over a record it couldn't show.
 */
export async function workOrderView(root: string, series: readonly AuthoredSeries[]): Promise<WorkOrderView | null> {
    let site: AuthoredSite | null;
    try {
        site = await readAuthoredRecord(root, 'site', 'site');
    } catch (error) {
        console.warn(`[curation] The site record can't be read for the Series screen's Work order: ${scrub((error as Error).message, [root, configuredLibraryRoot()])}`);
        return null;
    }
    const byId = new Map(series.map((entry) => [entry.id, entry]));
    const row = (entry: AuthoredSeries): WorkSeries => ({ id: entry.id, title: seriesName(entry.title), visibility: entry.visibility });
    const order = (site?.seriesOrder ?? []).flatMap((id) => (byId.has(id) ? [row(byId.get(id)!)] : []));
    const listed = new Set(order.map((entry) => entry.id));
    const offWork = series.filter((entry) => !listed.has(entry.id)).map(row).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    return { version: site?.version ?? 0, order, offWork, all: [...order, ...offWork], featured: [...(site?.featuredSeriesIds ?? [])] };
}

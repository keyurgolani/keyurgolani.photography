import { checkText, editable, newSeries } from '../catalog/edit-record';
import { MAX_SLUG_LENGTH, RESERVED_SLUGS, SERIES_ID_RE, SLUG_RE } from '../catalog/schema';
import type { AuthoredSeries, AuthoredSeriesInput } from '../catalog/types';
import { readActivePointer, readAuthoredRecord, readAuthoredSeries, RecordUnusableError } from '../catalog/working-layer';
import { AuthoredWriteError, writeAuthoredRecord } from '../catalog/working-layer-writer';
import { canonicalJson } from '../storage/canonical';
import { dataRootStatus, libraryRoot } from '../storage/config';
import { LockLostError, LockTimeoutError } from '../storage/lock';
import { scrub } from './commands';
import { WEB_ACTOR } from './inbox-form';
import {
    BUSY_ANSWER,
    DONE_ANSWER,
    FIELD_LABEL,
    seriesName,
    STALE_ANSWER,
    VISIBILITIES,
    type SeriesActionKind,
    type SeriesActionState,
    type SeriesDetail,
    type SeriesField,
    type SeriesRow,
    type SeriesVisibility,
} from './series-view';

/**
 * #150's 2a: the curator's Series screen, read from the working layer, and
 * its two forms, written through `photos edit`'s own path.
 * app/curation/series/actions.ts calls runSeriesAction() only after
 * requireCurator() lets the request in.
 *
 * New series opens from edit-record.ts's newSeries(), as `photos edit
 * <seriesId>` does for a series with no record, with the title the curator
 * typed. Its ID and slug come from the web address typed, or from the
 * title, made unique among every series' slugs and old slugs, and its ID
 * matches SERIES_ID_RE.
 *
 * A series' page edits what `photos edit` shows of it (editable()), and only
 * its title, statements and visibility: the order, the cover, the opening
 * photograph and the chapters are 2b's, and the photographs and the
 * carry-over marker are never the form's, so whatever else a form sends is
 * not read. Both forms clean their text with edit-record.ts's checkText(),
 * so the curator and the CLI store the same text, and both save with
 * writeAuthoredRecord() under the version the page showed, so a series
 * that moved since is `stale` and nothing is written. Nothing is public
 * until Publish.
 */

class SeriesFormError extends Error {
    /** The field the refusal is about, so the page shows it beside that field. */
    readonly field: SeriesField | undefined;

    constructor(message: string, field?: SeriesField) {
        super(message);
        this.field = field;
    }
}

const NOTHING = 'Nothing was written.';

const invalid = (message: string, field?: SeriesField): never => {
    throw new SeriesFormError(message, field);
};

function field(form: FormData, name: string): string | null {
    const value = form.get(name);
    if (value === null) return null;
    if (typeof value !== 'string') return invalid(`${name} must be text.`);
    return value;
}

/** The series a page's form names, and the version the page showed. */
function seriesFields(form: FormData): { seriesId: string; expectedVersion: number } {
    const seriesId = field(form, 'seriesId') ?? '';
    if (!SERIES_ID_RE.test(seriesId)) invalid('The form names no series. Refresh the page.');
    const version = field(form, 'version') ?? '';
    if (!/^[1-9]\d{0,9}$/.test(version)) invalid('The form carries no series version. Refresh the page.');
    return { seriesId, expectedVersion: Number(version) };
}

const TEXT_FIELDS = ['title', 'statement', 'shortStatement'] as const;

/**
 * checkText()'s problems, which start with the field's name, in the page's words: the field by its label, and the
 * first field named, for the page to show them by.
 */
function textRefusal(problems: readonly string[]): never {
    let first: SeriesField | undefined;
    const worded = problems.map((problem) => {
        const name = TEXT_FIELDS.find((key) => problem.startsWith(`${key} `));
        if (name === undefined) return problem;
        first ??= name;
        return `${FIELD_LABEL[name]}${problem.slice(name.length)}`;
    });
    return invalid(`${worded.join(' ')} ${NOTHING}`, first);
}

/** Every slug and old slug the working layer's series answer to, and their IDs, with those of records that can't be read. */
async function taken(root: string): Promise<{ slugs: Set<string>; ids: Set<string> }> {
    const { series, problems } = await readAuthoredSeries(root);
    return {
        slugs: new Set(series.flatMap((entry) => [entry.slug, ...entry.slugAliases])),
        ids: new Set([...series.map((entry) => entry.id), ...problems.filter((problem) => problem.kind === 'series').map((problem) => problem.id)]),
    };
}

const reserved = (slug: string) => (RESERVED_SLUGS as readonly string[]).includes(slug);

/** A title's words as a slug: accents dropped, lowercase letters and digits joined by single hyphens, short enough for a suffix. */
function slugFromTitle(title: string): string {
    const words = title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return words.slice(0, MAX_SLUG_LENGTH - 4).replace(/-+$/, '');
}

/** The first of `base`, `base-2`, `base-3` … that `free` takes. */
function firstFree(base: string, free: (candidate: string) => boolean): string {
    if (free(base)) return base;
    for (let n = 2; ; n++) if (free(`${base}-${n}`)) return `${base}-${n}`;
}

/** New series' slug: the one typed, which must be free, or one made from the title, made free. */
function slugFrom(typed: string, title: string, used: Set<string>): string {
    if (typed !== '') {
        if (!SLUG_RE.test(typed) || typed.length > MAX_SLUG_LENGTH) invalid(`A web address is lowercase letters and digits in words joined by single hyphens, at most ${MAX_SLUG_LENGTH} characters. ${NOTHING}`, 'slug');
        if (reserved(typed)) invalid(`The site keeps /${typed} for its own pages. Choose another web address. ${NOTHING}`, 'slug');
        if (used.has(typed)) invalid(`Another series has that web address already. Choose another. ${NOTHING}`, 'slug');
        return typed;
    }
    const base = slugFromTitle(title);
    if (base === '') invalid(`The title has no letters or digits to make a web address from. Type one. ${NOTHING}`, 'slug');
    return firstFree(base, (candidate) => !reserved(candidate) && !used.has(candidate));
}

/** New series' ID: `ser_` and its slug, cut to fit SERIES_ID_RE, and made free among the IDs the working layer holds. */
function idFor(slug: string, ids: Set<string>): string {
    const stem = slug.length >= 2 ? slug.slice(0, 56).replace(/-+$/, '') : `${slug}-series`;
    return `ser_${firstFree(stem, (candidate) => !ids.has(`ser_${candidate}`))}`;
}

/** New series: newSeries()'s draft, with the title the curator typed, under a free ID and slug. */
async function created(form: FormData, root: string): Promise<AuthoredSeriesInput> {
    const draft = newSeries('ser_new');
    draft.title = field(form, 'title') ?? '';
    const problems = checkText(draft, 'series');
    if (problems.length > 0) textRefusal(problems);
    const title = draft.title as string;
    if (title === '') invalid(`A new series needs a title. ${NOTHING}`, 'title');
    const used = await taken(root);
    const slug = slugFrom((field(form, 'slug') ?? '').trim(), title, used.slugs);
    const id = idFor(slug, used.ids);
    const record = { ...newSeries(id), title, slug };
    // As `photos edit` checks the file it commits: every field of the record it writes.
    const again = checkText(record, 'series');
    if (again.length > 0) textRefusal(again);
    return record as unknown as AuthoredSeriesInput;
}

/** Thrown for a series that moved or went since the page loaded. */
class StaleSeries extends Error {}

/** A series' page: the record as `photos edit` opens it, with the four fields the form edits. */
async function edited(form: FormData, root: string, seriesId: string, expectedVersion: number): Promise<{ record: AuthoredSeriesInput; current: AuthoredSeries }> {
    const values = Object.fromEntries(TEXT_FIELDS.map((name) => [name, field(form, name)]));
    const visibility = field(form, 'visibility');
    if (Object.values(values).some((value) => value === null) || visibility === null) invalid('The form is missing a field. Refresh the page.');
    if (!(VISIBILITIES as readonly string[]).includes(visibility as string)) invalid(`Choose Published, Draft or Hidden. ${NOTHING}`, 'visibility');
    const current = await readAuthoredRecord(root, 'series', seriesId);
    if (current === null) throw new StaleSeries("This series isn't in the working layer any more, so nothing was written. Refresh the list.");
    if (current.version !== expectedVersion) throw new StaleSeries(STALE_ANSWER);
    const opened = editable(current);
    const record: Record<string, unknown> = { ...opened, ...values, visibility: visibility as SeriesVisibility };
    const problems = checkText(record, 'series');
    if (problems.length > 0) textRefusal(problems);
    // Compared as values, as `photos edit` does, so text the cleaning stores as it is already is no change.
    if (canonicalJson(record) === canonicalJson(opened)) invalid('Nothing changed, so there is nothing to save.');
    return { record: record as unknown as AuthoredSeriesInput, current };
}

/** What a refusal says when its own words would name an ID, a field key, or a file. */
const REFUSED = "The series can't be saved as it stands, so nothing was written. The server log names the problem.";

let serial = 0;

/** Run New series or a series' Save from its form. Never throws for anything the form or the data holds; every answer is a state the page shows, with no host path in it. */
export async function runSeriesAction(kind: SeriesActionKind, form: unknown, options: { actor?: string; waitMs?: number } = {}): Promise<SeriesActionState> {
    serial += 1;
    const answer = (status: Exclude<SeriesActionState, { status: 'idle' }>['status'], seriesId: string | null, message: string, extra: { field?: SeriesField; href?: string; title?: string } = {}): SeriesActionState => {
        return { status, action: kind, seriesId, message: scrub(message, [dataRootStatus().root, libraryRoot()]), ...extra, serial };
    };
    if (!(form instanceof FormData)) return answer('invalid', null, 'The form was empty. Refresh the page.');
    let seriesId: string | null = null;
    try {
        const target = kind === 'edit' ? seriesFields(form) : null;
        seriesId = target?.seriesId ?? null;
        const status = dataRootStatus({ versioned: true });
        if (status.state !== 'ready' || status.root === null) return answer('failed', seriesId, `The data root is ${status.state}. ${NOTHING}`);
        const root = status.root;
        const { record, current } = target ? await edited(form, root, target.seriesId, target.expectedVersion) : { record: await created(form, root), current: null };
        seriesId = record.id;
        // Stamped as the Publish screen's fixes are: the web curator, against the live revision as the write starts.
        const review = { baseRevisionId: (await readActivePointer(root))?.revisionId ?? null, origin: 'curator' as const, actor: options.actor ?? WEB_ACTOR, reviewedAt: new Date().toISOString() };
        const saved = await writeAuthoredRecord(record, { expectedVersion: current?.version ?? 0, root, review, ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }) });
        if (kind === 'edit') return answer('done', saved.id, DONE_ANSWER.edit);
        return answer('done', saved.id, DONE_ANSWER.create(saved.title), { href: `/curation/series/${saved.id}`, title: seriesName(saved.title) });
    } catch (error) {
        if (error instanceof SeriesFormError) return answer('invalid', seriesId, error.message, error.field ? { field: error.field } : {});
        if (error instanceof StaleSeries) return answer('stale', seriesId, error.message);
        if (error instanceof RecordUnusableError) {
            console.warn(`[curation] The series ${kind} on ${seriesId} found it unusable: ${scrub(error.message, [dataRootStatus().root, libraryRoot()])}`);
            return answer('failed', seriesId, `This series can't be read, so nothing was written. The server log names the problem.`);
        }
        if (error instanceof AuthoredWriteError) {
            // A new series' ID that another write took between the read and the write, or a series saved since.
            if (error.code === 'VERSION_CONFLICT') return answer('stale', seriesId, kind === 'create' ? `Another series took that web address just now, so ${NOTHING.toLowerCase()} Refresh the list and make it again.` : STALE_ANSWER);
            if (error.code === 'AUTHORED_LOCKED' || error.code === 'LOCK_NOT_HELD') return answer('busy', seriesId, BUSY_ANSWER);
            if (error.code === 'DATA_ROOT_NOT_READY') return answer('failed', seriesId, `The data root isn't ready, so ${NOTHING.toLowerCase()}`);
            // The writer's own words name the record by ID and its issues by field key, so they stay in the server log.
            const issues = error.issues?.map((issue) => `${issue.path || '(the record)'}: ${issue.message}`).join('; ') ?? '';
            console.warn(`[curation] The series ${kind} on ${seriesId} was refused: ${scrub(`${error.message} ${issues}`, [dataRootStatus().root, libraryRoot()])}`);
            return answer('refused', seriesId, REFUSED);
        }
        if (error instanceof LockTimeoutError || error instanceof LockLostError) return answer('busy', seriesId, BUSY_ANSWER);
        // Storage errors can name a host path, so only the kind of failure shows here. The server log keeps the rest.
        console.error(`[curation] The series ${kind} on ${seriesId ?? 'a new series'} failed:`, error);
        return answer('failed', seriesId, `The curator couldn't finish that (${error instanceof Error ? error.name : 'an error'}). Refresh and check the series before trying again.`);
    }
}

/** The Series screen, or why it can't be shown. Throws when the working layer can't be read, as loadInbox() does. */
export async function loadSeriesScreen(): Promise<{ state: 'ready'; rows: SeriesRow[]; unreadable: number } | { state: 'not-ready'; message: string }> {
    const status = dataRootStatus();
    if (status.state !== 'ready' || status.root === null) return { state: 'not-ready', message: `The data root is ${status.state}, so the series can't be shown. Nothing was written.` };
    const root = status.root;
    const { series, problems } = await readAuthoredSeries(root);
    const order = await workOrder(root);
    const rows = series.map((entry): SeriesRow => ({
        id: entry.id,
        title: entry.title,
        slug: entry.slug,
        visibility: entry.visibility,
        photoCount: entry.photoIds.length,
        carriedOver: entry.carryOver !== undefined,
        inWorkOrder: order.has(entry.id),
        href: `/curation/series/${entry.id}`,
    }));
    // Work order first, as visitors see it, then the rest by title.
    const place = (row: SeriesRow) => order.get(row.id) ?? Number.POSITIVE_INFINITY;
    rows.sort((a, b) => place(a) - place(b) || seriesName(a.title).localeCompare(seriesName(b.title)) || a.id.localeCompare(b.id));
    return { state: 'ready', rows, unreadable: problems.filter((problem) => problem.kind === 'series').length };
}

/** The site record's Work order, by place. Empty when there's no site record, or it can't be read: the list then shows every series by title. */
async function workOrder(root: string): Promise<Map<string, number>> {
    try {
        const site = await readAuthoredRecord(root, 'site', 'site');
        return new Map((site?.seriesOrder ?? []).map((id, index) => [id, index]));
    } catch (error) {
        console.warn(`[curation] The site record can't be read for the Series screen's Work order: ${scrub((error as Error).message, [root, libraryRoot()])}`);
        return new Map();
    }
}

/** One series for its page. Not found for an ID that can't name a series or one with no record. Throws when the record can't be read. */
export async function loadSeriesDetail(seriesId: string): Promise<{ state: 'ready'; detail: SeriesDetail } | { state: 'not-found' } | { state: 'not-ready'; message: string }> {
    if (!SERIES_ID_RE.test(seriesId)) return { state: 'not-found' };
    const status = dataRootStatus();
    if (status.state !== 'ready' || status.root === null) return { state: 'not-ready', message: `The data root is ${status.state}, so the series can't be shown. Nothing was written.` };
    const record = await readAuthoredRecord(status.root, 'series', seriesId);
    if (record === null) return { state: 'not-found' };
    const order = await workOrder(status.root);
    return {
        state: 'ready',
        detail: {
            id: record.id,
            version: record.version,
            title: record.title,
            slug: record.slug,
            statement: record.statement,
            shortStatement: record.shortStatement,
            visibility: record.visibility,
            photoCount: record.photoIds.length,
            carriedOver: record.carryOver !== undefined,
            inWorkOrder: order.has(record.id),
        },
    };
}

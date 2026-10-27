import type { CatalogChange, CatalogDiff } from '../catalog/diff';
import { hashValue, inboxReviewOf, type FieldReviewState, type InboxItem, type ReviewContext } from '../catalog/review';
import type { Activation, AuthoredRecord, CandidateContent, CandidatePhotoRecord, Issue, IssueRecord, PublicPhotoRecord, RevisionContent, WorkingLayer } from '../catalog/types';
import type { Registry } from '../identity/types';
import { dayOf, type Blocker, type BlockerLink, type Compare, type Fix, type KindLabel, type Ledger, type LedgerRow, type Picture, type ReviewLabel, type ReviewTarget } from './publish-facts';
import { fileParts, shortIdOf } from './inbox-view';

/**
 * #16's Publish screen (16-3): the ledger rows and the blocker list, from one
 * function (the join, spec "Server side"). It takes the diff, the review
 * context and, after Validate or Publish, the answer's diagnostics, and
 * returns both, so every blocker in the result has exactly one row that says
 * so, with its fix. Summaries are in visitor terms, by title or file name,
 * never 16-1's CLI summary. Pure: the page's loader reads the data root.
 */

export interface LedgerInput {
    diff: CatalogDiff;
    layer: WorkingLayer;
    active: RevisionContent;
    candidate: CandidateContent;
    registry: Registry | null;
    review: ReviewContext;
    activations: readonly Activation[];
    /** The answer's errors, or null on a page load, where the review state predicts them. */
    issues: readonly Issue[] | null;
    /** A `/media` URL for an image of the candidate (the preview's mirror) and of the active revision. */
    media: { draft: (url: string) => string; live: (url: string) => string };
}

type Json = CatalogChange['before'];
type PhotoLike = CandidatePhotoRecord | PublicPhotoRecord;

const SERIES_FIELD: Record<string, string> = {
    title: 'title',
    statement: 'statement',
    shortStatement: 'short statement',
    cover: 'cover',
    chapters: 'chapters',
    openingPhotoId: 'opening photograph',
    accent: 'accent colour',
    slug: 'address',
    slugAliases: 'former addresses',
    photoIds: 'order',
    visibility: 'visibility',
};

const PHOTO_FIELD: Record<string, string> = {
    alt: 'description',
    title: 'title',
    caption: 'caption',
    credit: 'credit',
    location: 'location',
    capturedAt: 'capture date',
    focalPoint: 'focal point',
    crop: 'crop',
    accent: 'accent colour',
    assetRevision: 'image revision',
};

const DERIVED_FIELD: Record<string, string> = {
    width: 'size',
    height: 'size',
    aspectRatio: 'size',
    variants: 'image set',
    profileId: 'image set',
    lqip: 'colour summary',
    technical: 'camera details',
    capturedAt: 'capture date',
};

const TEXT_FIELDS = new Set(['title', 'statement', 'shortStatement', 'caption', 'credit', 'location']);

/** The reasons a stamp-only review on the screen may clear (decision 2), and the action's label. */
const RESTAMP: Partial<Record<NonNullable<FieldReviewState['reason']>, string>> = {
    'active-moved': 'Still right, mark reviewed',
    'base-unreadable': 'Still right, mark reviewed',
    'asset-replaced': 'Still right, mark reviewed',
    'cover-replaced': 'Still right, mark reviewed',
    edited: 'Mark reviewed',
    'no-stamp': 'Mark reviewed',
    generated: 'Mark reviewed',
};

/** The reasons only the Inbox settles. */
export const INBOX_REASONS: ReadonlySet<string> = new Set(['item-reopened', 'newer-item', 'item-unreadable', 'inbox-unread']);

/** Whether "Mark reviewed" may clear this field's state: its reason is one the screen restamps, and it isn't a generated description, whose review is its own fix. */
export function restampReason(state: FieldReviewState): boolean {
    return state.state !== 'reviewed' && state.reason !== undefined && RESTAMP[state.reason] !== undefined && !isGeneratedAlt(state);
}

/** What the CLI or a restore has to do, for a reason the screen can't clear. */
const HINT_ONLY: Partial<Record<NonNullable<FieldReviewState['reason']>, string>> = {
    'no-record': 'Its record is gone from the working layer. Restore it from a backup, or publish without the change.',
    'backfill-unreadable': "authored/review-backfill.json can't be read. Restore it from the data-root backup; never edit or delete it.",
    'inbox-unread': "The inbox couldn't be read. Load the page again.",
};

const valueOf = (record: AuthoredRecord, field: string): unknown => (record as unknown as Record<string, unknown>)[field];
const pad = (n: number) => String(n).padStart(2, '0');
const isGeneratedAlt = (entry: FieldReviewState) => entry.reason === 'generated' && entry.record.kind === 'photo' && entry.field === 'alt';
const keyOf = (record: IssueRecord, field: string) => `${record.kind}:${record.id}:${field}`;

/** The page's names for records, read from the candidate, then the active revision, then the working layer and the registry. */
export class Names {
    constructor(private readonly input: Pick<LedgerInput, 'active' | 'candidate' | 'layer' | 'registry'>) {}

    series(id: string): string {
        const { candidate, active, layer } = this.input;
        const title = candidate.series.find((entry) => entry.id === id)?.title || active.series.find((entry) => entry.id === id)?.title || layer.series.find((entry) => entry.id === id)?.title;
        return title || id;
    }

    /** A photograph by its title, or its file name and short ID, as the Inbox shows it. */
    photo(id: string): string {
        const { candidate, active, layer, registry } = this.input;
        const title = candidate.photos.find((entry) => entry.id === id)?.title ?? active.photos.find((entry) => entry.id === id)?.title ?? layer.photos.find((entry) => entry.id === id)?.title;
        if (title) return title;
        const source = registry?.photos[id]?.source?.path;
        return source ? `${fileParts(source).name} (${shortIdOf(id)})` : shortIdOf(id);
    }

    record(record: IssueRecord): string {
        if (record.kind === 'site') return 'Home';
        return record.kind === 'series' ? this.series(record.id) : this.photo(record.id);
    }
}

/** A revision's number, for an owner's sentence about what a review was made against. */
function revisionNumberOf(activations: readonly Activation[], revisionId: string | null): number | null {
    if (revisionId === null) return null;
    return activations.find((activation) => activation.status === 'committed' && activation.revisionId === revisionId)?.revisionNumber ?? null;
}

function stampPhrase(by: string | undefined): string {
    if (by === 'curator:web') return 'from this screen';
    if (by === undefined || by === 'cli') return 'with the photos command';
    return `by ${by}`;
}

/** The smallest WebP (else any) derivative of a photograph, as a picture the screen can show. */
function pictureOf(photo: PhotoLike | undefined, url: (path: string) => string, alt: string): Picture | null {
    if (!photo) return null;
    const widths = Object.keys(photo.variants).sort((a, b) => Number(a) - Number(b));
    for (const width of widths) {
        const formats = photo.variants[width as keyof typeof photo.variants];
        const file = formats?.webp ?? Object.values(formats ?? {})[0];
        if (file) return { src: url(file.url), alt };
    }
    return null;
}

function altText(photo: PhotoLike | undefined): string {
    const alt = photo?.alt;
    return alt?.kind === 'described' && alt.text.trim() !== '' ? alt.text : 'Image, no description yet';
}

function altValue(value: Json): string | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const kind = (value as { kind?: unknown }).kind;
    if (kind === 'described') return String((value as { text?: unknown }).text ?? '');
    if (kind === 'decorative') return 'Decorative, no description';
    return null;
}

const asText = (value: Json): string | null => (value === null ? null : typeof value === 'string' ? value : JSON.stringify(value));

/** The candidate's placement of a photograph, by series. */
function placementOf(content: CandidateContent | RevisionContent, photoId: string): { seriesId: string; position: number } | null {
    for (const series of content.series) {
        const index = series.photoIds.indexOf(photoId);
        if (index >= 0) return { seriesId: series.id, position: index + 1 };
    }
    return null;
}

interface Built {
    rows: Map<string, LedgerRow>;
    group: Map<string, 'authored' | 'derived' | 'health'>;
    /** Each row's change, for the blockers. */
    change: Map<string, CatalogChange>;
}

/** The rows of one diff, the join's first half. */
function rowsOf(input: LedgerInput, names: Names): Built {
    const built: Built = { rows: new Map(), group: new Map(), change: new Map() };
    for (const change of input.diff.changes) {
        if (!change.visible && change.category !== 'missing') continue;
        const id = `chg-${change.id}`;
        const group = change.category === 'missing' ? 'health' : change.category === 'derived' || change.category === 'asset' ? 'derived' : 'authored';
        built.rows.set(id, {
            id,
            kind: kindOf(change),
            review: reviewOf(change),
            summary: summaryOf(change, input, names),
            blocks: false,
            ...detailOf(change, input, names),
            ...compareOf(change, input, names),
        });
        built.group.set(id, group);
        built.change.set(id, change);
    }
    return built;
}

function kindOf(change: CatalogChange): KindLabel {
    switch (change.category) {
        case 'new':
            return 'New';
        case 'removed':
            return 'Removed';
        case 'moved':
            return 'Moved';
        case 'visibility':
            return 'Hidden';
        case 'route':
            return 'Route';
        case 'asset':
            return 'New image';
        case 'derived':
            return 'Recalculated';
        case 'missing':
            return 'Source health';
        default:
            return 'Changed';
    }
}

function reviewOf(change: CatalogChange): ReviewLabel {
    if (change.category === 'derived' || change.category === 'missing' || change.review.state === 'not-required') return 'automatic';
    const entries = change.review.fields;
    if (entries.some((entry) => entry.state === 'stale')) return 'stale';
    if (entries.some((entry) => entry.state === 'unreviewed' && entry.reason === 'generated')) return 'generated';
    if (entries.some((entry) => entry.state === 'unreviewed')) return 'not-reviewed';
    return change.category === 'asset' ? 'confirmed' : 'reviewed';
}

/** The ledger's one line for a change, in visitor terms. */
export function summaryOf(change: CatalogChange, input: Pick<LedgerInput, 'active' | 'candidate'>, names: Names): string {
    const { record, field, category } = change;
    const before = change.before as Record<string, Json> | Json[] | null;
    const after = change.after as Record<string, Json> | Json[] | null;
    if (record.kind === 'site') {
        if (field === 'featuredSeriesIds') {
            const was = Array.isArray(before) ? before : [];
            const now = Array.isArray(after) ? after : [];
            return now.length > 0 && now[0] !== was[0] ? `Home features ${names.series(String(now[0]))} first` : 'Home features other series';
        }
        return 'The Work order changes';
    }
    if (record.kind === 'series') {
        const name = names.series(record.id);
        if (category === 'new') return `${name} is published, with ${String((after as Record<string, Json>)?.photoCount ?? 0)} photographs`;
        if (category === 'removed') return `${name} leaves the site`;
        if (category === 'visibility') return `${name} is ${String(after)}, so it leaves the site`;
        if (category === 'route') return `${name}: its address changes`;
        if (category === 'derived') {
            const was = (before as Record<string, Json> | null)?.photoCount;
            const now = (after as Record<string, Json> | null)?.photoCount;
            return typeof was === 'number' && typeof now === 'number' && was !== now ? `${name}: ${now} photographs, was ${was}` : `${name}: its dates are recalculated`;
        }
        if (category === 'moved' && field.startsWith('photoIds[')) {
            const photoId = field.slice('photoIds['.length, -1);
            const from = (before as Record<string, Json> | null)?.position;
            const to = (after as Record<string, Json> | null)?.position;
            return `${names.photo(photoId)} moves from position ${String(from)} to ${String(to)} in ${name}`;
        }
        return `${name}: the ${SERIES_FIELD[field] ?? field} changes`;
    }
    const photo = names.photo(record.id);
    if (category === 'new') {
        const at = placementOf(input.candidate, record.id);
        if (!at) return `Add ${photo}`;
        return at.position === 1 ? `Add ${photo} to ${names.series(at.seriesId)} at the start` : `Add ${photo} to ${names.series(at.seriesId)} after photograph ${pad(at.position - 1)}`;
    }
    if (category === 'removed') {
        const seriesId = (before as Record<string, Json> | null)?.seriesId;
        return typeof seriesId === 'string' ? `${photo} leaves the site, from ${names.series(seriesId)}` : `${photo} leaves the site`;
    }
    if (category === 'moved') {
        const from = (before as Record<string, Json> | null)?.seriesId;
        const to = (after as Record<string, Json> | null)?.seriesId;
        return `${photo} moves from ${names.series(String(from))} to ${names.series(String(to))}`;
    }
    if (category === 'asset') return `${photo} gets a new image`;
    if (category === 'missing') return `${photo}: source missing; last published image kept`;
    if (category === 'derived') {
        if (change.causedBy) return `${photo}: its image set and facts come from the new file`;
        const labels = [...new Set((change.fields ?? []).map((name) => DERIVED_FIELD[name] ?? name))];
        return `${photo}: ${labels.join(', ')} recalculated`;
    }
    if (field === 'alt') {
        const was = altValue(change.before);
        const now = altValue(change.after);
        if (was === null && now !== null && now !== 'Decorative, no description') return `Publish descriptive alternative text for ${photo}`;
        if (now === 'Decorative, no description') return `${photo} becomes decorative`;
        return `${photo}: the description changes`;
    }
    return `${photo}: the ${PHOTO_FIELD[field] ?? field} changes`;
}

/** Before and after, only where they help judgment (scope, Visual). */
function compareOf(change: CatalogChange, input: LedgerInput, names: Names): { compare?: Compare } {
    const { record, field, category } = change;
    if (category === 'derived' || category === 'missing' || category === 'removed' || category === 'route' || category === 'visibility') return {};
    if (record.kind === 'photo') {
        const was = input.active.photos.find((photo) => photo.id === record.id);
        const now = input.candidate.photos.find((photo) => photo.id === record.id);
        if (category === 'asset') {
            return { compare: { type: 'images', before: pictureOf(was, input.media.live, altText(was)), after: pictureOf(now, input.media.draft, altText(now)) } };
        }
        if (category === 'new') {
            // Its description, labelled, while the description is what the row waits on or was just reviewed; under an Inbox
            // reason it has nothing to do with what the row says.
            const text = altValue((now?.alt ?? null) as Json);
            const open = change.review.fields.filter((entry) => entry.state !== 'reviewed');
            if (text === null || inboxWaiting(change, input) || (open.length > 0 && !isGeneratedAlt(open[0]))) return {};
            const authored = recordIn(input.layer, record);
            const generated = authored?.kind === 'photo' && authored.alt?.kind === 'described' && authored.alt.reviewed === false;
            return { compare: { type: 'description', label: generated ? 'Generated description' : 'Description', text } };
        }
        if (field === 'alt') return { compare: { type: 'text', before: altValue(change.before), after: altValue(change.after) } };
        if (TEXT_FIELDS.has(field)) return { compare: { type: 'text', before: asText(change.before), after: asText(change.after) } };
        return {};
    }
    if (record.kind === 'series') {
        if (category === 'moved' && field.startsWith('photoIds[')) {
            const photoId = field.slice('photoIds['.length, -1);
            const was = input.active.series.find((series) => series.id === record.id)?.photoIds ?? [];
            const now = input.candidate.series.find((series) => series.id === record.id)?.photoIds ?? [];
            return { compare: { type: 'list', before: was.map((id) => names.photo(id)), after: now.map((id) => names.photo(id)), moved: names.photo(photoId), from: was.indexOf(photoId) + 1, to: now.indexOf(photoId) + 1 } };
        }
        if (field === 'cover') {
            const coverOf = (value: Json) => (value && typeof value === 'object' && !Array.isArray(value) ? String((value as Record<string, Json>).photoId ?? '') : '');
            const was = input.active.photos.find((photo) => photo.id === coverOf(change.before));
            const now = input.candidate.photos.find((photo) => photo.id === coverOf(change.after));
            return { compare: { type: 'images', before: pictureOf(was, input.media.live, altText(was)), after: pictureOf(now, input.media.draft, altText(now)) } };
        }
        if (TEXT_FIELDS.has(field)) return { compare: { type: 'text', before: asText(change.before), after: asText(change.after) } };
        return {};
    }
    // The site: Home's featured series, or the Work order.
    const was = Array.isArray(change.before) ? change.before.map(String) : [];
    const now = Array.isArray(change.after) ? change.after.map(String) : [];
    // An entry the draft adds is the change, not the ones it pushes down.
    const added = now.find((id) => !was.includes(id));
    if (added !== undefined) {
        return { compare: { type: 'list', before: was.map((id) => names.series(id)), after: now.map((id) => names.series(id)), moved: names.series(added), from: 0, to: now.indexOf(added) + 1 } };
    }
    const moved = now.find((id, index) => was.indexOf(id) !== index && was.includes(id)) ?? now[0];
    if (moved === undefined) return {};
    return { compare: { type: 'list', before: was.map((id) => names.series(id)), after: now.map((id) => names.series(id)), moved: names.series(moved), from: was.indexOf(moved) + 1, to: now.indexOf(moved) + 1 } };
}

/** What a review reason means, in the owner's words. */
function reasonDetail(entry: FieldReviewState, activations: readonly Activation[], active: number | null, baseOf: (entry: FieldReviewState) => string | null): string {
    switch (entry.reason) {
        case 'generated':
            return isGeneratedAlt(entry) ? 'Required description is still a generated draft.' : 'Suggested by the Inbox, not reviewed.';
        case 'active-moved': {
            const base = revisionNumberOf(activations, baseOf(entry));
            return base === null ? `Reviewed against an earlier revision. Revision ${active ?? ''} published it differently.` : `Reviewed against revision ${base}. Revision ${active ?? ''} published it differently.`;
        }
        case 'base-unreadable':
            return "Reviewed against a revision that can't be read now, so check it against what is live.";
        case 'asset-replaced':
            return 'Reviewed with the earlier image. The photograph has new bytes.';
        case 'cover-replaced':
            return 'The cover photograph has new bytes.';
        case 'edited':
        case 'no-stamp':
            return 'Changed outside the tools, so nothing reviewed it.';
        case 'item-reopened':
        case 'newer-item':
        case 'item-unreadable':
            return 'Its Inbox item needs a decision again.';
        default:
            return HINT_ONLY[entry.reason ?? 'no-record'] ?? 'Review the change, then validate again.';
    }
}

/**
 * The open review entry whose inbox item needs a decision, even where a
 * stale base or a suggestion reads first, so the row offers Decide it in the
 * Inbox from the start, not a fix the action would refuse (high review N1).
 */
function inboxWaiting(change: CatalogChange, input: LedgerInput): FieldReviewState | null {
    const env = { layer: input.layer, active: null, review: input.review };
    for (const entry of change.review.fields) {
        if (entry.state === 'reviewed') continue;
        if (entry.reason && INBOX_REASONS.has(entry.reason) && entry.eventId) return entry;
        const hidden = inboxReviewOf(entry, env);
        if (hidden?.eventId) return hidden;
    }
    return null;
}

function detailOf(change: CatalogChange, input: LedgerInput, names: Names): { detail?: string } {
    void names;
    if (change.category === 'missing') return { detail: 'Not a change. Visitors keep the published image. Its Inbox item says what to do.' };
    if (change.category === 'derived') return {};
    const open = inboxWaiting(change, input) ?? change.review.fields.find((entry) => entry.state !== 'reviewed');
    if (open) return { detail: reasonDetail(open, input.activations, activeNumber(input), (entry) => stampBase(input.layer, entry)) };
    const latest = [...change.review.fields].filter((entry) => entry.at !== undefined && entry.at !== '1970-01-01T00:00:00.000Z').sort((a, b) => ((a.at ?? '') < (b.at ?? '') ? 1 : -1))[0];
    if (!latest?.at) return {};
    const settled = recordStamp(input.layer, latest)?.event;
    if (settled) return { detail: `${change.category === 'asset' ? 'Confirmed' : 'Approved'} in the Inbox on ${dayOf(latest.at)}.` };
    return { detail: `Reviewed ${stampPhrase(latest.by)} on ${dayOf(latest.at)}.` };
}

function activeNumber(input: Pick<LedgerInput, 'diff' | 'activations'>): number | null {
    return revisionNumberOf(input.activations, input.diff.activeRevisionId);
}

function recordIn(layer: WorkingLayer, record: IssueRecord): AuthoredRecord | null {
    if (record.kind === 'site') return layer.site;
    return (record.kind === 'series' ? layer.series : layer.photos).find((entry) => entry.id === record.id) ?? null;
}

function recordStamp(layer: WorkingLayer, entry: FieldReviewState) {
    return recordIn(layer, entry.record)?.review?.fields[entry.field];
}

function stampBase(layer: WorkingLayer, entry: FieldReviewState): string | null {
    return recordStamp(layer, entry)?.baseRevisionId ?? null;
}

/** The Inbox item a photograph's description fix points at: its newest `new` item, else any item for it. */
function inboxItemFor(review: ReviewContext, photoId: string): string | null {
    const items: InboxItem[] = [...review.inbox.values()].filter((item) => item.photoId === photoId);
    if (items.length === 0) return null;
    const newest = (list: InboxItem[]) => list.sort((a, b) => (a.lastObservedAt < b.lastObservedAt ? 1 : a.lastObservedAt > b.lastObservedAt ? -1 : a.id < b.id ? 1 : -1))[0];
    return newest(items.filter((item) => item.type === 'new'))?.id ?? newest(items).id;
}

/** A blocking row's fix, by the first field it waits on (spec, Fixes on a row). */
function fixOf(change: CatalogChange, input: LedgerInput, names: Names): Fix | undefined {
    const open = change.review.fields.filter((entry) => entry.state !== 'reviewed');
    const first = open[0];
    if (!first) return undefined;
    const waiting = inboxWaiting(change, input);
    if (waiting?.eventId) return { type: 'inbox', record: names.record(change.record), eventId: waiting.eventId };
    if (isGeneratedAlt(first)) {
        const record = recordIn(input.layer, first.record);
        const alt = record?.kind === 'photo' ? record.alt : null;
        if (record?.kind !== 'photo' || alt?.kind !== 'described') return { type: 'hint', text: 'Describe it, or mark it decorative, with photos edit.' };
        const now = input.candidate.photos.find((photo) => photo.id === record.id);
        return {
            type: 'description',
            record: names.photo(record.id),
            photoId: record.id,
            inboxItem: inboxItemFor(input.review, record.id),
            picture: pictureOf(now, input.media.draft, 'Image, no description yet'),
            text: alt.text,
            suggested: first.at && first.at !== '1970-01-01T00:00:00.000Z' ? `Suggested by the Inbox on ${dayOf(first.at)}. Nobody has reviewed it.` : 'Suggested by the Inbox. Nobody has reviewed it.',
            version: record.version,
            valueHash: hashValue(alt),
        };
    }
    if (first.reason && INBOX_REASONS.has(first.reason) && first.eventId) return { type: 'inbox', record: names.record(change.record), eventId: first.eventId };
    const label = first.reason ? RESTAMP[first.reason] : undefined;
    if (label) {
        const record = recordIn(input.layer, first.record);
        if (!record) return { type: 'hint', text: HINT_ONLY['no-record'] as string };
        // Every field this row waits on in the same record, that a review here may clear.
        const fields = open.filter((entry) => keyOf(entry.record, '') === keyOf(first.record, '') && entry.reason && RESTAMP[entry.reason] && !isGeneratedAlt(entry)).map((entry) => entry.field);
        const target: ReviewTarget = {
            kind: first.record.kind,
            id: first.record.id,
            version: record.version,
            hashes: Object.fromEntries(fields.map((field) => [field, hashValue(valueOf(record, field))])),
        };
        return { type: 'restamp', record: actionName(change, first, names), label, target, field: fieldName(first) };
    }
    return { type: 'hint', text: HINT_ONLY[first.reason ?? 'no-record'] ?? 'Review the change with the photos command, then validate again.' };
}

/** The fields #13's rebase left in conflict, by record (the `working.conflicts` rule's input). */
function conflictFields(layer: WorkingLayer): { kind: IssueRecord['kind']; id: string; field: string }[] {
    const of = (kind: IssueRecord['kind'], id: string, conflicts: { field: string }[] | undefined) => (conflicts ?? []).map((conflict) => ({ kind, id, field: conflict.field }));
    return [
        ...(layer.site ? of('site', 'site', layer.site.conflicts) : []),
        ...layer.series.flatMap((series) => of('series', series.id, series.conflicts)),
        ...layer.photos.flatMap((photo) => of('photo', photo.id, photo.conflicts)),
    ];
}

/** A conflict's fix: the edit that settles the field, with the record's full ID. Marking it reviewed would leave the conflicts entry. */
function conflictFix(change: CatalogChange): Fix {
    return { type: 'hint', text: 'Keep one value with photos edit, which clears the conflict, then validate again.', command: `photos edit ${change.record.kind === 'site' ? 'site' : change.record.id}` };
}

/** The owner's name for a field. */
function fieldName(entry: Pick<FieldReviewState, 'record' | 'field'>): string {
    const map = entry.record.kind === 'photo' ? PHOTO_FIELD : entry.record.kind === 'series' ? SERIES_FIELD : { featuredSeriesIds: 'featured series', seriesOrder: 'Work order' } as Record<string, string>;
    return map[entry.field] ?? (entry.field || 'record');
}

/** What a stamp action's accessible name adds: "Pier lamps position in Salt Roads", or "the short statement of Low Tide Hours". */
function actionName(change: CatalogChange, entry: FieldReviewState, names: Names): string {
    if (change.record.kind === 'series' && change.field.startsWith('photoIds[')) return `${names.photo(change.field.slice('photoIds['.length, -1))} position in ${names.series(change.record.id)}`;
    return `the ${fieldName(entry)} of ${names.record(entry.record)}`;
}

/** The blocker list's link for a row's fix. */
function linkOf(fix: Fix | undefined, record: string): BlockerLink {
    if (!fix || fix.type === 'hint') return { type: 'row', record };
    if (fix.type === 'description') return { type: 'description', name: fix.record };
    if (fix.type === 'inbox') return { type: 'inbox', record: fix.record, eventId: fix.eventId };
    return { type: 'restamp', name: fix.record };
}

/** The field a blocker names after its row's record: "Salt Roads · order (Pier lamps)", "Breakwater, first light · place in Low Tide Hours". */
function blockerField(change: CatalogChange, entry: Pick<FieldReviewState, 'record' | 'field'>, names: Names): string {
    if (change.record.kind === 'series' && change.field.startsWith('photoIds[')) return `order (${names.photo(change.field.slice('photoIds['.length, -1))})`;
    // A field of another record the change relies on: a new photograph's place in its series, say.
    if (entry.record.kind !== change.record.kind || entry.record.id !== change.record.id) {
        return entry.record.kind === 'series' && entry.field === 'photoIds' ? `place in ${names.series(entry.record.id)}` : `${fieldName(entry)} of ${names.record(entry.record)}`;
    }
    return fieldName(entry);
}

/** One blocker's message, in the owner's words where the reason is known. */
function blockerMessage(change: CatalogChange, entry: FieldReviewState | undefined, issue: Issue | null, input: LedgerInput): string {
    if (entry && entry.state !== 'reviewed') {
        const detail = reasonDetail(entry, input.activations, activeNumber(input), (e) => stampBase(input.layer, e));
        const lead = entry.state === 'stale' ? 'Stale review' : isGeneratedAlt(entry) ? null : 'Not reviewed';
        return lead ? `${lead}: ${detail.charAt(0).toLowerCase()}${detail.slice(1)}` : detail;
    }
    void change;
    return issue ? `${issue.message}${issue.hint ? ` ${issue.hint}` : ''}` : 'Review the change, then validate again.';
}

/**
 * The join: the ledger's rows and the blocker list, from the diff, the review
 * context and the answer's diagnostics (or, on a page load, what the review
 * state predicts the gate refuses). Every blocker that names a changed
 * record and field marks exactly that row, with its label, the badge and its
 * fix; a diagnostic with no row is listed on its own, with no link.
 */
export function buildLedger(input: LedgerInput): { ledger: Ledger; blockers: Blocker[] } {
    const names = new Names(input);
    const built = rowsOf(input, names);
    const blockers: Blocker[] = [];
    const marked = new Set<string>();
    const conflicts = conflictFields(input.layer);
    const conflictOf = (change: CatalogChange) => conflicts.some((key) => key.kind === change.record.kind && key.id === change.record.id && (change.field === key.field || change.field.startsWith(`${key.field}[`)));

    const mark = (rowId: string, entry: FieldReviewState | undefined, issue: Issue | null) => {
        const row = built.rows.get(rowId);
        const change = built.change.get(rowId);
        if (!row || !change) return;
        if (!marked.has(rowId)) {
            marked.add(rowId);
            const conflict = conflictOf(change);
            const fix = conflict ? conflictFix(change) : fixOf(change, input, names);
            row.blocks = true;
            if (fix) row.fix = fix;
            if (conflict) {
                // 15-4: a field a restore's rebase left in conflict. Its own label, not "Stale review", and the edit that settles it.
                const live = activeNumber(input);
                row.review = 'conflict';
                row.detail = `Your draft and revision ${live ?? 'live now'} both changed it.`;
            }
            // Every blocker names its row's record, so the list and the row say the same thing.
            const record = names.record(change.record);
            blockers.push({
                key: rowId,
                rowId,
                record,
                field: entry ? blockerField(change, entry, names) : blockerField(change, { record: change.record, field: change.field }, names),
                message: conflict ? 'This field changed both here and in the live revision, in different ways.' : blockerMessage(change, entry, issue, input),
                link: linkOf(fix, record),
            });
        }
    };

    if (input.issues === null) {
        // A page load: every visible change waiting on a review blocks, as review.authored-change and description.required would.
        for (const [rowId, change] of built.change) {
            if (!change.visible) continue;
            const entry = change.review.fields.find((field) => field.state !== 'reviewed');
            // A rebase conflict blocks too (working.conflicts), and the load predicts it from the layer, not the rules.
            if (entry || conflictOf(change)) mark(rowId, entry, null);
        }
    } else {
        for (const issue of input.issues) {
            if (issue.severity !== 'error') continue;
            const issueKey = keyOf(issue.record, issue.field);
            let hit = false;
            for (const [rowId, change] of built.change) {
                const entry = change.review.fields.find((field) => keyOf(field.record, field.field) === issueKey);
                const own = keyOf(change.record, change.field) === issueKey;
                if (!entry && !own) continue;
                hit = true;
                mark(rowId, entry && entry.state !== 'reviewed' ? entry : change.review.fields.find((field) => field.state !== 'reviewed'), issue);
                break;
            }
            if (!hit) {
                const key = `issue:${issue.code}:${issueKey}`;
                if (blockers.some((blocker) => blocker.key === key)) continue;
                blockers.push({ key, rowId: null, record: names.record(issue.record), field: issue.field ? fieldName({ record: issue.record, field: issue.field }) : issue.code, message: `${issue.message}${issue.hint ? ` ${issue.hint}` : ''}`, link: { type: 'none' } });
            }
        }
    }

    const ledger: Ledger = { authored: [], derived: [], health: [] };
    for (const [rowId, row] of built.rows) ledger[built.group.get(rowId) ?? 'authored'].push(row);
    // The list follows the ledger's order, so Tab meets the blockers in the order of the rows they name; a rule with no row comes last.
    const order = [...ledger.authored, ...ledger.derived, ...ledger.health].map((row) => row.id);
    const rank = (blocker: Blocker) => (blocker.rowId === null ? order.length : order.indexOf(blocker.rowId));
    blockers.sort((a, b) => rank(a) - rank(b));
    return { ledger, blockers };
}

/** The series the panel opens: the one with the most authored rows, and its first changed photograph in series order. */
export function panelTarget(diff: CatalogDiff, candidate: CandidateContent, active: RevisionContent): { seriesId: string | null; photoId: string | null } {
    const authoredRows = new Map<string, number>();
    const changedPhotos = new Set<string>();
    const seriesOfPhoto = (photoId: string) => candidate.series.find((series) => series.photoIds.includes(photoId))?.id ?? null;
    for (const change of diff.changes) {
        if (!change.visible) continue;
        let seriesId: string | null = null;
        if (change.record.kind === 'series') seriesId = change.record.id;
        if (change.record.kind === 'photo') {
            seriesId = seriesOfPhoto(change.record.id);
            if (change.category !== 'derived' && change.category !== 'removed') changedPhotos.add(change.record.id);
        }
        if (seriesId === null || !candidate.series.some((series) => series.id === seriesId)) continue;
        if (change.provenance !== 'derived') authoredRows.set(seriesId, (authoredRows.get(seriesId) ?? 0) + 1);
    }
    let best: string | null = null;
    for (const series of candidate.series) {
        const count = authoredRows.get(series.id) ?? 0;
        if (count > 0 && (best === null || count > (authoredRows.get(best) ?? 0))) best = series.id;
    }
    if (best === null) return { seriesId: null, photoId: null };
    const series = candidate.series.find((entry) => entry.id === best);
    const photoId = series?.photoIds.find((id) => changedPhotos.has(id)) ?? null;
    void active;
    return { seriesId: best, photoId };
}

/** The panel's lines: the series and its counts, and one line on its copy. */
export function panelLines(diff: CatalogDiff, candidate: CandidateContent, active: RevisionContent, seriesId: string | null, names: Names): { count: string; copyLine: string } {
    if (seriesId === null) return { count: 'Work: what visitors see now.', copyLine: 'No series changes its photographs or copy.' };
    const now = candidate.series.find((series) => series.id === seriesId);
    const was = active.series.find((series) => series.id === seriesId);
    const name = names.series(seriesId);
    const nowCount = now?.derived.photoCount ?? 0;
    const count = was && was.derived.photoCount !== nowCount ? `${name}: ${nowCount} ${nowCount === 1 ? 'photograph' : 'photographs'}, was ${was.derived.photoCount}` : `${name}: ${nowCount} ${nowCount === 1 ? 'photograph' : 'photographs'}`;
    const touched = (field: string) => diff.changes.some((change) => change.visible && change.record.kind === 'series' && change.record.id === seriesId && change.field === field);
    const statement = touched('statement') ? 'The statement changes.' : 'The authored statement stays exactly as published.';
    const short = touched('shortStatement') ? ' The short statement changes.' : '';
    return { count, copyLine: `${statement}${short}` };
}

import { readActivePointer, readAuthoredRecord, readAuthoredSeries } from '../catalog/working-layer';
import { currentProfileId } from '../identity/profile';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { dataRootStatus, libraryRoot } from '../storage/config';
import { printable, scrub } from './commands';
import { EVENT_ID_RE, FAILURE_TEXT, needsJudgment, waitingReason, type CurationEvent } from './events';
import { photoHolderEntries, type ReferenceCache } from './holders';
import {
    itemTitle,
    PRIMARY_ACTION,
    replacementHint,
    seriesName,
    shortIdOf,
    type HolderRef,
    type InboxDetail,
    type InboxItem,
    type InboxView,
    type ItemGroup,
    type ReplacementDraft,
    type SeriesOption,
} from './inbox-view';
import { readDraftPlan } from './pins';
import { placedItems } from './placement';
import { listEvents } from './repository';

/**
 * Reads the inbox for the curator's page (#14's 14-3): every event, grouped
 * as the page lists them, and the one the URL selects in full. It writes
 * nothing and takes no lock, and what it returns names no host path, only
 * library-relative source paths and IDs. Only app/curation/ loads it, behind
 * requireCurator(), and lib/curation/__tests__/boundary.test.ts holds every
 * public route away from it.
 */

/** The curator-only URL of a derivative set's w800 WebP. app/api/curation/media serves it. */
export function curatorPreviewUrl(photoId: string, assetRevision: string, profileId: string): string {
    return `/api/curation/media/${photoId}/${assetRevision}/${profileId}/w800.webp`;
}

/** The same route's smallest WebP, w400, for a list row's thumbnail. Never the original. */
export function curatorThumbnailUrl(photoId: string, assetRevision: string, profileId: string): string {
    return `/api/curation/media/${photoId}/${assetRevision}/${profileId}/w400.webp`;
}

/** Where an item sits, the way `curation list` counts it, from D6's shared placement lookup (lib/curation/placement.ts). */
function groupOf(event: CurationEvent, waiting: string | null, placed: boolean, unplaced: boolean): ItemGroup {
    if (unplaced) return 'unplaced';
    if (event.status === 'approved' || event.status === 'dismissed' || event.status === 'resolved') return 'settled';
    if (placed) return 'placed';
    if (event.status === 'deferred') return 'deferred';
    return needsJudgment(event, waiting, placed) ? 'judgment' : 'waiting';
}

const GROUP_ORDER: Record<ItemGroup, number> = { judgment: 0, unplaced: 1, waiting: 2, deferred: 3, placed: 4, settled: 5 };

function itemOf(event: CurationEvent, registry: Registry | null, waiting: string | null, placed: string | null, unplaced: string | null): InboxItem {
    const ready = readyProfile(event, registry);
    return {
        id: event.id,
        version: event.version,
        type: event.type,
        status: event.status,
        group: groupOf(event, waiting, placed !== null, unplaced !== null),
        title: unplaced !== null ? 'Approved, no longer placed' : itemTitle(event.type, waiting !== null),
        photoId: event.photoId,
        shortId: shortIdOf(event.photoId),
        sourcePath: printable(event.derivedFacts.sourcePath),
        thumbnailUrl: ready && event.photoId && event.assetRevision ? curatorThumbnailUrl(event.photoId, event.assetRevision, ready) : null,
        waiting,
        placedBy: placed,
        unplacedSeries: unplaced,
    };
}

function identityText(event: CurationEvent, registry: Registry | null): string {
    if (event.photoId === null) return 'None yet. This file has no photo ID.';
    const photo = registry?.photos[event.photoId];
    if (!photo) return `${event.photoId}, which the registry no longer holds.`;
    const parts = [`${event.photoId}, source ${photo.sourceHealth}`];
    if (photo.mergedInto) parts.push(`merged into ${photo.mergedInto}`);
    if (photo.duplicateOf) parts.push(`a copy of ${photo.duplicateOf}`);
    if (event.assetRevision !== null && photo.source.observedRevision !== event.assetRevision) parts.push(`its source now holds ${photo.source.observedRevision}`);
    return parts.join(', ');
}

/** The profile of the item's ready derivative set, the current profile first, or null when none is ready. */
function readyProfile(event: CurationEvent, registry: Registry | null): string | null {
    if (event.photoId === null || event.assetRevision === null) return null;
    const revision = registry?.photos[event.photoId]?.revisions[event.assetRevision];
    if (!revision) return null;
    const profileId = currentProfileId();
    if (revision.profiles[profileId]?.state === 'ready') return profileId;
    return Object.entries(revision.profiles).find(([, entry]) => entry.state === 'ready')?.[0] ?? null;
}

/** Each profile's state, and how many tries a failed one took. A build's error text may name a host path, so it never shows. */
function derivativeText(event: CurationEvent, registry: Registry | null): { text: string; ready: string | null } {
    if (event.photoId === null || event.assetRevision === null) return { text: 'None. Nothing was made from it.', ready: null };
    const revision = registry?.photos[event.photoId]?.revisions[event.assetRevision];
    const profiles = revision ? Object.entries(revision.profiles) : [];
    if (profiles.length === 0) return { text: 'None built yet.', ready: null };
    const ready = readyProfile(event, registry);
    const text = profiles
        .map(([id, entry]) => `${id} ${entry.state}${entry.state === 'failed' ? ` after ${entry.attempts} attempt${entry.attempts === 1 ? '' : 's'}` : ''}`)
        .join(', ');
    return { text, ready };
}

function factsOf(event: CurationEvent): { label: string; value: string }[] {
    const facts = event.derivedFacts;
    const rows: { label: string; value: string }[] = [];
    if (facts.capturedDate) rows.push({ label: 'Capture date', value: facts.capturedDate });
    else if (facts.capturedDate === null) rows.push({ label: 'Capture date', value: 'None in the file' });
    if (facts.width && facts.height) rows.push({ label: 'Size', value: `${facts.width} x ${facts.height}` });
    if (facts.sourceFormat) rows.push({ label: 'Format', value: facts.sourceFormat });
    if (facts.folder) rows.push({ label: 'Folder', value: printable(facts.folder) });
    if (facts.duplicateOf) rows.push({ label: 'Same bytes as', value: facts.duplicateOf });
    return rows;
}

/** A decision in History, with its series by title and the ID kept beside it. */
function decisionDetail(decision: CurationEvent['decisions'][number], series: readonly SeriesOption[]): string {
    const parts: string[] = [];
    if (decision.seriesId === null) parts.push('left unassigned');
    else if (decision.seriesId !== undefined) {
        const name = seriesName(series, decision.seriesId);
        parts.push(name === decision.seriesId ? name : `${name} (${decision.seriesId})`);
    }
    if (decision.placement) parts.push(typeof decision.placement === 'string' ? `at the ${decision.placement}` : `after ${decision.placement.after}`);
    if (decision.reason) parts.push(`"${printable(decision.reason)}"`);
    if (decision.writes?.length) parts.push(`wrote ${decision.writes.map((entry) => `${entry.record} v${entry.version}`).join(', ')}`);
    if (decision.identityDecisionId) parts.push(`identity decision ${decision.identityDecisionId}`);
    return parts.join(', ');
}

/**
 * Which of 14-1's actions would get past their state and type checks. The
 * action checks again, under the lock. A missing photograph that something
 * still shows can't be dismissed either (detailOf() decides that once it
 * knows the references).
 */
function abilities(event: CurationEvent, registry: Registry | null): InboxDetail['can'] {
    const open = event.status === 'open' || event.status === 'deferred' || event.status === 'failed';
    const failure = event.derivedFacts.failure;
    const revision = event.photoId !== null && event.assetRevision !== null ? registry?.photos[event.photoId]?.revisions[event.assetRevision] : undefined;
    const failedBuild = revision !== undefined && Object.values(revision.profiles).some((profile) => profile.state === 'failed');
    return {
        approve: event.type === 'new' && (event.status === 'open' || event.status === 'deferred'),
        edit: open,
        defer: event.status === 'open' || event.status === 'failed',
        dismiss: open,
        // As retryEvent() decides: an identified photograph whose file couldn't be decoded, or whose build failed.
        retry: open && event.photoId !== null && event.assetRevision !== null && failure !== 'unsupported-format' && failure !== 'digest-collision' && (failure === 'undecodable' || failedBuild),
        reopen: event.status === 'deferred' || event.status === 'dismissed' || event.status === 'approved',
    };
}

/**
 * The hint under the actions. Only while Decide later is offered, since it names Decide later: for a replacement, what
 * Decide later does with the draft now; for a missing source, why its primary action isn't in the inbox yet.
 */
function primaryUnavailable(event: CurationEvent, can: InboxDetail['can'], replacement: ReplacementDraft | null): string | null {
    if (PRIMARY_ACTION[event.type] === undefined || event.type === 'new' || !can.defer) return null;
    return event.type === 'replacement'
        ? replacementHint(replacement)
        : "Locating, binding, and archiving aren't in the inbox yet, so choose Decide later until they are. The published output stays protected.";
}

/**
 * #17: a replacement's draft, and what Decide later does with it, from the plan leaveInDraft() acts on. `cache` holds
 * the references() scan photoHolderEntries() already made, whose active-revision entry says which bytes are live. Null
 * for any other item, and when the photo record or the inbox's pins can't be read: the page then claims nothing.
 */
async function replacementOf(root: string, event: CurationEvent, registry: Registry | null, cache: ReferenceCache): Promise<ReplacementDraft | null> {
    if (event.type !== 'replacement' || event.photoId === null || event.assetRevision === null || registry === null) return null;
    const photoId = event.photoId;
    const revision = event.assetRevision;
    let pinned: string | null;
    let plan: Awaited<ReturnType<typeof readDraftPlan>>;
    try {
        const read = (await readAuthoredRecord(root, 'photo', photoId))?.assetRevision ?? null;
        pinned = read;
        plan = await readDraftPlan(root, event, async () => read, registry);
    } catch {
        return null;
    }
    const list = Array.isArray(cache.list) ? cache.list : [];
    const live = list.some((entry) => entry.source === 'active-revision' && entry.photoId === photoId && entry.assetRevision === revision);
    return {
        draft: pinned === null ? 'none' : pinned === revision ? 'new' : 'other',
        live,
        decideLater: plan.kind === 'put-back' ? 'put-back' : plan.kind === 'moved' ? 'refuses' : 'keeps',
    };
}

/** The photo record and the series holding it, for a photograph an approval already placed. */
async function placedOf(root: string, event: CurationEvent, series: readonly SeriesOption[]): Promise<InboxDetail['placed']> {
    if (event.type !== 'new' || event.photoId === null) return null;
    const photoId = event.photoId;
    const record = await readAuthoredRecord(root, 'photo', photoId);
    if (record === null) return null;
    const alt = record.alt;
    return {
        // Only a reviewed description fills the form, since the form sends what it shows as reviewed text.
        alt: alt === null ? null : alt.kind === 'decorative' ? { kind: 'decorative' } : alt.reviewed ? { kind: 'described', text: alt.text } : null,
        seriesIds: series.filter((option) => option.members.some((member) => member.photoId === photoId)).map((option) => option.id),
    };
}

async function detailOf(root: string, event: CurationEvent, item: InboxItem, registry: Registry | null, scrubbed: (text: string) => string, series: readonly SeriesOption[]): Promise<InboxDetail> {
    const derivatives = derivativeText(event, registry);
    let references: HolderRef[] | null = null;
    const cache: ReferenceCache = {};
    if (event.photoId !== null) {
        const found = await photoHolderEntries(root, event.photoId, cache);
        references = 'unknown' in found ? null : found.entries;
    } else {
        references = [];
    }
    const replacement = await replacementOf(root, event, registry, cache);
    const can = { ...abilities(event, registry), ...(event.type === 'missing' && references?.length !== 0 ? { dismiss: false } : {}) };
    const suggestedSeries = event.suggestions.series;
    const placement = event.suggestions.placement;
    return {
        ...item,
        assetRevision: event.assetRevision,
        observedAt: event.observedAt,
        lastObservedAt: event.lastObservedAt,
        capturedDate: event.derivedFacts.capturedDate ?? null,
        fromPath: event.derivedFacts.fromPath ? printable(event.derivedFacts.fromPath) : null,
        identity: identityText(event, registry),
        derivatives: derivatives.text,
        previewUrl: derivatives.ready && event.photoId && event.assetRevision ? curatorPreviewUrl(event.photoId, event.assetRevision, derivatives.ready) : null,
        facts: factsOf(event),
        failure: event.derivedFacts.failure ? FAILURE_TEXT[event.derivedFacts.failure] : null,
        candidates: event.derivedFacts.candidates ?? [],
        references,
        suggestions: {
            series: suggestedSeries ? { value: suggestedSeries.value, confidence: suggestedSeries.confidence, producedBy: suggestedSeries.producedBy, producedAt: suggestedSeries.producedAt, evidence: suggestedSeries.evidence.map((line) => scrubbed(printable(line))) } : null,
            placement: placement ? { value: placement.value, confidence: placement.confidence, producedBy: placement.producedBy, producedAt: placement.producedAt, evidence: placement.evidence.map((line) => scrubbed(printable(line))) } : null,
        },
        edits: event.edits
            ? {
                  ...(event.edits.seriesId === undefined ? {} : { seriesId: event.edits.seriesId }),
                  ...(event.edits.placement === undefined ? {} : { placement: event.edits.placement }),
                  ...(event.edits.description === undefined ? {} : { description: event.edits.description }),
                  editedAt: event.edits.editedAt,
                  editedBy: printable(event.edits.editedBy),
              }
            : null,
        placed: await placedOf(root, event, series),
        lastApprovedSeries: event.decisions.filter((decision) => decision.action === 'approve').at(-1)?.seriesId ?? null,
        decisions: event.decisions.map((decision) => ({ action: decision.action, at: decision.at, by: printable(decision.by), detail: decisionDetail(decision, series) })),
        reviewedAt: event.reviewedAt,
        reviewedBy: event.reviewedBy === null ? null : printable(event.reviewedBy),
        can,
        primaryUnavailable: primaryUnavailable(event, can, replacement),
        replacement,
    };
}

async function seriesOptions(root: string): Promise<{ series: SeriesOption[]; problem: string | null }> {
    const { series, problems } = await readAuthoredSeries(root);
    const options = series.map((entry) => ({
        id: entry.id,
        label: entry.title.trim() || entry.id,
        visibility: entry.visibility,
        members: entry.photoIds.map((photoId) => ({ photoId, shortId: shortIdOf(photoId) })),
    }));
    const unreadable = problems.filter((problem) => problem.kind === 'series').map((problem) => problem.id);
    return { series: options, problem: unreadable.length > 0 ? `Some series can't be read (${unreadable.join(', ')}), so they aren't offered.` : null };
}

/**
 * The inbox as the page shows it, with `selectedId`'s event in full. With no
 * selection, the first item that needs judgment is selected, and none when
 * nothing does, so the page shows its empty state (as it does once the last
 * decision opens no next item). A data root that isn't ready is
 * `not-ready`, and nothing else is read.
 */
export async function loadInbox(selectedId: string | null): Promise<InboxView> {
    const status = dataRootStatus();
    if (status.state !== 'ready' || status.root === null) {
        return { state: 'not-ready', message: `The data root is ${status.state}, so the inbox can't be read. Nothing was written.` };
    }
    const root = status.root;
    const scrubbed = (text: string) => scrub(text, [root, libraryRoot()]);
    const { events, problems } = await listEvents(root);
    const registry = events.length > 0 ? await readRegistry(root).catch(() => null) : null;
    const profileId = currentProfileId();
    // The same lookup `curation list` and `show` use, so the page and the CLI count alike.
    const placements = await placedItems(root, events);
    const items = events
        .map((event) => itemOf(event, registry, waitingReason(event, registry, profileId), placements.placed.get(event.id) ?? null, placements.unplaced.get(event.id) ?? null))
        .sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group]);
    const active = (await readActivePointer(root))?.revisionId ?? null;
    const { series, problem } = await seriesOptions(root);

    const wanted = selectedId !== null && EVENT_ID_RE.test(selectedId) ? selectedId : null;
    const fallback = items.find((item) => item.group === 'judgment') ?? null;
    const chosen = selectedId === null ? fallback : wanted === null ? null : (items.find((item) => item.id === wanted) ?? null);
    const event = chosen ? events.find((entry) => entry.id === chosen.id) ?? null : null;

    return {
        state: 'ready',
        activeRevisionId: active,
        needsJudgment: items.filter((item) => item.group === 'judgment').length,
        waiting: items.filter((item) => item.group === 'waiting').length,
        placed: placements.placed.size,
        unplaced: placements.unplaced.size,
        placementUnknown: placements.unknown !== null,
        items,
        problems: problems.map((entry) => ({ id: entry.id, message: scrubbed(printable(`${entry.reason}: ${entry.message}`)) })),
        series,
        seriesProblem: problem,
        selected: event && chosen ? await detailOf(root, event, chosen, registry, scrubbed, series) : null,
        missingSelection: selectedId !== null && chosen === null ? (wanted ?? 'that item') : null,
    };
}

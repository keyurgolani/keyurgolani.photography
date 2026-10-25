import { readActivePointer, readAuthoredRecord, readAuthoredSeries } from '../catalog/working-layer';
import { currentProfileId } from '../identity/profile';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { dataRootStatus, libraryRoot } from '../storage/config';
import { printable, scrub } from './commands';
import { EVENT_ID_RE, FAILURE_TEXT, needsJudgment, shortPhotoId, waitingReason, type CurationEvent } from './events';
import { photoHolders } from './holders';
import {
    itemTitle,
    PRIMARY_ACTION,
    type InboxDetail,
    type InboxItem,
    type InboxView,
    type ItemGroup,
    type SeriesOption,
} from './inbox-view';
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

function groupOf(event: CurationEvent, waiting: string | null): ItemGroup {
    if (event.status === 'approved' || event.status === 'dismissed') return 'settled';
    if (event.status === 'deferred') return 'deferred';
    return needsJudgment(event, waiting) ? 'judgment' : 'waiting';
}

const GROUP_ORDER: Record<ItemGroup, number> = { judgment: 0, waiting: 1, deferred: 2, settled: 3 };

function itemOf(event: CurationEvent, waiting: string | null): InboxItem {
    return {
        id: event.id,
        version: event.version,
        type: event.type,
        status: event.status,
        group: groupOf(event, waiting),
        title: itemTitle(event.type, waiting !== null),
        photoId: event.photoId,
        shortId: shortPhotoId(event.photoId),
        waiting,
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

/** Each profile's state, and how many tries a failed one took. A build's error text may name a host path, so it never shows. */
function derivativeText(event: CurationEvent, registry: Registry | null): { text: string; ready: string | null } {
    if (event.photoId === null || event.assetRevision === null) return { text: 'None. Nothing was made from it.', ready: null };
    const revision = registry?.photos[event.photoId]?.revisions[event.assetRevision];
    const profiles = revision ? Object.entries(revision.profiles) : [];
    if (profiles.length === 0) return { text: 'None built yet.', ready: null };
    const profileId = currentProfileId();
    const ready = revision?.profiles[profileId]?.state === 'ready' ? profileId : (profiles.find(([, entry]) => entry.state === 'ready')?.[0] ?? null);
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

function decisionDetail(decision: CurationEvent['decisions'][number]): string {
    const parts: string[] = [];
    if (decision.seriesId !== undefined) parts.push(decision.seriesId ?? 'left unassigned');
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

function primaryUnavailable(event: CurationEvent): string | null {
    if (PRIMARY_ACTION[event.type] === undefined || event.type === 'new') return null;
    return event.type === 'replacement'
        ? "Confirming new bytes isn't in the inbox yet. Leave it in draft until it is; the published photograph keeps its current revision."
        : "Locating, binding, and archiving aren't in the inbox yet. Leave it in draft until they are; the published output stays protected.";
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
    let references: string[] | null = null;
    if (event.photoId !== null) {
        const found = await photoHolders(root, event.photoId);
        references = 'unknown' in found ? null : found.holders;
    } else {
        references = [];
    }
    const suggestedSeries = event.suggestions.series;
    const placement = event.suggestions.placement;
    return {
        ...item,
        assetRevision: event.assetRevision,
        observedAt: event.observedAt,
        lastObservedAt: event.lastObservedAt,
        sourcePath: printable(event.derivedFacts.sourcePath),
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
        decisions: event.decisions.map((decision) => ({ action: decision.action, at: decision.at, by: printable(decision.by), detail: decisionDetail(decision) })),
        reviewedAt: event.reviewedAt,
        reviewedBy: event.reviewedBy === null ? null : printable(event.reviewedBy),
        can: { ...abilities(event, registry), ...(event.type === 'missing' && references?.length !== 0 ? { dismiss: false } : {}) },
        primaryUnavailable: primaryUnavailable(event),
    };
}

async function seriesOptions(root: string): Promise<{ series: SeriesOption[]; problem: string | null }> {
    const { series, problems } = await readAuthoredSeries(root);
    const options = series.map((entry) => ({
        id: entry.id,
        label: entry.title.trim() || entry.id,
        visibility: entry.visibility,
        members: entry.photoIds.map((photoId) => ({ photoId, shortId: shortPhotoId(photoId) })),
    }));
    const unreadable = problems.filter((problem) => problem.kind === 'series').map((problem) => problem.id);
    return { series: options, problem: unreadable.length > 0 ? `Some series can't be read (${unreadable.join(', ')}), so they aren't offered.` : null };
}

/**
 * The inbox as the page shows it, with `selectedId`'s event in full. With no
 * selection, the first item that needs judgment is selected. A data root
 * that isn't ready is `not-ready`, and nothing else is read.
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
    const items = events
        .map((event) => itemOf(event, waitingReason(event, registry, profileId)))
        .sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group]);
    const active = (await readActivePointer(root))?.revisionId ?? null;
    const { series, problem } = await seriesOptions(root);

    const wanted = selectedId !== null && EVENT_ID_RE.test(selectedId) ? selectedId : null;
    const fallback = items.find((item) => item.group === 'judgment') ?? items.find((item) => item.group !== 'settled') ?? null;
    const chosen = selectedId === null ? fallback : wanted === null ? null : (items.find((item) => item.id === wanted) ?? null);
    const event = chosen ? events.find((entry) => entry.id === chosen.id) ?? null : null;

    return {
        state: 'ready',
        activeRevisionId: active,
        needsJudgment: items.filter((item) => item.group === 'judgment').length,
        waiting: items.filter((item) => item.group === 'waiting').length,
        items,
        problems: problems.map((entry) => ({ id: entry.id, message: scrubbed(printable(`${entry.reason}: ${entry.message}`)) })),
        series,
        seriesProblem: problem,
        selected: event && chosen ? await detailOf(root, event, chosen, registry, scrubbed, series) : null,
        missingSelection: selectedId !== null && chosen === null ? (wanted ?? 'that item') : null,
    };
}

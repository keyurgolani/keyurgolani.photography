import path from 'node:path';
import { inboxAlertLines, inboxAlerts, type InboxAlerts } from '../curation/alerts';
import { currentProfileId } from '../identity/profile';
import { readRegistry } from '../identity/registry';
import { identityStatus, type IdentityStatus } from '../identity/status';
import type { PhotoRecord, Registry } from '../identity/types';
import { mediaFilePath } from '../media/path';
import { dataRootStatus } from '../storage/config';
import { usualProfile } from './compile';
import { catalogMode, type CatalogMode } from './mode';
import { lastCommitted, listActivations, readLastPublish, readRevisionFile, type LastPublishFile } from './repository';
import type { CommandResult, LayerHandle } from './sequence-commands';
import type { Activation, AuthoredPhoto, AuthoredSeries, WorkingLayer } from './types';
import { readActivePointer, readWorkingLayer } from './working-layer';

/**
 * #13 slice D's read-only owner commands, `photos status` and `photos list`.
 * Like sequence-commands.ts, each takes parsed arguments and a data root and
 * returns the exit code and the text to print: 0 when everything read, 1 when
 * the data root isn't ready or a file it needs can't be read.
 */

/** A photo's description, as the description rules see it. */
/** `no description yet`: carried over at the launch with no alt, so it is named by its place and doesn't block a publish. */
export type AltState = 'described' | 'unreviewed' | 'decorative' | 'none' | 'no description yet' | 'no record';

export interface PhotoListing {
    photoId: string;
    /** Its library-relative path, the last one when the source is missing. */
    source: string;
    sourceHealth: PhotoRecord['sourceHealth'];
    /** `YYYY-MM-DD`, authored or #10's, or null. */
    capturedAt: string | null;
    /** The series that list it, any visibility, by ID. */
    series: string[];
    alt: AltState;
    /** The 400 px WebP of the set it would publish on, relative to the data root, or null when no set is ready. */
    w400: string | null;
}

/**
 * The revision the site serves: the one `active.json` names, whatever its
 * activation's status, since the public reader follows the pointer alone.
 * Without a pointer, the last committed activation's.
 */
export interface LiveRevision {
    revisionId: string;
    /** Null when no activation record names the pointer's activation, or that activation is of another revision. */
    revisionNumber: number | null;
    activationId: string | null;
    /** The activation's `NNNNNN` number. */
    sequence: number | null;
    /**
     * `missing` when no activation record names the pointer's activation, and
     * `mismatch` when that activation is of another revision, as a hand edit
     * or a torn restore can leave it. The site still serves `revisionId`.
     */
    status: Activation['status'] | 'missing' | 'mismatch';
    /** For `mismatch`: the revision the pointer's activation names. */
    activationRevisionId?: string;
    kind: Activation['kind'] | null;
    actor: string | null;
    committedAt: string | null;
}

export interface OwnerStatus {
    identity: IdentityStatus;
    catalog: {
        mode: CatalogMode;
        active: LiveRevision | null;
        lastPublish: LastPublishFile | null;
        /** Why a catalog file couldn't be read, if one couldn't. */
        error?: string;
    };
    working: {
        site: boolean;
        series: Record<AuthoredSeries['visibility'], number>;
        photoRecords: number;
        /** Record files the working layer can't use, by kind and ID. */
        problems: string[];
        /** Photos in the library that no series lists. */
        unassigned: string[];
        /** Photos in the library or in a series with no reviewed description or decorative flag. */
        undescribed: string[];
        /** The undescribed photos a published series lists, which block a publish. Carried-over ones don't. */
        undescribedPublished: string[];
        /** Undescribed photos `photos carry-over` brought over, named by their place until described. They don't block. */
        carriedOver: string[];
    } | null;
    /**
     * #17's alerting: the curation inbox's open missing sources and failures,
     * or why the inbox can't be read. Null before the data root is ready.
     */
    inbox: InboxAlerts | { error: string } | null;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function altState(record: AuthoredPhoto | undefined): AltState {
    if (!record) return 'no record';
    if (record.alt === null) return record.carryOver !== undefined ? 'no description yet' : 'none';
    if (record.alt.kind === 'decorative') return 'decorative';
    return record.alt.reviewed ? 'described' : 'unreviewed';
}

/** Photos the library holds now: present at their path, and not merged into another. */
function inLibrary(photo: PhotoRecord): boolean {
    return photo.sourceHealth === 'present' && photo.mergedInto === undefined;
}

/** The series that list each photo, by photo ID. */
function membership(layer: WorkingLayer): Map<string, string[]> {
    const members = new Map<string, string[]>();
    for (const series of layer.series) {
        for (const photoId of new Set(series.photoIds)) members.set(photoId, [...(members.get(photoId) ?? []), series.id]);
    }
    return members;
}

function workingSummary(layer: WorkingLayer, registry: Registry): NonNullable<OwnerStatus['working']> {
    const records = new Map(layer.photos.map((photo) => [photo.id, photo]));
    const members = membership(layer);
    const published = new Set(layer.series.filter((series) => series.visibility === 'published').flatMap((series) => series.photoIds));
    const library = Object.values(registry.photos).filter(inLibrary).map((photo) => photo.photoId);
    const considered = [...new Set([...library, ...members.keys()])].sort(compare);
    const undescribed = considered.filter((photoId) => !['described', 'decorative'].includes(altState(records.get(photoId))));
    const series: Record<AuthoredSeries['visibility'], number> = { published: 0, draft: 0, hidden: 0 };
    for (const entry of layer.series) series[entry.visibility]++;
    return {
        site: layer.site !== null,
        series,
        photoRecords: layer.photos.length,
        problems: layer.problems.map((problem) => `${problem.kind} ${problem.id}`),
        unassigned: library.filter((photoId) => !members.has(photoId)).sort(compare),
        undescribed,
        undescribedPublished: undescribed.filter((photoId) => published.has(photoId) && altState(records.get(photoId)) !== 'no description yet'),
        carriedOver: undescribed.filter((photoId) => altState(records.get(photoId)) === 'no description yet'),
    };
}

/** `photos status` with no data root: PHOTOGRAPHY_DATA_DIR unset in production. */
function unsetIdentity(): IdentityStatus {
    return {
        dataRoot: { state: 'unset', root: null, detail: 'PHOTOGRAPHY_DATA_DIR is not set' },
        registry: null,
        photos: { total: 0, bySourceHealth: { present: 0, missing: 0, ambiguous: 0, archived: 0 } },
        holds: [],
        failedProfiles: [],
        pendingJobs: 0,
        pendingFacts: 0,
        watcher: null,
    };
}

function live(activation: Activation): LiveRevision {
    const { revisionId, revisionNumber, activationId, sequence, status, kind, actor } = activation;
    return { revisionId, revisionNumber, activationId, sequence, status, kind, actor, committedAt: activation.committedAt ?? null };
}

export interface StatusHandle {
    /** Null when PHOTOGRAPHY_DATA_DIR is unset in production. */
    dataRoot: string | null;
    /** For the watcher heartbeat's age. */
    clock?: () => number;
}

export async function ownerStatus({ dataRoot, clock }: StatusHandle): Promise<OwnerStatus> {
    // status builds no failed-profile text of its own: identityStatus() strips the library and data root paths from
    // each reason (withoutAbsolutePaths(), #53), so status --json carries none.
    const identity = dataRoot === null ? unsetIdentity() : await identityStatus({ root: path.resolve(dataRoot), clock });
    const status: OwnerStatus = { identity, catalog: { mode: 'legacy', active: null, lastPublish: null }, working: null, inbox: null };
    if (dataRoot === null || identity.dataRoot.state !== 'ready') return status;
    const root = path.resolve(dataRoot);
    try {
        status.catalog.mode = await catalogMode(root);
        const activations = await listActivations(root);
        const pointer = await readActivePointer(root);
        if (pointer) {
            // After a crash between the pointer switch and the commit, the pointer names a pending activation, and
            // the site already serves its revision.
            const named = activations.find((activation) => activation.activationId === pointer.activationId);
            // The public reader follows the pointer's revisionId, so that is what's live even when its activation names another.
            if (!named) {
                status.catalog.active = { revisionId: pointer.revisionId, revisionNumber: null, activationId: pointer.activationId, sequence: null, status: 'missing', kind: null, actor: null, committedAt: null };
            } else if (named.revisionId !== pointer.revisionId) {
                status.catalog.active = { ...live(named), revisionId: pointer.revisionId, revisionNumber: null, status: 'mismatch', activationRevisionId: named.revisionId };
            } else {
                status.catalog.active = live(named);
            }
        } else {
            const last = lastCommitted(activations);
            if (last) status.catalog.active = live(last);
        }
        status.catalog.lastPublish = await readLastPublish(root);
    } catch (error) {
        status.catalog.error = message(error);
    }
    if (identity.registryError === undefined && identity.registry !== null) {
        status.working = workingSummary(await readWorkingLayer(root), await readRegistry(root));
    }
    try {
        status.inbox = await inboxAlerts(root);
    } catch (error) {
        status.inbox = { error: message(error) };
    }
    return status;
}

function formatStatus(status: OwnerStatus): string {
    const { identity, catalog, working } = status;
    const lines = [`Data root: ${identity.dataRoot.root ?? 'not set'} (${identity.dataRoot.state}${identity.dataRoot.detail ? `: ${identity.dataRoot.detail}` : ''})`];
    if (identity.dataRoot.state === 'uninitialized') lines.push('  photos:migrate initializes it, as docs/data-root.md describes.');
    if (identity.dataRoot.state !== 'ready') return `${lines.join('\n')}\n`;
    if (catalog.error) {
        lines.push(`Catalog: can't be read (${catalog.error})`);
    } else if (catalog.active) {
        const { revisionId, revisionNumber, kind, actor, committedAt, sequence } = catalog.active;
        switch (catalog.active.status) {
            case 'committed':
                lines.push(`Catalog: ${catalog.mode} mode, revision ${revisionNumber} (${revisionId}) active since ${committedAt ?? 'an unknown time'}, a ${kind} by ${actor}`);
                break;
            case 'pending':
                lines.push(`Catalog: ${catalog.mode} mode, revision ${revisionNumber} (${revisionId}) is live, from a ${kind} by ${actor} that didn't finish`);
                lines.push(`  Activation ${sequence} is pending. The next photos publish settles it.`);
                break;
            case 'abandoned':
                lines.push(`Catalog: ${catalog.mode} mode, revision ${revisionNumber} (${revisionId}) is live, though its activation was abandoned`);
                lines.push(`  Activation ${sequence} is abandoned, but the pointer names it. The next photos publish repairs it, unless that revision's rules block it.`);
                break;
            case 'missing':
                lines.push(`Catalog: ${catalog.mode} mode, ${revisionId} is live, but no activation record names it`);
                lines.push("  The next photos publish repairs the record, unless that revision's rules block it.");
                break;
            case 'mismatch':
                lines.push(`Catalog: ${catalog.mode} mode, ${revisionId} is live, but the pointer names activation ${sequence}, which activated ${catalog.active.activationRevisionId}`);
                lines.push("  The pointer and its activation record disagree. The next photos publish repairs them, unless that revision's rules block it.");
                break;
        }
    } else {
        lines.push(`Catalog: ${catalog.mode} mode, nothing published yet, so the site lists the registry's photos`);
    }
    const last = catalog.lastPublish;
    lines.push(last
        ? `Last publish: ${last.outcome} at ${last.at} by ${last.actor}, ${count(last.errors, 'error')} and ${count(last.warnings, 'warning')}${last.revisionNumber === null ? '' : `, revision ${last.revisionNumber}`}`
        : 'Last publish: none yet');
    const { photos } = identity;
    lines.push(identity.registry
        ? `Photos: ${photos.total} in the registry (${Object.entries(photos.bySourceHealth).map(([health, n]) => `${health} ${n}`).join(', ')})`
        : `Photos: the registry can't be read (${identity.registryError ?? 'unknown error'})`);
    if (working) {
        const { series } = working;
        const total = series.published + series.draft + series.hidden;
        lines.push(`Working layer: ${working.site ? 'site.json' : 'no site.json'}, ${count(total, 'series record')} (published ${series.published}, draft ${series.draft}, hidden ${series.hidden}), ${count(working.photoRecords, 'photo record')}`);
        if (working.problems.length > 0) lines.push(`Unusable record files: ${working.problems.join(', ')}. photos validate says why.`);
        lines.push(`Unassigned: ${count(working.unassigned.length, 'photo')} in the library that no series lists`);
        lines.push(`Undescribed: ${count(working.undescribed.length, 'photo')} without a reviewed description or a decorative flag, ${working.undescribedPublished.length} of them in a published series`);
        if (working.carriedOver.length > 0) lines.push(`  ${count(working.carriedOver.length, 'photo')} carried over at the launch ${working.carriedOver.length === 1 ? 'has' : 'have'} no description yet. ${working.carriedOver.length === 1 ? 'It keeps' : 'They keep'} the name the legacy Gallery gave, "Photograph N of T", and never ${working.carriedOver.length === 1 ? 'blocks' : 'block'} a publish. Describe ${working.carriedOver.length === 1 ? 'it' : 'them'} any time.`);
        if (working.unassigned.length > 0 || working.undescribed.length > 0) lines.push('  photos list shows each photo with its series and description state.');
    }
    if (status.inbox) lines.push(...('error' in status.inbox ? [`Inbox: can't be read (${status.inbox.error})`] : inboxAlertLines(status.inbox)));
    lines.push(`Holds: ${identity.holds.length}, failed profiles: ${identity.failedProfiles.length}, pending jobs: ${identity.pendingJobs}`);
    lines.push(`Watcher heartbeat: ${identity.watcher ? `${identity.watcher.ageSeconds} s ago (${identity.watcher.heartbeatAt})` : 'none yet'}`);
    return `${lines.join('\n')}\n`;
}

/** `photos status [--json]`. */
export async function runStatusCommand(layer: StatusHandle, { json = false, clock }: { json?: boolean; clock?: () => number } = {}): Promise<CommandResult> {
    try {
        const status = await ownerStatus({ ...layer, clock: clock ?? layer.clock });
        const ok = status.identity.dataRoot.state === 'ready' && status.working !== null && status.catalog.error === undefined
            && status.inbox !== null && !('error' in status.inbox);
        return { exitCode: ok ? 0 : 1, output: json ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status) };
    } catch (error) {
        return { exitCode: 1, output: `Error: ${message(error)}\n` };
    }
}

/** The active revision's profile for each photo, so a listing points at the set that is live. */
async function activeProfiles(root: string): Promise<Map<string, { assetRevision: string; profileId: string }>> {
    const pointer = await readActivePointer(root);
    const revision = pointer ? await readRevisionFile(root, pointer.revisionId) : null;
    return new Map((revision?.content.photos ?? []).map((photo) => [photo.id, { assetRevision: photo.assetRevision, profileId: photo.profileId }]));
}

/** The data-root-relative path of the 400 px WebP a photo would publish on, or null when that set isn't ready. */
function w400Path(root: string, photo: PhotoRecord, record: AuthoredPhoto | undefined, active: Map<string, { assetRevision: string; profileId: string }>, current: string): string | null {
    const assetRevision = record?.assetRevision ?? photo.source.observedRevision;
    const revision = photo.revisions[assetRevision];
    if (!revision || revision.reassignedTo) return null;
    const live = active.get(photo.photoId);
    const profileId = usualProfile(revision, current, live && live.assetRevision === assetRevision ? live.profileId : null);
    if (revision.profiles[profileId]?.state !== 'ready') return null;
    return path.relative(root, mediaFilePath({ photoId: photo.photoId, assetRevision, profileId }, 'w400', 'webp', root)).split(path.sep).join('/');
}

/** Every photo the registry holds, but not archived or merged ones. `unassigned` keeps those in the library that no series lists. */
export async function listPhotos({ dataRoot }: LayerHandle, { unassigned = false }: { unassigned?: boolean } = {}): Promise<PhotoListing[]> {
    const root = path.resolve(dataRoot);
    const registry = await readRegistry(root);
    const layer = await readWorkingLayer(root);
    const records = new Map(layer.photos.map((photo) => [photo.id, photo]));
    const members = membership(layer);
    const active = await activeProfiles(root);
    const current = currentProfileId();
    return Object.values(registry.photos)
        .filter((photo) => photo.sourceHealth !== 'archived' && photo.mergedInto === undefined)
        .filter((photo) => !unassigned || (inLibrary(photo) && !members.has(photo.photoId)))
        .map((photo): PhotoListing => {
            const record = records.get(photo.photoId);
            const revision = photo.revisions[record?.assetRevision ?? photo.source.observedRevision];
            return {
                photoId: photo.photoId,
                source: photo.source.path,
                sourceHealth: photo.sourceHealth,
                capturedAt: record?.capturedAt ?? revision?.derived.capturedDate?.value ?? null,
                series: members.get(photo.photoId) ?? [],
                alt: altState(record),
                w400: w400Path(root, photo, record, active, current),
            };
        })
        .sort((a, b) => compare(a.source, b.source) || compare(a.photoId, b.photoId));
}

function formatList(rows: readonly PhotoListing[]): string {
    if (rows.length === 0) return 'No photos.\n';
    const lines = rows.map((row) => [
        row.photoId,
        row.sourceHealth === 'present' ? row.source : `${row.source} (${row.sourceHealth})`,
        row.capturedAt ?? 'undated',
        row.series.length ? row.series.join(',') : '-',
        row.alt,
        row.w400 ?? 'no ready set',
    ].join('  '));
    return `${['photoId  source  captured  series  alt  w400', ...lines].join('\n')}\n`;
}

/** `photos list [--unassigned] [--json]`. */
export async function runListCommand(layer: LayerHandle, options: { unassigned?: boolean; json?: boolean } = {}): Promise<CommandResult> {
    try {
        const status = dataRootStatus({ root: path.resolve(layer.dataRoot) });
        if (status.state !== 'ready') return { exitCode: 1, output: `Error: The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}.\n` };
        const rows = await listPhotos(layer, options);
        return { exitCode: 0, output: options.json ? `${JSON.stringify(rows, null, 2)}\n` : formatList(rows) };
    } catch (error) {
        return { exitCode: 1, output: `Error: ${message(error)}\n` };
    }
}

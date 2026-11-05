import path from 'node:path';
import { inboxAlertLines, inboxAlerts, type InboxAlerts } from '../curation/alerts';
import { ageText } from '../curation/inbox-view';
import { HEARTBEAT_PROBLEM_TEXT, heartbeatStale, WATCHER_STALE_AFTER_MS, WATCHER_STALLED_AFTER_MS, watcherHeartbeatAge, type HeartbeatAge } from '../identity/heartbeat';
import { currentProfileId } from '../identity/profile';
import { readRegistry } from '../identity/registry';
import { identityStatus, type IdentityStatus } from '../identity/status';
import type { PhotoRecord, Registry } from '../identity/types';
import { mediaFilePath } from '../media/path';
import { dataRootStatus } from '../storage/config';
import { usualProfile } from './compile';
import { checkPublished, type PublishState } from './mode';
import { lastCommitted, listActivations, readLastPublish, readRevisionFile, type LastPublishFile } from './repository';
import { setAsideFolders } from './tombstones';
import { sizeText, trashSummary, type TrashSummary } from './asset-folders';
import type { CommandResult, LayerHandle } from './sequence-commands';
import type { Activation, AuthoredPhoto, AuthoredSeries, WorkingLayer } from './types';
import { readActivePointer, readWorkingLayer } from './working-layer';

/**
 * #13 slice D's read-only owner commands, `photos status` and `photos list`.
 * Like sequence-commands.ts, each takes parsed arguments and a data root and
 * returns the exit code and the text to print: 0 when everything read, 1 when
 * the data root isn't ready or a file it needs can't be read.
 *
 * `photos status --check` (#14 and #17, v2.0.0) is the monitor's form: it
 * also exits 1 on an open missing, failed or ambiguous item, on a failed
 * last pass, or on a heartbeat over 5 minutes old, and prints why.
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
        /** Whether the data root has published (checkPublished()). Nothing serves before it does. */
        published: PublishState;
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
    /** What `photos gc --set-aside` moved into the data root's `trash/`, when anything is there (#181's A10). Emptying it is the owner's step. */
    trash?: TrashSummary | { error: string };
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
        retryingJobs: 0,
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

/**
 * The data root states whose catalog status reads: any usable root, a
 * launched one without its data-root.json included. An unset or unavailable
 * one isn't read, so its publish state stays `unknown`, never `unpublished`,
 * which would contradict a web process serving a launched site.
 */
const CATALOG_READABLE: ReadonlySet<IdentityStatus['dataRoot']['state']> = new Set(['ready', 'uninitialized']);

export async function ownerStatus({ dataRoot, clock }: StatusHandle): Promise<OwnerStatus> {
    // status builds no failed-profile text of its own: identityStatus() strips the library and data root paths from
    // each reason (withoutAbsolutePaths(), #53), so status --json carries none.
    const identity = dataRoot === null ? unsetIdentity() : await identityStatus({ root: path.resolve(dataRoot), clock });
    const status: OwnerStatus = { identity, catalog: { published: 'unknown', active: null, lastPublish: null }, working: null, inbox: null };
    if (dataRoot === null || !CATALOG_READABLE.has(identity.dataRoot.state)) return status;
    const root = path.resolve(dataRoot);
    try {
        status.catalog.published = (await checkPublished(root)).state;
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
    if (identity.dataRoot.state !== 'ready') return status;
    if (identity.registryError === undefined && identity.registry !== null) {
        status.working = workingSummary(await readWorkingLayer(root), await readRegistry(root));
    }
    try {
        status.inbox = await inboxAlerts(root, clock);
    } catch (error) {
        status.inbox = { error: message(error) };
    }
    try {
        const trash = await trashSummary(root);
        if (trash) status.trash = trash;
    } catch (error) {
        status.trash = { error: message(error) };
    }
    return status;
}

/** The heartbeat line: its age, and why it's stale when it is, worded as --check words it. */
function heartbeatLine(watcher: IdentityStatus['watcher'], now: number): string {
    if (watcher === null) return 'Watcher heartbeat: none yet';
    // identityStatus() clamps a stamp ahead of the clock to 0 s, which is right for a few seconds of drift and wrong past the stale bound.
    const ageMs = now - Date.parse(watcher.heartbeatAt);
    if (ageMs < -WATCHER_STALE_AFTER_MS) return `Watcher heartbeat: stamped ${ageText(ageMs)} ahead of this clock (${watcher.heartbeatAt}), so it can't show the watcher runs`;
    const late = ageMs > WATCHER_STALE_AFTER_MS ? ", over 5 minutes old, so new photographs won't reach the Inbox until the watcher runs" : '';
    return `Watcher heartbeat: ${watcher.ageSeconds} s ago (${watcher.heartbeatAt})${late}`;
}

function formatStatus(status: OwnerStatus, now: number): string {
    const { identity, catalog, working } = status;
    const lines = [`Data root: ${identity.dataRoot.root ?? 'not set'} (${identity.dataRoot.state}${identity.dataRoot.detail ? `: ${identity.dataRoot.detail}` : ''})`];
    if (identity.dataRoot.state === 'uninitialized') lines.push('  photos:migrate initializes it, as docs/data-root.md describes.');
    if (!CATALOG_READABLE.has(identity.dataRoot.state)) return `${lines.join('\n')}\n`;
    if (catalog.error) {
        lines.push(`Catalog: can't be read (${catalog.error})`);
    } else if (catalog.active) {
        const { revisionId, revisionNumber, kind, actor, committedAt, sequence } = catalog.active;
        switch (catalog.active.status) {
            case 'committed':
                lines.push(`Catalog: revision ${revisionNumber} (${revisionId}) active since ${committedAt ?? 'an unknown time'}, a ${kind} by ${actor}`);
                break;
            case 'pending':
                lines.push(`Catalog: revision ${revisionNumber} (${revisionId}) is live, from a ${kind} by ${actor} that didn't finish`);
                lines.push(`  Activation ${sequence} is pending. The next photos publish settles it.`);
                break;
            case 'abandoned':
                lines.push(`Catalog: revision ${revisionNumber} (${revisionId}) is live, though its activation was abandoned`);
                lines.push(`  Activation ${sequence} is abandoned, but the pointer names it. The next photos publish repairs it, unless that revision's rules block it.`);
                break;
            case 'missing':
                lines.push(`Catalog: ${revisionId} is live, but no activation record names it`);
                lines.push("  The next photos publish repairs the record, unless that revision's rules block it.");
                break;
            case 'mismatch':
                lines.push(`Catalog: ${revisionId} is live, but the pointer names activation ${sequence}, which activated ${catalog.active.activationRevisionId}`);
                lines.push("  The pointer and its activation record disagree. The next photos publish repairs them, unless that revision's rules block it.");
                break;
        }
    } else if (catalog.published === 'published') {
        // A data root seen to publish never reads as unpublished again (checkPublished()'s latch), and web says so too.
        lines.push('Catalog: this data root has published, but no live revision can be read, so the site answers unavailable (503, active-unreadable), or degraded on the revision web last loaded');
    } else if (catalog.published === 'unknown') {
        lines.push("Catalog: can't tell whether this data root has published, so the site answers unavailable (503, catalog-unreadable)");
    } else {
        lines.push("Catalog: nothing published yet, so the site answers unavailable (503, not-published) until the first photos publish");
    }
    const last = catalog.lastPublish;
    lines.push(last
        ? `Last publish: ${last.outcome} at ${last.at} by ${last.actor}, ${count(last.errors, 'error')} and ${count(last.warnings, 'warning')}${last.revisionNumber === null ? '' : `, revision ${last.revisionNumber}`}`
        : 'Last publish: none yet');
    if (identity.dataRoot.state !== 'ready') return `${lines.join('\n')}\n`;
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
    if (status.trash) {
        lines.push('error' in status.trash
            ? `Trash: trash/ can't be read (${status.trash.error})`
            : `Trash: ${count(status.trash.folders.length, 'folder')}, ${sizeText(status.trash.bytes)}, in trash/: ${status.trash.folders.map((each) => each.name).join(', ')}. Emptying trash/ is your own step.`);
    }
    lines.push(heartbeatLine(identity.watcher, now));
    return `${lines.join('\n')}\n`;
}

/** Why `photos status --check` fails, one code each, so a monitor can tell them apart. A6 adds `library-unavailable`. */
export type CheckCode =
    | 'status-incomplete'
    | 'library-unavailable'
    | 'inbox-unreadable'
    | 'missing-open'
    | 'failed-open'
    | 'ambiguous-open'
    | 'last-pass-failed'
    | 'pass-stalled'
    | 'heartbeat-missing'
    | 'heartbeat-stale'
    /** #181's A10: a folder a stopped `photos gc --apply` run set aside, which GC never deletes. */
    | 'gc-set-aside';

export interface StatusCheck {
    ok: boolean;
    problems: { code: CheckCode; message: string }[];
    /**
     * A6: what the check counts without failing on it: the missing sources
     * the library-unavailable item holds, the builds waiting for a retry, and
     * the builds that failed for good, which the inbox's failures cover.
     */
    counts?: { held: number; retrying: number; permanent: number };
}

/** The heartbeat's problem for the check, or null while it's fresh. */
function heartbeatProblem(heartbeat: HeartbeatAge | null): StatusCheck['problems'][number] | null {
    // The reason names the file's absolute path, so the check words the cause instead.
    if (heartbeat === null) return { code: 'heartbeat-missing', message: "PHOTOGRAPHY_DATA_DIR is not set, so there's no heartbeat to read" };
    if (!heartbeat.found) {
        if (heartbeat.cause === 'absent') return { code: 'heartbeat-missing', message: "The watcher hasn't written a heartbeat, so nothing shows it runs" };
        const what = HEARTBEAT_PROBLEM_TEXT[heartbeat.cause].replace(/^status\/watcher\.json /, '');
        return { code: 'heartbeat-missing', message: `The watcher's heartbeat, status/watcher.json, ${what}, so nothing shows it runs` };
    }
    if (!heartbeatStale(heartbeat.ageMs)) return null;
    return {
        code: 'heartbeat-stale',
        message: heartbeat.ageMs < 0
            ? `The watcher's heartbeat is stamped ${ageText(heartbeat.ageMs)} ahead of this clock, at ${heartbeat.heartbeatAt}`
            : `The watcher's heartbeat is ${ageText(heartbeat.ageMs)} old, over 5 minutes, at ${heartbeat.heartbeatAt}`,
    };
}

/**
 * A watcher that beats but gets no pass through: none committed or refused
 * an empty library for WATCHER_STALLED_AFTER_MS, measured from lastProgressAt.
 * A heartbeat from a watcher older than that field is read by its last pass
 * when that one got through, else by the pass under way.
 */
function stallProblem(heartbeat: Extract<HeartbeatAge, { found: true }>, now: number): StatusCheck['problems'][number] | null {
    // A6 review: only a committed pass got anywhere. A refused one, for an empty or unavailable library, is no progress.
    const progressed = heartbeat.lastPassResult === 'committed';
    const running = heartbeat.passRunningMs === null ? null : new Date(now - heartbeat.passRunningMs).toISOString();
    const since = heartbeat.lastProgressAt ?? (progressed ? heartbeat.lastPassAt : null) ?? running;
    if (since === null || now - Date.parse(since) <= WATCHER_STALLED_AFTER_MS) return null;
    const why = heartbeat.passRunningMs !== null
        ? `; the pass under way started ${ageText(heartbeat.passRunningMs)} ago`
        : heartbeat.lastPassResult !== null && !progressed ? `; its last try was ${heartbeat.lastPassResult}` : '';
    return { code: 'pass-stalled', message: `The watcher has finished no pass for ${ageText(now - Date.parse(since))}, over 30 minutes, since ${since}${why}` };
}

/** `--check`'s verdict on what status read, and on the heartbeat. `complete` is whether status itself read everything. */
async function statusCheck(status: OwnerStatus, dataRoot: string | null, complete: boolean, clock: () => number): Promise<StatusCheck> {
    const problems: StatusCheck['problems'] = [];
    if (!complete) problems.push({ code: 'status-incomplete', message: "Status couldn't read everything it reports, as above" });
    if (status.inbox && !('error' in status.inbox)) {
        const { missing, failed, ambiguous, unreadable, library, held } = status.inbox;
        // A6: the library itself, before the per-photo items it holds.
        if (library) {
            const heldText = held.length > 0 ? `, so ${count(held.length, 'missing source')} ${held.length === 1 ? 'is' : 'are'} held` : '';
            problems.push({ code: 'library-unavailable', message: `The library is unavailable (${library.causeText}) since ${library.since}, ${ageText(library.ageSeconds * 1000)} ago${heldText}` });
        }
        // An item that can't be read may be an open missing source or failure, so the check can't pass over it.
        if (unreadable > 0) problems.push({ code: 'inbox-unreadable', message: `${count(unreadable, 'inbox item')} can't be read, so the check can't tell what ${unreadable === 1 ? 'it holds' : 'they hold'}. curation list names ${unreadable === 1 ? 'it' : 'them'}` });
        if (missing.length > 0) {
            const oldest = Math.max(...missing.map((item) => item.ageSeconds));
            problems.push({ code: 'missing-open', message: `${count(missing.length, 'missing source')} open, the oldest ${ageText(oldest * 1000)} old` });
        }
        if (failed.length > 0) problems.push({ code: 'failed-open', message: `${count(failed.length, 'failure')} open` });
        if (ambiguous.length > 0) problems.push({ code: 'ambiguous-open', message: `${ambiguous.length} ambiguous ${ambiguous.length === 1 ? 'item' : 'items'} open` });
    }
    const heartbeat = dataRoot === null ? null : await watcherHeartbeatAge(path.resolve(dataRoot), clock);
    // A6 review: fail closed. A last pass that refused the library fails the check even when its item couldn't be
    // written, as with curation/events/ unwritable. Reported once, with the item when there is one.
    const refused = heartbeat?.found && (heartbeat.lastPassResult === 'library-empty' || heartbeat.lastPassResult === 'library-unavailable') ? heartbeat : null;
    if (refused && !problems.some((problem) => problem.code === 'library-unavailable')) {
        const what = refused.lastPassResult === 'library-empty' ? 'the library empty while the registry has present photos' : 'the library root missing or unreadable';
        problems.push({ code: 'library-unavailable', message: `The watcher's last pass${refused.lastPassAt ? `, at ${refused.lastPassAt},` : ''} found ${what}, so it changed nothing` });
    }
    if (heartbeat?.found && heartbeat.lastPassResult === 'failed') {
        problems.push({ code: 'last-pass-failed', message: `The watcher's last pass failed${heartbeat.lastPassAt ? `, at ${heartbeat.lastPassAt}` : ''}` });
    }
    const stalled = heartbeat?.found ? stallProblem(heartbeat, clock()) : null;
    if (stalled) problems.push(stalled);
    const late = heartbeatProblem(heartbeat);
    if (late) problems.push(late);
    const aside = dataRoot === null ? null : await setAsideProblem(path.resolve(dataRoot));
    if (aside) problems.push(aside);
    const held = status.inbox && !('error' in status.inbox) ? status.inbox.held.length : 0;
    // Review nit: a superseded set isn't a failure of these bytes.
    const permanent = status.identity.failedProfiles.filter((failed) => failed.error !== 'source-superseded').length;
    return { ok: problems.length === 0, problems, counts: { held, retrying: status.identity.retryingJobs, permanent } };
}

/** The folders a stopped `photos gc --apply` run set aside, as a problem, or null when there are none. */
async function setAsideProblem(dataRoot: string): Promise<StatusCheck['problems'][number] | null> {
    let found: Awaited<ReturnType<typeof setAsideFolders>>;
    try {
        found = await setAsideFolders(dataRoot);
    } catch (error) {
        return { code: 'gc-set-aside', message: `assets/ can't be listed for folders photos gc --apply set aside (${(error as NodeJS.ErrnoException).code ?? 'an I/O error'})` };
    }
    if (found.length === 0) return null;
    return { code: 'gc-set-aside', message: `${count(found.length, 'folder')} a stopped photos gc --apply run left, which GC never deletes: ${found.map((folder) => folder.text).join('; ')}` };
}

function checkLines(check: StatusCheck): string {
    // A6: what the check counts without failing on, before its verdict, so the verdict stays the last line.
    const counts = check.counts
        ? `Held: ${count(check.counts.held, 'missing source')}. Builds: ${check.counts.retrying} retrying, ${check.counts.permanent} failed for good.\n`
        : '';
    return `${counts}${check.ok ? 'Check: passed.\n' : `${['Check: failed.', ...check.problems.map((problem) => `  - ${problem.message}.`)].join('\n')}\n`}`;
}

/** `photos status [--json] [--check]`. */
export async function runStatusCommand(layer: StatusHandle, { json = false, check = false, clock }: { json?: boolean; check?: boolean; clock?: () => number } = {}): Promise<CommandResult> {
    try {
        const now = clock ?? layer.clock ?? Date.now;
        const status = await ownerStatus({ ...layer, clock: now });
        const ok = status.identity.dataRoot.state === 'ready' && status.working !== null && status.catalog.error === undefined
            && status.inbox !== null && !('error' in status.inbox);
        if (!check) return { exitCode: ok ? 0 : 1, output: json ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status, now()) };
        const verdict = await statusCheck(status, layer.dataRoot, ok, now);
        return { exitCode: verdict.ok ? 0 : 1, output: json ? `${JSON.stringify({ ...status, check: verdict }, null, 2)}\n` : `${formatStatus(status, now())}${checkLines(verdict)}` };
    } catch (error) {
        // A monitor parsing --json gets JSON even now, and --check's verdict in its usual shape.
        const verdict: StatusCheck = { ok: false, problems: [{ code: 'status-incomplete', message: `Status couldn't run: ${message(error)}` }] };
        if (json) return { exitCode: 1, output: `${JSON.stringify(check ? { error: message(error), check: verdict } : { error: message(error) }, null, 2)}\n` };
        return { exitCode: 1, output: `Error: ${message(error)}\n${check ? checkLines(verdict) : ''}` };
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

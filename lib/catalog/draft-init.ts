import path from 'node:path';
import { readRegistry } from '../identity/registry';
import type { PhotoRecord } from '../identity/types';
import { dataRootStatus } from '../storage/config';
import type { VersionedWriteOptions } from '../storage/document';
import { LockLostError, LockTimeoutError, withLock } from '../storage/lock';
import type { CommandResult, LayerHandle } from './sequence-commands';
import { AUTHORED_LEASE_MS, AUTHORED_LOCK, AUTHORED_WAIT_MS, AuthoredWriteError, writeAuthoredRecord } from './working-layer-writer';
import { readWorkingLayer } from './working-layer';

/**
 * `photos draft:init`, #13 slice D: give every photo the registry knows an
 * authored record to describe and sequence, and the site its `site.json`,
 * wherever one is missing. It never overwrites a record, so it is safe to
 * run again after the watcher finds new photos. A new photo record pins the
 * asset revision its source is bound to and has no description yet, and no
 * series lists it until the owner adds it.
 *
 * Exit codes follow sequence-commands.ts: 0 on success, 1 when the data root
 * isn't ready, 3 when the authored lock stays busy or is lost part way, and
 * 4 for I/O. A run that stops part way leaves the records it wrote, and
 * running it again finishes the rest.
 */

export interface DraftInitResult {
    siteCreated: boolean;
    /** Photo IDs that got a record, sorted. */
    created: string[];
    /** Photos that already had one. */
    existing: number;
    /** Photos left out, and why. */
    skipped: { photoId: string; reason: string }[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const records = (n: number) => `${n} photo record${n === 1 ? '' : 's'}`;
/** How many IDs the output lists before it only counts the rest. */
const LISTED = 200;

function listed(lines: string[]): string[] {
    return lines.length > LISTED ? [...lines.slice(0, LISTED), `  and ${lines.length - LISTED} more`] : lines;
}

/** Why a registry photo gets no record yet, or null when it gets one. */
function skipReason(photo: PhotoRecord): string | null {
    if (photo.mergedInto !== undefined) return `merged into ${photo.mergedInto}`;
    if (photo.sourceHealth === 'archived') return 'archived';
    if (photo.sourceHealth === 'ambiguous') return 'its source is ambiguous until an identity decision settles it';
    const revision = photo.revisions[photo.source.observedRevision];
    if (!revision || revision.reassignedTo) return 'its bound asset revision belongs to another photo';
    return null;
}

export interface DraftInitOptions {
    /** Test hooks, passed to every writeAuthoredRecord() call. */
    hooks?: VersionedWriteOptions['hooks'];
}

export async function initDrafts({ dataRoot, waitMs = AUTHORED_WAIT_MS }: LayerHandle, { hooks }: DraftInitOptions = {}): Promise<DraftInitResult> {
    const root = path.resolve(dataRoot);
    return withLock(AUTHORED_LOCK, { root, leaseMs: AUTHORED_LEASE_MS, waitMs }, async (lock) => {
        const layer = await readWorkingLayer(root);
        const registry = await readRegistry(root);
        // A record file that exists but can't be read is the owner's to fix. It is never replaced.
        const unusable = new Set(layer.problems.map((problem) => `${problem.kind}:${problem.id}`));
        const result: DraftInitResult = { siteCreated: false, created: [], existing: 0, skipped: [] };
        if (layer.site === null && !unusable.has('site:site')) {
            await writeAuthoredRecord({ kind: 'site', featuredSeriesIds: [], seriesOrder: [] }, { expectedVersion: 0, lock, root, hooks });
            result.siteCreated = true;
        }
        const known = new Set(layer.photos.map((photo) => photo.id));
        for (const photo of Object.values(registry.photos).sort((a, b) => compare(a.photoId, b.photoId))) {
            if (known.has(photo.photoId)) {
                result.existing++;
                continue;
            }
            if (unusable.has(`photo:${photo.photoId}`)) {
                result.skipped.push({ photoId: photo.photoId, reason: 'its record file exists but can\'t be read' });
                continue;
            }
            const reason = skipReason(photo);
            if (reason !== null) {
                result.skipped.push({ photoId: photo.photoId, reason });
                continue;
            }
            lock.signal.throwIfAborted();
            await writeAuthoredRecord({ kind: 'photo', id: photo.photoId, assetRevision: photo.source.observedRevision, alt: null }, { expectedVersion: 0, lock, root, hooks });
            result.created.push(photo.photoId);
        }
        return result;
    });
}

function format(result: DraftInitResult): string {
    const lines = [
        `${result.siteCreated ? 'Created site.json' : 'site.json was already there'}. Created ${records(result.created.length)}, and ${result.existing} ${result.existing === 1 ? 'photo already had one' : 'photos already had one'}.`,
        ...listed(result.created.map((photoId) => `  ${photoId}`)),
    ];
    if (result.skipped.length > 0) {
        lines.push(`Left out ${result.skipped.length}:`, ...listed(result.skipped.map(({ photoId, reason }) => `  ${photoId}: ${reason}`)));
    }
    if (result.created.length > 0) lines.push('The new records have no description yet. photos describe --import adds them, and photos sequence puts photos in a series.');
    return `${lines.join('\n')}\n`;
}

/** `photos draft:init`. Never throws: every outcome is an exit code and the text to print. */
export async function runDraftInit(layer: LayerHandle, options: DraftInitOptions = {}): Promise<CommandResult> {
    const status = dataRootStatus({ write: true, root: path.resolve(layer.dataRoot) });
    if (status.state !== 'ready') return { exitCode: 1, output: `Error: The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}. Nothing was written.\n` };
    try {
        return { exitCode: 0, output: format(await initDrafts(layer, options)) };
    } catch (error) {
        if (error instanceof LockTimeoutError) return { exitCode: 3, output: `Error (authored-locked): ${error.message} Nothing was written.\n` };
        // Each record is written on its own, so whatever stops the run leaves the ones before it.
        const rest = 'Records written before it stay, and running draft:init again finishes the rest.';
        if (error instanceof LockLostError) return { exitCode: 3, output: `Error (LOCK_LOST): ${error.message} ${rest}\n` };
        if (error instanceof AuthoredWriteError) {
            const exitCode = ['VERSION_CONFLICT', 'AUTHORED_LOCKED', 'LOCK_NOT_HELD'].includes(error.code) ? 3 : 1;
            return { exitCode, output: `Error (${error.code}): ${error.message} ${rest}\n` };
        }
        return { exitCode: 4, output: `Error: ${(error as Error).message} ${rest}\n` };
    }
}

import { dataRootStatus, libraryRoot, type DataRootStatus } from '../storage/config';
import { withoutAbsolutePaths } from '../storage/fsx';
import { watcherHeartbeatAge } from './heartbeat';
import { readRegistry } from './registry';
import type { Hold, SourceHealth } from './types';

export interface FailedProfile {
    photoId: string;
    assetRevision: string;
    profileId: string;
    error?: string;
}

/** What `photos:identity status` reports. Read-only, and it works in every data-root state. */
export interface IdentityStatus {
    dataRoot: DataRootStatus;
    registry: { version: number; updatedAt: string | null } | null;
    /** Why the registry couldn't be read, if it couldn't. */
    registryError?: string;
    photos: { total: number; bySourceHealth: Record<SourceHealth, number> };
    holds: Hold[];
    failedProfiles: FailedProfile[];
    /** Derivative builds waiting for the worker. */
    pendingJobs: number;
    /** Facts committed but not yet delivered to every sink. */
    pendingFacts: number;
    /** From `status/watcher.json`, which the watcher writes. Null until it has run. */
    watcher: { heartbeatAt: string; ageSeconds: number } | null;
}

export async function identityStatus({ clock = Date.now }: { clock?: () => number } = {}): Promise<IdentityStatus> {
    const dataRoot = dataRootStatus();
    const status: IdentityStatus = {
        dataRoot,
        registry: null,
        photos: { total: 0, bySourceHealth: { present: 0, missing: 0, ambiguous: 0, archived: 0 } },
        holds: [],
        failedProfiles: [],
        pendingJobs: 0,
        pendingFacts: 0,
        watcher: null,
    };
    if (dataRoot.root === null || (dataRoot.state === 'unavailable' && dataRoot.cause !== 'inside-served-folder')) return status;

    // A reason recorded before builds left paths out may still name where the library or the data root lives.
    const roots = [libraryRoot(), dataRoot.root];
    try {
        const registry = await readRegistry(dataRoot.root);
        status.registry = { version: registry.version, updatedAt: registry.updatedAt };
        status.holds = registry.holds;
        status.pendingFacts = registry.pendingFacts.length;
        for (const photo of Object.values(registry.photos)) {
            status.photos.total++;
            status.photos.bySourceHealth[photo.sourceHealth]++;
            for (const revision of Object.values(photo.revisions)) {
                if (revision.reassignedTo) continue;
                for (const [profileId, profile] of Object.entries(revision.profiles)) {
                    if (profile.state === 'pending') status.pendingJobs++;
                    if (profile.state === 'failed') {
                        status.failedProfiles.push({ photoId: photo.photoId, assetRevision: revision.assetRevision, profileId, ...(profile.error ? { error: withoutAbsolutePaths(profile.error, roots) } : {}) });
                    }
                }
            }
        }
    } catch (error) {
        status.registryError = error instanceof Error ? error.message : String(error);
    }

    const heartbeat = await watcherHeartbeatAge(dataRoot.root, clock);
    if (heartbeat.found) status.watcher = { heartbeatAt: heartbeat.heartbeatAt, ageSeconds: Math.max(0, Math.round(heartbeat.ageMs / 1000)) };
    return status;
}

export function formatStatus(status: IdentityStatus): string {
    const { dataRoot } = status;
    const lines = [
        `Data root: ${dataRoot.root ?? 'not set'} (${dataRoot.state}${dataRoot.detail ? `: ${dataRoot.detail}` : ''})`,
        status.registry
            ? `Registry: version ${status.registry.version}, updated ${status.registry.updatedAt ?? 'never'}`
            : `Registry: ${status.registryError ? `unreadable (${status.registryError})` : 'none'}`,
        `Photos: ${status.photos.total} (${Object.entries(status.photos.bySourceHealth).map(([health, count]) => `${health} ${count}`).join(', ')})`,
        `Holds: ${status.holds.length}`,
        ...status.holds.map((held) => `  ${held.path} since ${held.since}, candidates: ${held.candidates.join(', ') || 'none'}`),
        `Failed profiles: ${status.failedProfiles.length}`,
        ...status.failedProfiles.map((failed) => `  ${failed.photoId} ${failed.assetRevision} ${failed.profileId}${failed.error ? `: ${failed.error}` : ''}`),
        `Pending jobs: ${status.pendingJobs}`,
        `Pending facts: ${status.pendingFacts}`,
        `Watcher heartbeat: ${status.watcher ? `${status.watcher.ageSeconds} s ago (${status.watcher.heartbeatAt})` : 'none yet'}`,
    ];
    return `${lines.join('\n')}\n`;
}

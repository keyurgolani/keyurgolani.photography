import type { LockRecord } from '../storage/lock';
import type { CatalogLogger } from './publish';
import type { Tombstone, TombstoneEntry, TombstoneRevoke } from './tombstones';

/**
 * #15's purge, #181's A10. A stub for the red tests: the interface only.
 * Both commands throw until the implementation lands.
 */

export const PURGE_WAIT_MS = 30_000;

export type PurgeOutcome =
    | 'PLANNED'
    | 'PURGED'
    | 'ALREADY_TAKEN_DOWN'
    | 'IN_ACTIVE_REVISION'
    | 'IN_SERIES'
    | 'UNKNOWN_PHOTO'
    | 'UNKNOWN_ASSET_REVISION'
    | 'REVOKE_PLANNED'
    | 'REVOKED'
    | 'ALREADY_REVOKED'
    | 'UNKNOWN_TOMBSTONE'
    | 'ALREADY_COLLECTED'
    | 'CATALOG_LOCKED'
    | 'AUTHORED_LOCKED'
    | 'LOCK_LOST'
    | 'DATA_ROOT_NOT_READY'
    | 'INTEGRITY_MISMATCH'
    | 'STORAGE_ERROR';

export const PURGE_EXIT_CODES = {} as Record<PurgeOutcome, 0 | 1 | 3 | 4>;

export interface PurgeSet {
    path: string;
    profileId: string;
    bytes: number;
}

export interface PurgeAssetRevision {
    assetRevision: string;
    sets: PurgeSet[];
    bytes: number;
    takenDownBy: string[];
}

export interface LosingRevision {
    revisionId: string;
    revisionNumber: number;
    assetRevisions: string[];
}

export interface PurgePlan {
    photoId: string;
    assetRevision: string | null;
    assetRevisions: PurgeAssetRevision[];
    sets: number;
    bytes: number;
    losing: LosingRevision[];
    graceEndsAt: string;
    summary: string;
}

export interface RevokePlan {
    tombstone: TombstoneEntry;
    summary: string;
}

export interface PurgeResult {
    outcome: PurgeOutcome;
    message: string;
    plan: PurgePlan | null;
    revokePlan?: RevokePlan | null;
    tombstone: Tombstone | null;
    revoke?: TombstoneRevoke | null;
    holder?: LockRecord | null;
}

export interface PurgeHooks {
    beforeWrite?(): void | Promise<void>;
}

interface CommonOptions {
    dataRoot: string;
    reason: string;
    actor: string;
    yes?: boolean;
    clock?: () => number;
    waitMs?: number;
    leaseMs?: number;
    logger?: CatalogLogger;
    hooks?: PurgeHooks;
}

export interface PurgeOptions extends CommonOptions {
    photoId: string;
    assetRevision?: string;
    idGen?: () => string;
    onPlan?(plan: PurgePlan): void;
}

export interface RevokeOptions extends CommonOptions {
    tombstoneId: string;
    onPlan?(plan: RevokePlan): void;
}

export async function runPurge(options: PurgeOptions): Promise<PurgeResult> {
    throw new Error(`Not implemented yet: #181 A10 (${options.photoId}).`);
}

export async function runRevoke(options: RevokeOptions): Promise<PurgeResult> {
    throw new Error(`Not implemented yet: #181 A10 (${options.tombstoneId}).`);
}

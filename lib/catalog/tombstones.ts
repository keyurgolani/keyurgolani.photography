import path from 'node:path';

/**
 * #15's tombstones, the read side (#181's A10). A stub for the red tests:
 * the file layout and the types only. Every reader throws until the
 * implementation lands.
 */

export const TOMBSTONE_ID_RE = /^tomb_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const TOMBSTONE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface Tombstone {
    tombstoneId: string;
    photoId: string;
    assetRevision: string | null;
    assetRevisions: string[];
    actor: string;
    reason: string;
    createdAt: string;
}

export interface TombstoneRevoke {
    tombstoneId: string;
    actor: string;
    reason: string;
    createdAt: string;
}

export interface TombstoneCollected {
    tombstoneId: string;
    planDigest: string;
    startedAt: string;
    paths: string[];
}

export interface TombstoneEntry extends Tombstone {
    revoked: TombstoneRevoke | null;
    collected: TombstoneCollected | null;
}

export type TombstoneProblemReason = 'unreadable' | 'not-a-file' | 'not-a-folder' | 'too-large' | 'invalid-json' | 'invalid' | 'file-name' | 'orphan';

export interface TombstoneProblem {
    file: string;
    reason: TombstoneProblemReason;
    detail: string;
}

export interface TombstoneRead {
    tombstones: TombstoneEntry[];
    problems: TombstoneProblem[];
}

export const TOMBSTONES_DIR = 'catalog/tombstones';

export function tombstonesDir(root: string): string {
    return path.join(root, 'catalog', 'tombstones');
}

export const tombstoneFile = (root: string, tombstoneId: string) => path.join(tombstonesDir(root), `${tombstoneId}.json`);
export const revokeFile = (root: string, tombstoneId: string) => path.join(tombstonesDir(root), `${tombstoneId}.revoked.json`);
export const collectedFile = (root: string, tombstoneId: string) => path.join(tombstonesDir(root), `${tombstoneId}.collected.json`);

const notYet = (...args: unknown[]) => new Error(`Not implemented yet: #181 A10 (${args.length} arguments).`);

export async function readTombstones(root: string): Promise<TombstoneRead> {
    throw notYet(root);
}

export function readTombstonesSync(root: string): TombstoneRead {
    throw notYet(root);
}

export function standingFor(read: Pick<TombstoneRead, 'tombstones'>, photoId: string, assetRevision: string): TombstoneEntry[] {
    throw notYet(read, photoId, assetRevision);
}

export interface TombstoneIndexOptions {
    root(): string | null;
    logger?: Pick<Console, 'warn'>;
    clock?: () => number;
}

export function createTombstoneIndex(options: TombstoneIndexOptions): (ref: { photoId: string; assetRevision: string }) => Promise<boolean> {
    return async (ref) => {
        throw notYet(options, ref);
    };
}

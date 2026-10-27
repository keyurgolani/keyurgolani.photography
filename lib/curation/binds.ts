import fs from 'node:fs';
import path from 'node:path';
import { readPendingDecisions } from '../identity/decisions';
import { identityPaths } from '../identity/registry';
import { hasErrorCode } from '../storage/fsx';

/**
 * What became of the #10 `bind` decisions #17's curator writes. A decision
 * waits in `identity/decisions/` until the watcher's next pass, which moves
 * it to `applied/`, or to `rejected/` with #10's reason. These read those
 * folders and write nothing.
 */

export interface PendingMerge {
    decisionId: string;
    /** The photo the merge gives this one's bytes to. */
    into: string;
    path: string;
}

/**
 * The pending bind decision that merges `photoId` into another photo, or
 * null. A decision file that can't be read could be one, so it throws.
 */
export async function pendingMergeOf(root: string, photoId: string): Promise<PendingMerge | null> {
    for (const file of await readPendingDecisions(root)) {
        if (file.raw === null) throw new Error(`The identity decision ${file.name} can't be read, so nothing shows whether it merges ${photoId}`);
        const decision = file.decision;
        if (decision?.type === 'bind' && decision.merge === photoId) return { decisionId: decision.decisionId, into: decision.photoId, path: decision.path };
    }
    return null;
}

export interface PendingBind {
    decisionId: string;
    path: string;
}

/**
 * The pending bind decision that gives `photoId` a file, or null. A decision
 * file that can't be read could be one, so it throws.
 */
export async function pendingBindOf(root: string, photoId: string): Promise<PendingBind | null> {
    for (const file of await readPendingDecisions(root)) {
        if (file.raw === null) throw new Error(`The identity decision ${file.name} can't be read, so nothing shows whether it binds ${photoId}`);
        const decision = file.decision;
        if (decision?.type === 'bind' && decision.photoId === photoId) return { decisionId: decision.decisionId, path: decision.path };
    }
    return null;
}

export type DecisionState =
    | { state: 'pending' }
    | { state: 'applied' }
    | { state: 'rejected'; reason: string }
    /** No file names it, or its record can't be read. */
    | { state: 'unknown' };

async function findIn(dir: string, decisionId: string): Promise<string | null> {
    try {
        const name = (await fs.promises.readdir(dir)).find((entry) => entry.endsWith(`-${decisionId}.json`));
        return name === undefined ? null : path.join(/*turbopackIgnore: true*/ dir, name);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return null;
        throw error;
    }
}

/** Where the decision `decisionId` is now: waiting, applied, or rejected with #10's reason, which names only library paths and photo IDs. */
export async function decisionState(root: string, decisionId: string): Promise<DecisionState> {
    const dir = identityPaths(root).decisions;
    if (await findIn(dir, decisionId)) return { state: 'pending' };
    if (await findIn(path.join(/*turbopackIgnore: true*/ dir, 'applied'), decisionId)) return { state: 'applied' };
    const rejected = await findIn(path.join(/*turbopackIgnore: true*/ dir, 'rejected'), decisionId);
    if (rejected === null) return { state: 'unknown' };
    try {
        const record: unknown = JSON.parse(await fs.promises.readFile(/*turbopackIgnore: true*/ rejected, 'utf8'));
        const reason = typeof record === 'object' && record !== null && typeof (record as { reason?: unknown }).reason === 'string' ? (record as { reason: string }).reason : null;
        return reason === null ? { state: 'unknown' } : { state: 'rejected', reason };
    } catch {
        return { state: 'unknown' };
    }
}

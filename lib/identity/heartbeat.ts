import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../storage/atomicWrite';
import type { DataRootState } from '../storage/config';
import { hasErrorCode, PRIVATE_DIR_MODE } from '../storage/fsx';

/**
 * What the watcher's last pass did: committed a reconcile, found the registry
 * busy, failed, or found the data root not ready, by its state.
 */
export type PassResult = 'committed' | 'locked' | 'failed' | `data-root-${Exclude<DataRootState, 'ready'>}`;

/** `status/watcher.json`, the watcher's sign of life for its healthcheck and `photos:identity status`. */
export interface WatcherHeartbeat {
    pid: number;
    hostname: string;
    /** When the last pass finished, or null before the first. */
    lastPassAt: string | null;
    lastPassResult: PassResult | null;
    heartbeatAt: string;
}

export function watcherStatusFile(root: string): string {
    return path.join(root, 'status', 'watcher.json');
}

/** Replace `status/watcher.json` atomically, creating `status/` for its owner only. */
export async function writeWatcherHeartbeat(root: string, heartbeat: WatcherHeartbeat): Promise<void> {
    const file = watcherStatusFile(root);
    try {
        await fs.promises.mkdir(path.dirname(file), { mode: PRIVATE_DIR_MODE });
    } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
    await atomicWriteJson(file, heartbeat);
}

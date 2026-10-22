import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../storage/atomicWrite';
import { dataRoot, type DataRootState } from '../storage/config';
import { CorruptDocumentError, isRecord, readJsonFile } from '../storage/document';
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
    return path.join(/*turbopackIgnore: true*/ root, 'status', 'watcher.json');
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

/** When `status/watcher.json` says the watcher was last alive and how long ago, or why it says nothing. */
export type HeartbeatAge = { found: true; heartbeatAt: string; ageMs: number } | { found: false; reason: string };

/** Read the heartbeat under `root`. Never throws. */
export async function watcherHeartbeatAge(root: string, clock: () => number = Date.now): Promise<HeartbeatAge> {
    const file = watcherStatusFile(root);
    let heartbeat: unknown;
    try {
        heartbeat = await readJsonFile(file);
    } catch (error) {
        if (error instanceof CorruptDocumentError) return { found: false, reason: error.message };
        return { found: false, reason: `${file} can't be read: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (heartbeat === null) return { found: false, reason: `${file} doesn't exist` };
    const at = isRecord(heartbeat) ? heartbeat.heartbeatAt : undefined;
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return { found: false, reason: `${file} has no valid heartbeatAt` };
    return { found: true, heartbeatAt: at, ageMs: clock() - Date.parse(at) };
}

/** The watcher's healthcheck passes while its heartbeat is at most this old, four of the 30 s beats. */
export const WATCHER_HEALTHY_WITHIN_MS = 120_000;

/**
 * The watcher container's healthcheck: healthy while the heartbeat in the
 * data root is at most `maxAgeMs` old. The watcher writes it every 30 s while
 * the data root exists and is writable, initialized or not, so an unset,
 * missing, or unwritable data root reads as unhealthy too.
 */
export async function checkWatcherHealth({ clock = Date.now, maxAgeMs = WATCHER_HEALTHY_WITHIN_MS }: { clock?: () => number; maxAgeMs?: number } = {}): Promise<{ healthy: boolean; message: string }> {
    const root = dataRoot();
    if (root === null) return { healthy: false, message: 'PHOTOGRAPHY_DATA_DIR is not set, so the watcher writes no heartbeat.' };
    const age = await watcherHeartbeatAge(root, clock);
    if (!age.found) return { healthy: false, message: `No heartbeat: ${age.reason}.` };
    const seconds = Math.max(0, Math.round(age.ageMs / 1000));
    if (age.ageMs > maxAgeMs) return { healthy: false, message: `The last heartbeat was ${seconds} s ago, at ${age.heartbeatAt}.` };
    return { healthy: true, message: `The last heartbeat was ${seconds} s ago.` };
}

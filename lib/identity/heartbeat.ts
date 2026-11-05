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
export type PassResult = 'committed' | 'locked' | 'failed' | 'library-empty' | `data-root-${Exclude<DataRootState, 'ready'>}`;

/** `status/watcher.json`, the watcher's sign of life for its healthcheck and `photos:identity status`. */
export interface WatcherHeartbeat {
    pid: number;
    hostname: string;
    /** When the last pass finished, or null before the first. */
    lastPassAt: string | null;
    lastPassResult: PassResult | null;
    /** When the pass under way started, or null while none runs. */
    passStartedAt: string | null;
    heartbeatAt: string;
    /**
     * v2.0.0: when a pass last got through the library, committed or refusing
     * an empty one, or when the watcher started, before its first. A locked,
     * failed, or off pass doesn't move it, so `photos status --check` can tell
     * a watcher that beats but makes no progress. Older watchers write none.
     */
    lastProgressAt?: string;
    /**
     * Whether this watcher writes the legacy basename derivatives into the
     * library. Always false from v1.7.0, which stopped writing them (#13's
     * slice E). Older watchers write no such field, and #15's GC reads a
     * missing field as "still writes them", so it only takes legacy files
     * while a fresh heartbeat says false.
     */
    legacyDerivatives: false;
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

/**
 * When `status/watcher.json` says the watcher was last alive and how long
 * ago, and how long the pass under way has run (null when none runs, or the
 * heartbeat predates the field), or why it says nothing.
 */
export type HeartbeatAge =
    | {
          found: true;
          heartbeatAt: string;
          ageMs: number;
          passRunningMs: number | null;
          libraryEmpty: boolean;
          /** The last pass's result and when it finished, or null before the first or when the heartbeat doesn't say. */
          lastPassResult: PassResult | null;
          lastPassAt: string | null;
          /** WatcherHeartbeat's lastProgressAt, or null from a watcher that writes none. */
          lastProgressAt: string | null;
      }
    | {
          found: false;
          /** Why, as a code, so a caller can word it without the path. */
          cause: HeartbeatProblem;
          /** Why, naming the file's absolute path: for the watcher's own healthcheck, never for an owner command's output. */
          reason: string;
      };

/** Why `status/watcher.json` gives no heartbeat. */
export type HeartbeatProblem = 'absent' | 'unreadable' | 'not-json' | 'no-heartbeat-at' | 'bad-pass-started-at';

/** What each HeartbeatProblem means, with the file named relative to the data root, as owner output may show it. */
export const HEARTBEAT_PROBLEM_TEXT: Record<HeartbeatProblem, string> = {
    absent: "status/watcher.json doesn't exist",
    unreadable: "status/watcher.json can't be read",
    'not-json': "status/watcher.json isn't valid JSON",
    'no-heartbeat-at': 'status/watcher.json has no valid heartbeatAt',
    'bad-pass-started-at': 'status/watcher.json has an invalid passStartedAt',
};

const PASS_RESULT_RE = /^(committed|locked|failed|library-empty|data-root-(unset|unavailable|unwritable|uninitialized))$/;

/** Read the heartbeat under `root`. Never throws. */
export async function watcherHeartbeatAge(root: string, clock: () => number = Date.now): Promise<HeartbeatAge> {
    const file = watcherStatusFile(root);
    let heartbeat: unknown;
    try {
        heartbeat = await readJsonFile(file);
    } catch (error) {
        if (error instanceof CorruptDocumentError) return { found: false, cause: 'not-json', reason: error.message };
        return { found: false, cause: 'unreadable', reason: `${file} can't be read: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (heartbeat === null) return { found: false, cause: 'absent', reason: `${file} doesn't exist` };
    const at = isRecord(heartbeat) ? heartbeat.heartbeatAt : undefined;
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return { found: false, cause: 'no-heartbeat-at', reason: `${file} has no valid heartbeatAt` };
    const started = isRecord(heartbeat) ? heartbeat.passStartedAt : undefined;
    if (started !== undefined && started !== null && (typeof started !== 'string' || Number.isNaN(Date.parse(started)))) {
        return { found: false, cause: 'bad-pass-started-at', reason: `${file} has an invalid passStartedAt` };
    }
    const now = clock();
    const libraryEmpty = isRecord(heartbeat) && heartbeat.lastPassResult === 'library-empty';
    const result = isRecord(heartbeat) ? heartbeat.lastPassResult : undefined;
    const lastAt = isRecord(heartbeat) ? heartbeat.lastPassAt : undefined;
    const progress = isRecord(heartbeat) ? heartbeat.lastProgressAt : undefined;
    return {
        found: true,
        heartbeatAt: at,
        ageMs: now - Date.parse(at),
        passRunningMs: typeof started === 'string' ? now - Date.parse(started) : null,
        libraryEmpty,
        lastPassResult: typeof result === 'string' && PASS_RESULT_RE.test(result) ? (result as PassResult) : null,
        lastPassAt: typeof lastAt === 'string' && !Number.isNaN(Date.parse(lastAt)) ? lastAt : null,
        lastProgressAt: typeof progress === 'string' && !Number.isNaN(Date.parse(progress)) ? progress : null,
    };
}

/**
 * #14 and #17: a heartbeat more than this old, or stamped more than this
 * ahead of the reader's clock, is stale. `photos status --check` fails on
 * it, and the curator's Inbox warns that new photographs won't appear until
 * the watcher runs. Ten of the watcher's 30 s beats, so a slow pass or a
 * restart doesn't page; the container's own healthcheck stays at 120 s.
 */
export const WATCHER_STALE_AFTER_MS = 5 * 60_000;

/**
 * v2.0.0: `photos status --check` fails once no pass has got through for
 * this long, though the heartbeat still beats: a registry that stays locked,
 * or one pass that never ends. Three of watcherStep.ts's 10-minute periodic
 * passes, so an idle watcher misses two before it counts, and a long first
 * scan of a big library has room. The healthcheck's own limit on one pass is
 * WATCHER_PASS_LIMIT_MS, also 30 minutes.
 */
export const WATCHER_STALLED_AFTER_MS = 30 * 60_000;

/** Whether a heartbeat this old (negative: stamped ahead of the clock) is stale. */
export function heartbeatStale(ageMs: number): boolean {
    return ageMs > WATCHER_STALE_AFTER_MS || ageMs < -WATCHER_STALE_AFTER_MS;
}

/** The watcher's healthcheck passes while its heartbeat is at most this old, four of the 30 s beats. */
export const WATCHER_HEALTHY_WITHIN_MS = 120_000;

/** The healthcheck fails once one identity pass has run longer than this. */
export const WATCHER_PASS_LIMIT_MS = 30 * 60_000;

/**
 * The watcher container's healthcheck. Healthy while the heartbeat in the
 * data root is at most `maxAgeMs` old, and stamped no more than `maxAgeMs`
 * after this clock, and no identity pass has run longer than `passLimitMs`.
 * The watcher writes the heartbeat every 30 s while the data root exists and
 * is writable, initialized or not, so an unset, missing, or unwritable data
 * root reads as unhealthy too. So does a last pass that refused an empty
 * library while the registry has present photos, such as an unmounted NAS.
 */
export async function checkWatcherHealth(
    { clock = Date.now, maxAgeMs = WATCHER_HEALTHY_WITHIN_MS, passLimitMs = WATCHER_PASS_LIMIT_MS }: { clock?: () => number; maxAgeMs?: number; passLimitMs?: number } = {},
): Promise<{ healthy: boolean; message: string }> {
    const root = dataRoot();
    if (root === null) return { healthy: false, message: 'PHOTOGRAPHY_DATA_DIR is not set, so the watcher writes no heartbeat.' };
    const age = await watcherHeartbeatAge(root, clock);
    if (!age.found) return { healthy: false, message: `No heartbeat: ${age.reason}.` };
    const seconds = Math.round(Math.abs(age.ageMs) / 1000);
    if (age.ageMs > maxAgeMs) return { healthy: false, message: `The last heartbeat was ${seconds} s ago, at ${age.heartbeatAt}.` };
    // Writer and checker share the container's clock, so this follows a clock step back, after which a dead watcher would look alive.
    if (age.ageMs < -maxAgeMs) return { healthy: false, message: `The last heartbeat is stamped ${seconds} s after this clock, at ${age.heartbeatAt}.` };
    if (age.passRunningMs !== null && age.passRunningMs > passLimitMs) {
        return { healthy: false, message: `The identity pass under way has run for ${Math.round(age.passRunningMs / 60_000)} min, longer than ${Math.round(passLimitMs / 60_000)} min.` };
    }
    if (age.libraryEmpty) {
        return { healthy: false, message: 'The last pass found no photo in the library while the registry has present ones, so it marked nothing missing. Check the mount and PHOTOGRAPHY_LIBRARY_DIR.' };
    }
    return { healthy: true, message: `The last heartbeat was ${age.ageMs < 0 ? 0 : seconds} s ago.` };
}

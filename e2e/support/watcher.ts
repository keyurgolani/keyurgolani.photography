import { writeWatcherHeartbeat } from '../../lib/identity/heartbeat';

/**
 * The watcher's heartbeat for an e2e data root, every 30 s as the watcher
 * writes it, so the curator's Inbox shows no watcher warning (#14) through
 * a run longer than its 5 minutes. Unref'd, so it never holds the worker
 * open. stop() ends it, and must run before the data root is removed;
 * start() beats at once and starts it again.
 */
export interface WatcherBeat {
    start(): Promise<void>;
    stop(): void;
}

export async function keepWatcherAlive(root: string): Promise<WatcherBeat> {
    let timer: ReturnType<typeof setInterval> | null = null;
    const beat = () => {
        const now = new Date().toISOString();
        return writeWatcherHeartbeat(root, { pid: process.pid, hostname: 'e2e', lastPassAt: now, lastPassResult: 'committed', passStartedAt: null, heartbeatAt: now, lastProgressAt: now, legacyDerivatives: false });
    };
    const handle: WatcherBeat = {
        async start() {
            handle.stop();
            await beat();
            // A later beat that fails leaves the last one, which the Inbox then warns about once it's 5 minutes old.
            timer = setInterval(() => void beat().catch(() => undefined), 30_000);
            timer.unref();
        },
        stop() {
            if (timer !== null) clearInterval(timer);
            timer = null;
        },
    };
    await handle.start();
    return handle;
}

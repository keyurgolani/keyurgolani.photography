// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTsx } from '../../../test/helpers/runTsx';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { checkWatcherHealth, watcherStatusFile, writeWatcherHeartbeat, WATCHER_HEALTHY_WITHIN_MS, WATCHER_PASS_LIMIT_MS } from '../heartbeat';
import { identityStatus } from '../status';

const AT = Date.parse('2026-05-01T12:00:00.000Z');
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function dataRoot(state: 'ready' | 'uninitialized' = 'ready'): TempDataRoot {
    const data = createTempDataRoot({ state });
    cleanups.push(() => data.cleanup());
    return data;
}

function beat(root: string, at = AT, passStartedAt: number | null = null): Promise<void> {
    return writeWatcherHeartbeat(root, {
        pid: 7,
        hostname: 'watcher-host',
        lastPassAt: null,
        lastPassResult: null,
        passStartedAt: passStartedAt === null ? null : new Date(passStartedAt).toISOString(),
        heartbeatAt: new Date(at).toISOString(),
    });
}

function writeStatus(root: string, text: string): string {
    const file = watcherStatusFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
}

describe('checkWatcherHealth', () => {
    it('is healthy while the heartbeat the watcher writes is at most 120 s old, on an initialized data root or not', async () => {
        for (const state of ['ready', 'uninitialized'] as const) {
            const data = dataRoot(state);
            await beat(data.root);
            expect(await checkWatcherHealth({ clock: () => AT + 30_000 }), state).toEqual({ healthy: true, message: 'The last heartbeat was 30 s ago.' });
            expect((await checkWatcherHealth({ clock: () => AT + WATCHER_HEALTHY_WITHIN_MS })).healthy, state).toBe(true);
        }
    });

    it('is unhealthy once the heartbeat is older than 120 s, and says when it was', async () => {
        const data = dataRoot();
        await beat(data.root);
        expect(WATCHER_HEALTHY_WITHIN_MS).toBe(120_000);
        expect(await checkWatcherHealth({ clock: () => AT + WATCHER_HEALTHY_WITHIN_MS + 1 })).toEqual({
            healthy: false,
            message: 'The last heartbeat was 120 s ago, at 2026-05-01T12:00:00.000Z.',
        });
        expect(await checkWatcherHealth({ clock: () => AT + 600_000, maxAgeMs: 900_000 })).toEqual({ healthy: true, message: 'The last heartbeat was 600 s ago.' });
    });

    it('takes a heartbeat stamped up to 120 s after its own clock as fresh, and one stamped later as unhealthy', async () => {
        const data = dataRoot();
        await beat(data.root, AT + 5_000);
        expect(await checkWatcherHealth({ clock: () => AT })).toEqual({ healthy: true, message: 'The last heartbeat was 0 s ago.' });
        await beat(data.root, AT + WATCHER_HEALTHY_WITHIN_MS);
        expect((await checkWatcherHealth({ clock: () => AT })).healthy).toBe(true);

        // After the clock steps back, a watcher that died just before the step would otherwise stay healthy until the clock caught up.
        await beat(data.root, AT + WATCHER_HEALTHY_WITHIN_MS + 1_000);
        expect(await checkWatcherHealth({ clock: () => AT })).toEqual({
            healthy: false,
            message: 'The last heartbeat is stamped 121 s after this clock, at 2026-05-01T12:02:01.000Z.',
        });
    });

    it('is unhealthy once the identity pass under way has run longer than 30 minutes, even with a fresh heartbeat', async () => {
        const data = dataRoot();
        expect(WATCHER_PASS_LIMIT_MS).toBe(30 * 60_000);
        await beat(data.root, AT, AT - WATCHER_PASS_LIMIT_MS);
        expect(await checkWatcherHealth({ clock: () => AT })).toEqual({ healthy: true, message: 'The last heartbeat was 0 s ago.' });

        await beat(data.root, AT, AT - WATCHER_PASS_LIMIT_MS - 60_000);
        expect(await checkWatcherHealth({ clock: () => AT })).toEqual({
            healthy: false,
            message: 'The identity pass under way has run for 31 min, longer than 30 min.',
        });
        expect((await checkWatcherHealth({ clock: () => AT, passLimitMs: 60 * 60_000 })).healthy).toBe(true);
    });

    it('reads a heartbeat from before passStartedAt existed as no pass running, and refuses a malformed one', async () => {
        const data = dataRoot();
        const file = writeStatus(data.root, JSON.stringify({ pid: 7, hostname: 'h', lastPassAt: null, lastPassResult: null, heartbeatAt: new Date(AT).toISOString() }));
        expect(await checkWatcherHealth({ clock: () => AT })).toEqual({ healthy: true, message: 'The last heartbeat was 0 s ago.' });

        for (const started of ['"soon"', '12']) {
            writeStatus(data.root, `{"heartbeatAt": "${new Date(AT).toISOString()}", "passStartedAt": ${started}}`);
            expect(await checkWatcherHealth({ clock: () => AT }), started).toEqual({ healthy: false, message: `No heartbeat: ${file} has an invalid passStartedAt.` });
        }
    });

    it('is unhealthy with no data root, no heartbeat yet, or a heartbeat it cannot use', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        expect(await checkWatcherHealth({ clock: () => AT })).toEqual({ healthy: false, message: 'PHOTOGRAPHY_DATA_DIR is not set, so the watcher writes no heartbeat.' });
        vi.unstubAllEnvs();

        const data = dataRoot();
        const file = watcherStatusFile(data.root);
        expect(await checkWatcherHealth({ clock: () => AT })).toEqual({ healthy: false, message: `No heartbeat: ${file} doesn't exist.` });

        for (const [text, reason] of [
            ['{"heartbeatAt": ', 'is not a valid document'],
            ['["2026-05-01T12:00:00.000Z"]', 'has no valid heartbeatAt'],
            ['{"heartbeatAt": "yesterday"}', 'has no valid heartbeatAt'],
            ['{"pid": 7}', 'has no valid heartbeatAt'],
        ]) {
            writeStatus(data.root, text);
            const check = await checkWatcherHealth({ clock: () => AT });
            expect(check.healthy, text).toBe(false);
            expect(check.message, text).toContain(`No heartbeat: ${file} ${reason}`);
        }
    });

    it('exits 0 from the healthcheck script on a fresh heartbeat, and 1 with the reason otherwise', async () => {
        const data = dataRoot('uninitialized');
        const missing = await runTsx('scripts/watcherHealth.ts', [], { env: { PHOTOGRAPHY_DATA_DIR: data.root } });
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain(`[watcher-health] No heartbeat: ${watcherStatusFile(data.root)} doesn't exist.`);

        await beat(data.root, Date.now());
        const fresh = await runTsx('scripts/watcherHealth.ts', [], { env: { PHOTOGRAPHY_DATA_DIR: data.root } });
        expect(fresh.code).toBe(0);
        expect(fresh.stdout).toMatch(/^\[watcher-health\] The last heartbeat was \d+ s ago\.$/m);

        await beat(data.root, Date.now() - 10 * 60_000);
        const stale = await runTsx('scripts/watcherHealth.ts', [], { env: { PHOTOGRAPHY_DATA_DIR: data.root } });
        expect(stale.code).toBe(1);
        expect(stale.stderr).toMatch(/^\[watcher-health\] The last heartbeat was \d+ s ago, at /m);
    }, 120_000);
});

describe('identityStatus', () => {
    it("reports the heartbeat's time and age, and null when the heartbeat is missing or unusable", async () => {
        const data = dataRoot();
        expect((await identityStatus({ clock: () => AT })).watcher).toBeNull();

        await beat(data.root);
        expect((await identityStatus({ clock: () => AT + 45_400 })).watcher).toEqual({ heartbeatAt: '2026-05-01T12:00:00.000Z', ageSeconds: 45 });
        expect((await identityStatus({ clock: () => AT - 9_000 })).watcher).toEqual({ heartbeatAt: '2026-05-01T12:00:00.000Z', ageSeconds: 0 });

        writeStatus(data.root, '{"heartbeatAt": ');
        expect((await identityStatus({ clock: () => AT })).watcher).toBeNull();
        writeStatus(data.root, '{"heartbeatAt": 12}');
        expect((await identityStatus({ clock: () => AT })).watcher).toBeNull();
    });
});

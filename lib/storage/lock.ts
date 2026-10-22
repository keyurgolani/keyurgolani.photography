import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataRoot } from './config';
import { hasErrorCode, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './fsx';

/** The contents of `locks/<name>.lock`. */
export interface LockRecord {
    owner: string;
    hostname: string;
    pid: number;
    acquiredAt: string;
    heartbeatAt: string;
    /** The holder's lease, so a waiter with a shorter one never breaks it early. */
    leaseMs: number;
}

export interface LockTakeover {
    previousOwner: string;
    previousAcquiredAt: string;
}

export interface LockContext {
    /** Aborted when a renewal finds the lock gone or held by another owner. */
    signal: AbortSignal;
    /** Set when this holder replaced an expired lease. */
    takeover: LockTakeover | null;
    /** The lock's name, so code handed this hold can check it is the one it needs. */
    name: string;
    /** The data root whose `locks/` holds it. */
    root: string;
    /**
     * Re-read the lock file now: true while it is still this holder's. A
     * waiter that broke an expired lease since the last renewal makes it
     * false before `signal` knows.
     */
    isHeld(): Promise<boolean>;
}

export interface LockHooks {
    /** Runs before each renewal. A test can hold it to simulate a paused holder. */
    beforeRenew?(): void | Promise<void>;
    /** Runs after a waiter reads an expired lease and before it renames it away. */
    beforeBreak?(lockPath: string): void | Promise<void>;
    /** Runs after a releasing holder finds the lock still its own and before it renames it away. */
    beforeRelease?(lockPath: string): void | Promise<void>;
}

export interface LockOptions {
    /** How long a heartbeat stays valid. Renewed every leaseMs / 4. */
    leaseMs?: number;
    /** How long to wait for a live holder. 0 tries once. */
    waitMs?: number;
    /** How often a waiter checks again. */
    pollMs?: number;
    /** The data root holding `locks/`. Defaults to dataRoot(). */
    root?: string;
    clock?: () => number;
    sleep?: (ms: number) => Promise<void>;
    hooks?: LockHooks;
}

export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_WAIT_MS = 10_000;
export const LOCK_POLL_MS = 250;
/**
 * The longest lease a holder may take or a record may claim. A record asking
 * for more is judged by this, so a bad record can't hold the lock forever.
 */
export const MAX_LEASE_MS = 10 * 60_000;

const LOCK_NAME = /^[a-z0-9][a-z0-9-]*$/;

export class LockTimeoutError extends Error {
    readonly lockName: string;
    /** The holder's record when the wait ended, or null if it couldn't be read. */
    readonly holder: LockRecord | null;

    constructor(lockName: string, holder: LockRecord | null, waitedMs: number) {
        const who = holder ? `${holder.owner} (pid ${holder.pid} on ${holder.hostname}, since ${holder.acquiredAt})` : 'another process';
        super(`The ${lockName} lock is held by ${who}. Gave up after ${waitedMs} ms.`);
        this.name = 'LockTimeoutError';
        this.lockName = lockName;
        this.holder = holder;
    }
}

export class LockLostError extends Error {
    readonly lockName: string;
    /** Whoever holds the lock now, if anyone. */
    readonly current: LockRecord | null;

    constructor(lockName: string, current: LockRecord | null) {
        super(
            current
                ? `The ${lockName} lock was taken over by ${current.owner} (pid ${current.pid} on ${current.hostname}).`
                : `The ${lockName} lock file disappeared while it was held.`,
        );
        this.name = 'LockLostError';
        this.lockName = lockName;
        this.current = current;
    }
}

interface Observed {
    raw: string;
    record: LockRecord | null;
    ino: number;
    dev: number;
    mtimeMs: number;
}

function parseRecord(raw: string): LockRecord | null {
    try {
        const value = JSON.parse(raw) as Partial<LockRecord>;
        if (
            typeof value.owner !== 'string' ||
            typeof value.hostname !== 'string' ||
            typeof value.pid !== 'number' ||
            typeof value.acquiredAt !== 'string' ||
            typeof value.heartbeatAt !== 'string'
        ) {
            return null;
        }
        return value as LockRecord;
    } catch {
        return null;
    }
}

/** Read a lock file and the inode it came from. Null when there is none. */
async function observe(file: string): Promise<Observed | null> {
    let handle: fs.promises.FileHandle;
    try {
        handle = await fs.promises.open(file, 'r');
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return null;
        throw error;
    }
    try {
        const stat = await handle.stat();
        const raw = await handle.readFile('utf8');
        return { raw, record: parseRecord(raw), ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs };
    } finally {
        await handle.close();
    }
}

async function writeRecord(handle: fs.promises.FileHandle, record: LockRecord): Promise<void> {
    const data = Buffer.from(`${JSON.stringify(record)}\n`);
    await handle.write(data, 0, data.length, 0);
    await handle.truncate(data.length);
    await handle.sync();
}

/**
 * Run `fn` while holding `locks/<name>.lock` in the data root.
 *
 * The lock file is created with O_EXCL and holds the holder's record, which
 * is renewed every `leaseMs / 4`. A waiter polls every 250 ms and throws
 * LockTimeoutError with the holder's record after `waitMs`. A lease whose
 * heartbeat is older than its `leaseMs`, capped at MAX_LEASE_MS, or that far
 * ahead of the waiter's clock, is renamed to `<name>.lock.stale-<uuid>` and
 * re-read: if it changed in the meantime it is linked back and the waiter
 * keeps waiting, otherwise the waiter replaces it and gets `takeover`. A
 * lock path that blocks the create but can't be read, such as a dangling
 * symlink, counts as held, so the wait still ends. A holder whose renewal
 * finds another owner aborts `fn` through `signal`. There are no PID checks,
 * so this works across hosts.
 */
export async function withLock<T>(name: string, options: LockOptions, fn: (context: LockContext) => Promise<T>): Promise<T> {
    if (!LOCK_NAME.test(name)) throw new TypeError(`Invalid lock name: ${name}`);
    const {
        leaseMs = DEFAULT_LEASE_MS,
        waitMs = DEFAULT_WAIT_MS,
        pollMs = LOCK_POLL_MS,
        clock = Date.now,
        sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        hooks,
    } = options;
    if (!(leaseMs > 0 && leaseMs <= MAX_LEASE_MS)) throw new RangeError(`leaseMs must be above 0 and at most ${MAX_LEASE_MS}, got ${leaseMs}`);
    const root = options.root ?? dataRoot();
    if (root === null) throw new Error(`Can't take the ${name} lock: PHOTOGRAPHY_DATA_DIR is not set.`);

    const lockDir = path.join(/*turbopackIgnore: true*/ root, 'locks');
    const lockPath = path.join(/*turbopackIgnore: true*/ lockDir, `${name}.lock`);
    try {
        // Never create the data root itself: a missing one is an unmounted volume, not an empty one.
        await fs.promises.mkdir(lockDir, { mode: PRIVATE_DIR_MODE });
    } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
    }

    const iso = (ms: number) => new Date(ms).toISOString();

    function isExpired(observed: Observed, now: number): boolean {
        // An unparseable record is a holder that crashed mid-write, or one writing now, so it is judged by its mtime.
        const claimed = observed.record?.leaseMs;
        const lease = typeof claimed === 'number' && claimed > 0 ? Math.min(claimed, MAX_LEASE_MS) : leaseMs;
        const heartbeat = observed.record ? Date.parse(observed.record.heartbeatAt) : Number.NaN;
        const age = now - (Number.isNaN(heartbeat) ? observed.mtimeMs : heartbeat);
        // A live holder renews with its current time, so a heartbeat more than a lease ahead means the
        // clock stepped back. Without this, a crashed holder's lock would stay held until the clock caught up.
        return age > lease || age < -lease;
    }

    /** Move an expired lease aside. Returns what it replaced, or null if it changed and was put back. */
    async function breakExpired(observed: Observed): Promise<LockTakeover | null> {
        await hooks?.beforeBreak?.(lockPath);
        const stalePath = `${lockPath}.stale-${randomUUID()}`;
        try {
            await fs.promises.rename(lockPath, stalePath);
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) return null; // Released or broken by someone else
            throw error;
        }
        const moved = await observe(stalePath);
        if (!moved || moved.raw !== observed.raw || moved.ino !== observed.ino || moved.dev !== observed.dev) {
            // It was renewed or replaced after we read it, so it isn't ours to break. Put it back.
            // link() never overwrites. If a third process created a lock in this gap, that one stands,
            // and the holder we displaced aborts at its next renewal. Until then the registry's
            // compare-and-swap still stops a second writer: writeVersionedDocument() claims each
            // version with a link() that never replaces a file, so only one of two writers at a version stores it.
            try {
                await fs.promises.link(stalePath, lockPath);
            } catch (error) {
                if (!hasErrorCode(error, 'EEXIST')) throw error;
            }
            await fs.promises.rm(stalePath, { force: true });
            return null;
        }
        await fs.promises.rm(stalePath, { force: true });
        return {
            previousOwner: observed.record?.owner ?? 'unknown',
            previousAcquiredAt: observed.record?.acquiredAt ?? iso(observed.mtimeMs),
        };
    }

    /** Create the lock file with O_EXCL. Null when it already exists. */
    async function tryCreate(): Promise<{ handle: fs.promises.FileHandle; record: LockRecord } | null> {
        let created: fs.promises.FileHandle;
        try {
            created = await fs.promises.open(lockPath, 'wx', PRIVATE_FILE_MODE);
        } catch (error) {
            if (hasErrorCode(error, 'EEXIST')) return null;
            throw error;
        }
        const now = iso(clock());
        const fresh: LockRecord = { owner: randomUUID(), hostname: os.hostname(), pid: process.pid, acquiredAt: now, heartbeatAt: now, leaseMs };
        try {
            await writeRecord(created, fresh);
        } catch (error) {
            await created.close();
            await fs.promises.rm(lockPath, { force: true });
            throw error;
        }
        return { handle: created, record: fresh };
    }

    const started = clock();
    let brokeLease: LockTakeover | null = null;
    let acquired: { handle: fs.promises.FileHandle; record: LockRecord } | null = null;
    let unreadable = 0;
    for (;;) {
        acquired = await tryCreate();
        if (acquired) break;

        const observed = await observe(lockPath);
        if (observed) {
            unreadable = 0;
            if (isExpired(observed, clock())) {
                const replaced = await breakExpired(observed);
                if (replaced) {
                    // Create it again right away. Another waiter may still win, and then we wait on that one.
                    brokeLease = replaced;
                    continue;
                }
            }
        } else if (++unreadable === 1) {
            // Most likely released between our create and our read, so try again at once. Something that
            // blocks the create but can't be read, such as a dangling symlink, counts as a holder from the
            // second try, so the wait still ends.
            continue;
        }
        brokeLease = null;
        const waited = clock() - started;
        if (waited >= waitMs) throw new LockTimeoutError(name, observed?.record ?? null, waited);
        await sleep(Math.min(pollMs, Math.max(0, waitMs - waited)));
    }

    const takeover = brokeLease;
    const { handle: held, record: ownRecord } = acquired;
    const ownStat = await held.stat();
    const controller = new AbortController();
    let renewing: Promise<void> | null = null;

    async function ownership(): Promise<'ours' | 'missing' | 'other'> {
        try {
            const stat = await fs.promises.stat(lockPath);
            return stat.ino === ownStat.ino && stat.dev === ownStat.dev ? 'ours' : 'other';
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) return 'missing';
            throw error;
        }
    }

    /**
     * A waiter that misjudged our lease renames the file away for a moment
     * before linking it back, so a missing file is checked a few more times
     * before it counts as lost.
     */
    async function stillOurs(): Promise<boolean> {
        for (let attempt = 1; ; attempt++) {
            const state = await ownership();
            if (state !== 'missing' || attempt === 4) return state === 'ours';
            await sleep(10 * attempt);
        }
    }

    async function renew(): Promise<void> {
        try {
            await hooks?.beforeRenew?.();
            if (controller.signal.aborted) return;
            if (!(await stillOurs())) {
                const current = await observe(lockPath);
                controller.abort(new LockLostError(name, current?.record ?? null));
                return;
            }
            ownRecord.heartbeatAt = iso(clock());
            await writeRecord(held, ownRecord);
        } catch (error) {
            // A heartbeat we can't write is a lease we can't keep.
            if (!controller.signal.aborted) controller.abort(error);
        }
    }

    /**
     * Remove the lock file only if it is still ours. Deleting by path after the
     * check would delete a lock that replaced ours in between, so this renames
     * the file to a unique name first, checks that what it moved is ours, and
     * deletes only that. Anything else is linked back, as breakExpired() does.
     */
    async function release(): Promise<void> {
        // A lost lock now belongs to someone else.
        if (!(await stillOurs())) return;
        await hooks?.beforeRelease?.(lockPath);
        const releasing = `${lockPath}.release-${randomUUID()}`;
        try {
            await fs.promises.rename(lockPath, releasing);
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) return; // Broken and removed by a waiter just now
            throw error;
        }
        const moved = await fs.promises.stat(releasing);
        if (moved.ino !== ownStat.ino || moved.dev !== ownStat.dev) {
            try {
                await fs.promises.link(releasing, lockPath);
            } catch (error) {
                if (!hasErrorCode(error, 'EEXIST')) throw error;
            }
        }
        await fs.promises.rm(releasing, { force: true });
    }

    const timer = setInterval(() => {
        if (renewing || controller.signal.aborted) return;
        renewing = renew().finally(() => {
            renewing = null;
        });
    }, Math.max(1, Math.floor(leaseMs / 4)));

    try {
        return await fn({ signal: controller.signal, takeover, name, root, isHeld: stillOurs });
    } finally {
        clearInterval(timer);
        await renewing;
        try {
            await release();
        } finally {
            await held.close();
        }
    }
}

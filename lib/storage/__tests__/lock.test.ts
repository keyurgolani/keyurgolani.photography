// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTsx } from '../../../test/helpers/runTsx';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { LockLostError, LockTimeoutError, MAX_LEASE_MS, withLock, type LockContext, type LockRecord } from '../lock';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let data: TempDataRoot;
let lockPath: string;

beforeEach(() => {
    data = createTempDataRoot();
    lockPath = data.file('locks', 'registry.lock');
});

afterEach(async () => {
    await data.cleanup();
});

function readRecord(): LockRecord {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockRecord;
}

function writeStaleRecord(record: Partial<LockRecord>): LockRecord {
    const stale: LockRecord = {
        owner: 'crashed-owner',
        hostname: 'old-host',
        pid: 999_999,
        acquiredAt: '2026-01-01T00:00:00.000Z',
        heartbeatAt: '2026-01-01T00:00:00.000Z',
        leaseMs: 60_000,
        ...record,
    };
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify(stale)}\n`);
    return stale;
}

function lockDirEntries(): string[] {
    return fs.existsSync(path.dirname(lockPath)) ? fs.readdirSync(path.dirname(lockPath)).sort() : [];
}

/** A promise plus the function that resolves it. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('withLock', () => {
    it('holds an O_EXCL lock file with the holder record and removes it on release', async () => {
        const result = await withLock('registry', { root: data.root }, async ({ signal, takeover }) => {
            const record = readRecord();
            expect(record.owner).toMatch(UUID);
            expect(record).toMatchObject({ hostname: os.hostname(), pid: process.pid, leaseMs: 60_000 });
            expect(record.heartbeatAt).toBe(record.acquiredAt);
            expect(signal.aborted).toBe(false);
            expect(takeover).toBeNull();
            return 42;
        });
        expect(result).toBe(42);
        expect(lockDirEntries()).toEqual([]);
    });

    it('names the lock and its data root in the hold it passes, so a callee can check it', async () => {
        const hold = await withLock('registry', { root: data.root }, async ({ name, root }) => ({ name, root }));
        expect(hold).toEqual({ name: 'registry', root: data.root });
    });

    it('creates locks/ and the lock file for their owner only', async () => {
        const modes = await withLock('registry', { root: data.root }, async () => ({
            dir: fs.statSync(path.dirname(lockPath)).mode & 0o777,
            file: fs.statSync(lockPath).mode & 0o777,
        }));
        expect(modes).toEqual({ dir: 0o700, file: 0o600 });
    });

    it('releases the lock when fn throws', async () => {
        await expect(withLock('registry', { root: data.root }, async () => {
            throw new Error('fn failed');
        })).rejects.toThrow('fn failed');
        expect(lockDirEntries()).toEqual([]);
    });

    it('makes a second holder wait until the first releases', async () => {
        const events: string[] = [];
        const entered = deferred();
        const first = withLock('registry', { root: data.root }, async () => {
            events.push('first enter');
            entered.resolve();
            await sleep(300);
            events.push('first exit');
        });
        await entered.promise;
        const second = withLock('registry', { root: data.root, waitMs: 5_000 }, async ({ takeover }) => {
            events.push('second enter');
            return takeover;
        });
        const [, takeover] = await Promise.all([first, second]);
        expect(events).toEqual(['first enter', 'first exit', 'second enter']);
        expect(takeover).toBeNull();
    });

    it('with waitMs 0 throws LockTimeoutError at once, carrying the holder record', async () => {
        const entered = deferred();
        const release = deferred();
        const holder = withLock('registry', { root: data.root }, async () => {
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        const holderRecord = readRecord();

        // At once means without waiting. The waiter only waits through the injected sleep, so
        // counting those calls, rather than timing the attempt, holds on a busy machine too. The
        // clock stands still, so no time passes even on a slow attempt, and a waiter that kept
        // polling would fail here instead of spinning.
        const now = Date.now();
        const waits: number[] = [];
        const error = await withLock('registry', {
            root: data.root,
            waitMs: 0,
            clock: () => now,
            sleep: async (ms) => {
                waits.push(ms);
                if (waits.length > 3) throw new Error('the waiter kept waiting');
            },
        }, async () => 'never').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(LockTimeoutError);
        expect((error as LockTimeoutError).holder).toEqual(holderRecord);
        expect(waits).toEqual([]);

        release.resolve();
        await holder;
    });

    it('never breaks a live lease: a waiter times out while the holder keeps renewing', async () => {
        // One clock for both, and only the waiter moves it. Each time the
        // waiter sleeps, it moves the clock on by its poll interval and then
        // waits for the holder's next renewal, so however late a loaded
        // machine runs the renewal timer, the waiter judges a lease the holder
        // is keeping alive.
        let now = Date.now();
        const clock = () => now;
        const heartbeat = () => {
            try {
                return Date.parse(readRecord().heartbeatAt);
            } catch {
                return Number.NaN; // Read mid-renewal
            }
        };
        const renewedSince = async (ms: number) => {
            while (!(heartbeat() >= ms)) await sleep(5);
        };
        const entered = deferred();
        const done = deferred();
        let aborted = false;
        const holder = withLock('registry', { root: data.root, leaseMs: 200, clock }, async ({ signal }) => {
            entered.resolve();
            await done.promise;
            aborted = signal.aborted;
        });
        await entered.promise;
        const before = readRecord();

        // The wait outlasts the holder's lease three times over.
        const error = await withLock('registry', {
            root: data.root,
            leaseMs: 200,
            waitMs: 600,
            pollMs: 50,
            clock,
            sleep: async (ms) => {
                now += ms;
                await renewedSince(now);
            },
        }, async () => 'never').catch((caught: unknown) => caught);
        const after = readRecord();
        done.resolve();
        await holder;

        expect(error).toBeInstanceOf(LockTimeoutError);
        expect(after.owner).toBe(before.owner);
        expect(Date.parse(after.heartbeatAt)).toBeGreaterThan(Date.parse(before.heartbeatAt));
        expect(aborted).toBe(false);
        expect(lockDirEntries()).toEqual([]);
    });

    it("counts a lock path it can neither create nor read, such as a dangling symlink, as held, and times out instead of spinning", async () => {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.symlinkSync(path.join(data.root, 'nowhere'), lockPath);
        let now = Date.now();
        const waits: number[] = [];
        const error = await withLock('registry', {
            root: data.root,
            waitMs: 600,
            pollMs: 50,
            clock: () => now,
            sleep: async (ms) => {
                waits.push(ms);
                now += ms;
                if (waits.length > 100) throw new Error('the waiter kept waiting');
            },
        }, async () => 'never').catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(LockTimeoutError);
        expect((error as LockTimeoutError).holder).toBeNull();
        expect(waits.reduce((total, ms) => total + ms, 0)).toBe(600);
        await expect(withLock('registry', { root: data.root, waitMs: 0 }, async () => 'never')).rejects.toBeInstanceOf(LockTimeoutError);
    });

    it('tries again at once, without waiting, when the lock is released between its create and its read', async () => {
        const realOpen = fs.promises.open.bind(fs.promises);
        let opens = 0;
        const open = vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: Parameters<typeof fs.promises.open>) => {
            opens++;
            if (opens === 1) throw Object.assign(new Error(`EEXIST: file already exists, open '${String(args[0])}'`), { code: 'EEXIST' });
            if (opens === 2) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${String(args[0])}'`), { code: 'ENOENT' });
            return realOpen(...args);
        }) as typeof fs.promises.open);
        const waits: number[] = [];
        try {
            const result = await withLock('registry', { root: data.root, waitMs: 0, sleep: async (ms) => { waits.push(ms); } }, async () => 'acquired');
            expect(result).toBe('acquired');
        } finally {
            open.mockRestore();
        }
        expect(waits).toEqual([]);
    });

    it('judges a lease by the holder\'s leaseMs, not the waiter\'s', async () => {
        writeStaleRecord({ heartbeatAt: new Date(Date.now() - 5_000).toISOString(), leaseMs: 60_000 });
        await expect(withLock('registry', { root: data.root, leaseMs: 1_000, waitMs: 0 }, async () => 'never'))
            .rejects.toBeInstanceOf(LockTimeoutError);
        expect(readRecord().owner).toBe('crashed-owner');
    });

    it('caps the lease a record can claim, so a huge leaseMs still expires', async () => {
        const stale = writeStaleRecord({ heartbeatAt: new Date(Date.now() - MAX_LEASE_MS - 1_000).toISOString(), leaseMs: Number.MAX_SAFE_INTEGER });
        const takeover = await withLock('registry', { root: data.root, waitMs: 0 }, async (context) => context.takeover);
        expect(takeover).toEqual({ previousOwner: 'crashed-owner', previousAcquiredAt: stale.acquiredAt });
    });

    it('breaks a lease whose heartbeat is more than a lease ahead, as after the clock stepped back, and keeps one less ahead', async () => {
        writeStaleRecord({ heartbeatAt: new Date(Date.now() + 30_000).toISOString(), leaseMs: 60_000 });
        await expect(withLock('registry', { root: data.root, waitMs: 0 }, async () => 'never')).rejects.toBeInstanceOf(LockTimeoutError);

        writeStaleRecord({ heartbeatAt: new Date(Date.now() + 2 * 60_000).toISOString(), leaseMs: 60_000 });
        const takeover = await withLock('registry', { root: data.root, waitMs: 0 }, async (context) => context.takeover);
        expect(takeover?.previousOwner).toBe('crashed-owner');
    });

    it('refuses a lease of 0 or one above MAX_LEASE_MS', async () => {
        for (const leaseMs of [0, -1, MAX_LEASE_MS + 1, Number.NaN]) {
            await expect(withLock('registry', { root: data.root, leaseMs }, async () => 'never'), String(leaseMs)).rejects.toThrow(RangeError);
        }
        expect(lockDirEntries()).toEqual([]);
    });

    it('releases by moving its own file aside first, so a lock that replaced it after the check survives', async () => {
        const replacement: LockRecord = {
            owner: 'next-holder', hostname: 'other-host', pid: 4242, acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), leaseMs: 60_000,
        };
        await withLock('registry', {
            root: data.root,
            hooks: {
                beforeRelease(target) {
                    // A waiter takes over between the holder's ownership check and its removal of the file.
                    const temp = `${target}.replacement`;
                    fs.writeFileSync(temp, `${JSON.stringify(replacement)}\n`);
                    fs.renameSync(temp, target);
                },
            },
        }, async () => 'done');

        expect(readRecord()).toEqual(replacement);
        expect(lockDirEntries()).toEqual(['registry.lock']);
    });

    it('replaces an expired lease and reports the takeover, leaving no stale file', async () => {
        const stale = writeStaleRecord({});
        const takeover = await withLock('registry', { root: data.root, waitMs: 0 }, async (context) => {
            expect(readRecord().owner).not.toBe(stale.owner);
            return context.takeover;
        });
        expect(takeover).toEqual({ previousOwner: 'crashed-owner', previousAcquiredAt: stale.acquiredAt });
        expect(lockDirEntries()).toEqual([]);
    });

    it('waits on an unreadable lock file until its mtime is older than the lease, then replaces it', async () => {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, '{"owner": "half-writ');
        const fresh = await withLock('registry', { root: data.root, waitMs: 0 }, async () => 'acquired').catch((caught: unknown) => caught);
        expect(fresh).toBeInstanceOf(LockTimeoutError);
        expect((fresh as LockTimeoutError).holder).toBeNull();

        const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(lockPath, old, old);
        const takeover = await withLock('registry', { root: data.root, waitMs: 0 }, async (context) => context.takeover);
        expect(takeover).toEqual({ previousOwner: 'unknown', previousAcquiredAt: old.toISOString() });
    });

    it('puts a lease back and keeps waiting when it was renewed between the read and the rename', async () => {
        const stale = writeStaleRecord({});
        const renewed = { ...stale, heartbeatAt: new Date().toISOString() };
        const error = await withLock('registry', {
            root: data.root,
            waitMs: 300,
            pollMs: 20,
            hooks: {
                beforeBreak(target) {
                    // The holder wakes up and renews in place, just before the waiter renames its file away.
                    fs.writeFileSync(target, `${JSON.stringify(renewed)}\n`);
                },
            },
        }, async () => 'never').catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(LockTimeoutError);
        expect((error as LockTimeoutError).holder).toEqual(renewed);
        expect(readRecord()).toEqual(renewed);
        expect(lockDirEntries()).toEqual(['registry.lock']);
    });

    it('aborts a paused holder through its signal once a waiter has taken over its expired lease', async () => {
        const entered = deferred();
        const pausedInRenewal = deferred();
        const resume = deferred();
        let pause = false;
        const holder = withLock('registry', {
            root: data.root,
            leaseMs: 200,
            hooks: {
                async beforeRenew() {
                    if (!pause) return;
                    pausedInRenewal.resolve();
                    await resume.promise;
                },
            },
        }, async ({ signal }) => {
            entered.resolve();
            await new Promise<void>((done) => signal.addEventListener('abort', () => done()));
            return signal.reason as unknown;
        });
        await entered.promise;
        const oldOwner = readRecord().owner;
        pause = true;
        await pausedInRenewal.promise;

        const outcome = await withLock('registry', { root: data.root, leaseMs: 200, waitMs: 3_000, pollMs: 20 }, async ({ takeover }) => {
            const newOwner = readRecord().owner;
            resume.resolve();
            const reason = await holder;
            return { takeover, newOwner, reason, stillLocked: fs.existsSync(lockPath) && readRecord().owner === newOwner };
        });

        expect(outcome.takeover?.previousOwner).toBe(oldOwner);
        expect(outcome.reason).toBeInstanceOf(LockLostError);
        expect((outcome.reason as LockLostError).current?.owner).toBe(outcome.newOwner);
        // The old holder's release must not delete the new holder's lock.
        expect(outcome.stillLocked).toBe(true);
        expect(lockDirEntries()).toEqual([]);
    });

    it('re-reads the lock file in isHeld(), which turns false at a takeover before the paused holder\'s signal does', async () => {
        const entered = deferred<LockContext>();
        const pausedInRenewal = deferred();
        const resume = deferred();
        let pause = false;
        const holder = withLock('registry', {
            root: data.root,
            leaseMs: 200,
            hooks: {
                async beforeRenew() {
                    if (!pause) return;
                    pausedInRenewal.resolve();
                    await resume.promise;
                },
            },
        }, async (context) => {
            entered.resolve(context);
            await new Promise<void>((done) => context.signal.addEventListener('abort', () => done()));
        });
        const context = await entered.promise;
        await expect(context.isHeld()).resolves.toBe(true);
        pause = true;
        await pausedInRenewal.promise;

        const seen = await withLock('registry', { root: data.root, leaseMs: 200, waitMs: 3_000, pollMs: 20 }, async () => {
            const result = { aborted: context.signal.aborted, held: await context.isHeld() };
            resume.resolve();
            await holder;
            return result;
        });
        expect(seen).toEqual({ aborted: false, held: false });
    });

    it('lets exactly one of two processes break an expired lease, and never runs them at once', { timeout: 60_000 }, async () => {
        const stale = writeStaleRecord({});
        const log = data.file('lock-log.txt');
        const startAt = Date.now() + 2_500;
        const runs = await Promise.all(['a', 'b'].map((id) => runTsx('test/helpers/storageWorker.ts', [
            'lock',
            JSON.stringify({ root: data.root, name: 'registry', leaseMs: 2_000, waitMs: 20_000, holdMs: 400, log, id, startAt }),
        ])));

        for (const run of runs) expect(run.code, run.stderr).toBe(0);
        const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(4);
        // Enter and exit pairs never interleave.
        const [firstEnter, firstExit, secondEnter, secondExit] = lines.map((line) => line.split(' '));
        expect(firstEnter[0]).toBe('enter');
        expect(firstExit).toEqual(['exit', firstEnter[1]]);
        expect(secondEnter[0]).toBe('enter');
        expect(secondEnter[1]).not.toBe(firstEnter[1]);
        expect(secondExit).toEqual(['exit', secondEnter[1]]);
        // Only a holder that broke the lease reports it, the second holder found a live lock, and nobody saw a fresh owner as stale.
        const takeovers = [firstEnter[2], secondEnter[2]].filter((owner) => owner !== '-');
        expect(takeovers.length).toBeLessThanOrEqual(1);
        for (const owner of takeovers) expect(owner).toBe(stale.owner);
        expect(secondEnter[2]).toBe('-');
        expect(lockDirEntries()).toEqual([]);
    });

    it('rejects an invalid lock name and never creates a missing data root', async () => {
        await expect(withLock('../registry', { root: data.root }, async () => 'never')).rejects.toThrow(TypeError);
        const missing = path.join(data.root, 'not-mounted');
        await expect(withLock('registry', { root: missing }, async () => 'never')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(fs.existsSync(missing)).toBe(false);
    });
});

import { verifyPassphrase, type PassphraseHash } from './passphrase';
import { createSession } from './sessions';

/**
 * Curator login (#14's 14-2): the passphrase check and the lockout.
 *
 * Five failed logins within 15 minutes lock login for 15 minutes. The lock
 * is global, one for the whole curator, not one per client. Every request
 * reaches the curator over loopback, through the owner's SSH tunnel or a
 * shell on the host, so they all come from the same address, and anything
 * else a client could send to tell itself apart (a header, a cookie) is the
 * client's to change. A per-client count would let one caller reset its own.
 * The cost: whoever can reach the port can keep the owner locked out, and
 * that is someone who already has the host or the owner's tunnel.
 *
 * Attempts run one at a time, so a burst sent together still meets the
 * count. While the lock is on, a login still derives the key, so it takes as
 * long as a wrong passphrase, and it's refused whatever the passphrase: the
 * answer is the same as for a wrong one. The login page says the lock is on,
 * and nothing more. Attempts during the lock don't count or extend it.
 *
 * The state lives in memory, like the sessions, so a restart clears it.
 */

export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;

interface LockState {
    failures: number[];
    lockedUntil: number;
    queue: Promise<unknown>;
}

const LOCK_KEY = Symbol.for('keyurgolani.photography.curatorLogin');

function state(): LockState {
    const holder = globalThis as unknown as Record<symbol, LockState | undefined>;
    holder[LOCK_KEY] ??= { failures: [], lockedUntil: 0, queue: Promise.resolve() };
    return holder[LOCK_KEY];
}

/** Whether login is locked at `now`. */
export function loginLocked(now: number = Date.now()): boolean {
    return state().lockedUntil > now;
}

function recordFailure(now: number): void {
    const lock = state();
    lock.failures = lock.failures.filter((at) => at > now - FAILURE_WINDOW_MS);
    lock.failures.push(now);
    if (lock.failures.length >= MAX_FAILURES) {
        lock.lockedUntil = now + LOCK_MS;
        lock.failures = [];
    }
}

/** What a login attempt came to. `refused` is the one answer for a wrong passphrase and for the lock. */
export type LoginOutcome = { ok: true; sessionId: string } | { ok: false };

/**
 * Checks `passphrase` against `hash` and, when it matches and login isn't
 * locked, starts a new session. `clock` is for tests.
 */
export function attemptLogin(passphrase: string, hash: PassphraseHash, clock: () => number = Date.now): Promise<LoginOutcome> {
    const lock = state();
    const run = async (): Promise<LoginOutcome> => {
        const lockedAtStart = loginLocked(clock());
        const match = await verifyPassphrase(passphrase, hash);
        const now = clock();
        if (lockedAtStart || loginLocked(now)) return { ok: false };
        if (!match) {
            recordFailure(now);
            return { ok: false };
        }
        lock.failures = [];
        return { ok: true, sessionId: createSession(now) };
    };
    const result = lock.queue.then(run, run);
    lock.queue = result.catch(() => undefined);
    return result;
}

/** For tests: clear the count and the lock, as a restart does. */
export function resetLoginForTests(): void {
    const lock = state();
    lock.failures = [];
    lock.lockedUntil = 0;
    lock.queue = Promise.resolve();
}

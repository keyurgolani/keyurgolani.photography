import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Curator sessions (#14's 14-2). A session is a random 32-byte ID held in
 * this process's memory, so a restart of `curator` ends every session, which
 * the docs say. It ends 12 hours after login, or at logout, which deletes it.
 *
 * The `curator_session` cookie carries the ID and an HMAC-SHA256 tag of it
 * under the session secret: `<id>.<tag>`, each 32 bytes in base64url. A
 * cookie counts only when its tag matches, compared in constant time, and
 * its ID is a live session here. A tag alone proves nothing after logout or
 * expiry, since the ID is gone from the store.
 *
 * The store sits on globalThis under a registered symbol, so proxy.ts and
 * the app's handlers, which Next bundles apart, share it in one process.
 */

export const SESSION_COOKIE = 'curator_session';
/** 12 hours, in seconds, as the cookie's Max-Age. */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const SESSION_TTL_MS = SESSION_MAX_AGE_SECONDS * 1000;
const ID_BYTES = 32;
/** Domain separation for the tag, so the secret signs nothing else by accident. */
const TAG_CONTEXT = 'curator_session v1\n';
const PART = '[A-Za-z0-9_-]{43}';
const COOKIE_VALUE = new RegExp(`^(${PART})\\.(${PART})$`);

interface Session {
    createdAt: number;
}

interface Store {
    sessions: Map<string, Session>;
}

const STORE_KEY = Symbol.for('keyurgolani.photography.curatorSessions');

function store(): Store {
    const holder = globalThis as unknown as Record<symbol, Store | undefined>;
    holder[STORE_KEY] ??= { sessions: new Map() };
    return holder[STORE_KEY];
}

function tagOf(id: string, key: Buffer): Buffer {
    return createHmac('sha256', key).update(TAG_CONTEXT).update(id).digest();
}

/** Decodes canonical base64url of exactly 32 bytes, or null. */
function decode32(text: string): Buffer | null {
    const value = Buffer.from(text, 'base64url');
    return value.length === ID_BYTES && value.toString('base64url') === text ? value : null;
}

/** The cookie value for session `id` under `key`. */
export function signSessionId(id: string, key: Buffer): string {
    return `${id}.${tagOf(id, key).toString('base64url')}`;
}

/** The session ID a cookie value carries, when its shape and tag check out under `key`. Says nothing of whether the session lives. */
export function verifiedSessionId(value: string, key: Buffer): string | null {
    const match = COOKIE_VALUE.exec(value);
    if (!match) return null;
    const [, id, tagText] = match;
    const tag = decode32(tagText);
    if (decode32(id) === null || tag === null) return null;
    const expected = tagOf(id, key);
    return expected.length === tag.length && timingSafeEqual(expected, tag) ? id : null;
}

function isLive(id: string, now: number): boolean {
    const session = store().sessions.get(id);
    if (!session) return false;
    if (now >= session.createdAt + SESSION_TTL_MS) {
        store().sessions.delete(id);
        return false;
    }
    return true;
}

/** Drops every expired session, so the store never grows past the live ones. */
function sweep(now: number): void {
    for (const [id, session] of store().sessions) if (now >= session.createdAt + SESSION_TTL_MS) store().sessions.delete(id);
}

/** Starts a new session and returns its ID. Every login gets a fresh one. */
export function createSession(now: number = Date.now()): string {
    sweep(now);
    const id = randomBytes(ID_BYTES).toString('base64url');
    store().sessions.set(id, { createdAt: now });
    return id;
}

/** Ends a session. Unknown IDs are fine. */
export function deleteSession(id: string): void {
    store().sessions.delete(id);
}

/**
 * The `curator_session` values a Cookie header carries. Usually one; a
 * second, say one another server on the same host name set with another
 * Path, means the request can't say which it means.
 */
export function sessionCookieValues(cookieHeader: string | null): string[] {
    if (!cookieHeader) return [];
    const values: string[] = [];
    for (const part of cookieHeader.split(';')) {
        const at = part.indexOf('=');
        if (at < 0) continue;
        if (part.slice(0, at).trim() === SESSION_COOKIE) values.push(part.slice(at + 1).trim());
    }
    return values;
}

/**
 * The live session a request's Cookie header names, or null. Exactly one
 * `curator_session` cookie, with a tag that matches under `key`, naming a
 * session that hasn't ended.
 */
export function sessionFromCookies(cookieHeader: string | null, key: Buffer, now: number = Date.now()): string | null {
    const values = sessionCookieValues(cookieHeader);
    if (values.length !== 1) return null;
    const id = verifiedSessionId(values[0], key);
    return id !== null && isLive(id, now) ? id : null;
}

/**
 * How the cookie goes out. `secure: false` only for a LAN-mode name over
 * plain http (policy.ts, plainLanRequest()), where a browser would drop a
 * `Secure` cookie; loopback and https keep it. Every other attribute is the
 * same in every mode.
 */
export interface SessionCookieOptions {
    secure: boolean;
}

function attributes({ secure }: SessionCookieOptions): string {
    return secure ? 'Path=/; HttpOnly; Secure; SameSite=Strict' : 'Path=/; HttpOnly; SameSite=Strict';
}

/** The Set-Cookie value that hands the browser session `id`. */
export function sessionCookie(id: string, key: Buffer, options: SessionCookieOptions): string {
    return `${SESSION_COOKIE}=${signSessionId(id, key)}; ${attributes(options)}; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

/** The Set-Cookie value that clears it. The same attributes it was set with, or a browser on plain http won't take it. */
export function clearedSessionCookie(options: SessionCookieOptions): string {
    return `${SESSION_COOKIE}=; ${attributes(options)}; Max-Age=0`;
}

/** For tests: forget every session, as a restart does. */
export function resetSessionsForTests(): void {
    store().sessions.clear();
}

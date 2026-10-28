import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * The curator passphrase hash (#14's 14-2, the layer the owner approved on
 * 2026-10-25). `curation hash-passphrase` writes one line in this format to
 * a file under `./secrets/`, and login checks a passphrase against it:
 *
 *   scrypt$32768$8$1$<salt>$<key>
 *
 * The salt is 16 random bytes made for each hash, the key is 32 bytes, both
 * base64url without padding. Only these exact parameters parse, so a file
 * with cheaper ones is refused rather than trusted.
 */

export const SCRYPT_N = 32768;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** 128 * N * r is exactly Node's default limit, which it refuses, so give it room. */
const MAX_MEM = 64 * 1024 * 1024;
const OPTIONS: ScryptOptions = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEM };

/** The longest passphrase the command and login accept, in UTF-8 bytes. */
export const MAX_PASSPHRASE_BYTES = 1024;
/** The fewest characters `curation hash-passphrase` takes for a new passphrase. Login checks none, so a hash made before still works. */
export const MIN_PASSPHRASE_CHARS = 12;

const B64URL = /^[A-Za-z0-9_-]+$/;
const PREFIX = `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$`;

/** A parsed hash file: the salt and the key it holds. */
export interface PassphraseHash {
    salt: Buffer;
    key: Buffer;
}

/** Why a passphrase can't be hashed or checked, or null when it can. Says nothing about its value. */
export function passphraseProblem(passphrase: string): string | null {
    if (passphrase.length === 0) return 'The passphrase is empty.';
    if (/[\r\n]/.test(passphrase)) return 'The passphrase has a line break in it.';
    if (Buffer.byteLength(passphrase.normalize('NFC'), 'utf8') > MAX_PASSPHRASE_BYTES) return `The passphrase is longer than ${MAX_PASSPHRASE_BYTES} bytes.`;
    return null;
}

/**
 * Why a new passphrase can't be hashed, or null: passphraseProblem()'s
 * reasons, and fewer than MIN_PASSPHRASE_CHARS characters (code points,
 * after NFC). Only the command that makes a hash asks this; login uses
 * passphraseProblem() alone, so an existing shorter passphrase still signs in.
 */
export function newPassphraseProblem(passphrase: string): string | null {
    const problem = passphraseProblem(passphrase);
    if (problem) return problem;
    const chars = [...passphrase.normalize('NFC')].length;
    if (chars < MIN_PASSPHRASE_CHARS) return `The passphrase is ${chars === 1 ? '1 character' : `${chars} characters`} long. Use at least ${MIN_PASSPHRASE_CHARS}.`;
    return null;
}

function derive(passphrase: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scrypt(passphrase.normalize('NFC'), salt, KEY_BYTES, OPTIONS, (error, key) => (error ? reject(error) : resolve(key)));
    });
}

/** Decodes canonical base64url of exactly `bytes` bytes, or null. */
function decode(text: string, bytes: number): Buffer | null {
    if (!B64URL.test(text)) return null;
    const value = Buffer.from(text, 'base64url');
    if (value.length !== bytes || value.toString('base64url') !== text) return null;
    return value;
}

/** The hash file line for `passphrase`, with a new random salt. Throws on a passphrase passphraseProblem() refuses. */
export async function hashPassphrase(passphrase: string): Promise<string> {
    const problem = passphraseProblem(passphrase);
    if (problem) throw new Error(problem);
    const salt = randomBytes(SALT_BYTES);
    const key = await derive(passphrase, salt);
    return `${PREFIX}${salt.toString('base64url')}$${key.toString('base64url')}\n`;
}

/** Parses a hash file's text, or returns null when it isn't exactly this format with these parameters. */
export function parsePassphraseHash(text: string): PassphraseHash | null {
    const line = text.endsWith('\n') ? text.slice(0, -1) : text;
    if (!line.startsWith(PREFIX)) return null;
    const parts = line.slice(PREFIX.length).split('$');
    if (parts.length !== 2) return null;
    const salt = decode(parts[0], SALT_BYTES);
    const key = decode(parts[1], KEY_BYTES);
    return salt && key ? { salt, key } : null;
}

/**
 * Whether `passphrase` matches `hash`. It always derives a key, whatever the
 * passphrase, so a refused shape takes as long as a wrong one, and compares
 * the two keys, of equal length, with timingSafeEqual.
 */
export async function verifyPassphrase(passphrase: string, hash: PassphraseHash): Promise<boolean> {
    const usable = passphraseProblem(passphrase) === null;
    const derived = await derive(usable ? passphrase : '', hash.salt);
    const match = derived.length === hash.key.length && timingSafeEqual(derived, hash.key);
    return usable && match;
}

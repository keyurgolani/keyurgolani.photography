import fs from 'node:fs';
import { parsePassphraseHash, type PassphraseHash } from './passphrase';

/**
 * The curator's two secret files, made at deploy time (docs/curator.md) and
 * mounted into the `curator` service alone, read-only:
 *
 * - the passphrase hash `curation hash-passphrase` writes;
 * - the session secret, 32 random bytes or more, that signs the
 *   `curator_session` cookie.
 *
 * Both are read on every check, so a missing, emptied or loosened file stops
 * the curator at once (every curator path answers 503), and a replaced one
 * counts from the next request. Their values never go in git, the image,
 * Compose values or the environment; the settings below only name where the
 * files are.
 */

/** Names the passphrase hash file. Optional; the default is where the `curator` service mounts it. */
export const PASSPHRASE_FILE_SETTING = 'CURATOR_PASSPHRASE_HASH_FILE';
/** Names the session secret file. Optional, like the other. */
export const SESSION_SECRET_FILE_SETTING = 'CURATOR_SESSION_SECRET_FILE';

/** Where docker-compose.prod.yml mounts `./secrets/`, read-only, in `curator`. */
export const SECRETS_MOUNT = '/run/secrets/curator';
export const DEFAULT_PASSPHRASE_FILE = `${SECRETS_MOUNT}/curator-passphrase.hash`;
export const DEFAULT_SESSION_SECRET_FILE = `${SECRETS_MOUNT}/curator-session.key`;

/** The least a session secret may hold. */
export const MIN_SESSION_SECRET_BYTES = 32;
/** Neither file is ever this big. Anything larger isn't one of them. */
const MAX_SECRET_FILE_BYTES = 4096;

export interface CuratorSecrets {
    passphrase: PassphraseHash;
    sessionKey: Buffer;
}

type Env = Readonly<Record<string, string | undefined>>;

const setting = (env: Env, name: string, fallback: string) => {
    const value = env[name];
    return value === undefined || value === '' ? fallback : value;
};

/**
 * A secret file's bytes, or why it can't be used. It has to be a regular
 * file only its owner may read or write (no group or other bits, as `ssh`
 * asks of a key), and this process has to be able to read it.
 */
function readSecretFile(file: string, label: string): { bytes: Buffer } | { problem: string } {
    let fd: number;
    try {
        fd = fs.openSync(/*turbopackIgnore: true*/ file, 'r');
    } catch {
        return { problem: `the ${label} file can't be read` };
    }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return { problem: `the ${label} file isn't a regular file` };
        if ((stat.mode & 0o077) !== 0) return { problem: `the ${label} file can be read by others than its owner (chmod 0400 it)` };
        if (stat.size > MAX_SECRET_FILE_BYTES) return { problem: `the ${label} file is too big to be one` };
        const bytes = Buffer.alloc(stat.size);
        const read = stat.size === 0 ? 0 : fs.readSync(fd, bytes, 0, stat.size, 0);
        return { bytes: bytes.subarray(0, read) };
    } catch {
        return { problem: `the ${label} file can't be read` };
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Both secrets, or why the curator can't use them. The message names the
 * setting and the problem, never a value or a path's contents.
 */
export function readCuratorSecrets(env: Env): { secrets: CuratorSecrets } | { problem: string } {
    const hashFile = readSecretFile(setting(env, PASSPHRASE_FILE_SETTING, DEFAULT_PASSPHRASE_FILE), `passphrase hash (${PASSPHRASE_FILE_SETTING})`);
    if ('problem' in hashFile) return hashFile;
    const passphrase = parsePassphraseHash(hashFile.bytes.toString('utf8'));
    if (!passphrase) return { problem: `the passphrase hash (${PASSPHRASE_FILE_SETTING}) isn't one curation hash-passphrase wrote` };
    const keyFile = readSecretFile(setting(env, SESSION_SECRET_FILE_SETTING, DEFAULT_SESSION_SECRET_FILE), `session secret (${SESSION_SECRET_FILE_SETTING})`);
    if ('problem' in keyFile) return keyFile;
    if (keyFile.bytes.length < MIN_SESSION_SECRET_BYTES) {
        return { problem: `the session secret (${SESSION_SECRET_FILE_SETTING}) holds fewer than ${MIN_SESSION_SECRET_BYTES} bytes` };
    }
    return { secrets: { passphrase, sessionKey: keyFile.bytes } };
}

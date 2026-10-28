/**
 * Test values for the curator's two secret files (#14's 14-2): a passphrase
 * made fresh for each set, its scrypt hash, and 32 random bytes of session
 * secret, written owner read-only to a temp folder outside the repository.
 * Nothing here is a real credential, and no test prints one.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPassphrase } from '../../lib/curation/auth/passphrase';
import { PASSPHRASE_FILE_SETTING, SESSION_SECRET_FILE_SETTING } from '../../lib/curation/auth/secrets';
import { createSession, SESSION_COOKIE, signSessionId } from '../../lib/curation/auth/sessions';
import { assertOutsideRepository } from './tempDataRoot';

export interface TestCuratorSecrets {
    dir: string;
    hashFile: string;
    keyFile: string;
    /** The test passphrase the hash was made from. */
    passphrase: string;
    sessionKey: Buffer;
    /** The settings that point a curator at these files. */
    env: Record<string, string>;
    /** A `Cookie` header for a new live session, signed with this set's secret. */
    cookie(now?: number): string;
    cleanup(): void;
}

/** `passphrase` sets the test passphrase, for a test about one, such as a short one an older hash command allowed. */
export async function makeCuratorSecrets({ passphrase = `test-${randomBytes(12).toString('base64url')}` }: { passphrase?: string } = {}): Promise<TestCuratorSecrets> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-secrets-'));
    assertOutsideRepository(dir);
    const sessionKey = randomBytes(32);
    const hashFile = path.join(dir, 'curator-passphrase.hash');
    const keyFile = path.join(dir, 'curator-session.key');
    fs.writeFileSync(hashFile, await hashPassphrase(passphrase), { mode: 0o400 });
    fs.writeFileSync(keyFile, sessionKey, { mode: 0o400 });
    return {
        dir,
        hashFile,
        keyFile,
        passphrase,
        sessionKey,
        env: { [PASSPHRASE_FILE_SETTING]: hashFile, [SESSION_SECRET_FILE_SETTING]: keyFile },
        cookie: (now?: number) => `${SESSION_COOKIE}=${signSessionId(createSession(now), sessionKey)}`,
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

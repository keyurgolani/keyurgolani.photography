// @vitest-environment node
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCredentialCommand, type CredentialIo } from '../credential-cli';
import { parsePassphraseHash, verifyPassphrase } from '../passphrase';
import { readCuratorSecrets } from '../secrets';

// `curation hash-passphrase` and `curation session-secret`: what they read,
// what they write, and that they print nothing secret. Test values only.

let dir: string;
let stderr: string;
const PASSPHRASE = 'a test passphrase for the CLI';

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-cli-'));
    stderr = '';
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

const piped = (text: string): CredentialIo => ({ stdin: Readable.from([Buffer.from(text)]), stderr: { write: (chunk: string) => (stderr += chunk) } });

/** A terminal that types `lines`, one per prompt, and records whether echo went off. */
function terminal(lines: string[]) {
    const stdin = new EventEmitter() as EventEmitter & { isTTY: boolean; setRawMode: (raw: boolean) => void; resume: () => void; pause: () => void; raw: boolean[] };
    stdin.isTTY = true;
    stdin.raw = [];
    stdin.setRawMode = (raw) => stdin.raw.push(raw);
    stdin.pause = () => undefined;
    stdin.resume = () => {
        const line = lines.shift();
        if (line !== undefined) setImmediate(() => stdin.emit('data', Buffer.from(line)));
    };
    return { stdin, io: { stdin: stdin as unknown as CredentialIo['stdin'], stderr: { write: (chunk: string) => (stderr += chunk) } } };
}

const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe('curation hash-passphrase', () => {
    it('hashes a piped passphrase into an owner read-only file, and prints nothing secret', async () => {
        const out = path.join(dir, 'curator-passphrase.hash');
        const result = await runCredentialCommand('hash-passphrase', ['--out', out], piped(`${PASSPHRASE}\n`));
        expect(result.exitCode).toBe(0);
        expect(mode(out)).toBe(0o400);
        const text = fs.readFileSync(out, 'utf8');
        const hash = parsePassphraseHash(text)!;
        expect(await verifyPassphrase(PASSPHRASE, hash)).toBe(true);
        for (const printed of [result.output, stderr]) {
            expect(printed).not.toContain(PASSPHRASE);
            expect(printed).not.toContain(text.trim());
            expect(printed).not.toContain(hash.key.toString('base64url'));
            expect(printed).not.toContain(dir);
        }
        expect(fs.readdirSync(dir)).toEqual(['curator-passphrase.hash']);
    });

    it('takes the passphrase as piped, with one trailing line break dropped', async () => {
        const out = path.join(dir, 'h');
        expect((await runCredentialCommand('hash-passphrase', ['--out', out], piped(`${PASSPHRASE}\r\n`))).exitCode).toBe(0);
        expect(await verifyPassphrase(PASSPHRASE, parsePassphraseHash(fs.readFileSync(out, 'utf8'))!)).toBe(true);
        fs.rmSync(out);
        expect((await runCredentialCommand('hash-passphrase', ['--out', out], piped(` ${PASSPHRASE}`))).exitCode).toBe(0);
        expect(await verifyPassphrase(` ${PASSPHRASE}`, parsePassphraseHash(fs.readFileSync(out, 'utf8'))!)).toBe(true);
    });

    it.each([
        ['an empty passphrase', '', 'empty'],
        ['a bare line break', '\n', 'empty'],
        ['two lines', 'one\ntwo\n', 'line break'],
    ])('refuses %s and writes nothing', async (_, input, message) => {
        const out = path.join(dir, 'h');
        const result = await runCredentialCommand('hash-passphrase', ['--out', out], piped(input));
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain(message);
        expect(result.output).toContain('Nothing was written');
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('turns echo off on a terminal, asks twice, and writes the hash', async () => {
        const out = path.join(dir, 'h');
        const { stdin, io } = terminal([`${PASSPHRASE}\r`, `${PASSPHRASE}\r`]);
        const result = await runCredentialCommand('hash-passphrase', ['--out', out], io);
        expect(result.exitCode).toBe(0);
        expect(stdin.raw).toEqual([true, false, true, false]);
        expect(stderr).toContain('Passphrase: ');
        expect(stderr).toContain('Again: ');
        expect(stderr).not.toContain(PASSPHRASE);
        expect(await verifyPassphrase(PASSPHRASE, parsePassphraseHash(fs.readFileSync(out, 'utf8'))!)).toBe(true);
    });

    it('writes nothing when the two entries differ', async () => {
        const out = path.join(dir, 'h');
        const { io } = terminal([`${PASSPHRASE}\r`, 'something else\r']);
        const result = await runCredentialCommand('hash-passphrase', ['--out', out], io);
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain("didn't match");
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('treats a backspace on a terminal as an edit, and Ctrl-C as a stop', async () => {
        const out = path.join(dir, 'h');
        const edited = terminal([`${PASSPHRASE}x\u007f\r`, `${PASSPHRASE}\r`]);
        expect((await runCredentialCommand('hash-passphrase', ['--out', out], edited.io)).exitCode).toBe(0);
        fs.rmSync(out);
        const stopped = terminal(['abc\u0003']);
        const result = await runCredentialCommand('hash-passphrase', ['--out', out], stopped.io);
        expect(result.exitCode).toBe(1);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('replaces an existing hash file in one rename, owner read-only still', async () => {
        const out = path.join(dir, 'h');
        await runCredentialCommand('hash-passphrase', ['--out', out], piped('first'));
        expect((await runCredentialCommand('hash-passphrase', ['--out', out], piped('second'))).exitCode).toBe(0);
        expect(mode(out)).toBe(0o400);
        const hash = parsePassphraseHash(fs.readFileSync(out, 'utf8'))!;
        expect(await verifyPassphrase('second', hash)).toBe(true);
        expect(await verifyPassphrase('first', hash)).toBe(false);
        expect(fs.readdirSync(dir)).toEqual(['h']);
    });

    it.each([[[]], [['--out']], [['--out', 'x', 'extra']], [['--file', 'x']]])('is a usage error with %j', async (args) => {
        expect((await runCredentialCommand('hash-passphrase', args, piped('p'))).exitCode).toBe(2);
    });

    it("says so, and names no path, when the folder can't be written", async () => {
        const result = await runCredentialCommand('hash-passphrase', ['--out', path.join(dir, 'missing', 'h')], piped('p'));
        expect(result.exitCode).toBe(1);
        expect(result.output).not.toContain(dir);
    });
});

describe('curation session-secret', () => {
    it('writes 32 random bytes, owner read-only, and prints none of them', async () => {
        const out = path.join(dir, 'curator-session.key');
        const result = await runCredentialCommand('session-secret', ['--out', out], piped(''));
        expect(result.exitCode).toBe(0);
        expect(mode(out)).toBe(0o400);
        const bytes = fs.readFileSync(out);
        expect(bytes).toHaveLength(32);
        expect(result.output).not.toContain(bytes.toString('base64url'));
        expect(result.output).not.toContain(bytes.toString('hex'));
        const again = path.join(dir, 'again.key');
        await runCredentialCommand('session-secret', ['--out', again], piped(''));
        expect(fs.readFileSync(again).equals(bytes)).toBe(false);
    });

    it('makes files the curator reads', async () => {
        const hashFile = path.join(dir, 'curator-passphrase.hash');
        const keyFile = path.join(dir, 'curator-session.key');
        await runCredentialCommand('hash-passphrase', ['--out', hashFile], piped(PASSPHRASE));
        await runCredentialCommand('session-secret', ['--out', keyFile], piped(''));
        const read = readCuratorSecrets({ CURATOR_PASSPHRASE_HASH_FILE: hashFile, CURATOR_SESSION_SECRET_FILE: keyFile });
        expect('secrets' in read).toBe(true);
    });
});

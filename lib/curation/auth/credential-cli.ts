import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { hashPassphrase, newPassphraseProblem } from './passphrase';
import { MIN_SESSION_SECRET_BYTES } from './secrets';

/**
 * `photos curation hash-passphrase` and `photos curation session-secret`:
 * the curator's credential, made at deploy time (docs/curator.md). Each
 * writes one file, owner read-only (0400), through a temporary file and a
 * rename, and prints nothing secret: no passphrase, hash, secret, or path.
 *
 * hash-passphrase reads the passphrase from stdin. On a terminal it turns
 * echo off and asks twice; piped, it takes the input with one trailing line
 * break dropped. It refuses a passphrase under 12 characters.
 */

export const CREDENTIAL_COMMANDS = ['hash-passphrase', 'session-secret'] as const;

export function credentialUsage(program: string): string {
    return `  ${program} curation hash-passphrase --out <file>
  ${program} curation session-secret --out <file>
    The curator's passphrase hash and session secret, made at deploy time (docs/curator.md).`;
}

/** What the commands read and write besides files. Tests pass their own. */
export interface CredentialIo {
    stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown };
    stderr: { write: (text: string) => unknown };
}

export interface CredentialResult {
    exitCode: 0 | 1 | 2;
    output: string;
}

/** Writes `bytes` to `file`, owner read-only, replacing what was there in one rename. */
function writeOwnerOnly(file: string, bytes: Buffer | string): void {
    const dir = path.dirname(path.resolve(file));
    const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o400);
    try {
        fs.fchmodSync(fd, 0o400);
        fs.writeSync(fd, typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(temp, file);
    } catch (error) {
        fs.rmSync(temp, { force: true });
        throw error;
    }
}

/** Reads one line from a terminal with echo off. Ctrl-C or Ctrl-D before Enter gives null. */
function readHidden(io: CredentialIo, prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
        const { stdin } = io;
        io.stderr.write(prompt);
        stdin.setRawMode?.(true);
        stdin.resume();
        let value = '';
        const finish = (result: string | null) => {
            stdin.removeListener('data', onData);
            stdin.setRawMode?.(false);
            stdin.pause();
            io.stderr.write('\n');
            resolve(result);
        };
        const onData = (chunk: Buffer | string) => {
            for (const char of chunk.toString('utf8')) {
                if (char === '\r' || char === '\n') return finish(value);
                if (char === '\u0003' || char === '\u0004') return finish(null);
                if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
                else value += char;
            }
        };
        stdin.on('data', onData);
    });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8');
}

async function readPassphrase(io: CredentialIo): Promise<{ passphrase: string } | { problem: string }> {
    if (io.stdin.isTTY) {
        const first = await readHidden(io, 'Passphrase: ');
        if (first === null) return { problem: 'Stopped.' };
        const second = await readHidden(io, 'Again: ');
        if (second === null) return { problem: 'Stopped.' };
        if (first !== second) return { problem: "The two entries didn't match." };
        return { passphrase: first };
    }
    const text = await readAll(io.stdin);
    return { passphrase: text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text };
}

function outFlag(args: string[]): { out: string } | { usage: string } {
    let parsed;
    try {
        parsed = parseArgs({ args, options: { out: { type: 'string' } }, strict: true, allowPositionals: false });
    } catch (error) {
        return { usage: (error as Error).message };
    }
    const out = parsed.values.out;
    if (!out) return { usage: 'Give the file to write with --out <file>.' };
    return { out };
}

/** Runs `curation hash-passphrase` or `curation session-secret` with the arguments after the command name. */
export async function runCredentialCommand(command: (typeof CREDENTIAL_COMMANDS)[number], args: string[], io: CredentialIo): Promise<CredentialResult> {
    const flags = outFlag(args);
    if ('usage' in flags) return { exitCode: 2, output: `${flags.usage}\n` };
    try {
        if (command === 'session-secret') {
            writeOwnerOnly(flags.out, randomBytes(MIN_SESSION_SECRET_BYTES));
            return { exitCode: 0, output: 'Wrote a new session secret (32 random bytes, mode 0400). Restart curator to use it; every session ends.\n' };
        }
        const read = await readPassphrase(io);
        if ('problem' in read) return { exitCode: 1, output: `${read.problem} Nothing was written.\n` };
        const problem = newPassphraseProblem(read.passphrase);
        if (problem) return { exitCode: 1, output: `${problem} Nothing was written.\n` };
        writeOwnerOnly(flags.out, await hashPassphrase(read.passphrase));
        return { exitCode: 0, output: 'Wrote the passphrase hash (scrypt, mode 0400). Restart curator to use it.\n' };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { exitCode: 1, output: `Couldn't write the file${code ? ` (${code})` : ''}. Nothing was changed.\n` };
    }
}

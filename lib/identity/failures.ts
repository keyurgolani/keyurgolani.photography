/**
 * A6 (#17): why a derivative build failed, as a code. A failure with a code
 * is permanent: the same bytes fail the same way, so the worker never
 * retries it, and only a `retry` decision (`curation retry`) or new bytes
 * bring it back. A failure without one is transient, such as a full disk or
 * too many open files, and the worker retries it after each of
 * RETRY_DELAYS_MS before it records `retries-exhausted`.
 *
 * The registry keeps the writer's error text, as v1.7.x does, and the code
 * is read from it, so the registry gains no field v1.7.x doesn't know.
 *
 * - `io-error`: the source can't be read, EACCES, EPERM or EIO.
 * - `decode-error`: the decoder refused the bytes, which the build checked by
 *   digest first, or #10 found them undecodable (`undecodable`).
 * - `unsupported-format`: the file's bytes are in a format the decoder doesn't read.
 * - `too-large`: the source is over MAX_SOURCE_PIXELS (lib/identity/profile.ts).
 * - `corrupt-destination`: a set already in place doesn't match its manifest
 *   (`integrity: ...`). The writer never overwrites one.
 * - `retries-exhausted`: a transient failure that failed every retry.
 * - `source-superseded`: the source moved on to other bytes. Not a failure
 *   of these bytes, and counted apart, as before.
 */
export const FAILURE_CODES = ['io-error', 'decode-error', 'unsupported-format', 'too-large', 'corrupt-destination', 'retries-exhausted', 'source-superseded'] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** How long the worker waits before each retry of a transient failure: 30 s, 2 min, 10 min. */
export const RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];

/** The codes the writer writes as a prefix of the error text: `<code>: <detail>`. */
const PREFIXED: readonly FailureCode[] = ['io-error', 'decode-error', 'unsupported-format', 'too-large', 'retries-exhausted'];

/** The errnos reading a source that make it `io-error`, here and for #10's unreadable files. */
export const IO_ERROR_CODES: readonly string[] = ['EACCES', 'EPERM', 'EIO'];

/** The code a recorded failure's error text carries, or null for a transient failure. */
export function failureCodeOf(error: string | undefined): FailureCode | null {
    if (error === undefined || error.length === 0) return null;
    if (error === 'source-superseded') return 'source-superseded';
    if (error === 'undecodable') return 'decode-error';
    if (error.startsWith('integrity:')) return 'corrupt-destination';
    for (const code of PREFIXED) if (error.startsWith(`${code}: `)) return code;
    const unreadable = /^source unreadable: ([A-Z]+)\b/.exec(error);
    if (unreadable && IO_ERROR_CODES.includes(unreadable[1])) return 'io-error';
    return null;
}

/** Whether a recorded failure is worth another try: one with no code. */
export function isRetryable(error: string | undefined): boolean {
    return failureCodeOf(error) === null;
}

/**
 * What a decoder's error makes of a build: `too-large` past the pixel cap,
 * `unsupported-format` for a format it can't read, and `decode-error`
 * otherwise. Null for an errno error, which is I/O, not the decoder.
 */
export function classifyDecodeFailure(error: unknown): Extract<FailureCode, 'too-large' | 'unsupported-format' | 'decode-error'> | null {
    if (typeof error === 'object' && error !== null && typeof (error as NodeJS.ErrnoException).code === 'string') return null;
    const message = error instanceof Error ? error.message : String(error);
    if (/pixel limit/i.test(message)) return 'too-large';
    if (/unsupported image format/i.test(message)) return 'unsupported-format';
    return 'decode-error';
}

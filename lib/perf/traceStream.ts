import fs from 'node:fs';

/**
 * A trace read from Chrome's stream to a file, under a size cap (e2e/themes/perfTrace.ts drives it). A trace is never
 * held whole in memory or written past the cap: each chunk is checked before it's written, and a trace that would pass
 * the cap stops the read, closes the stream, removes its partial file and fails, naming the cap. PERF_TRACE_MAX_MB sets
 * the cap, 150 MB unless it says otherwise (perf5's profile traces ran about 125 MB each, with the stack and v8.execute
 * categories that the profile pass no longer takes).
 */

export const TRACE_MAX_MB = 150;

/** The cap in bytes, from PERF_TRACE_MAX_MB. */
export function traceCapBytes(value = process.env.PERF_TRACE_MAX_MB): number {
    const mb = Number(value ?? TRACE_MAX_MB);
    if (!Number.isFinite(mb) || mb <= 0) throw new Error(`PERF_TRACE_MAX_MB is a positive number of MB, not ${JSON.stringify(value)}`);
    return Math.floor(mb * 2 ** 20);
}

/** One `IO.read` answer. */
export interface StreamChunk {
    data: string;
    base64Encoded?: boolean;
    eof: boolean;
}

/** Reads `read` to its end into `file`, failing past `capBytes`; `close` runs either way. Returns the bytes written. */
export async function drainToFile(read: () => Promise<StreamChunk>, close: () => Promise<void>, file: string, capBytes: number): Promise<number> {
    const fd = fs.openSync(file, 'wx');
    let written = 0;
    let ok = false;
    try {
        for (;;) {
            const chunk = await read();
            const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
            if (written + bytes.length > capBytes) throw new Error(`The trace passed ${Math.round(capBytes / 2 ** 20)} MB (PERF_TRACE_MAX_MB), so the phase stops; nothing of it is kept.`);
            fs.writeSync(fd, bytes);
            written += bytes.length;
            if (chunk.eof) break;
        }
        ok = true;
        return written;
    } finally {
        fs.closeSync(fd);
        await close().catch(() => undefined);
        if (!ok) fs.rmSync(file, { force: true });
    }
}

/** Whether a raw trace is kept after its summary: only with PERF_KEEP_TRACE=1. */
export const keepTrace = (value = process.env.PERF_KEEP_TRACE) => value === '1';

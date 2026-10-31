import fs from 'node:fs';
import type { Browser, CDPSession } from '@playwright/test';
import { drainToFile, keepTrace, traceCapBytes } from '../../lib/perf/traceStream';

// A traced phase for the perf specs, streamed to a file under a cap (lib/perf/traceStream.ts). Chrome writes the trace
// to a stream (Tracing.start with transferMode ReturnAsStream), which is read to `file` in chunks and fails the phase
// past PERF_TRACE_MAX_MB. The events are parsed from the file, and the raw trace is then removed unless
// PERF_KEEP_TRACE=1, passed or failed.

export interface TraceEvent {
    name: string;
    ph: string;
    pid: number;
    tid: number;
    ts?: number;
    dur?: number;
    args?: Record<string, unknown> & { chrome_frame_reporter?: { state?: string }; name?: string };
}

/** Ends the trace and waits, bounded, for its stream handle. */
async function endTrace(session: CDPSession): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    const complete = new Promise<{ stream?: string }>((resolve) => session.once('Tracing.tracingComplete', resolve));
    await session.send('Tracing.end');
    const { stream } = await Promise.race([complete, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('Chrome never completed the trace')), 60_000)))]).finally(() => clearTimeout(timer));
    if (!stream) throw new Error('Chrome ended the trace with no stream');
    return stream;
}

/** Runs `work` under a trace of `categories`, streamed into `file`; returns work's result and the trace's events. */
export async function tracedToFile<T>(browser: Browser, categories: string[], file: string, work: () => Promise<T>): Promise<{ result: T; events: TraceEvent[]; bytes: number }> {
    const session = await browser.newBrowserCDPSession();
    try {
        await session.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: categories, recordMode: 'recordUntilFull' } });
        let result: T;
        try {
            result = await work();
        } catch (error) {
            // The phase failed: the trace still ends, so Chrome isn't left tracing, and its stream closes unread.
            const handle = await endTrace(session).catch(() => undefined);
            if (handle) await session.send('IO.close', { handle }).catch(() => undefined);
            throw error;
        }
        const handle = await endTrace(session);
        const bytes = await drainToFile(
            () => session.send('IO.read', { handle, size: 4 * 2 ** 20 }),
            () => session.send('IO.close', { handle }).then(() => undefined),
            file,
            traceCapBytes(),
        );
        try {
            const events = (JSON.parse(fs.readFileSync(file, 'utf8')) as { traceEvents?: TraceEvent[] }).traceEvents ?? [];
            return { result, events, bytes };
        } finally {
            if (!keepTrace()) fs.rmSync(file, { force: true });
        }
    } finally {
        await session.detach().catch(() => undefined);
    }
}

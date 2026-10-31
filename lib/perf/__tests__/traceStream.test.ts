// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { makeRunTemp, removeRunTemp } from '../runFiles';
import { drainToFile, keepTrace, traceCapBytes, type StreamChunk } from '../traceStream';

const dir = makeRunTemp('trace-stream-test-');
afterAll(() => removeRunTemp(dir));

/** A stream answering `chunks` in turn, the last one at eof. */
const streamOf = (chunks: string[], base64 = false) => {
    let at = 0;
    return vi.fn(async (): Promise<StreamChunk> => {
        const data = chunks[at++];
        return { data: base64 ? Buffer.from(data).toString('base64') : data, base64Encoded: base64, eof: at === chunks.length };
    });
};

describe('drainToFile', () => {
    it('writes every chunk, plain or base64, and closes the stream', async () => {
        for (const base64 of [false, true]) {
            const file = path.join(dir, `whole-${base64}.json`);
            const close = vi.fn(async () => undefined);
            expect(await drainToFile(streamOf(['{"traceEvents":', '[]}'], base64), close, file, 1024)).toBe(18);
            expect(fs.readFileSync(file, 'utf8')).toBe('{"traceEvents":[]}');
            expect(close).toHaveBeenCalledOnce();
        }
    });

    it('stops past the cap, before writing the chunk that passes it, closes the stream and keeps nothing', async () => {
        const file = path.join(dir, 'capped.json');
        const read = streamOf(['x'.repeat(600), 'y'.repeat(600), 'z']);
        const close = vi.fn(async () => undefined);
        await expect(drainToFile(read, close, file, 1000)).rejects.toThrow('PERF_TRACE_MAX_MB');
        expect(read).toHaveBeenCalledTimes(2);
        expect(close).toHaveBeenCalledOnce();
        expect(fs.existsSync(file)).toBe(false);
    });

    it('never writes over a file that is there', async () => {
        const file = path.join(dir, 'there.json');
        fs.writeFileSync(file, 'kept');
        await expect(drainToFile(streamOf(['x']), async () => undefined, file, 1024)).rejects.toThrow(/EEXIST/);
        expect(fs.readFileSync(file, 'utf8')).toBe('kept');
    });
});

describe('the knobs', () => {
    it('caps at 150 MB unless PERF_TRACE_MAX_MB says otherwise, and keeps no raw trace unless asked', () => {
        expect(traceCapBytes(undefined)).toBe(150 * 2 ** 20);
        expect(traceCapBytes('20')).toBe(20 * 2 ** 20);
        expect(() => traceCapBytes('0')).toThrow('PERF_TRACE_MAX_MB');
        expect(keepTrace(undefined)).toBe(false);
        expect(keepTrace('1')).toBe(true);
    });
});

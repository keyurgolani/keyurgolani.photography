// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTsx } from '../../../test/helpers/runTsx';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { atomicWriteFile, atomicWriteJson } from '../atomicWrite';

let data: TempDataRoot;

beforeEach(() => {
    data = createTempDataRoot({ state: 'uninitialized' });
});

afterEach(async () => {
    await data.cleanup();
});

describe('atomicWriteJson', () => {
    it('writes pretty JSON with a trailing newline and leaves no temp file', async () => {
        const file = data.file('doc.json');
        await atomicWriteJson(file, { a: 1, b: ['x'] });
        expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}\n');
        await atomicWriteJson(file, { a: 2 });
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 2 });
        expect(data.files()).toEqual(['doc.json']);
    });

    it('leaves the file readable by its owner only, even when it replaces a wider one', async () => {
        const file = data.file('doc.json');
        await atomicWriteJson(file, { a: 1 });
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        fs.chmodSync(file, 0o644);
        await atomicWriteJson(file, { a: 2 });
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it('keeps the old contents and removes its temp file when a fault hits before the rename', async () => {
        const file = data.file('doc.json');
        await atomicWriteJson(file, { generation: 1 });
        let staged = '';
        await expect(atomicWriteJson(file, { generation: 2 }, {
            faults: {
                beforeRename(tempPath) {
                    staged = tempPath;
                    throw new Error('injected fault before rename');
                },
            },
        })).rejects.toThrow('injected fault before rename');

        expect(path.dirname(staged)).toBe(data.root);
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ generation: 1 });
        expect(data.files()).toEqual(['doc.json']);
    });

    it('has committed once the rename has happened, even if a later step fails', async () => {
        const file = data.file('doc.json');
        await atomicWriteJson(file, { generation: 1 });
        await expect(atomicWriteJson(file, { generation: 2 }, {
            faults: { afterRename() { throw new Error('injected fault after rename'); } },
        })).rejects.toThrow('injected fault after rename');

        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ generation: 2 });
        expect(data.files()).toEqual(['doc.json']);
    });

    it('never creates a missing directory', async () => {
        await expect(atomicWriteFile(data.file('missing', 'doc.json'), 'x')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(fs.existsSync(data.file('missing'))).toBe(false);
    });

    it('survives a process killed mid-write: the target keeps its old bytes, and the next write succeeds', { timeout: 30_000 }, async () => {
        const file = data.file('doc.json');
        await atomicWriteJson(file, { generation: 1 });

        const run = await runTsx('test/helpers/storageWorker.ts', ['crash-write', JSON.stringify({ file, content: '{"generation": 2}\n' })]);
        expect(run.signal, run.stderr).toBe('SIGKILL');

        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ generation: 1 });
        const leftovers = data.files().filter((name) => name !== 'doc.json');
        expect(leftovers).toHaveLength(1);
        expect(leftovers[0]).toMatch(/^\.doc\.json\.\d+\.[0-9a-f-]+\.tmp$/);

        await atomicWriteJson(file, { generation: 3 });
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ generation: 3 });
    });
});

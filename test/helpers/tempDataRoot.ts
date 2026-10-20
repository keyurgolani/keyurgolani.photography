/**
 * Temp data roots for tests. Points PHOTOGRAPHY_DATA_DIR at a fresh temp
 * directory and refuses any root inside the repository, so no test can touch
 * a real portfolio-data folder.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_ROOT_FILE, DATA_ROOT_SCHEMA_VERSION, type DataRootMarker } from '../../lib/storage/config';
import { isInside, realpathLoose } from '../../lib/storage/fsx';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Throws if `dir` resolves inside this repository or the working directory. */
export function assertOutsideRepository(dir: string): void {
    const target = realpathLoose(dir);
    for (const forbidden of new Set([REPO_ROOT, process.cwd()])) {
        if (isInside(target, realpathLoose(forbidden))) {
            throw new Error(`Refusing to use ${dir} as a test data root: it resolves inside ${forbidden}. Use a temp root.`);
        }
    }
}

/** Point PHOTOGRAPHY_DATA_DIR at `dir`. Returns a function that restores the previous value. */
export function setDataDir(dir: string): () => void {
    assertOutsideRepository(dir);
    const previous = process.env.PHOTOGRAPHY_DATA_DIR;
    process.env.PHOTOGRAPHY_DATA_DIR = dir;
    return () => {
        if (previous === undefined) delete process.env.PHOTOGRAPHY_DATA_DIR;
        else process.env.PHOTOGRAPHY_DATA_DIR = previous;
    };
}

/** Write `data-root.json` the way `photos:migrate --apply` will, so the root reads as `ready`. */
export function writeDataRootMarker(root: string, marker: Partial<DataRootMarker> = {}): void {
    const value: DataRootMarker = {
        schemaVersion: DATA_ROOT_SCHEMA_VERSION,
        initializedAt: '2026-01-01T00:00:00.000Z',
        ...marker,
    };
    fs.writeFileSync(path.join(root, DATA_ROOT_FILE), `${JSON.stringify(value, null, 2)}\n`);
}

export interface TempDataRoot {
    /** The root PHOTOGRAPHY_DATA_DIR points at. */
    root: string;
    /** Absolute path inside the root. */
    file(...segments: string[]): string;
    /** Every file under the root, relative to it, sorted. */
    files(): string[];
    /** Restore PHOTOGRAPHY_DATA_DIR and delete the temp root. */
    cleanup(): Promise<void>;
}

export interface TempDataRootOptions {
    /** 'ready' writes data-root.json. 'uninitialized' leaves an empty directory. 'missing' creates nothing. */
    state?: 'ready' | 'uninitialized' | 'missing';
}

export function createTempDataRoot({ state = 'ready' }: TempDataRootOptions = {}): TempDataRoot {
    assertOutsideRepository(os.tmpdir());
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'photography-data-'));
    const root = path.join(parent, 'data');
    const restore = setDataDir(root);
    if (state !== 'missing') {
        fs.mkdirSync(root);
        if (state === 'ready') writeDataRootMarker(root);
    }
    const file = (...segments: string[]) => path.join(root, ...segments);
    return {
        root,
        file,
        files() {
            if (!fs.existsSync(root)) return [];
            return fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
                .filter((relativePath) => fs.statSync(path.join(root, relativePath)).isFile())
                .map((relativePath) => relativePath.split(path.sep).join('/'))
                .sort();
        },
        async cleanup() {
            restore();
            await fs.promises.chmod(root, 0o755).catch(() => undefined);
            await fs.promises.rm(parent, { recursive: true, force: true });
        },
    };
}

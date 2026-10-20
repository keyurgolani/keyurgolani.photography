/**
 * Temp photo libraries for tests. Points PHOTOGRAPHY_LIBRARY_DIR at a fresh
 * temp root and refuses any root inside public/, so no test can touch the
 * real library.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLibrary } from '../fixtures/makeLibrary';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The seven derivatives a source named `<base>.*` gets, relative to the library root. */
export function derivativePaths(base: string): string[] {
    return [
        `thumbnails/${base}.webp`,
        `medium/${base}.webp`,
        `optimized/${base}.webp`,
        `thumbnails-avif/${base}.avif`,
        `medium-avif/${base}.avif`,
        `optimized-avif/${base}.avif`,
        `lqip/${base}.txt`,
    ];
}

/** Resolve symlinks (macOS /tmp is /private/tmp) even when the path doesn't exist yet. */
function realpathLoose(target: string): string {
    const missing: string[] = [];
    let current = path.resolve(target);
    while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) break;
        missing.unshift(path.basename(current));
        current = parent;
    }
    return path.join(fs.realpathSync(current), ...missing);
}

function isInside(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Throws if `dir` resolves inside the repository's public/ folder. */
export function assertOutsidePublic(dir: string): void {
    const target = realpathLoose(dir);
    for (const publicDir of new Set([path.join(REPO_ROOT, 'public'), path.resolve(process.cwd(), 'public')])) {
        if (isInside(target, realpathLoose(publicDir))) {
            throw new Error(`Refusing to use ${dir} as a test library: it resolves inside ${publicDir}. Use a temp root.`);
        }
    }
}

/** Point PHOTOGRAPHY_LIBRARY_DIR at `dir`. Returns a function that restores the previous value. */
export function setLibraryDir(dir: string): () => void {
    assertOutsidePublic(dir);
    const previous = process.env.PHOTOGRAPHY_LIBRARY_DIR;
    process.env.PHOTOGRAPHY_LIBRARY_DIR = dir;
    return () => {
        if (previous === undefined) delete process.env.PHOTOGRAPHY_LIBRARY_DIR;
        else process.env.PHOTOGRAPHY_LIBRARY_DIR = previous;
    };
}

export interface TempLibrary {
    /** The root PHOTOGRAPHY_LIBRARY_DIR points at. */
    root: string;
    /** Absolute path inside the root. */
    file(...segments: string[]): string;
    /** SHA-256 of each existing file, by path relative to the root. */
    hashes(relativePaths: string[]): Record<string, string>;
    /** Every `.tmp` file under the root, relative to it. */
    tempFiles(): string[];
    /** Restore PHOTOGRAPHY_LIBRARY_DIR and delete the temp root. */
    cleanup(): Promise<void>;
}

export interface TempLibraryOptions {
    /** 'basic' writes landscape.jpg, portrait.png, and square.webp. 'extras' adds the edited, rotated, and corrupt files. */
    fixtures?: 'none' | 'basic' | 'extras';
    /** Point PHOTOGRAPHY_LIBRARY_DIR at a root that doesn't exist. */
    missingRoot?: boolean;
}

export async function createTempLibrary({ fixtures = 'none', missingRoot = false }: TempLibraryOptions = {}): Promise<TempLibrary> {
    assertOutsidePublic(os.tmpdir());
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'photography-library-'));
    const root = path.join(parent, 'library');
    const restore = setLibraryDir(root);
    try {
        if (!missingRoot) {
            fs.mkdirSync(root);
            if (fixtures !== 'none') await makeLibrary(root, { extras: fixtures === 'extras' });
        }
    } catch (error) {
        restore();
        fs.rmSync(parent, { recursive: true, force: true });
        throw error;
    }

    const file = (...segments: string[]) => path.join(root, ...segments);

    return {
        root,
        file,
        hashes(relativePaths) {
            const result: Record<string, string> = {};
            for (const relativePath of relativePaths) {
                const absolute = file(relativePath);
                if (fs.existsSync(absolute)) {
                    result[relativePath] = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
                }
            }
            return result;
        },
        tempFiles() {
            if (!fs.existsSync(root)) return [];
            return fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
                .filter((relativePath) => relativePath.endsWith('.tmp'))
                .sort();
        },
        async cleanup() {
            restore();
            await fs.promises.rm(parent, { recursive: true, force: true });
        },
    };
}

/**
 * Import graphs for boundary tests. Walks the imports ts.preProcessFile
 * finds, static and dynamic, type-only ones included, so a walk can only
 * overstate what a module reaches.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { REPO_ROOT } from './runTsx';

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export interface ImportGraph {
    /** Repository modules reached, the entry included, relative to the repository root and sorted. */
    files: string[];
    /** Package and Node built-in specifiers, by the relative path of the module importing them. */
    packages: Map<string, string[]>;
}

const isFile = (candidate: string) => fs.existsSync(candidate) && fs.statSync(candidate).isFile();

/** The file a relative or `@/` specifier names, or null for a package or built-in. Throws when a local one doesn't resolve. */
function resolveLocal(from: string, specifier: string): string | null {
    let base: string;
    if (specifier.startsWith('@/')) base = path.join(REPO_ROOT, specifier.slice(2));
    else if (specifier.startsWith('.') || path.isAbsolute(specifier)) base = path.resolve(path.dirname(from), specifier);
    else return null;
    const stem = base.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
    const candidates = [
        base,
        ...EXTENSIONS.map((extension) => `${stem}${extension}`),
        ...EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
    ];
    const resolved = candidates.find(isFile);
    if (!resolved) throw new Error(`${path.relative(REPO_ROOT, from)} imports ${specifier}, which doesn't resolve to a file.`);
    return resolved;
}

const relative = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join('/');

/**
 * Every module `entry` reaches. `source` stands in for the entry's text, so a
 * test can walk a fixture at a path inside the repository without writing it.
 */
export function importGraph(entry: string, { source }: { source?: string } = {}): ImportGraph {
    const start = path.resolve(REPO_ROOT, entry);
    const seen = new Set<string>();
    const packages = new Map<string, string[]>();
    const queue = [start];
    while (queue.length > 0) {
        const file = queue.pop() as string;
        if (seen.has(file)) continue;
        seen.add(file);
        if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
        const text = file === start && source !== undefined ? source : fs.readFileSync(file, 'utf8');
        const { importedFiles } = ts.preProcessFile(text, true, true);
        for (const { fileName } of importedFiles) {
            const resolved = resolveLocal(file, fileName);
            if (resolved) queue.push(resolved);
            else packages.set(relative(file), [...(packages.get(relative(file)) ?? []), fileName]);
        }
    }
    return { files: [...seen].map(relative).sort(), packages };
}

import fs from 'node:fs';
import path from 'node:path';

/**
 * Every file under `dir`, by `/`-separated path relative to it, sorted, or
 * null when `dir` doesn't exist. A version folder's history and stray temps
 * count too, so equal results mean nothing was committed, staged, or pruned.
 */
export function folderBytes(dir: string): Record<string, string> | null {
    if (!fs.existsSync(dir)) return null;
    return Object.fromEntries(fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter((name) => fs.statSync(path.join(dir, name)).isFile())
        .map((name) => name.split(path.sep).join('/'))
        .sort()
        .map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
}

import fs from 'fs';
import path from 'path';
import { keyOf } from '../lib/identity/scan';
import { libraryRoot } from '../lib/storage/config';

/**
 * Which sources write one set of legacy derivatives. No Sharp and no
 * pipeline here, so the web process can group sources, as `/api/photos`
 * does, without loading either. utils/imageOptimizer.ts re-exports these.
 */

/** A source's name without its extension. Its derivatives share it, so `a.jpg` and `a.png` share one set. */
export function baseNameOf(filename: string): string {
    return path.basename(filename, path.extname(filename));
}

/**
 * Whether two paths are one file, as when a case-insensitive disk resolves two
 * spellings of a name to one entry. Null when lstat fails for a reason other
 * than a missing entry, since then it can't tell.
 */
export function sameFile(a: string, b: string): boolean | null {
    try {
        const first = fs.lstatSync(a, { throwIfNoEntry: false });
        const second = fs.lstatSync(b, { throwIfNoEntry: false });
        return first !== undefined && second !== undefined && first.dev === second.dev && first.ino === second.ino;
    } catch {
        return null;
    }
}

/**
 * A source's base name, folded as the identity scan folds paths. Sources that
 * may write one set of derivatives share it, so the watcher runs their jobs in
 * turn. Whether they do share one is sharesSet()'s call.
 */
export function setKeyOf(filename: string): string {
    return keyOf(baseNameOf(filename));
}

/**
 * Whether two sources write one set of derivatives: when their base names
 * match, such as IMG_1.jpg and IMG_1.png, or differ only in case or Unicode
 * form and the disk resolves both spellings to one file, as a case-insensitive
 * disk does with Beach.jpg and beach.png. On a case-sensitive disk those two
 * have a set each. When lstat can't tell, they count as one.
 */
export function sharesSet(a: string, b: string, root: string = libraryRoot()): boolean {
    const baseA = baseNameOf(a);
    const baseB = baseNameOf(b);
    if (baseA === baseB) return true;
    if (setKeyOf(a) !== setKeyOf(b)) return false;
    return sameFile(path.join(root, b), path.join(root, `${baseA}${path.extname(b)}`)) !== false;
}

/** Sources grouped by the set they write, each group in path order. */
export function setGroups(files: string[], root: string = libraryRoot()): string[][] {
    const groups: string[][] = [];
    const byKey = new Map<string, string[][]>();
    for (const file of [...files].sort()) {
        const candidates = byKey.get(setKeyOf(file)) ?? [];
        const group = candidates.find((members) => sharesSet(members[0], file, root));
        if (group) {
            group.push(file);
            continue;
        }
        const created = [file];
        byKey.set(setKeyOf(file), [...candidates, created]);
        groups.push(created);
    }
    return groups;
}

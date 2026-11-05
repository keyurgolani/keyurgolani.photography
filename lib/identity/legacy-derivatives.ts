import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_FOLDER, DERIVATIVE_FOLDERS } from '../derivativeFolders.mjs';
import { atomicWriteFile } from '../storage/atomicWrite';
import { hasErrorCode, PRIVATE_DIR_MODE } from '../storage/fsx';
import { LibraryRootMissingError, scanLibrary, SOURCE_EXTENSIONS, UNSUPPORTED_EXTENSIONS } from './scan';

/**
 * `photos legacy-derivatives` (#15, v2.0.0 A12): the manifest that says which
 * of the legacy folders a watcher before v1.7.0 wrote may move out of the
 * library, for scripts/host/legacy-move-aside.sh. Those folders carry no
 * marker of their own, and a name is never enough: on a case-insensitive disk
 * `medium` is also the owner's `Medium` album. So this reads the library,
 * read-only, and records only folders whose every file is a derivative of an
 * original the scan sees at the library root. Its one write is
 * `status/legacy-derivatives.json` in the data root. It never writes the
 * library.
 */

export const LEGACY_MANIFEST_SCHEMA_VERSION = 1;

/** How long the script takes a manifest for, from `writtenAt`. */
export const LEGACY_MANIFEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The eight names, in lib/derivativeFolders.mjs's order. */
export const LEGACY_NAMES: readonly string[] = [...Object.keys(DERIVATIVE_FOLDERS), CACHE_FOLDER];

/** The widths the removed /api/image route cached at, and its cache file name: `<base>-<width>-<quality>.<format>`. */
const CACHE_WIDTHS = new Set([400, 800, 1200, 1920]);
const CACHE_FILE = /^(.+)-(\d+)-(\d+)\.(webp|avif)$/;
const CACHE_SUBFOLDER = 'dynamic';

/** Every extension the scan reads as an original, supported or not. */
const ORIGINAL_EXTENSIONS: ReadonlySet<string> = new Set([...SOURCE_EXTENSIONS, ...UNSUPPORTED_EXTENSIONS]);

export interface LegacyFile {
    /** Relative to the folder, POSIX, exactly as on disk. */
    path: string;
    size: number;
    /** Whole seconds since the epoch, as stat's st_mtime. */
    mtime: number;
}

export type LegacyFolder =
    | { name: string; moves: true; files: LegacyFile[]; dirs: string[] }
    | { name: string; moves: false; reason: string };

export interface LegacyManifest {
    schemaVersion: typeof LEGACY_MANIFEST_SCHEMA_VERSION;
    writtenAt: string;
    /** The library root's device and inode, as decimal strings. */
    library: { dev: string; ino: string };
    /** Only the names the library's root holds exactly, case-sensitively, in LEGACY_NAMES order. */
    folders: LegacyFolder[];
}

export function legacyManifestFile(dataRoot: string): string {
    return path.join(/*turbopackIgnore: true*/ dataRoot, 'status', 'legacy-derivatives.json');
}

/** Where the script records each manifest digest it has used, one per line. */
export function legacyManifestUsedFile(dataRoot: string): string {
    return path.join(/*turbopackIgnore: true*/ dataRoot, 'status', 'legacy-derivatives.used');
}

/** A file name without its extension, as the legacy pipeline named a source's derivatives. */
function baseOf(name: string): string {
    return path.posix.basename(name, path.posix.extname(name));
}

/** Why `relative` (inside folder `name`) isn't a legacy derivative of an original in `bases`, or null when it is one. */
function notDerivative(name: string, relative: string, bases: ReadonlySet<string>): string | null {
    const extension = path.posix.extname(relative).toLowerCase();
    if (name === CACHE_FOLDER) {
        if (!relative.startsWith(`${CACHE_SUBFOLDER}/`)) return `isn't in ${CACHE_FOLDER}/${CACHE_SUBFOLDER}/, where the old image route cached`;
        const match = CACHE_FILE.exec(relative.slice(CACHE_SUBFOLDER.length + 1));
        if (match === null || match[1].includes('/')) {
            return ORIGINAL_EXTENSIONS.has(extension) && extension !== '.webp'
                ? "has an original's extension"
                : "isn't named as the old image route's cache named its files";
        }
        const [, base, width, quality] = match;
        if (!CACHE_WIDTHS.has(Number(width)) || Number(quality) < 1 || Number(quality) > 100) return "isn't named as the old image route's cache named its files";
        if (!bases.has(base)) return `names no original at the library root (${base})`;
        return null;
    }
    const own = (DERIVATIVE_FOLDERS as Record<string, string>)[name];
    if (ORIGINAL_EXTENSIONS.has(extension) && extension !== own) return "has an original's extension";
    if (!relative.endsWith(own) || relative.length === own.length) return `isn't a ${own} file named for an original`;
    const base = relative.slice(0, -own.length);
    if (!bases.has(base)) return `names no original at the library root (${base})`;
    return null;
}

/** What one exactly-named root entry is: a folder that moves, with its full listing, or one that stays, and why. */
async function judgeFolder(library: string, name: string, bases: ReadonlySet<string>): Promise<LegacyFolder> {
    const stays = (reason: string): LegacyFolder => ({ name, moves: false, reason });
    const top = path.join(/*turbopackIgnore: true*/ library, name);
    const stat = await fs.promises.lstat(/*turbopackIgnore: true*/ top);
    if (stat.isSymbolicLink()) return stays(`${name} is a symlink`);
    if (!stat.isDirectory()) return stays(`${name} isn't a folder`);

    const files: LegacyFile[] = [];
    const dirs: string[] = [];
    const pending = [''];
    while (pending.length > 0) {
        const relativeDir = pending.pop() as string;
        let names: string[];
        try {
            names = await fs.promises.readdir(/*turbopackIgnore: true*/ path.join(top, relativeDir));
        } catch (error) {
            return stays(`${path.posix.join(name, relativeDir)} can't be read (${hasErrorCode(error, 'EACCES', 'EPERM') ? 'permission denied' : 'an error'})`);
        }
        for (const entry of names) {
            const relative = relativeDir === '' ? entry : `${relativeDir}/${entry}`;
            const shown = `${name}/${relative}`;
            let entryStat: fs.BigIntStats;
            try {
                entryStat = await fs.promises.lstat(/*turbopackIgnore: true*/ path.join(top, relative), { bigint: true });
            } catch {
                return stays(`${shown} can't be read`);
            }
            if (entryStat.isSymbolicLink()) return stays(`${shown} is a symlink`);
            if (entryStat.isDirectory()) {
                if (name === CACHE_FOLDER && relative === CACHE_SUBFOLDER) {
                    dirs.push(relative);
                    pending.push(relative);
                    continue;
                }
                return stays(`${shown} is a folder, and only ${CACHE_FOLDER}/${CACHE_SUBFOLDER}/ may hold one`);
            }
            if (!entryStat.isFile()) return stays(`${shown} isn't a regular file`);
            const reason = notDerivative(name, relative, bases);
            if (reason !== null) return stays(`${shown} ${reason}`);
            files.push({ path: relative, size: Number(entryStat.size), mtime: Number(entryStat.mtimeNs / BigInt(1_000_000_000)) });
        }
    }
    if (files.length === 0) return stays(`${name} holds no derivative`);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { name, moves: true, files, dirs: dirs.sort() };
}

/**
 * Read the library and judge each of the eight names its root holds exactly.
 * Reads only: readdir and lstat on the library, and the identity scan.
 */
export async function buildLegacyManifest(library: string, { clock = Date.now }: { clock?: () => number } = {}): Promise<LegacyManifest> {
    let root: fs.BigIntStats;
    try {
        root = await fs.promises.stat(/*turbopackIgnore: true*/ library, { bigint: true });
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) throw new LibraryRootMissingError(library);
        throw error;
    }
    if (!root.isDirectory()) throw new LibraryRootMissingError(library);
    const scan = await scanLibrary(library, { clock });
    const bases = new Set(scan.entries.filter((entry) => entry.kind === 'source' && !entry.path.includes('/')).map((entry) => baseOf(entry.path)));
    // A real listing, so `Medium` is never taken for `medium`, as a stat of a constructed path would on a case-insensitive disk.
    const present = new Set(await fs.promises.readdir(/*turbopackIgnore: true*/ library));
    const folders: LegacyFolder[] = [];
    for (const name of LEGACY_NAMES) {
        if (present.has(name)) folders.push(await judgeFolder(library, name, bases));
    }
    return {
        schemaVersion: LEGACY_MANIFEST_SCHEMA_VERSION,
        writtenAt: new Date(clock()).toISOString(),
        library: { dev: String(root.dev), ino: String(root.ino) },
        folders,
    };
}

/**
 * The manifest file's text. The manifest itself is a JSON string inside it,
 * so its digest covers exact bytes that the script, in perl, can check
 * without re-serializing anything.
 */
export function sealLegacyManifest(manifest: LegacyManifest): string {
    const body = JSON.stringify(manifest);
    const digest = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
    return `${JSON.stringify({ schemaVersion: LEGACY_MANIFEST_SCHEMA_VERSION, digest, manifest: body }, null, 2)}\n`;
}

/** Write `status/legacy-derivatives.json` atomically, owner-only, creating `status/` if it's missing. */
export async function writeLegacyManifest(dataRoot: string, manifest: LegacyManifest): Promise<string> {
    const file = legacyManifestFile(dataRoot);
    try {
        await fs.promises.mkdir(/*turbopackIgnore: true*/ path.dirname(file), { mode: PRIVATE_DIR_MODE });
    } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
    await atomicWriteFile(file, sealLegacyManifest(manifest));
    return file;
}

/** One line per folder, for the owner: what moves and what stays, and why. */
export function legacyManifestLines(manifest: LegacyManifest): string[] {
    if (manifest.folders.length === 0) return ['None of the eight legacy folders is at the top of the library, by its exact name. Nothing will move.'];
    return manifest.folders.map((folder) => (folder.moves
        ? `  ${folder.name}: moves aside, ${folder.files.length} ${folder.files.length === 1 ? 'file' : 'files'}`
        : `  ${folder.name}: stays, because ${folder.reason}`));
}

/** `photos legacy-derivatives`: build the manifest and write it. Exits 0 when written. */
export async function runLegacyDerivativesCommand({ dataRoot, library, clock = Date.now }: { dataRoot: string; library: string; clock?: () => number }): Promise<{ exitCode: 0; output: string }> {
    const manifest = await buildLegacyManifest(library, { clock });
    await writeLegacyManifest(dataRoot, manifest);
    const lines = [
        'The legacy folders at the top of the library, by exact name:',
        ...legacyManifestLines(manifest),
        '',
        'Wrote status/legacy-derivatives.json in the data root, and nothing else. The library was only read.',
        'It holds for 24 hours and one --apply. On the host, give it to scripts/host/legacy-move-aside.sh with --manifest, dry run first, as the README\'s "Moving the legacy derivatives aside" shows.',
    ];
    return { exitCode: 0, output: `${lines.join('\n')}\n` };
}

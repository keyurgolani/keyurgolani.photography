import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fsyncDirectory, hasErrorCode, PRIVATE_DIR_MODE } from './fsx';

export const MANIFEST_FILE = 'manifest.json';

export interface AssetIdentity {
    photoId: string;
    assetRevision: string;
    profileId: string;
}

export interface ManifestFileEntry {
    bytes: number;
    /** 64 lowercase hex. */
    sha256: string;
}

/**
 * The part of a derivative set's `manifest.json` that publishing checks:
 * whose set it is, and the size and digest of every file, stored as
 * `<variant>.<format>` beside the manifest.
 */
export interface DirectoryManifest extends AssetIdentity {
    variants: Record<string, Record<string, ManifestFileEntry>>;
}

/** A final directory that exists but doesn't match what was about to be published. */
export class IntegrityError extends Error {
    readonly dir: string;
    readonly problems: string[];

    constructor(dir: string, problems: string[]) {
        super(`${dir} does not hold a valid derivative set: ${problems.join('; ')}`);
        this.name = 'IntegrityError';
        this.dir = dir;
        this.problems = problems;
    }
}

const FILE_PART = /^[a-z0-9]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Every file a manifest lists, by name. Throws on a name that could leave the directory. */
export function manifestFiles(manifest: DirectoryManifest): { name: string; bytes: number; sha256: string }[] {
    const files: { name: string; bytes: number; sha256: string }[] = [];
    for (const [variant, formats] of Object.entries(manifest.variants)) {
        for (const [format, entry] of Object.entries(formats)) {
            if (!FILE_PART.test(variant) || !FILE_PART.test(format)) throw new Error(`Invalid manifest entry ${variant}.${format}`);
            files.push({ name: `${variant}.${format}`, bytes: entry.bytes, sha256: entry.sha256 });
        }
    }
    return files;
}

function isManifest(value: unknown): value is DirectoryManifest {
    if (typeof value !== 'object' || value === null) return false;
    const { photoId, assetRevision, profileId, variants } = value as Partial<DirectoryManifest>;
    if (typeof photoId !== 'string' || typeof assetRevision !== 'string' || typeof profileId !== 'string') return false;
    if (typeof variants !== 'object' || variants === null) return false;
    return Object.values(variants).every((formats) =>
        typeof formats === 'object' && formats !== null &&
        Object.values(formats).every((entry) =>
            typeof entry === 'object' && entry !== null &&
            Number.isInteger(entry.bytes) && entry.bytes > 0 &&
            typeof entry.sha256 === 'string' && SHA256_HEX.test(entry.sha256)));
}

/** Read `<dir>/manifest.json`. Null when the directory or manifest is missing; throws when it is malformed. */
export async function readDirectoryManifest(dir: string): Promise<DirectoryManifest | null> {
    let text: string;
    try {
        text = await fs.promises.readFile(path.join(dir, MANIFEST_FILE), 'utf8');
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return null;
        throw error;
    }
    const value: unknown = JSON.parse(text);
    if (!isManifest(value)) throw new Error(`${path.join(dir, MANIFEST_FILE)} is not a valid manifest`);
    return value;
}

async function sha256Of(file: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex');
}

/**
 * List what is wrong with `dir` as the derivative set for `identity`: a
 * missing or malformed manifest, a manifest for another photo, revision, or
 * profile, or a listed file that is missing or whose size or SHA-256 differs.
 * An empty list means the set is valid.
 */
export async function verifyDirectory(dir: string, identity: AssetIdentity): Promise<string[]> {
    let manifest: DirectoryManifest | null;
    try {
        manifest = await readDirectoryManifest(dir);
    } catch (error) {
        return [`unreadable manifest: ${(error as Error).message}`];
    }
    if (!manifest) return ['no manifest'];

    const problems: string[] = [];
    for (const field of ['photoId', 'assetRevision', 'profileId'] as const) {
        if (manifest[field] !== identity[field]) problems.push(`${field} is ${manifest[field]}, expected ${identity[field]}`);
    }
    let files: ReturnType<typeof manifestFiles>;
    try {
        files = manifestFiles(manifest);
    } catch (error) {
        return [...problems, (error as Error).message];
    }
    if (files.length === 0) problems.push('the manifest lists no files');
    for (const file of files) {
        const target = path.join(dir, file.name);
        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(target);
        } catch {
            problems.push(`${file.name} is missing`);
            continue;
        }
        if (!stat.isFile()) {
            problems.push(`${file.name} is not a file`);
        } else if (stat.size !== file.bytes) {
            problems.push(`${file.name} is ${stat.size} bytes, expected ${file.bytes}`);
        } else if ((await sha256Of(target)) !== file.sha256) {
            problems.push(`${file.name} does not match its sha256`);
        }
    }
    return problems;
}

/** fsync every file the manifest lists, the manifest, and the directory itself. */
async function syncDirectory(dir: string, manifest: DirectoryManifest): Promise<void> {
    for (const name of [...manifestFiles(manifest).map((file) => file.name), MANIFEST_FILE]) {
        const handle = await fs.promises.open(path.join(dir, name), 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    }
    await fsyncDirectory(dir);
}

/**
 * Move a fully written staging directory to its final path with one rename,
 * after checking it against its own manifest and syncing it to disk, so a torn
 * set can never become a final one. If the final directory already exists and
 * is a valid set for the same photo, revision, and profile, it is kept and the
 * staging copy is discarded, so a rebuild after a crash is a no-op. Any other
 * existing directory throws IntegrityError and is left untouched, as is the
 * staging directory.
 *
 * Returns whether this call published the staging directory.
 */
export async function publishDirectory(stagingDir: string, finalDir: string): Promise<{ published: boolean }> {
    const staged = await readDirectoryManifest(stagingDir);
    if (!staged) throw new Error(`${stagingDir} has no ${MANIFEST_FILE}`);
    const identity: AssetIdentity = { photoId: staged.photoId, assetRevision: staged.assetRevision, profileId: staged.profileId };
    const stagedProblems = await verifyDirectory(stagingDir, identity);
    if (stagedProblems.length > 0) throw new IntegrityError(stagingDir, stagedProblems);
    await syncDirectory(stagingDir, staged);

    const parent = path.dirname(finalDir);
    await fs.promises.mkdir(parent, { recursive: true, mode: PRIVATE_DIR_MODE });
    if (!fs.existsSync(finalDir)) {
        try {
            await fs.promises.rename(stagingDir, finalDir);
            await fsyncDirectory(parent);
            return { published: true };
        } catch (error) {
            // Another writer published first. Fall through and check what it wrote.
            if (!hasErrorCode(error, 'EEXIST', 'ENOTEMPTY')) throw error;
        }
    }

    const problems = await verifyDirectory(finalDir, identity);
    if (problems.length > 0) throw new IntegrityError(finalDir, problems);
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
    return { published: false };
}

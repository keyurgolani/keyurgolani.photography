import fs from 'node:fs';
import path from 'node:path';
import { versionFile } from '../../lib/storage/document';
import { identityPaths } from '../../lib/identity/registry';

/**
 * The identity registry as files, for tests: it is the version folder
 * `identity/registry/`, and the document is its newest `v<N>.json`
 * (lib/storage/document.ts).
 */

/** The highest version number in the registry folder, or 0 when it has none. */
export function newestRegistryVersion(root: string): number {
    const dir = identityPaths(root).registry;
    if (!fs.existsSync(dir)) return 0;
    return Math.max(0, ...fs.readdirSync(dir).map((name) => /^v([1-9]\d*)\.json$/.exec(name)).filter((match) => match !== null).map((match) => Number(match[1])));
}

/** The newest version file. Throws when there is none. */
export function newestRegistryFile(root: string): string {
    const version = newestRegistryVersion(root);
    if (version === 0) throw new Error(`No registry version in ${identityPaths(root).registry}`);
    return versionFile(identityPaths(root).registry, version);
}

/** The newest version, parsed. */
export function readNewestRegistry(root: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(newestRegistryFile(root), 'utf8')) as Record<string, unknown>;
}

/**
 * A hand edit as docs/data-root.md describes it: copy the newest version to
 * the next number and edit the copy, leaving its stamp. Returns the new file.
 */
export function handEditRegistry(root: string, edit: (value: Record<string, unknown>) => void): string {
    const value = readNewestRegistry(root);
    edit(value);
    const file = versionFile(identityPaths(root).registry, newestRegistryVersion(root) + 1);
    fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx' });
    return file;
}

/** Lay down `text` as registry version `version`, such as one from a newer build. Returns the file. */
export function writeRegistryFile(root: string, version: number, text: string): string {
    const dir = identityPaths(root).registry;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `v${version}.json`);
    fs.writeFileSync(file, text);
    return file;
}

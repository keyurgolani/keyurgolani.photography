// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeAbandonedStaging } from '../derivatives';

/**
 * #181's A10 review, the coordinator's item 11: the watcher's start-up clear
 * of `staging/` stays on the delete rail with a guard. It removes only direct
 * children of `staging/` that builds left, follows no symlink (one is
 * unlinked as a link), and stays inside `staging/` by dev:inode, checked again
 * right before each delete. Test values in temp folders only, and the test
 * itself deletes nothing.
 */

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

/** Every path under `dir` with the sha256 of each file, so any changed byte shows. */
function hashes(dir: string): Map<string, string> {
    const found = new Map<string, string>();
    const walk = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            const relative = path.relative(dir, full);
            if (entry.isDirectory()) {
                found.set(relative, 'dir');
                walk(full);
            } else if (entry.isSymbolicLink()) found.set(relative, `link ${fs.readlinkSync(full)}`);
            else found.set(relative, createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
        }
    };
    walk(dir);
    return found;
}

/** A data root with a killed build's staging folder and one asset set, and a library beside it with a folder a build's name could match. */
function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-clear-'));
    const root = path.join(dir, 'data');
    const staging = path.join(root, 'staging');
    fs.mkdirSync(path.join(staging, 'killed-build'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'killed-build', 'w400.webp'), 'partial');
    const set = path.join(root, 'assets', 'ph_00000000-0000-4000-8000-000000000001', `sha256-${'a'.repeat(64)}`, 'p_0000000000000001');
    fs.mkdirSync(set, { recursive: true });
    fs.writeFileSync(path.join(set, 'w400.webp'), 'a published derivative');
    fs.writeFileSync(path.join(set, 'manifest.json'), '{}');
    const library = path.join(dir, 'library');
    fs.mkdirSync(path.join(library, 'trips'), { recursive: true });
    fs.writeFileSync(path.join(library, 'trips', 'original.jpg'), "the owner's original");
    return { dir, root, staging, library };
}

describe("the watcher's start-up staging clear (item 11)", () => {
    it('unlinks a symlink planted in staging/ as a link, and leaves assets/ and a library folder it points at byte for byte', async () => {
        const { root, staging, library } = setup();
        fs.symlinkSync(path.join(root, 'assets'), path.join(staging, 'assets-link'));
        fs.symlinkSync(path.join(library, 'trips'), path.join(staging, 'library-link'));
        const assets = hashes(path.join(root, 'assets'));
        const owner = hashes(library);

        const removed = await removeAbandonedStaging(root, { logger: quiet });

        expect(removed).toEqual(['assets-link', 'killed-build', 'library-link']);
        expect(fs.readdirSync(staging)).toEqual([]);
        expect(hashes(path.join(root, 'assets'))).toEqual(assets);
        expect(hashes(library)).toEqual(owner);
    });

    it('clears nothing when staging/ itself is a symlink, here to a library folder', async () => {
        const { dir, root, staging, library } = setup();
        fs.renameSync(staging, path.join(dir, 'staging-moved'));
        fs.symlinkSync(library, staging);
        const owner = hashes(library);

        const removed = await removeAbandonedStaging(root, { logger: quiet });

        expect(removed).toEqual([]);
        expect(hashes(library)).toEqual(owner);
        expect(hashes(path.join(dir, 'staging-moved'))).toEqual(new Map([['killed-build', 'dir'], [path.join('killed-build', 'w400.webp'), createHash('sha256').update('partial').digest('hex')]]));
    });

    it('checks staging/ by dev:inode right before each delete, so one swapped for a symlink after the listing removes nothing', async () => {
        const { dir, root, staging, library } = setup();
        const owner = hashes(library);
        const removed = await removeAbandonedStaging(root, {
            logger: quiet,
            hooks: {
                beforeClear: () => {
                    // After the listing and the build lock, staging/ is swapped for a link to the library, which has a trips/ too.
                    fs.renameSync(staging, path.join(dir, 'staging-moved'));
                    fs.mkdirSync(path.join(library, 'killed-build'));
                    fs.writeFileSync(path.join(library, 'killed-build', 'mine.jpg'), "the owner's");
                    fs.symlinkSync(library, staging);
                },
            },
        });
        expect(removed).toEqual([]);
        expect(hashes(library)).toEqual(new Map([...owner, ['killed-build', 'dir'], [path.join('killed-build', 'mine.jpg'), createHash('sha256').update("the owner's").digest('hex')]]));
        expect(fs.existsSync(path.join(dir, 'staging-moved', 'killed-build', 'w400.webp'))).toBe(true);
    });

    it('leaves alone what a build never names: a file, and a name with no build lock shape', async () => {
        const { root, staging } = setup();
        fs.writeFileSync(path.join(staging, 'notes.txt'), 'not a build');
        fs.mkdirSync(path.join(staging, 'Not_A_Build'));
        expect(await removeAbandonedStaging(root, { logger: quiet })).toEqual(['killed-build']);
        expect(fs.readdirSync(staging).sort()).toEqual(['Not_A_Build', 'notes.txt']);
    });
});

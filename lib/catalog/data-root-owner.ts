import fs from 'node:fs';

/**
 * The A11 coordinator's ruling (c), for #15's takedown files: a command that
 * writes into `catalog/tombstones/` must run as the uid that owns the data
 * root, the one `web` runs as. Purge, revoke and GC write those files `0600`,
 * so one written as another uid is a file `web` can't read: `/media` passes it
 * over and serves the set as the live revision says, and `assets.tombstoned`
 * stops every publish and rollback until it reads again. In production every
 * container, and so every `run --rm` command, is uid 1001
 * (docker-compose.prod.yml).
 *
 * Returns null when the uids match, or the refusal to print, which says
 * nothing was written. Windows has no `process.getuid()` and no uid to
 * compare, so there the check is skipped and this returns null.
 */
export function ownerRefusal(root: string, command: string): string | null {
    if (typeof process.getuid !== 'function') return null;
    const uid = process.getuid();
    const owner = fs.statSync(root).uid;
    if (uid === owner) return null;
    return `${command} runs as uid ${uid}, but uid ${owner} owns the data root, and web runs as that owner. A takedown file this uid writes is one web can't read, so it would serve the set anyway and stop every publish. Nothing was written. Run it as uid ${owner}, as docker-compose.prod.yml runs every container and its run --rm commands: docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs …`;
}

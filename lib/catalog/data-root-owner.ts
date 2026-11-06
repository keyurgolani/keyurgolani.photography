import fs from 'node:fs';

/**
 * The A11 coordinator's ruling (c), and review round 2, for #15's takedown
 * files: a command that writes into `catalog/tombstones/`, or deletes as GC,
 * must run as the uid that owns the data root, the one `web` runs as. Purge,
 * revoke and GC write those files `0600`, so one written as another uid is a
 * file `web` can't read. In production every container, and so every
 * `run --rm` command, is uid 1001 (docker-compose.prod.yml).
 *
 * Each caller asks before it takes any lock: a lock file, or a whole
 * `locks/`, left by a killed run as another uid would stop every command of
 * the owner's.
 *
 * The effective uid is the one that owns what a process creates, so it's
 * the one compared, with the real uid as a fallback. The data root is
 * `stat()`ed, through any symlink to the folder itself. Returns null when
 * the uids match, or the refusal to print, which says nothing was written.
 * Windows has neither `process.geteuid()` nor `process.getuid()`, and no uid
 * to compare, so there the check is skipped and this returns null.
 */

export type OwnerCommand = 'purge' | 'revoke' | 'gc';

const COMMANDS: Record<OwnerCommand, { name: string; breaks: string }> = {
    purge: {
        name: 'photos purge --yes',
        breaks: "A tombstone this uid writes is one web can't read: /media would pass it over and serve the set as the live revision says, and every publish and rollback would stop on assets.tombstoned.",
    },
    revoke: {
        name: 'photos purge --revoke --yes',
        breaks: "A revoke this uid writes is one web can't read: /media would keep answering 410 for the sets, and every publish and rollback would stop on assets.tombstoned.",
    },
    gc: {
        name: 'photos gc --apply',
        breaks: "A marker this uid writes in catalog/tombstones/ is one web can't read, which would keep its sets at 410 and stop every publish and rollback on assets.tombstoned. GC deletes and writes its markers only as the data root's owner.",
    },
};

function effectiveUid(): number | null {
    if (typeof process.geteuid === 'function') return process.geteuid();
    if (typeof process.getuid === 'function') return process.getuid();
    return null;
}

export function ownerRefusal(root: string, command: OwnerCommand): string | null {
    const uid = effectiveUid();
    if (uid === null) return null;
    const owner = fs.statSync(root).uid;
    if (uid === owner) return null;
    const { name, breaks } = COMMANDS[command];
    return `${name} runs as uid ${uid}, but uid ${owner} owns the data root, and web runs as that owner. ${breaks} Nothing was written. Run it as uid ${owner}, as docker-compose.prod.yml runs every container and its run --rm commands: docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs …`;
}

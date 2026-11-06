import fs from 'node:fs';

/**
 * The A11 coordinator's ruling (c), and rounds 2 and 3: a command that takes
 * a lock or writes under the data root runs only as the uid that owns it,
 * the one `web`, the watcher and the curator run as. Everything they write
 * is `0600` in `0700` folders, lock files included, so a file another uid
 * writes is one the owner can't read, and a lock file a killed run leaves
 * as another uid stops every command of the owner's. In production every
 * container, and so every `run --rm` command, is uid 1001
 * (docker-compose.prod.yml).
 *
 * lib/catalog/owner-gate.ts says which commands write. Its gate, in
 * scripts/photos.ts and at the watcher's start, asks here before the
 * command's first lock.
 *
 * The effective uid is the one that owns what a process creates, so it's
 * the one compared, with the real uid as a fallback. The data root is
 * `stat()`ed, through any symlink to the folder itself. Returns null when
 * the uids match, or the refusal to print, which says nothing was written.
 * Windows has neither `process.geteuid()` nor `process.getuid()`, and no uid
 * to compare, so there the check is skipped and this returns null.
 */

/** What a writer writes, for what its file would break as another uid. */
export type WriterKind =
    | 'tombstone'
    | 'revoke'
    | 'gc-apply'
    | 'set-aside'
    | 'identity'
    | 'migration-plan'
    | 'authored'
    | 'catalog'
    | 'verify'
    | 'curation'
    | 'watcher';

export const BREAKS: Record<WriterKind, string> = {
    tombstone: "A tombstone this uid writes is one web can't read: /media would pass it over and serve the set as the live revision says, and every publish and rollback would stop on assets.tombstoned.",
    revoke: "A revoke this uid writes is one web can't read: /media would keep answering 410 for the sets, and every publish and rollback would stop on assets.tombstoned.",
    'gc-apply': "A marker this uid writes in catalog/tombstones/ is one web can't read, which would keep its sets at 410 and stop every publish and rollback on assets.tombstoned. GC deletes and writes its markers only as the data root's owner.",
    'set-aside': "A folder this uid moves into trash/ would be one the owner's commands can't read, move or clear, and the lock file it takes, left behind if it's killed, would stop every one of them.",
    identity: "A registry version, decision or mapping this uid writes is one the watcher and every command of the owner's can't read, so no photo would get an ID or a set until the file is fixed by hand.",
    'migration-plan': "A plan and report this uid writes in identity/migration/ are ones photos migrate --apply, run as the owner, can't read.",
    authored: "A working-layer record this uid writes is one the curator, photos publish and every command of the owner's can't read, so the draft would stop until the file is fixed by hand.",
    catalog: "A candidate, revision, activation or pointer this uid writes is one web can't read, so the site would stop serving the catalog, and every publish and rollback of the owner's would stop on it.",
    verify: "A status/verify.json this uid writes is one the owner can't read, so every photos rollback and the curator's Publish screen would stop on it until photos verify runs as the owner.",
    curation: "An Inbox item or decision this uid writes is one the watcher, the curator and every command of the owner's can't read, so the Inbox would stop until the file is fixed by hand.",
    watcher: "Sets, registry versions, Inbox items and the heartbeat this uid writes are ones web and every command of the owner's can't read: /media would 404 the new sets, and the healthcheck would fail.",
};

function effectiveUid(): number | null {
    if (typeof process.geteuid === 'function') return process.geteuid();
    if (typeof process.getuid === 'function') return process.getuid();
    return null;
}

/** The refusal for `name`, a writer of `kind`, on data root `root`, or null when its uid owns the root. */
export function ownerRefusal(root: string, name: string, kind: WriterKind): string | null {
    const uid = effectiveUid();
    if (uid === null) return null;
    const owner = fs.statSync(root).uid;
    if (uid === owner) return null;
    const how = kind === 'watcher'
        ? `Run it as uid ${owner}, as docker-compose.prod.yml's image-watcher does.`
        : `Run it as uid ${owner}, as docker-compose.prod.yml runs every container and its run --rm commands: docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs …`;
    return `${name} runs as uid ${uid}, but uid ${owner} owns the data root, and web runs as that owner. ${BREAKS[kind]} It took no lock. Nothing was written. ${how}`;
}

import type { AssetRef } from './url';

/**
 * Who may fetch a derivative set from `/media`:
 * - `public`: anyone, cached for a year as immutable.
 * - `private`: this request only, never cached, for #16's previews and #14 slice B's curator.
 * - `gone`: 410, for #15's tombstones.
 * - `deny`: 404, as if the set didn't exist.
 */
export type MediaAccess = 'public' | 'private' | 'gone' | 'deny';

export type MediaAccessPolicy = (ref: AssetRef, request: Request) => MediaAccess | Promise<MediaAccess>;

/** Serves nothing. A handler given no policy gets this one. */
export const denyAll: MediaAccessPolicy = () => 'deny';

/**
 * The public policy: a set is public while the catalog revision being served
 * holds the photo at that asset revision and profile, as `isPublic` says, and
 * denied otherwise, as before the first activation. The web route passes the
 * catalog's isAssetPublic() in, since the watcher and the CLI load this folder
 * and the catalog's reader is server-only.
 */
export function activeRevisionAccess(isPublic: (ref: AssetRef) => boolean | Promise<boolean>): MediaAccessPolicy {
    return async (ref) => ((await isPublic(ref)) ? 'public' : 'deny');
}

/**
 * #15's tombstones first (#181's A10): a set a standing tombstone lists is
 * `gone`, a 410 with `no-store`, whatever `policy` would say, before and
 * after GC deletes its files. Any other set gets `policy`'s answer. The web
 * route passes the catalog's isTombstoned() in, as it does isAssetPublic().
 */
export function withTombstones(isTombstoned: (ref: AssetRef) => boolean | Promise<boolean>, policy: MediaAccessPolicy): MediaAccessPolicy {
    return async (ref, request) => ((await isTombstoned(ref)) ? 'gone' : policy(ref, request));
}

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

/**
 * Server-only PHOTOGRAPHY_MEDIA_ACCESS, read at each request: `deny`, the
 * default, or `all`. Any other value denies, and `unknown` carries it so the
 * caller can say so.
 */
export function mediaAccessMode(): { mode: 'deny' | 'all'; unknown?: string } {
    const value = process.env.PHOTOGRAPHY_MEDIA_ACCESS ?? '';
    if (value === 'all') return { mode: 'all' };
    if (value === '' || value === 'deny') return { mode: 'deny' };
    return { mode: 'deny', unknown: value };
}

/**
 * The access policy until #13 slice C decides it by active-revision
 * membership: every set is public under PHOTOGRAPHY_MEDIA_ACCESS=all, and
 * none is served otherwise.
 */
export const mediaAccess: MediaAccessPolicy = () => (mediaAccessMode().mode === 'all' ? 'public' : 'deny');

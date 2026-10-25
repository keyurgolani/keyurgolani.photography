import { foldName } from '../lib/foldName';

/*
 * The path checks proxy.ts runs. Every path under /assets/photos is private,
 * original sources at any depth and the legacy basename derivatives alike,
 * since the site serves photos only from /media.
 */

/** Decode a request pathname once, the way Next's file lookup does, or return it as sent if it doesn't decode. */
function decodePathname(pathname: string): string {
    try {
        return decodeURIComponent(pathname);
    } catch {
        return pathname;
    }
}

/** An encoded slash or backslash. No URL on this site has one. */
const ENCODED_SEPARATOR = /%(2f|5c)/i;

/** Whether a request pathname, as sent, encodes a slash or a backslash, which `next dev` would decode into a separator. */
export function hasEncodedSeparator(pathname: string): boolean {
    return ENCODED_SEPARATOR.test(pathname);
}

/**
 * The path a request pathname reaches once decoded, the way `next dev`
 * resolves it before it looks for a file: `.` and `..` segments resolved,
 * repeated slashes collapsed, and a backslash read as a slash too.
 */
export function resolvedPathname(pathname: string): string {
    const segments: string[] = [];
    for (const segment of decodePathname(pathname).split(/[/\\]/)) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') segments.pop();
        else segments.push(segment);
    }
    return `/${segments.join('/')}`;
}

/**
 * Whether a request pathname reaches /assets/photos or below it once
 * resolved, compared the way a case-insensitive disk would, where `next dev`
 * serves /Assets/Photos/x.jpg from public/assets/photos/x.jpg. Its first two
 * segments are folded as foldName() folds them, and then only their letters
 * and digits count, which also blocks a few paths no file has, the safe side.
 */
export function isUnderPhotos(pathname: string): boolean {
    const [first, second] = resolvedPathname(pathname).split('/').slice(1).map((segment) => foldName(segment).replace(/[^a-z0-9]/g, ''));
    return first === 'assets' && second === 'photos';
}

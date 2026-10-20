/**
 * The legacy derivative files the site may serve from /assets/photos: top-level
 * files in these folders with these extensions. Every other path under
 * /assets/photos, original sources at any depth included, is private.
 */
export const PUBLIC_DERIVATIVE_FOLDERS: Readonly<Record<string, string>> = {
    thumbnails: '.webp',
    medium: '.webp',
    optimized: '.webp',
    'thumbnails-avif': '.avif',
    'medium-avif': '.avif',
    'optimized-avif': '.avif',
    lqip: '.txt',
};

const PHOTOS_PREFIX = '/assets/photos/';

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
 * serves /Assets/Photos/x.jpg from public/assets/photos/x.jpg.
 */
export function isUnderPhotos(pathname: string): boolean {
    const folded = resolvedPathname(pathname).normalize('NFC').toUpperCase().toLowerCase();
    return folded === '/assets/photos' || folded.startsWith(PHOTOS_PREFIX);
}

/**
 * Whether a request pathname, as sent and possibly percent-encoded, names a
 * public legacy derivative. One that doesn't decode is never one, since Next
 * can't serve such a path either and would answer 500.
 */
export function isPublicDerivativePath(pathname: string): boolean {
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return false;
    }
    if (!decoded.startsWith(PHOTOS_PREFIX)) return false;
    const segments = decoded.slice(PHOTOS_PREFIX.length).split('/');
    if (segments.length !== 2) return false;
    const [folder, name] = segments;
    if (!Object.prototype.hasOwnProperty.call(PUBLIC_DERIVATIVE_FOLDERS, folder)) return false;
    const extension = PUBLIC_DERIVATIVE_FOLDERS[folder];
    // Dot-files there are temp files from an interrupted write, or OS metadata.
    if (name.startsWith('.') || name.length <= extension.length || !name.endsWith(extension)) return false;
    return !name.includes('\\') && !name.includes('\0');
}

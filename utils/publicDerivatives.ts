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
export function decodePathname(pathname: string): string {
    try {
        return decodeURIComponent(pathname);
    } catch {
        return pathname;
    }
}

/**
 * Whether a decoded pathname is /assets/photos or below it, compared the way
 * a case-insensitive disk would, where `next dev` serves /Assets/Photos/x.jpg
 * from public/assets/photos/x.jpg.
 */
export function isUnderPhotos(decoded: string): boolean {
    const folded = decoded.normalize('NFC').toUpperCase().toLowerCase();
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

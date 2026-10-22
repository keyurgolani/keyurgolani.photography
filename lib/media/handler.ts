import fs from 'node:fs';
import { ASSET_REVISION_RE, PHOTO_ID_RE, PROFILE_ID_RE } from '../identity/ids';
import type { AssetManifest } from '../identity/types';
import { dataRootStatus } from '../storage/config';
import { hasErrorCode } from '../storage/fsx';
import { denyAll, type MediaAccessPolicy } from './access';
import { readAssetManifest } from './manifest';
import { mediaFilePath, parseVariantFile } from './path';
import type { AssetRef } from './url';

/**
 * `GET /media/<photoId>/<assetRevision>/<profileId>/<variant>.<format>`.
 * Serves one file of a derivative set from the data root, read at each
 * request, since the standalone server's `public/` is a snapshot taken at
 * startup. It reads only the set's manifest and the file, never the registry
 * or the library. A malformed segment, a denied or missing set, and a data
 * root that isn't ready all give 404, and every 404 and 410 is `no-store`.
 * Found manifests are kept, since a published set never changes; a missing
 * one is read again next time, so a set built later is served.
 */

type Logger = Pick<Console, 'warn'>;

export interface MediaHandlerOptions {
    /** Who may fetch a set. Defaults to denyAll. The web route passes activeRevisionAccess(). */
    access?: MediaAccessPolicy;
    logger?: Logger;
    /** How many found manifests to keep. */
    cacheSize?: number;
}

export interface MediaRouteContext {
    params: Promise<{ photoId: string; assetRevision: string; profileId: string; variant: string }>;
}

const CACHE_CONTROL = { public: 'public, max-age=31536000, immutable', private: 'private, no-store' } as const;

function refused(status: 404 | 410): Response {
    return new Response(null, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/** Whether If-None-Match names `etag`, compared weakly, as RFC 9110 asks of a GET. */
function matches(header: string | null, etag: string): boolean {
    if (header === null) return false;
    return header.split(',').some((candidate) => {
        const tag = candidate.trim();
        return tag === '*' || tag.replace(/^W\//, '') === etag;
    });
}

export function createMediaHandler(options: MediaHandlerOptions = {}): (request: Request, context: MediaRouteContext) => Promise<Response> {
    const { logger = console, cacheSize = 2_000, access = denyAll } = options;
    const manifests = new Map<string, AssetManifest>();

    return async (request, { params }) => {
        const { photoId, assetRevision, profileId, variant } = await params;
        const file = parseVariantFile(variant);
        if (!PHOTO_ID_RE.test(photoId) || !ASSET_REVISION_RE.test(assetRevision) || !PROFILE_ID_RE.test(profileId) || file === null) return refused(404);
        const ref: AssetRef = { photoId, assetRevision, profileId };
        const decision = await access(ref, request);
        if (decision === 'deny') return refused(404);
        if (decision === 'gone') return refused(410);

        const status = dataRootStatus();
        if (status.state !== 'ready' || status.root === null) return refused(404);
        const key = `${status.root}\0${photoId}/${assetRevision}/${profileId}`;
        let manifest = manifests.get(key);
        if (manifest === undefined) {
            const found = await readAssetManifest(ref, { root: status.root });
            if (found === null) return refused(404);
            manifest = found;
            manifests.set(key, found);
            if (manifests.size > cacheSize) manifests.delete(manifests.keys().next().value as string);
        }

        const listed = manifest.variants[file.variant][file.format];
        const etag = `"${listed.sha256}"`;
        const headers = { 'Cache-Control': CACHE_CONTROL[decision], ETag: etag, 'X-Content-Type-Options': 'nosniff' };
        if (matches(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });

        let data: Buffer;
        try {
            data = await fs.promises.readFile(mediaFilePath(ref, file.variant, file.format, status.root));
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT', 'ENOTDIR')) logger.warn(`[media] Could not read ${photoId}/${assetRevision}/${profileId}/${variant}: ${(error as Error).message}`);
            manifests.delete(key);
            return refused(404);
        }
        if (data.length !== listed.bytes) {
            logger.warn(`[media] ${photoId}/${assetRevision}/${profileId}/${variant} is ${data.length} bytes, but its manifest says ${listed.bytes}, so it isn't served.`);
            return refused(404);
        }
        // readFile() fills a plain ArrayBuffer, never a shared one.
        return new Response(data as Uint8Array<ArrayBuffer>, {
            status: 200,
            headers: { ...headers, 'Content-Type': `image/${file.format}`, 'Content-Length': String(data.length) },
        });
    };
}

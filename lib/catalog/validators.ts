import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ifNoneMatchHits } from '../http/conditional';

/**
 * Validators for the public catalog JSON routes in catalog mode: `/api/photos`
 * now, and each `app/api/catalog/**` route as it's added. A route calls
 * catalogJson() once it knows it will answer 200 from a revision, and
 * catalogError() for anything else.
 *
 * The ETag is weak, since Next compresses responses, and covers the route,
 * the revision served, and the build. The body depends on the deployed code
 * as well as the revision, so a deploy that changes the payload changes the
 * tag. There is no `Last-Modified`: a rollback moves the active revision back
 * in time. Every answer, the 304 included, is `no-cache`, so a client or
 * proxy checks again on each use and sees a publish or rollback at once.
 *
 * The tag covers no query parameter, so a route whose body depends on one
 * can't use it as it stands.
 */

export const CATALOG_CACHE_CONTROL = 'no-cache';

/**
 * `.next/BUILD_ID` under `cwd`, trimmed, or null when it's missing or empty.
 * The standalone server and `next start` both run from the folder that holds it.
 */
export function readBuildId(cwd: string = process.cwd()): string | null {
    try {
        const id = fs.readFileSync(path.join(/*turbopackIgnore: true*/ cwd, '.next', 'BUILD_ID'), 'utf8').trim();
        return id === '' ? null : id;
    } catch {
        return null;
    }
}

let processBuildId: string | undefined;

/**
 * This process's build ID, read once. Without a BUILD_ID file (`next dev`,
 * unit tests) it's a random ID per process, so no tag outlives a server
 * that can't say which build it runs.
 */
export function buildId(): string {
    if (processBuildId === undefined) {
        const read = readBuildId();
        if (read === null && process.env.NODE_ENV === 'production') {
            console.error(JSON.stringify({ event: 'catalog.build-id.missing' }));
        }
        processBuildId = read ?? `unbuilt-${randomUUID()}`;
    }
    return processBuildId;
}

/** `W/"<22 base64url characters>"`: the first 132 bits of SHA-256 over the route, revision, and build. */
export function catalogETag(pathname: string, revisionId: string, build: string): string {
    const digest = createHash('sha256').update(JSON.stringify([pathname, revisionId, build])).digest('base64url');
    return `W/"${digest.slice(0, 22)}"`;
}

export interface CatalogJsonOptions {
    /** More headers for every answer, the 304 included, such as `X-Catalog-Mode`. */
    headers?: Record<string, string>;
    /** Defaults to buildId(). */
    buildId?: string;
}

/** A short, path-free name for an error, for the log line. */
export function errorName(error: unknown): string {
    if (typeof error === 'object' && error !== null && typeof (error as NodeJS.ErrnoException).code === 'string') return (error as NodeJS.ErrnoException).code as string;
    return error instanceof Error ? error.name : 'Error';
}

/** An error answer: `no-store`, and no ETag. */
export function catalogError(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return Response.json(body, { status, headers: { ...headers, 'Cache-Control': 'no-store' } });
}

/**
 * The 200 for `revisionId`, or a 304 when `If-None-Match` names its tag or
 * is `*`. The 304 carries the same `ETag`, `Cache-Control`, and
 * `X-Catalog-Revision` and doesn't build the body. A body that throws, or
 * that JSON can't encode, gives a 500 through catalogError().
 */
export async function catalogJson(request: Request, revisionId: string, body: () => unknown, options: CatalogJsonOptions = {}): Promise<Response> {
    const { pathname } = new URL(request.url);
    const etag = catalogETag(pathname, revisionId, options.buildId ?? buildId());
    const headers = { ...options.headers, 'Cache-Control': CATALOG_CACHE_CONTROL, ETag: etag, 'X-Catalog-Revision': revisionId };
    if (ifNoneMatchHits(request.headers.get('if-none-match'), etag)) {
        return new Response(null, { status: 304, headers });
    }
    try {
        // Encoding is inside the try too, so a body JSON can't encode fails the same way.
        return Response.json(await body(), { headers });
    } catch (error) {
        console.error(JSON.stringify({ event: 'catalog.response.failed', route: pathname, error: errorName(error) }));
        return catalogError(500, { reason: 'internal' }, options.headers);
    }
}

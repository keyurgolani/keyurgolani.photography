import { dataRootState, type DataRootState } from '@/lib/storage/config';

/**
 * `GET /api/health`, the web container's healthcheck. Answers 200 whenever
 * the server does, with the data root's state for whoever runs the host:
 * `ready`, `uninitialized`, `unavailable`, or `unset`. It reads only
 * `data-root.json`, never the registry or the library, checks nothing for
 * writing, since the web process never writes the data root, and names no path.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Response {
    let dataRoot: DataRootState;
    try {
        dataRoot = dataRootState();
    } catch {
        // Only a vanished working directory gets here. The server still answers.
        dataRoot = 'unavailable';
    }
    return Response.json({ ok: true, dataRoot }, { headers: { 'Cache-Control': 'no-store' } });
}

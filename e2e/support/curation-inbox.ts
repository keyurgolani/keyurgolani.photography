import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publish } from '../../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../../lib/catalog/testing';
import { authoredRecordDir } from '../../lib/catalog/working-layer';
import { createCurationSink } from '../../lib/curation/sink';
import type { IdentityFact, IdentityFactType } from '../../lib/identity/types';

/**
 * The Inbox e2e's data: a published catalog (one published series, one
 * draft series) plus photographs the registry holds, with ready derivative
 * sets, that no revision or working-layer record holds yet, as new sources
 * arrive. inboxFacts() then opens their inbox items through 14-1's sink, the
 * way the watcher would. Sample values only; nothing here is real.
 */

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const INBOX_SERIES = { published: { id: 'ser_e2e-inbox-harbor', slug: 'inbox-harbor', title: 'Inbox fixture harbor' }, draft: { id: 'ser_e2e-inbox-draft', slug: 'inbox-draft', title: 'Inbox fixture draft' } } as const;
export const PUBLISHED_IDS = [id(1), id(2)] as const;
export const DRAFT_ID = id(3);
/** New photographs, one per case: approve, moved behind the page's back, a cleared decorative flag, a refused answer, and "Leave unassigned". */
export const FRESH = { approve: id(21), stale: id(22), decorative: id(23), refused: id(24), unassigned: id(25), reopen: id(26) } as const;
export const FRESH_SOURCES: Record<string, string> = {
    [FRESH.approve]: 'inbox/arrival-approve.jpg',
    [FRESH.stale]: 'inbox/arrival-stale.jpg',
    [FRESH.decorative]: 'inbox/arrival-decorative.jpg',
    [FRESH.refused]: 'inbox/arrival-refused.jpg',
    [FRESH.unassigned]: 'inbox/arrival-unassigned.jpg',
    [FRESH.reopen]: 'inbox/arrival-reopen.jpg',
};
export const FAILED_SOURCE = 'inbox/raw-frame.heic';

export interface InboxFixture {
    catalog: TestCatalog;
    root: string;
    library: string;
    /** Each photograph's asset revision, from the registry. */
    revisionOf(photoId: string): string;
    cleanup(): Promise<void>;
}

export async function createInboxFixture(): Promise<InboxFixture> {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-inbox-'));
    const root = path.join(temp, 'data');
    const library = path.join(temp, 'library');
    const photo = (photoId: string, sourcePath?: string) => ({ id: photoId, width: 900, height: 600, ...(sourcePath ? { sourcePath } : {}) });
    const catalog = await createTestCatalog({
        root,
        seed: 14,
        withAssets: true,
        photos: [photo(PUBLISHED_IDS[0]), photo(PUBLISHED_IDS[1]), photo(DRAFT_ID), ...Object.values(FRESH).map((photoId) => photo(photoId, FRESH_SOURCES[photoId]))],
        series: [
            { ...INBOX_SERIES.published, photoIds: [...PUBLISHED_IDS] },
            { ...INBOX_SERIES.draft, photoIds: [DRAFT_ID], visibility: 'draft' },
        ],
    });
    // The new photographs reach the registry and the asset store only, as the watcher leaves them.
    for (const photoId of Object.values(FRESH)) fs.rmSync(authoredRecordDir(root, 'photo', photoId), { recursive: true, force: true });
    const outcome = await publish({ dataRoot: root, actor: 'e2e', reason: 'inbox fixture', confirmLaunch: true, logger: { log: () => undefined } });
    if (outcome.outcome !== 'PUBLISHED') throw new Error(`The inbox fixture didn't publish: ${outcome.outcome}: ${outcome.message}`);
    // Their sources sit in the library, so the public paths have something to refuse.
    for (const sourcePath of [...Object.values(FRESH_SOURCES), FAILED_SOURCE]) {
        fs.mkdirSync(path.dirname(path.join(library, sourcePath)), { recursive: true });
        fs.writeFileSync(path.join(library, sourcePath), 'fixture source bytes');
    }
    return {
        catalog,
        root,
        library,
        revisionOf: (photoId) => {
            const record = catalog.registry.photos[photoId];
            if (!record) throw new Error(`No fixture photo ${photoId}`);
            return record.source.observedRevision;
        },
        cleanup: async () => fs.rmSync(temp, { recursive: true, force: true }),
    };
}

function fact(fixture: InboxFixture, type: IdentityFactType, photoId: string | null, extra: Partial<IdentityFact> = {}): IdentityFact {
    const assetRevision = extra.assetRevision ?? (photoId ? fixture.revisionOf(photoId) : `sha256-${'e'.repeat(64)}`);
    const sourcePath = extra.path ?? (photoId ? fixture.catalog.registry.photos[photoId].source.path : FAILED_SOURCE);
    const folder = path.posix.dirname(sourcePath);
    return {
        type,
        factId: randomUUID(),
        key: `${type}:${photoId ?? assetRevision}:${assetRevision}`,
        photoId,
        assetRevision,
        path: sourcePath,
        folder: folder === '.' ? '' : folder,
        observedAt: '2026-02-01T00:00:00.000Z',
        ...extra,
    };
}

/** Open the spec's inbox items, as the watcher's next pass would: the new photographs, a missing published one, and a file the watcher can't read. */
export async function openInboxItems(fixture: InboxFixture): Promise<void> {
    const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
    await createCurationSink({ root: fixture.root, logger: quiet })([
        fact(fixture, 'new', FRESH.approve),
        fact(fixture, 'new', FRESH.stale, { observedAt: '2026-02-01T00:01:00.000Z' }),
        fact(fixture, 'new', FRESH.decorative, { observedAt: '2026-02-01T00:01:10.000Z' }),
        fact(fixture, 'new', FRESH.refused, { observedAt: '2026-02-01T00:01:20.000Z' }),
        fact(fixture, 'new', FRESH.unassigned, { observedAt: '2026-02-01T00:01:30.000Z' }),
        fact(fixture, 'new', FRESH.reopen, { observedAt: '2026-02-01T00:01:40.000Z' }),
        fact(fixture, 'missing', PUBLISHED_IDS[1], { observedAt: '2026-02-01T00:02:00.000Z' }),
        fact(fixture, 'processing-failed', null, { reason: 'unsupported-format', observedAt: '2026-02-01T00:03:00.000Z' }),
    ]);
}

/** Strings no public response may hold while no active revision references the new photographs. */
export function undisclosed(fixture: InboxFixture): string[] {
    return [
        // The draft series' photograph is in the working layer only, so it stays out too.
        DRAFT_ID,
        DRAFT_ID.slice('ph_'.length),
        fixture.revisionOf(DRAFT_ID).slice('sha256-'.length),
        ...Object.values(FRESH),
        ...Object.values(FRESH).map((photoId) => photoId.slice('ph_'.length)),
        ...Object.values(FRESH).map((photoId) => fixture.revisionOf(photoId)),
        ...Object.values(FRESH).map((photoId) => fixture.revisionOf(photoId).slice('sha256-'.length)),
        ...Object.values(FRESH_SOURCES).map((sourcePath) => path.posix.basename(sourcePath)),
        ...Object.values(FRESH_SOURCES).map((sourcePath) => path.posix.basename(sourcePath, '.jpg')),
        path.posix.basename(FAILED_SOURCE),
    ];
}

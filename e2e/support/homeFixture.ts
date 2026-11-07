/**
 * The catalog Home fixture, published: the featured series and a second one
 * from e2e/support/catalog-home.ts, with decodable derivatives, so /media
 * serves real images. publish() activates the first revision the way the
 * owner's launch publish would. playwright.config.ts's catalog server serves
 * it from publish-home-fixture.ts, and a spec with a server of its own
 * publishes its own copy.
 */
import { randomUUID } from 'node:crypto';
import { publish } from '../../lib/catalog/publish';
import {
    CATALOG_LOCK,
    lastCommitted,
    listActivations,
    nextSequence,
    readRevisionFile,
    revisionNumberFor,
    writeActivation,
    writeActivePointer,
    writeRevisionIfAbsent,
} from '../../lib/catalog/repository';
import { revisionIdOf } from '../../lib/catalog/schema';
import type { Activation } from '../../lib/catalog/types';
import { readActivePointer } from '../../lib/catalog/working-layer';
import { createTestCatalog, type TestCatalog } from '../../lib/catalog/testing';
import { withLock } from '../../lib/storage/lock';
import { HOME_FIXTURE_CATALOG, VARIETY_FIXTURE_CATALOG } from '../../test/helpers/homeFixtureCatalogs';
import { HOME_FRAMING } from '../../test/helpers/catalogHome';

export { HOME_FIXTURE_CATALOG, VARIETY_FIXTURE_CATALOG };

/** Publishes the fixture into `root`, an empty data root outside the repository, or a temp one without it. */
export async function publishHomeFixture(root?: string, framing = false): Promise<{ catalog: TestCatalog; revisionId: string }> {
    const framed = <P extends { id: string }>(photo: P) =>
        !framing ? photo : photo.id === HOME_FRAMING.contain ? { ...photo, crop: 'contain' as const, ...HOME_FRAMING.containSize } : photo.id === HOME_FRAMING.focal.photoId ? { ...photo, focalPoint: { ...HOME_FRAMING.focal.focalPoint } } : photo;
    const catalog = await createTestCatalog({ root, ...HOME_FIXTURE_CATALOG, photos: HOME_FIXTURE_CATALOG.photos.map(framed) });
    const result = await publish({ dataRoot: catalog.root, actor: 'e2e', reason: 'fixture', confirmLaunch: true, logger: { log: () => undefined } });
    if (result.outcome !== 'PUBLISHED' || result.revisionId === null) throw new Error(`The Home fixture didn't publish: ${result.outcome}: ${result.message} ${result.issues.map((issue) => issue.code).join(', ')}`);
    return { catalog, revisionId: result.revisionId };
}

/** The Home fixture with HOME_FRAMING's contain crop and focal point (#4, v2.0.0 B7), into `root` or a temp one. */
export function publishHomeFramingFixture(root?: string): Promise<{ catalog: TestCatalog; revisionId: string }> {
    return publishHomeFixture(root, true);
}

/**
 * The variety fixture from e2e/support/catalog-home.ts, published into
 * `root` or a temp one: three featured series, which Home plays as one loop,
 * and one that isn't featured, listed first in Work order.
 */
export async function publishHomeVarietyFixture(root?: string): Promise<{ catalog: TestCatalog; revisionId: string }> {
    const catalog = await createTestCatalog({ root, ...VARIETY_FIXTURE_CATALOG });
    const result = await publish({ dataRoot: catalog.root, actor: 'e2e', reason: 'fixture', confirmLaunch: true, logger: { log: () => undefined } });
    if (result.outcome !== 'PUBLISHED' || result.revisionId === null) throw new Error(`The variety fixture didn't publish: ${result.outcome}: ${result.message} ${result.issues.map((issue) => issue.code).join(', ')}`);
    return { catalog, revisionId: result.revisionId };
}

/**
 * A Home with nothing featured, which publish() and activateRevision() both
 * refuse (refs.non-empty), so this publishes the Home fixture, then writes
 * the same content with no featured series as a revision of its own, under
 * its own content ID, and a committed activation and the active pointer
 * naming it, as #13's writers lay them out. Home's projection then has no
 * featured series: its empty state.
 */
export async function publishEmptyHomeFixture(root?: string): Promise<{ catalog: TestCatalog; revisionId: string }> {
    const { catalog, revisionId: published } = await publishHomeFixture(root);
    const revision = await readRevisionFile(catalog.root, published);
    if (revision === null) throw new Error(`${published} has no revision file`);
    const content = { ...revision.content, site: { ...revision.content.site, featuredSeriesIds: [] } };
    const revisionId = revisionIdOf(content);
    await writeRevisionIfAbsent(catalog.root, { ...revision, revisionId, content });
    await withLock(CATALOG_LOCK, { root: catalog.root }, async () => {
        const activations = await listActivations(catalog.root);
        const pointer = await readActivePointer(catalog.root);
        const last = lastCommitted(activations);
        if (pointer === null || last === null) throw new Error('The Home fixture has nothing active');
        const now = new Date().toISOString();
        const activation: Activation = {
            ...last,
            activationId: `act_${randomUUID()}`,
            sequence: nextSequence(activations),
            kind: 'rollback',
            status: 'committed',
            revisionId,
            revisionNumber: revisionNumberFor(activations, revisionId),
            previousRevisionId: pointer.revisionId,
            previousActivationId: pointer.activationId,
            actor: 'e2e',
            reason: 'empty fixture',
            startedAt: now,
            committedAt: now,
        };
        await writeActivation(catalog.root, activation);
        await writeActivePointer(catalog.root, { revisionId, activationId: activation.activationId }, pointer.version);
    });
    return { catalog, revisionId };
}

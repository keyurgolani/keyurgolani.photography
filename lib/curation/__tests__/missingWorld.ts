import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { publish, type PublishResult } from '../../catalog/publish';
import { writeAuthoredRecord } from '../../catalog/working-layer-writer';
import { buildDerivativeSet, type BuildOptions, type WriterFaults } from '../../identity/derivatives';
import { runReconcilePass, type FactSink } from '../../identity/pass';
import { currentProfileId } from '../../identity/profile';
import { readRegistry } from '../../identity/registry';
import type { DerivativeJob, IdentityFact, Registry } from '../../identity/types';
import { runIdentityOnce } from '../../identity/watcherStep';
import { createCandidateSink, settlingAfterBuild } from '../candidates';
import { eventIdOf, eventKey, type CurationEvent } from '../events';
import { readEvent } from '../repository';
import { createCurationSink } from '../sink';
import { createSourcesSink, recordingFailuresAfterBuild } from '../sources';
import { OWNER, P_COPY, P_PATH, Q_PATH, quiet, SERIES, type Images } from './replacementWorld';

/**
 * #17's missing-source world, on temp roots with real images: P and Q, both
 * built by #10's writer and published in one series, Q first and the cover,
 * with authored copy on P. Each test then deletes, restores, or replaces
 * P's file and runs the watcher's passes, with every sink the watcher
 * registers. The world is made once and copied for each test.
 */

export interface MissingWorld {
    lib: TempLibrary;
    data: TempDataRoot;
    root: string;
    profileId: string;
    p: string;
    q: string;
    /** P's published revision. */
    a: string;
    /** Q's. */
    qa: string;
    revisionId: string;
    /** P's missing item, once a pass reports P missing. */
    missingId: string;
    /** One reconcile pass with the watcher's sinks. */
    pass(): Promise<IdentityFact[]>;
    /** The watcher started again with `--once`: the derivative worker's start, then passes and builds. */
    restart(): Promise<0 | 1>;
    /** One build as the watcher's worker runs it, settling the inbox after. */
    build(job: DerivativeJob, faults?: WriterFaults, options?: Partial<BuildOptions>): ReturnType<typeof buildDerivativeSet>;
    registry(): Promise<Registry>;
    event(id: string): Promise<CurationEvent>;
    publish(options?: { dryRun?: boolean }): Promise<PublishResult>;
    cleanup(): Promise<void>;
}

let ids = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
/** A minute ahead, so files a test just wrote count as settled. */
export const clock = () => Date.now() + 60_000;

export function watcherSinks(): FactSink[] {
    return [createCurationSink({ logger: quiet, clock }), createCandidateSink({ logger: quiet, clock }), createSourcesSink({ logger: quiet, clock })];
}

const watcherBuild = () => recordingFailuresAfterBuild(settlingAfterBuild(buildDerivativeSet, { logger: quiet, clock }), { logger: quiet, clock });

async function passIn(): Promise<IdentityFact[]> {
    const outcome = await runReconcilePass({ clock, idGen: nextId, logger: quiet, sinks: watcherSinks(), clearDelivered: true });
    if (outcome.status !== 'committed') throw new Error(`The pass didn't commit: ${JSON.stringify(outcome)}`);
    return outcome.facts;
}

export function missingEventId(photoId: string, assetRevision: string): string {
    return eventIdOf(eventKey('missing', { photoId, assetRevision, key: `missing:${photoId}:${assetRevision}` }));
}

interface Template {
    parent: string;
    data: string;
    library: string;
    facts: Pick<MissingWorld, 'profileId' | 'p' | 'q' | 'a' | 'qa' | 'revisionId' | 'missingId'>;
}

let template: Template | null = null;

async function makeTemplate(images: Images): Promise<Template> {
    const lib = await createTempLibrary();
    const data = createTempDataRoot();
    try {
        fs.mkdirSync(lib.file('harbor'));
        fs.writeFileSync(lib.file(P_PATH), images.original);
        fs.writeFileSync(lib.file(Q_PATH), images.second);
        await passIn();
        const profileId = currentProfileId();
        const registry = await readRegistry(data.root);
        const byPath = (at: string) => Object.values(registry.photos).find((photo) => photo.source.path === at);
        const [p, q] = [byPath(P_PATH), byPath(Q_PATH)];
        if (!p || !q) throw new Error('The pass did not register both photographs.');
        for (const photo of [p, q]) {
            const outcome = await buildDerivativeSet({ photoId: photo.photoId, assetRevision: photo.source.observedRevision, profileId, path: photo.source.path }, { logger: quiet });
            if (outcome.status !== 'ready') throw new Error(`Building ${photo.photoId} gave ${JSON.stringify(outcome)}`);
        }
        const root = data.root;
        await writeAuthoredRecord({ kind: 'photo', id: q.photoId, assetRevision: q.source.observedRevision, title: 'Fixture title for Q', alt: { kind: 'described', text: 'Fixture description of Q.', reviewed: true } }, { expectedVersion: 0, root });
        await writeAuthoredRecord({ kind: 'photo', id: p.photoId, assetRevision: p.source.observedRevision, ...P_COPY }, { expectedVersion: 0, root });
        await writeAuthoredRecord({
            kind: 'series',
            id: SERIES,
            slug: 'harbor',
            title: 'Fixture harbor',
            statement: 'Fixture statement.',
            shortStatement: 'Fixture short statement.',
            photoIds: [q.photoId, p.photoId],
            cover: { photoId: q.photoId },
            visibility: 'published',
        }, { expectedVersion: 0, root });
        await writeAuthoredRecord({ kind: 'site', featuredSeriesIds: [SERIES], seriesOrder: [SERIES] }, { expectedVersion: 0, root });
        const published = await publish({ dataRoot: root, actor: OWNER, confirmLaunch: true, logger: { log: () => undefined } });
        if (published.outcome !== 'PUBLISHED' || published.revisionId === null) {
            throw new Error(`The first publish gave ${published.outcome}: ${published.message} ${JSON.stringify(published.issues.filter((issue) => issue.severity === 'error'))}`);
        }
        await passIn();

        const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'photography-missing-world-'));
        fs.cpSync(data.root, path.join(parent, 'data'), { recursive: true });
        fs.cpSync(lib.root, path.join(parent, 'library'), { recursive: true });
        return {
            parent,
            data: path.join(parent, 'data'),
            library: path.join(parent, 'library'),
            facts: {
                profileId,
                p: p.photoId,
                q: q.photoId,
                a: p.source.observedRevision,
                qa: q.source.observedRevision,
                revisionId: published.revisionId,
                missingId: missingEventId(p.photoId, p.source.observedRevision),
            },
        };
    } finally {
        await data.cleanup();
        await lib.cleanup();
    }
}

/** A fresh copy of the world, with PHOTOGRAPHY_DATA_DIR and PHOTOGRAPHY_LIBRARY_DIR on it. */
export async function createMissingWorld(images: Images): Promise<MissingWorld> {
    template ??= await makeTemplate(images);
    const lib = await createTempLibrary();
    const data = createTempDataRoot();
    fs.rmSync(lib.root, { recursive: true, force: true });
    fs.rmSync(data.root, { recursive: true, force: true });
    fs.cpSync(template.library, lib.root, { recursive: true });
    fs.cpSync(template.data, data.root, { recursive: true });
    const build = watcherBuild();
    return {
        ...template.facts,
        lib,
        data,
        root: data.root,
        pass: passIn,
        restart: () => runIdentityOnce({
            sinks: watcherSinks(),
            worker: { build: watcherBuild() },
            pass: { clock, idGen: nextId },
            clock,
            logger: quiet,
            sleep: async () => undefined,
        }),
        build: (job, faults = {}, options = {}) => build(job, { logger: quiet, faults, ...options }),
        registry: () => readRegistry(data.root),
        async event(id) {
            const event = await readEvent(data.root, id);
            if (event === null) throw new Error(`No event ${id}`);
            return event;
        },
        publish: (options = {}) => publish({ dataRoot: data.root, actor: OWNER, logger: { log: () => undefined }, ...options }),
        async cleanup() {
            await data.cleanup();
            await lib.cleanup();
        },
    };
}

export function removeMissingTemplate(): void {
    if (template) fs.rmSync(template.parent, { recursive: true, force: true });
    template = null;
}

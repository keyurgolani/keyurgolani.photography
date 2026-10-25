import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { publish } from '../../catalog/publish';
import { readRevisionFile } from '../../catalog/repository';
import type { AuthoredPhoto } from '../../catalog/types';
import { readActivePointer, readAuthoredRecord } from '../../catalog/working-layer';
import { writeAuthoredRecord } from '../../catalog/working-layer-writer';
import { buildDerivativeSet, type BuildOptions, type WriterFaults } from '../../identity/derivatives';
import { runReconcilePass, type FactSink } from '../../identity/pass';
import { currentProfileId } from '../../identity/profile';
import { readRegistry } from '../../identity/registry';
import type { DerivativeJob, IdentityFact } from '../../identity/types';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../identity/variants';
import { createMediaHandler } from '../../media/handler';
import { assetDir } from '../../media/path';
import { mediaUrl, type AssetRef } from '../../media/url';
import { createCandidateSink, settlingAfterBuild } from '../candidates';
import { eventIdOf, eventKey, type CurationEvent } from '../events';
import { readEvent } from '../repository';
import { createCurationSink } from '../sink';

/**
 * #17's replacement world, on temp roots with real images: a library with
 * two photographs, both built by #10's writer and published in one series,
 * P second after Q, with authored copy on P. Then P's file is replaced by
 * other pixels and one pass runs, so #14's sink has opened P's replacement
 * item and the new revision's set is pending. Building it is each test's.
 * The world is made once and copied for each test.
 */

export const SERIES = 'ser_harbor';
export const OWNER = 'owner:test';
export const P_PATH = 'harbor/landscape.jpg';
export const Q_PATH = 'harbor/second.jpg';
export const P_COPY = {
    title: 'Fixture title for P',
    caption: 'Fixture story for P.',
    alt: { kind: 'described' as const, text: 'Fixture description of P.', reviewed: true },
    focalPoint: { x: 0.25, y: 0.75 },
};

export const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

const gradient = (width: number, height: number, tint: number) => {
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([tint, (x * 255) / width, (y * 255) / height], (y * width + x) * 3);
    return sharp(data, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
};

export interface Images {
    original: Buffer;
    replacement: Buffer;
    second: Buffer;
    /** Other pixels again, for a second replacement. */
    third: Buffer;
    /** A photograph added after the first publish, and other pixels for it. */
    fresh: Buffer;
    freshReplacement: Buffer;
}

export async function makeImages(): Promise<Images> {
    // Small, so every variant is the oriented width and the AVIF encodes stay quick.
    return {
        original: await gradient(240, 160, 200),
        replacement: await gradient(240, 160, 40),
        second: await gradient(160, 240, 120),
        third: await gradient(240, 160, 90),
        fresh: await gradient(180, 180, 10),
        freshReplacement: await gradient(180, 180, 240),
    };
}

export interface World {
    lib: TempLibrary;
    data: TempDataRoot;
    root: string;
    profileId: string;
    p: string;
    q: string;
    /** P's published revision. */
    a: string;
    /** P's replacement revision. */
    b: string;
    revisionId: string;
    /** P's replacement item, as the pass opened it. */
    eventId: string;
    /**
     * One reconcile pass with #14's sink and the candidate sink, as the
     * watcher runs it: the same sinks for every pass of a world, as one
     * watcher process keeps them, so only its first pass looks at every item.
     */
    pass(): Promise<IdentityFact[]>;
    /** Pass with new sinks, as a restarted watcher does. */
    restartPass(): Promise<IdentityFact[]>;
    /** Build one set as the watcher's worker does: the writer, then the item settled. */
    build(job: DerivativeJob, faults?: WriterFaults, options?: Partial<BuildOptions>): ReturnType<typeof buildDerivativeSet>;
    job(assetRevision: string): DerivativeJob;
    event(id?: string): Promise<CurationEvent>;
    cleanup(): Promise<void>;
}

let ids = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
const clock = () => Date.now() + 60_000;

function sinks(): FactSink[] {
    return [createCurationSink({ logger: quiet }), createCandidateSink({ logger: quiet })];
}

async function passIn(delivering: FactSink[] = sinks()): Promise<IdentityFact[]> {
    const outcome = await runReconcilePass({ clock, idGen: nextId, logger: quiet, sinks: delivering, clearDelivered: true });
    if (outcome.status !== 'committed') throw new Error(`The pass didn't commit: ${JSON.stringify(outcome)}`);
    return outcome.facts;
}

export function replacementEventId(photoId: string, assetRevision: string, type: 'replaced' | 'metadata-changed' = 'replaced'): string {
    return eventIdOf(eventKey('replacement', { photoId, assetRevision, key: `${type}:${photoId}:${assetRevision}` }));
}

interface Template {
    parent: string;
    data: string;
    library: string;
    facts: Omit<World, 'lib' | 'data' | 'root' | 'pass' | 'restartPass' | 'build' | 'job' | 'event' | 'cleanup'>;
}

let template: Template | null = null;

/** Make the world once, in its own temp folders. */
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
        await writeAuthoredRecord({ kind: 'photo', id: q.photoId, assetRevision: q.source.observedRevision, alt: { kind: 'described', text: 'Fixture description of Q.', reviewed: true } }, { expectedVersion: 0, root });
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

        fs.writeFileSync(lib.file(P_PATH), images.replacement);
        const facts = await passIn();
        const replaced = facts.find((fact) => fact.type === 'replaced' && fact.photoId === p.photoId);
        if (!replaced) throw new Error(`The replacement pass reported ${JSON.stringify(facts.map((fact) => fact.type))}`);

        const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'photography-replacement-world-'));
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
                b: replaced.assetRevision,
                revisionId: published.revisionId,
                eventId: replacementEventId(p.photoId, replaced.assetRevision),
            },
        };
    } finally {
        await data.cleanup();
        await lib.cleanup();
    }
}

/** A fresh copy of the world, with PHOTOGRAPHY_DATA_DIR and PHOTOGRAPHY_LIBRARY_DIR on it. */
export async function createWorld(images: Images): Promise<World> {
    template ??= await makeTemplate(images);
    const lib = await createTempLibrary();
    const data = createTempDataRoot();
    fs.rmSync(lib.root, { recursive: true, force: true });
    fs.rmSync(data.root, { recursive: true, force: true });
    fs.cpSync(template.library, lib.root, { recursive: true });
    fs.cpSync(template.data, data.root, { recursive: true });
    const facts = template.facts;
    const build = settlingAfterBuild(buildDerivativeSet, { logger: quiet });
    const processSinks = sinks();
    const job = (assetRevision: string): DerivativeJob => ({ photoId: facts.p, assetRevision, profileId: facts.profileId, path: P_PATH });
    return {
        ...facts,
        lib,
        data,
        root: data.root,
        pass: () => passIn(processSinks),
        restartPass: () => passIn(),
        job,
        build: (target, faults = {}, options = {}) => build(target, { logger: quiet, faults, ...options }),
        async event(id = facts.eventId) {
            const event = await readEvent(data.root, id);
            if (event === null) throw new Error(`No event ${id}`);
            return event;
        },
        async cleanup() {
            await data.cleanup();
            await lib.cleanup();
        },
    };
}

/** Remove the template once a file's tests are done. */
export function removeTemplate(): void {
    if (template) fs.rmSync(template.parent, { recursive: true, force: true });
    template = null;
}

/** Every file under `dir`, relative to it, with its bytes as base64. Null when `dir` is absent. */
export function treeBytes(dir: string): Record<string, string> | null {
    if (!fs.existsSync(dir)) return null;
    const files: Record<string, string> = {};
    for (const name of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()) {
        const file = path.join(dir, name);
        if (fs.statSync(file).isFile()) files[name.split(path.sep).join('/')] = fs.readFileSync(file).toString('base64');
    }
    return files;
}

export interface Served {
    revisionId: string;
    /** P as the active revision publishes it. */
    photo: { id: string; assetRevision: string; profileId: string; title?: string; caption?: string };
    /** The series' order as published. */
    order: string[];
    /** Each of P's variant URLs, with the status and bytes /media serves for it. */
    media: Record<string, { status: number; bytes: string }>;
    /** What /media gives for one of `other`'s variants, a set the active revision doesn't hold. */
    other: number | null;
}

const refKey = (ref: AssetRef) => `${ref.photoId}/${ref.assetRevision}/${ref.profileId}`;

/**
 * What a visitor gets now: the active revision's record for P, its series
 * order, and P's variants through /media, with access limited to the sets
 * the active revision holds, as 13C's activeRevisionAccess limits it.
 * `other` is a set to show /media keeps refusing.
 */
export async function served(world: Pick<World, 'root' | 'p'>, other?: AssetRef): Promise<Served> {
    const pointer = await readActivePointer(world.root);
    if (!pointer) throw new Error('Nothing is active.');
    const revision = await readRevisionFile(world.root, pointer.revisionId);
    if (!revision) throw new Error(`No revision ${pointer.revisionId}`);
    const held = new Set(revision.content.photos.map((photo) => refKey({ photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId })));
    const handler = createMediaHandler({ access: (ref) => (held.has(refKey(ref)) ? 'public' : 'deny'), logger: quiet });
    const photo = revision.content.photos.find((entry) => entry.id === world.p);
    if (!photo) throw new Error(`The active revision has no ${world.p}.`);
    const get = async (ref: AssetRef, variant: string) => {
        const response = await handler(new Request(`http://127.0.0.1/media/${refKey(ref)}/${variant}`), { params: Promise.resolve({ ...ref, variant }) });
        return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()).toString('base64') };
    };
    const ref = { photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId };
    const media: Served['media'] = {};
    for (const width of VARIANT_WIDTHS) for (const format of VARIANT_FORMATS) media[mediaUrl(ref, width, format)] = await get(ref, `${width}.${format}`);
    return {
        revisionId: pointer.revisionId,
        photo: { id: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId, ...(photo.title ? { title: photo.title } : {}), ...(photo.caption ? { caption: photo.caption } : {}) },
        order: revision.content.series.find((series) => series.id === SERIES)?.photoIds ?? [],
        media,
        other: other ? (await get(other, 'w400.webp')).status : null,
    };
}

/** P's authored record. */
export async function photoRecord(world: Pick<World, 'root' | 'p'>): Promise<AuthoredPhoto> {
    const record = await readAuthoredRecord(world.root, 'photo', world.p);
    if (!record) throw new Error('P has no photo record.');
    return record;
}

/** The set folder for P's revision. */
export function setDir(world: Pick<World, 'root' | 'p' | 'profileId'>, assetRevision: string): string {
    return assetDir({ photoId: world.p, assetRevision, profileId: world.profileId }, world.root);
}

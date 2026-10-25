import fs from 'node:fs';
import path from 'node:path';
import { DERIVATIVE_FOLDERS } from '../derivativeFolders.mjs';
import { legacyUrls } from '../identity/legacyUrls';
import { identityPaths, readStoredRegistry } from '../identity/registry';
import type { TechnicalKey } from '../identity/metadata';
import type { AssetRevisionRecord, PhotoRecord, Registry } from '../identity/types';
import { libraryRoot } from '../storage/config';
import { hasErrorCode } from '../storage/fsx';
import { baseNameOf, setGroups } from '../../utils/derivativeSets';
import { cameraSettingsCaption } from './legacy-photos';
import type { CatalogReader } from './reader';
import type { PublicPhotoRecord } from './types';

/**
 * The two `/api/photos` projections, with the item shape the legacy Gallery
 * and Home read. Legacy mode lists the #10 registry's photos at their legacy
 * derivative URLs, before the first activation. Catalog mode lists the
 * active revision's photos at their `/media` URLs, after it.
 */

/** One `/api/photos` item. `id` is its position in the list. */
export interface ImageItem {
    id: number;
    src: string;
    thumbnail: string;
    medium: string;
    optimized: string;
    thumbnailAvif?: string;
    mediumAvif?: string;
    optimizedAvif?: string;
    /** The photo's upright size. */
    width: number;
    height: number;
    /** The size of the 1920 px WebP, which is smaller than the photo once it is wider than 1920 px. */
    optimizedWidth: number;
    optimizedHeight: number;
    caption?: string;
    /** The capture date at UTC midnight in epoch milliseconds, or 0 when the photo isn't dated. */
    date: number;
    lqip: string;
}

/** `YYYY-MM-DD` at UTC midnight in epoch milliseconds, or 0 without one. */
function dateOf(day: string | null | undefined): number {
    return day ? Date.parse(`${day}T00:00:00.000Z`) : 0;
}

/**
 * Catalog mode: the active revision's photos in Work order, then each
 * series' `photoIds` order, each photo once. Sizes are oriented, and the
 * caption is the photo's alt text, or '' for a decorative one.
 */
export function catalogPhotos(reader: CatalogReader<PublicPhotoRecord>): ImageItem[] {
    const listed = new Set<string>();
    const items: ImageItem[] = [];
    for (const series of reader.listSeries()) {
        for (const photo of reader.photosOf(series.id)) {
            if (listed.has(photo.id)) continue;
            listed.add(photo.id);
            const { w400, w800, w1920 } = photo.variants;
            items.push({
                id: items.length,
                src: w1920.webp.url,
                thumbnail: w400.webp.url,
                medium: w800.webp.url,
                optimized: w1920.webp.url,
                thumbnailAvif: w400.avif.url,
                mediumAvif: w800.avif.url,
                optimizedAvif: w1920.avif.url,
                width: photo.width,
                height: photo.height,
                optimizedWidth: w1920.webp.width,
                optimizedHeight: w1920.webp.height,
                caption: photo.alt.kind === 'described' ? photo.alt.text : '',
                date: dateOf(photo.capturedAt),
                lqip: photo.lqip,
            });
        }
    }
    return items;
}

/** Why legacy mode can't list anything. A missing registry means the migration hasn't run. */
export type LegacyUnavailableReason = 'registry-missing' | 'registry-unreadable';

export type LegacyPhotos = { ok: true; items: ImageItem[] } | { ok: false; reason: LegacyUnavailableReason };

/** The legacy pipeline's 1920 px WebP: inside 1920 by 16383, never enlarged, as utils/imageOptimizer.ts resizes it. */
function optimizedSize(width: number, height: number): { width: number; height: number } {
    const scale = Math.min(1, 1920 / width, 16383 / height);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

interface Candidate {
    photo: PhotoRecord;
    revision: AssetRevisionRecord & { width: number; height: number };
}

/** Asked the way the pipeline asks, so a disk that ignores case answers for every spelling of the name. */
const exists = (file: string) => fs.existsSync(file);

function technicalValues(revision: AssetRevisionRecord): Partial<Record<TechnicalKey, string>> {
    return Object.fromEntries(Object.entries(revision.derived.technical).map(([key, entry]) => [key, entry?.value])) as Partial<Record<TechnicalKey, string>>;
}

/**
 * Legacy mode's list from the registry. Nothing runs Sharp or lists the
 * library: it checks that each listed photo's seven derivative files exist,
 * and reads its LQIP. It takes present photos at the library's top level with a
 * decodable observed revision, one per legacy set, the first by path, as the
 * watcher builds the set from it, and shows each only once all seven of its
 * derivatives exist. Newest capture first, undated last, ties by photo ID.
 */
export async function legacyList(registry: Registry, library: string): Promise<ImageItem[]> {
    const candidates = new Map<string, Candidate>();
    for (const photo of Object.values(registry.photos)) {
        if (!photo.source.present || photo.sourceHealth !== 'present' || photo.mergedInto !== undefined || photo.source.path.includes('/')) continue;
        const revision = photo.revisions[photo.source.observedRevision];
        if (!revision || revision.width === null || revision.height === null) continue;
        candidates.set(photo.source.path, { photo, revision: revision as Candidate['revision'] });
    }

    // Grouped in path order by the watcher's own rule, so a shared set lists the source the watcher built it from.
    const owners = setGroups([...candidates.keys()], library).map(([owner]) => candidates.get(owner) as Candidate);
    const listed = await Promise.all(owners.map(async ({ photo, revision }) => {
        const base = baseNameOf(photo.source.path);
        const files = Object.entries(DERIVATIVE_FOLDERS).map(([folder, extension]) => path.join(/*turbopackIgnore: true*/ library, folder, `${base}${extension}`));
        if (!files.every(exists)) return null;
        let lqip: string;
        try {
            lqip = await fs.promises.readFile(path.join(/*turbopackIgnore: true*/ library, 'lqip', `${base}.txt`), 'utf8');
        } catch {
            return null;
        }
        // The original, then the derivatives in DERIVATIVE_FOLDERS order.
        const [, thumbnail, medium, optimized, thumbnailAvif, mediumAvif, optimizedAvif] = legacyUrls(photo.source.path);
        const size = optimizedSize(revision.width, revision.height);
        const item: Omit<ImageItem, 'id'> = {
            src: optimized,
            thumbnail,
            medium,
            optimized,
            thumbnailAvif,
            mediumAvif,
            optimizedAvif,
            width: revision.width,
            height: revision.height,
            optimizedWidth: size.width,
            optimizedHeight: size.height,
            caption: cameraSettingsCaption(technicalValues(revision)),
            date: dateOf(revision.derived.capturedDate?.value),
            lqip,
        };
        return { photoId: photo.photoId, item };
    }));
    return listed
        .filter((entry) => entry !== null)
        .sort((a, b) => {
            if (a.item.date !== b.item.date) return a.item.date === 0 ? 1 : b.item.date === 0 ? -1 : b.item.date - a.item.date;
            return a.photoId < b.photoId ? -1 : a.photoId > b.photoId ? 1 : 0;
        })
        .map(({ item }, id) => ({ id, ...item }));
}

/** A file's identity, size and times, as a cache key. */
const stampOf = (stat: fs.Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

interface Built {
    /** The registry folder's stamp, and the library, from before the build read the registry. */
    folder: string;
    /** The version file the build read, and its stamp just after. */
    file: string;
    fileStamp: string;
    items: ImageItem[];
}

/** The last list built per data root. */
const built = new Map<string, Built>();

/**
 * Legacy mode's `/api/photos` list. Two stats per call: the registry's
 * version folder, `identity/registry/`, and the version file the last build
 * read. A write links a new version into the folder and prunes old ones,
 * which changes the folder's times, and a version saved in place changes the
 * file's, so the list is built again only when the registry changed since.
 * A folder with no version yet, as a write that stopped before its link
 * leaves it, is `registry-missing`, like no folder.
 */
export async function legacyPhotos(root: string, library: string = libraryRoot()): Promise<LegacyPhotos> {
    const dir = identityPaths(root).registry;
    let folder: string;
    try {
        folder = `${stampOf(await fs.promises.stat(/*turbopackIgnore: true*/ dir))}\0${library}`;
    } catch (error) {
        return { ok: false, reason: hasErrorCode(error, 'ENOENT') ? 'registry-missing' : 'registry-unreadable' };
    }
    const cached = built.get(root);
    if (cached?.folder === folder) {
        const file = await fs.promises.stat(/*turbopackIgnore: true*/ cached.file).then(stampOf, () => null);
        if (file === cached.fileStamp) return { ok: true, items: cached.items };
    }
    let stored: Awaited<ReturnType<typeof readStoredRegistry>>;
    try {
        stored = await readStoredRegistry(root);
    } catch {
        return { ok: false, reason: 'registry-unreadable' };
    }
    if (stored === null) {
        built.delete(root);
        return { ok: false, reason: 'registry-missing' };
    }
    // Pruned already: an empty stamp never matches, so the next call reads again.
    const fileStamp = await fs.promises.stat(/*turbopackIgnore: true*/ stored.file).then(stampOf, () => '');
    const items = await legacyList(stored.registry, library);
    built.set(root, { folder, file: stored.file, fileStamp, items });
    return { ok: true, items };
}

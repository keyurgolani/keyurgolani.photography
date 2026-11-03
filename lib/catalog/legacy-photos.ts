import fs from 'node:fs';
import path from 'node:path';
import { DERIVATIVE_FOLDERS } from '../derivativeFolders.mjs';
import { legacyUrls } from '../identity/legacyUrls';
import type { TechnicalKey } from '../identity/metadata';
import type { AssetRevisionRecord, PhotoRecord, Registry } from '../identity/types';
import { baseNameOf, setGroups } from '../../utils/derivativeSets';

/**
 * The legacy site's photo list, by the #10 registry: what the legacy Gallery
 * and Home showed before the launch, at their legacy derivative URLs. #13's
 * slice E removed both, and `/api/photos`, which served it, so nothing on the
 * visitor side reads it. The CLI still does: publish's launch count, and
 * `photos carry-over`, which carried this list into the catalog at the
 * launch, so both answer as before on a data root that hasn't launched.
 */

/** One entry of the legacy list, as the removed `/api/photos` served it. `id` is its position in the list. */
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
 * Whether the legacy site could list a photo, by the registry alone: present at
 * the library's top level, not merged into another, with a decodable
 * observed revision. legacyList() also needs its seven derivatives on disk,
 * and lists one photo per shared set name, so it can list fewer.
 */
export function onLegacySite(photo: PhotoRecord): boolean {
    if (!photo.source.present || photo.sourceHealth !== 'present' || photo.mergedInto !== undefined || photo.source.path.includes('/')) return false;
    const revision = photo.revisions[photo.source.observedRevision];
    return revision !== undefined && revision.width !== null && revision.height !== null;
}

/**
 * The caption the legacy Gallery built from camera settings, such as
 * "Model | 35mm f/1.8 1/200s ISO 100", from #10's stored technical values,
 * and the legacy list keeps as `caption`. It is never a description, so the
 * description rules refuse alt text that equals it.
 */
export function cameraSettingsCaption(technical: Partial<Record<TechnicalKey, string>>): string {
    const settings: string[] = [];
    if (technical.FocalLength) settings.push(`${technical.FocalLength}mm`);
    if (technical.FNumber) settings.push(`f/${technical.FNumber}`);
    if (technical.ExposureTime) settings.push(`${technical.ExposureTime}s`);
    if (technical.ISO) settings.push(`ISO ${technical.ISO}`);
    const camera = technical.Model ?? '';
    if (settings.length === 0) return camera;
    return camera ? `${camera} | ${settings.join(' ')}` : settings.join(' ');
}

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

/** A photo the legacy site can list by the registry (onLegacySite()) that legacyEntries() leaves out, and why. */
export interface UnlistedLegacyPhoto {
    photoId: string;
    sourcePath: string;
    reason: string;
}

/**
 * The photos the legacy site counted as on it, by the registry and paths
 * alone: every photo onLegacySite() takes, less the ones hidden behind
 * another's shared legacy set, since the Gallery showed only the first by
 * path of each set. A photo whose legacy derivatives aren't all built still counts,
 * so a missing or empty library folder can't make photos look already gone.
 * `hidden` names the ones left out, with why. publish's launch count and
 * `photos carry-over` both read this.
 */
export function legacySitePhotos(registry: Registry, library: string): { onSite: PhotoRecord[]; hidden: UnlistedLegacyPhoto[] } {
    const byPath = new Map<string, PhotoRecord>();
    for (const photo of Object.values(registry.photos)) if (onLegacySite(photo)) byPath.set(photo.source.path, photo);
    const onSite: PhotoRecord[] = [];
    const hidden: UnlistedLegacyPhoto[] = [];
    // Grouped in path order by the watcher's own rule, so a shared set lists the source the watcher built it from.
    for (const [owner, ...others] of setGroups([...byPath.keys()], library)) {
        onSite.push(byPath.get(owner) as PhotoRecord);
        for (const other of others) {
            const photo = byPath.get(other) as PhotoRecord;
            hidden.push({ photoId: photo.photoId, sourcePath: photo.source.path, reason: `it shares its legacy derivative set with ${owner}, so the Gallery shows that one instead` });
        }
    }
    return { onSite, hidden };
}

/**
 * The legacy list from the registry, each entry with its photo and source
 * path, in the order the legacy Gallery showed it: legacyList()'s, which is
 * this. `unlisted` names the photos the registry would put on the legacy
 * site that the list leaves out, so `photos carry-over` can say why.
 */
export async function legacyEntries(registry: Registry, library: string): Promise<{ entries: { photoId: string; sourcePath: string; item: ImageItem }[]; unlisted: UnlistedLegacyPhoto[] }> {
    const { onSite, hidden } = legacySitePhotos(registry, library);
    const unlisted: UnlistedLegacyPhoto[] = [...hidden];
    const owners = onSite.map((photo) => ({ photo, revision: photo.revisions[photo.source.observedRevision] as Candidate['revision'] }));
    const listed = await Promise.all(owners.map(async ({ photo, revision }) => {
        const base = baseNameOf(photo.source.path);
        const files = Object.entries(DERIVATIVE_FOLDERS).map(([folder, extension]) => path.join(/*turbopackIgnore: true*/ library, folder, `${base}${extension}`));
        const missing = { photoId: photo.photoId, sourcePath: photo.source.path };
        if (!files.every(exists)) return { ...missing, reason: "its seven legacy derivatives aren't all built, so the Gallery doesn't show it" };
        let lqip: string;
        try {
            lqip = await fs.promises.readFile(path.join(/*turbopackIgnore: true*/ library, 'lqip', `${base}.txt`), 'utf8');
        } catch {
            return { ...missing, reason: "its legacy LQIP can't be read, so the Gallery doesn't show it" };
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
        return { photoId: photo.photoId, sourcePath: photo.source.path, item };
    }));
    for (const entry of listed) if ('reason' in entry) unlisted.push(entry);
    const entries = listed
        .filter((entry): entry is { photoId: string; sourcePath: string; item: Omit<ImageItem, 'id'> } => 'item' in entry)
        .sort((a, b) => {
            if (a.item.date !== b.item.date) return a.item.date === 0 ? 1 : b.item.date === 0 ? -1 : b.item.date - a.item.date;
            return a.photoId < b.photoId ? -1 : a.photoId > b.photoId ? 1 : 0;
        })
        .map(({ photoId, sourcePath, item }, id) => ({ photoId, sourcePath, item: { id, ...item } }));
    return { entries, unlisted: unlisted.sort((a, b) => (a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0)) };
}

/**
 * The legacy list from the registry, the photos the legacy Gallery showed at
 * the launch, in its order. Nothing runs Sharp or lists the library: it checks that each listed photo's seven derivative files exist,
 * and reads its LQIP. It takes present photos at the library's top level with a
 * decodable observed revision, one per legacy set, the first by path, as the
 * watcher builds the set from it, and shows each only once all seven of its
 * derivatives exist. Newest capture first, undated last, ties by photo ID.
 */
export async function legacyList(registry: Registry, library: string): Promise<ImageItem[]> {
    return (await legacyEntries(registry, library)).entries.map(({ item }) => item);
}

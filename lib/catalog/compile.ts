import { toPublicAsset } from '../identity/metadata';
import { currentProfileId } from '../identity/profile';
import type { AssetRevisionRecord, PhotoRecord, Registry } from '../identity/types';
import { readAssetManifest } from '../media/manifest';
import { CATALOG_SCHEMA_VERSION, parseCandidateFile, revisionIdOf } from './schema';
import type {
    AuthoredAlt,
    AuthoredPhoto,
    AuthoredSeries,
    CandidateAlt,
    CandidateContent,
    CandidateFile,
    CandidatePhotoRecord,
    ExcludedMember,
    RevisionFile,
    SeriesRecord,
    WorkingLayer,
} from './types';

/**
 * Compile: one working-layer snapshot and #10's registry into a candidate,
 * the revision content a publish would write. Published series in Work order
 * with their resolvable members, and those photos by ID, each with the asset
 * half #10's toPublicAsset() builds from the chosen derivative set. It reads
 * manifests and nothing else, and writes nothing.
 *
 * A member is left out, and listed in `excluded`, when it has no photo
 * record, the registry doesn't know it or the asset revision its record pins,
 * or the chosen set isn't ready with a valid manifest. #8's order rules and
 * the asset rules report each kind. A series left with no members, or with no
 * cover, doesn't compile, which the order rules report too.
 */

export interface CompileInput {
    layer: WorkingLayer;
    registry: Registry;
    /** The data root the manifests are read from. */
    root: string;
    /** The active revision, whose photos keep their profiles. Null before the first activation. */
    active: RevisionFile | null;
    /** Move every photo #10 can rebuild to the current profile, ready or not. */
    reprofile?: boolean;
    /** #10's current profile. Defaults to currentProfileId(). */
    profileId?: string;
}

export interface CompileResult {
    content: CandidateContent;
    /** The revision ID the content would get. */
    candidateId: string;
    excluded: ExcludedMember[];
    /** Under `reprofile`: the photos moved to the current profile, and those #10 can't rebuild, which keep theirs. */
    reprofiled: { moved: string[]; kept: string[] } | null;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** An authored text field only when it holds something. */
function present(value: string | undefined): string | undefined {
    return value !== undefined && /\S/.test(value) ? value : undefined;
}

export function candidateAlt(alt: AuthoredAlt): CandidateAlt {
    if (alt === null) return { kind: 'pending' };
    return alt.kind === 'decorative' ? { kind: 'decorative' } : { kind: 'described', text: alt.text };
}

/** Width over height, to four places, the way every revision records it. */
export function aspectRatioOf(width: number, height: number): number {
    return Math.round((width / height) * 10_000) / 10_000;
}

/** The revision a photo record pins, unless the registry doesn't have it or it moved to another photo. */
function pinnedRevision(photo: PhotoRecord | undefined, assetRevision: string): AssetRevisionRecord | null {
    const revision = photo?.revisions[assetRevision];
    return revision && !revision.reassignedTo ? revision : null;
}

/** #10 can rebuild a set only from the bytes its bound path holds now. */
function canRebuild(photo: PhotoRecord, assetRevision: string): boolean {
    return photo.sourceHealth === 'present' && photo.source.present && photo.source.observedRevision === assetRevision;
}

/** The ready profile with the newest readyAt, ties by profile ID, or null. */
function newestReady(revision: AssetRevisionRecord): string | null {
    const ready = Object.entries(revision.profiles)
        .filter(([, entry]) => entry.state === 'ready')
        .sort(([idA, a], [idB, b]) => compare(b.readyAt ?? '', a.readyAt ?? '') || compare(idA, idB));
    return ready[0]?.[0] ?? null;
}

/** The authored half of a public photo record. */
function authoredFields(photo: AuthoredPhoto): Partial<CandidatePhotoRecord> {
    const fields: Partial<CandidatePhotoRecord> = { alt: candidateAlt(photo.alt) };
    for (const key of ['title', 'caption', 'credit', 'location'] as const) {
        const value = present(photo[key]);
        if (value !== undefined) fields[key] = value;
    }
    if (photo.focalPoint) fields.focalPoint = photo.focalPoint;
    if (photo.crop) fields.crop = photo.crop;
    if (photo.accent !== undefined) fields.accent = photo.accent;
    return fields;
}

type Resolved = { ok: true; record: CandidatePhotoRecord } | { ok: false; member: Omit<ExcludedMember, 'seriesId'> };

export async function compileCandidate(input: CompileInput): Promise<CompileResult> {
    const { layer, registry, root, active, reprofile = false } = input;
    const current = input.profileId ?? currentProfileId();
    const photoRecords = new Map(layer.photos.map((photo) => [photo.id, photo]));
    const seriesRecords = new Map(layer.series.map((series) => [series.id, series]));
    const activePhotos = new Map((active?.content.photos ?? []).map((photo) => [photo.id, photo]));
    const moved = new Set<string>();
    const kept = new Set<string>();

    /** The profile a photo publishes on. Active pairs keep theirs, others take the current profile if ready, else their newest ready one. */
    function chooseProfile(photo: PhotoRecord, assetRevision: string, revision: AssetRevisionRecord): string {
        const activePhoto = activePhotos.get(photo.photoId);
        const activeProfile = activePhoto && activePhoto.assetRevision === assetRevision ? activePhoto.profileId : null;
        const usual = activeProfile ?? (revision.profiles[current]?.state === 'ready' ? current : newestReady(revision) ?? current);
        if (!reprofile) return usual;
        if (canRebuild(photo, assetRevision)) {
            if (usual !== current) moved.add(photo.photoId);
            return current;
        }
        if (usual !== current) kept.add(photo.photoId);
        return usual;
    }

    async function build(photoId: string): Promise<Resolved> {
        const record = photoRecords.get(photoId);
        if (!record) return { ok: false, member: { photoId, assetRevision: null, profileId: null, reason: 'no-record' } };
        const { assetRevision } = record;
        const photo = registry.photos[photoId];
        if (!photo) return { ok: false, member: { photoId, assetRevision, profileId: null, reason: 'unknown-photo' } };
        const revision = pinnedRevision(photo, assetRevision);
        if (!revision) return { ok: false, member: { photoId, assetRevision, profileId: null, reason: 'unknown-revision' } };
        const ref = { photoId, assetRevision, profileId: chooseProfile(photo, assetRevision, revision) };
        if (revision.profiles[ref.profileId]?.state !== 'ready' || revision.width === null || revision.height === null) {
            return { ok: false, member: { ...ref, reason: 'not-ready' } };
        }
        const manifest = await readAssetManifest(ref, { root });
        if (manifest === null) return { ok: false, member: { ...ref, reason: 'no-manifest' } };
        const { photoId: id, capturedDate, ...asset } = toPublicAsset(photo, assetRevision, ref.profileId, manifest);
        const capturedAt = record.capturedAt ?? capturedDate ?? undefined;
        const built = { id, ...asset, aspectRatio: aspectRatioOf(asset.width, asset.height), ...authoredFields(record), ...(capturedAt ? { capturedAt } : {}) };
        return { ok: true, record: built as CandidatePhotoRecord };
    }

    /** Each photo is built once, however many series list it. */
    const resolved = new Map<string, Promise<Resolved>>();
    const resolve = (photoId: string): Promise<Resolved> => {
        let result = resolved.get(photoId);
        if (!result) {
            result = build(photoId);
            resolved.set(photoId, result);
        }
        return result;
    };

    const excluded: ExcludedMember[] = [];
    const publicPhotos = new Map<string, CandidatePhotoRecord>();
    const series: SeriesRecord[] = [];
    const seen = new Set<string>();
    for (const seriesId of layer.site?.seriesOrder ?? []) {
        if (seen.has(seriesId)) continue;
        seen.add(seriesId);
        const authored: AuthoredSeries | undefined = seriesRecords.get(seriesId);
        if (!authored || authored.visibility !== 'published' || authored.cover === null) continue;
        const members: string[] = [];
        for (const photoId of authored.photoIds) {
            const result = await resolve(photoId);
            if (result.ok) {
                members.push(photoId);
                publicPhotos.set(photoId, result.record);
            } else {
                excluded.push({ seriesId, ...result.member });
            }
        }
        if (members.length === 0) continue;
        const dates = members.map((photoId) => publicPhotos.get(photoId)?.capturedAt).filter((value): value is string => Boolean(value)).sort(compare);
        series.push({
            id: authored.id,
            slug: authored.slug,
            slugAliases: authored.slugAliases,
            title: authored.title,
            statement: authored.statement,
            shortStatement: authored.shortStatement,
            photoIds: members,
            chapters: authored.chapters,
            ...(authored.openingPhotoId ? { openingPhotoId: authored.openingPhotoId } : {}),
            cover: authored.cover,
            ...(authored.accent !== undefined ? { accent: authored.accent } : {}),
            derived: { photoCount: members.length, ...(dates.length ? { capturedFrom: dates[0], capturedTo: dates[dates.length - 1] } : {}) },
        });
    }

    const content: CandidateContent = {
        site: { featuredSeriesIds: layer.site?.featuredSeriesIds ?? [] },
        series,
        photos: [...publicPhotos.values()].sort((a, b) => compare(a.id, b.id)),
    };
    return {
        content,
        candidateId: revisionIdOf(content),
        excluded,
        reprofiled: reprofile ? { moved: [...moved].sort(compare), kept: [...kept].sort(compare) } : null,
    };
}

/** The candidate file for a compile, parsed strictly. Throws if compile built something the candidate schema refuses, which is a bug. */
export function candidateFile(result: CompileResult, { baseRevisionId, compiledAt }: { baseRevisionId: string | null; compiledAt: string }): CandidateFile {
    const parsed = parseCandidateFile({ revisionId: result.candidateId, schemaVersion: CATALOG_SCHEMA_VERSION, baseRevisionId, compiledAt, content: result.content });
    if (!parsed.ok) throw new Error(`Compile built an invalid candidate: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
    return parsed.value;
}

import type { CuratorOnlyMetadata, DerivedMetadata } from './metadata';
import type { VariantFormat, VariantWidth } from './variants';

/**
 * The identity registry, `identity/registry.json` in the data root. It holds
 * identity, binding, source health, and revisions only. Authored copy and
 * publication state belong to the catalog (#13), keyed by photoId.
 */

export const REGISTRY_SCHEMA_VERSION = 1;

/**
 * - `present`: the bound path holds one of this photo's revisions.
 * - `missing`: the path is gone and the bytes are nowhere. Everything is kept, and the last path is unbound.
 * - `ambiguous`: a hold candidate, or its path holds another photo's bytes.
 * - `archived`: retired by `archive` or by a `bind` merge.
 */
export type SourceHealth = 'present' | 'missing' | 'ambiguous' | 'archived';

export type ProfileState = 'pending' | 'ready' | 'failed';

export interface ProfileEntry {
    state: ProfileState;
    attempts: number;
    error?: string;
    readyAt?: string;
}

export interface AssetRevisionRecord {
    assetRevision: string;
    /** Null when the file can't be decoded. */
    pixelDigest: string | null;
    firstSeenAt: string;
    firstSeenPath: string;
    sourceBytes: number;
    sourceFormat: string;
    /** Oriented dimensions, null when undecodable. */
    width: number | null;
    height: number | null;
    /** The raw EXIF orientation, null when absent or undecodable. */
    orientation: number | null;
    derived: DerivedMetadata;
    curatorOnly: CuratorOnlyMetadata;
    /** Set when a `new` decision moved this revision to another photo. Such a revision no longer belongs here. */
    reassignedTo?: string;
    /** Derivative state by profileId. */
    profiles: Record<string, ProfileEntry>;
}

export interface PhotoSource {
    /** Library-relative POSIX path, exactly as on disk. Kept as the last path while missing. */
    path: string;
    /** `path` NFC-normalized and case-folded, so case-only and Unicode-only renames keep the binding. */
    key: string;
    /** Whether `path` is bound to this photo and existed at the last pass. */
    present: boolean;
    /** The revision last seen at `path`. */
    observedRevision: string;
    lastSeenAt: string;
}

export interface PhotoRecord {
    photoId: string;
    createdAt: string;
    source: PhotoSource;
    sourceHealth: SourceHealth;
    /** The photo whose bytes or pixels this one matched when it was created. */
    duplicateOf: string | null;
    mergedInto?: string;
    revisions: Record<string, AssetRevisionRecord>;
}

/** A path whose evidence was ambiguous. It binds nothing until a decision or a byte change ends it. */
export interface Hold {
    path: string;
    assetRevision: string;
    candidates: string[];
    since: string;
}

export type IdentityFactType =
    | 'new'
    | 'renamed'
    | 'reappeared'
    | 'replaced'
    | 'metadata-changed'
    | 'ambiguous'
    | 'missing'
    | 'processing-failed';

export type ProcessingFailure = 'unsupported-format' | 'digest-collision' | 'undecodable';

export interface IdentityFact {
    type: IdentityFactType;
    /** A UUID minted when the fact is committed to the registry. */
    factId: string;
    /** `${type}:${photoId ?? assetRevision}:${assetRevision}`, stable across passes for the same evidence. */
    key: string;
    photoId: string | null;
    /** The revision the fact is about. For `missing`, the last observed one. */
    assetRevision: string;
    path: string;
    /** The library-relative folder of `path`, '' at the root. A series hint for #14. */
    folder: string;
    observedAt: string;
    fromPath?: string;
    candidates?: string[];
    duplicateOf?: string;
    samePathAs?: string;
    revert?: boolean;
    reason?: ProcessingFailure;
}

export interface Registry {
    schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
    version: number;
    updatedAt: string | null;
    photos: Record<string, PhotoRecord>;
    holds: Hold[];
    /** Facts committed with this registry and not yet delivered to every sink. */
    pendingFacts: IdentityFact[];
}

export interface VariantFile {
    width: number;
    height: number;
    bytes: number;
    /** 64 lowercase hex. */
    sha256: string;
}

/** `assets/<photoId>/<assetRevision>/<profileId>/manifest.json`. It holds no URLs. */
export interface AssetManifest {
    schemaVersion: 1;
    photoId: string;
    assetRevision: string;
    profileId: string;
    variants: Record<VariantWidth, Record<VariantFormat, VariantFile>>;
    /** A 20 px WebP as a data URI. */
    lqip: string;
    createdAt: string;
}

/** A derivative set the worker should build. */
export interface DerivativeJob {
    photoId: string;
    assetRevision: string;
    profileId: string;
    path: string;
}

export function emptyRegistry(): Registry {
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, version: 0, updatedAt: null, photos: {}, holds: [], pendingFacts: [] };
}

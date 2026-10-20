import type { z } from 'zod';
import type * as schema from './schema';

/**
 * Catalog types, inferred from the schema so the two never drift. Type-only,
 * so modules that need a shape (such as #8's order rules) can import it
 * without pulling in zod.
 */

export type FocalPoint = z.infer<typeof schema.focalPointSchema>;
export type Crop = z.infer<typeof schema.cropSchema>;

/** What compile writes: published series and the photos they hold. */
export type SiteRecord = z.infer<typeof schema.siteRecordSchema>;
export type SeriesRecord = z.infer<typeof schema.seriesRecordSchema>;
export type PublicPhotoRecord = z.infer<typeof schema.publicPhotoRecordSchema>;
export type PublicAlt = z.infer<typeof schema.publicAltSchema>;
export type RevisionContent = z.infer<typeof schema.revisionContentSchema>;
export type RevisionFile = z.infer<typeof schema.revisionFileSchema>;

/** A compiled draft, which may still hold `pending` alt. */
export type CandidatePhotoRecord = z.infer<typeof schema.candidatePhotoRecordSchema>;
export type CandidateAlt = z.infer<typeof schema.candidateAltSchema>;
export type CandidateContent = z.infer<typeof schema.candidateContentSchema>;
export type CandidateFile = z.infer<typeof schema.candidateFileSchema>;

export type Activation = z.infer<typeof schema.activationSchema>;
export type ActivePointer = z.infer<typeof schema.activePointerSchema>;

/** The authored working layer under `authored/`. */
export type AuthoredSite = z.infer<typeof schema.authoredSiteSchema>;
export type AuthoredSeries = z.infer<typeof schema.authoredSeriesSchema>;
export type AuthoredPhoto = z.infer<typeof schema.authoredPhotoSchema>;
export type AuthoredAlt = z.infer<typeof schema.authoredAltSchema>;
export type AuthoredRecord = AuthoredSite | AuthoredSeries | AuthoredPhoto;
export type Conflict = NonNullable<AuthoredSite['conflicts']>[number];
export type Visibility = AuthoredSeries['visibility'];
export type PublicationPolicy = AuthoredSeries['publicationPolicy'];

/** The fields the writer owns: it sets them on every write, whatever a caller passes. */
export type ManagedField = 'schemaVersion' | 'version' | 'baseRevisionId';
type Writable<T> = Omit<T, ManagedField> & Partial<Record<ManagedField, unknown>>;
/** What a caller hands writeAuthoredRecord(): a record as read or newly built, before defaults. */
export type AuthoredSiteInput = Writable<z.input<typeof schema.authoredSiteSchema>>;
export type AuthoredSeriesInput = Writable<z.input<typeof schema.authoredSeriesSchema>>;
export type AuthoredPhotoInput = Writable<z.input<typeof schema.authoredPhotoSchema>>;
export type AuthoredRecordInput = AuthoredSiteInput | AuthoredSeriesInput | AuthoredPhotoInput;

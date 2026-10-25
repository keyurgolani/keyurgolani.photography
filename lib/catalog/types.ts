import type { z } from 'zod';
import type { Registry } from '../identity/types';
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
export type ManagedField = 'schemaVersion' | 'version' | 'baseRevisionId' | 'baseSeriesOrder';
type Writable<T> = Omit<T, ManagedField> & Partial<Record<ManagedField, unknown>>;
/** What a caller hands writeAuthoredRecord(): a record as read or newly built, before defaults. */
export type AuthoredSiteInput = Writable<z.input<typeof schema.authoredSiteSchema>>;
export type AuthoredSeriesInput = Writable<z.input<typeof schema.authoredSeriesSchema>>;
export type AuthoredPhotoInput = Writable<z.input<typeof schema.authoredPhotoSchema>>;
export type AuthoredRecordInput = AuthoredSiteInput | AuthoredSeriesInput | AuthoredPhotoInput;

export type RecordProblemReason = 'unreadable' | 'invalid-json' | 'unknown-schema-version' | 'invalid' | 'file-name' | 'edited-in-place';

/** A working-layer record that isn't usable. It names the record. A message may name a file or folder relative to the data root, never an absolute path. */
export interface RecordProblem {
    kind: schema.AuthoredKind;
    /** The record ID its folder name gives, or `site`. */
    id: string;
    reason: RecordProblemReason;
    issues: schema.SchemaIssue[];
}

/** One snapshot of the working layer, as working-layer.ts reads it. Unusable records are left out and listed in `problems`. */
export interface WorkingLayer {
    site: AuthoredSite | null;
    /** Sorted by ID. */
    series: AuthoredSeries[];
    /** Sorted by ID. */
    photos: AuthoredPhoto[];
    /** Sorted by kind, then ID. */
    problems: RecordProblem[];
}

export type Severity = 'error' | 'warning';
/** `render` rules block a preview and a publish; `publish` rules block only a publish. */
export type Gate = 'render' | 'publish';
/** A #15 rollback blocks on `integrity` errors and may accept `editorial` ones. */
export type RollbackClass = 'integrity' | 'editorial';

export interface IssueRecord {
    kind: 'site' | 'series' | 'photo';
    /** `site` for the site record. */
    id: string;
}

/** One validation problem. It names the record and field, never a path or a source file name. */
export interface Issue {
    /** The rule's ID. */
    code: string;
    severity: Severity;
    record: IssueRecord;
    /** Where in the record, such as `alt.text` or `slugAliases[0]`. */
    field: string;
    message: string;
    hint?: string;
}

/** What a rule reports. The registry adds the rule's ID as `code` and its severity. */
export type RuleFinding = Omit<Issue, 'code' | 'severity'>;

export interface RuleContext {
    /** The compiled candidate, or a stored revision's content. */
    candidate: CandidateContent;
    /** The working layer the candidate came from, or null for a stored revision (#15 rollback, photos:verify). */
    authored: WorkingLayer | null;
    /** The active revision, or null before the first activation. */
    active: RevisionFile | null;
    /** #10's registry snapshot, or null without one. */
    registry: Registry | null;
    /** For privacy.path: no published string may hold either. */
    roots: { dataRoot: string | null; libraryRoot: string | null };
}

export interface Rule {
    /** `<group>.<name>`, also the code of every issue it reports. */
    id: string;
    /** Bump when the check changes, so `rulesetVersion` changes. */
    version: number;
    severity: Severity;
    rollbackClass: RollbackClass;
    gate: Gate;
    check(ctx: RuleContext): readonly RuleFinding[];
}

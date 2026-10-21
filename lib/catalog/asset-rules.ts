import fs from 'node:fs';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../identity/variants';
import { mediaFilePath } from '../media/path';
import { mediaUrl } from '../media/url';
import { hasErrorCode } from '../storage/fsx';
import { registerRule, shared } from './rules';
import type { CandidatePhotoRecord, ExcludedMember, ExclusionReason, Rule, RuleContext, RuleFinding } from './types';

/**
 * The asset rules, slice B's: each published photo's derivative set is the
 * one #10's registry calls ready, each variant file is there at its
 * manifest's size, and each URL is the media route's. They stat files and
 * read nothing. Importing this module registers them, as rules.ts does its
 * own, so compile and publish see every rule and the slice A and #8 rule
 * tests stay free of asset fixtures.
 *
 * They check the candidate's photos, and the members compile left out
 * (`ctx.excluded`). On a stored revision they check its photos.
 */

const photoRecord = (id: string) => ({ kind: 'photo' as const, id });

/** The findings of `test` for each of the candidate's photos. */
function eachPhoto(ctx: RuleContext, test: (photo: CandidatePhotoRecord) => RuleFinding[]): RuleFinding[] {
    return ctx.candidate.photos.flatMap(test);
}

/** One finding per photo compile left out for `reason`, however many series list it. */
function excludedFor(ctx: RuleContext, reason: ExclusionReason, finding: (member: ExcludedMember) => RuleFinding): RuleFinding[] {
    const seen = new Set<string>();
    return (ctx.excluded ?? []).filter((member) => {
        if (member.reason !== reason || seen.has(member.photoId)) return false;
        seen.add(member.photoId);
        return true;
    }).map(finding);
}

/** Each variant file of a photo's set, with its field and what stat says about it. */
function variantFiles(ctx: RuleContext, photo: CandidatePhotoRecord): { field: string; size: number | 'missing' | string; bytes: number }[] {
    const root = ctx.roots.dataRoot;
    if (root === null) return [];
    const ref = { photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId };
    return VARIANT_WIDTHS.flatMap((width) => VARIANT_FORMATS.map((format) => {
        const field = `variants.${width}.${format}`;
        const { bytes } = photo.variants[width][format];
        try {
            return { field, size: fs.statSync(mediaFilePath(ref, width, format, root)).size, bytes };
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return { field, size: 'missing' as const, bytes };
            return { field, size: (error as NodeJS.ErrnoException).code ?? 'an I/O error', bytes };
        }
    }));
}

/** stat() each variant once per runRules() call, since two rules read the result. */
function filesOf(ctx: RuleContext, photo: CandidatePhotoRecord): ReturnType<typeof variantFiles> {
    const bySet = shared(ctx, 'assets.variant-files', () => new Map<string, ReturnType<typeof variantFiles>>());
    const key = `${photo.id}/${photo.assetRevision}/${photo.profileId}`;
    let files = bySet.get(key);
    if (!files) {
        files = variantFiles(ctx, photo);
        bySet.set(key, files);
    }
    return files;
}

const rule = (definition: Omit<Rule, 'version' | 'rollbackClass' | 'severity' | 'gate'>): Rule => ({
    version: 1,
    rollbackClass: 'integrity',
    severity: 'error',
    gate: 'render',
    ...definition,
});

export const ASSET_RULES: readonly Rule[] = [
    rule({
        id: 'assets.revision',
        check: (ctx) => [
            ...excludedFor(ctx, 'unknown-revision', (member) => ({
                record: photoRecord(member.photoId),
                field: 'assetRevision',
                message: `The record pins ${member.assetRevision}, which the library has no revision of this photograph for.`,
                hint: 'Set assetRevision to one of the photograph\'s revisions.',
            })),
            ...(ctx.registry === null ? [] : eachPhoto(ctx, (photo) => {
                const revision = ctx.registry?.photos[photo.id]?.revisions[photo.assetRevision];
                if (revision && !revision.reassignedTo) return [];
                return [{ record: photoRecord(photo.id), field: 'assetRevision', message: `The library has no revision ${photo.assetRevision} of this photograph.` }];
            })),
        ],
    }),
    rule({
        id: 'assets.ready',
        check: (ctx) => [
            ...excludedFor(ctx, 'not-ready', (member) => {
                const state = ctx.registry?.photos[member.photoId]?.revisions[member.assetRevision ?? '']?.profiles[member.profileId ?? '']?.state;
                return {
                    record: photoRecord(member.photoId),
                    field: 'profileId',
                    message: `Its derivative set for ${member.profileId} is ${state ?? 'not built'}, not ready.`,
                    hint: state === 'failed' ? 'Fix the source, then run photos:identity retry for it.' : 'Wait for the watcher to build it.',
                };
            }),
            ...(ctx.registry === null ? [] : eachPhoto(ctx, (photo) => {
                const revision = ctx.registry?.photos[photo.id]?.revisions[photo.assetRevision];
                // assets.revision reports a revision the registry lacks.
                if (!revision || revision.reassignedTo) return [];
                const state = revision.profiles[photo.profileId]?.state;
                if (state === 'ready') return [];
                return [{ record: photoRecord(photo.id), field: 'profileId', message: `Its derivative set for ${photo.profileId} is ${state ?? 'not built'}, not ready.` }];
            })),
        ],
    }),
    rule({
        id: 'assets.manifest',
        check: (ctx) => excludedFor(ctx, 'no-manifest', (member) => ({
            record: photoRecord(member.photoId),
            field: 'profileId',
            message: `Its derivative set for ${member.profileId} is ready in the registry, but has no valid manifest.`,
            hint: 'Run photos:identity retry for it, so the watcher builds the set again.',
        })),
    }),
    rule({
        id: 'assets.variant',
        check: (ctx) => eachPhoto(ctx, (photo) => filesOf(ctx, photo)
            .filter(({ size }) => typeof size === 'string')
            .map(({ field, size }) => ({
                record: photoRecord(photo.id),
                field,
                message: size === 'missing' ? 'The derivative file is missing.' : `The derivative file can't be read (${size}).`,
            }))),
    }),
    rule({
        id: 'assets.size',
        check: (ctx) => eachPhoto(ctx, (photo) => filesOf(ctx, photo)
            .filter(({ size, bytes }) => typeof size === 'number' && size !== bytes)
            .map(({ field, size, bytes }) => ({
                record: photoRecord(photo.id),
                field: `${field}.bytes`,
                message: `The derivative file is ${size} bytes, but its manifest says ${bytes}.`,
            }))),
    }),
    rule({
        id: 'assets.url',
        check: (ctx) => eachPhoto(ctx, (photo) => VARIANT_WIDTHS.flatMap((width) => VARIANT_FORMATS.flatMap((format) => {
            let expected: string | null;
            try {
                expected = mediaUrl({ photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId }, width, format);
            } catch {
                expected = null;
            }
            if (photo.variants[width][format].url === expected) return [];
            return [{ record: photoRecord(photo.id), field: `variants.${width}.${format}.url`, message: 'The URL is not the media route\'s URL for this derivative.' }];
        }))),
    }),
];

export const ASSET_RULE_IDS = ASSET_RULES.map((entry) => entry.id);

for (const entry of ASSET_RULES) registerRule(entry);

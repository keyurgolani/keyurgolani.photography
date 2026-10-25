// @vitest-environment node
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mediaFilePath } from '../../media/path';
import { ASSET_RULE_IDS } from '../asset-rules';
import { registeredRules, runRules } from '../rules';
import { createTestCatalog, type TestCatalog } from '../testing';
import type { CandidatePhotoRecord, Issue, RuleContext } from '../types';
import { VARIANT_BYTES } from './catalogFixtures';

const isRoot = process.getuid?.() === 0;
const STRAY = 'ph_00000000-0000-4000-8000-0000000000aa';

let catalog: TestCatalog;
let ctx: RuleContext;

beforeEach(async () => {
    catalog = await createTestCatalog({ seed: 51, photos: 3, series: 1, variantBytes: VARIANT_BYTES });
    ctx = await catalog.context();
});

afterEach(async () => {
    await catalog.cleanup();
});

const assetIssues = (context: RuleContext): Issue[] => runRules(context).filter((issue) => issue.code.startsWith('assets.'));
const first = (context: RuleContext): CandidatePhotoRecord => context.candidate.photos[0];
const fileOf = (photo: CandidatePhotoRecord, width: 'w400' | 'w800' | 'w1200' | 'w1920', format: 'avif' | 'webp') =>
    mediaFilePath({ photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId }, width, format, catalog.root);
const left = (context: RuleContext, reason: 'unknown-revision' | 'not-ready' | 'no-manifest', profileId: string | null) => {
    context.excluded = [{ seriesId: context.candidate.series[0].id, photoId: STRAY, assetRevision: `sha256-${'d'.repeat(64)}`, profileId, reason }];
    return { record: { kind: 'photo' as const, id: STRAY } };
};

interface Row {
    label: string;
    code: string;
    /** Breaks one thing, on disk or in `context`, and returns the record and field the issue must name. */
    breakIt(context: RuleContext): { record: Issue['record']; field: string };
}

const rows: Row[] = [
    { label: 'a missing variant file', code: 'assets.variant', breakIt: (context) => {
        fs.rmSync(fileOf(first(context), 'w400', 'webp'));
        return { record: { kind: 'photo', id: first(context).id }, field: 'variants.w400.webp' };
    } },
    { label: 'a variant file at another size than its manifest gives', code: 'assets.size', breakIt: (context) => {
        fs.truncateSync(fileOf(first(context), 'w800', 'avif'), 77);
        return { record: { kind: 'photo', id: first(context).id }, field: 'variants.w800.avif.bytes' };
    } },
    { label: 'a published photo whose profile is pending', code: 'assets.ready', breakIt: (context) => {
        const photo = first(context);
        const revision = context.registry?.photos[photo.id].revisions[photo.assetRevision];
        if (revision) revision.profiles[photo.profileId] = { state: 'pending', attempts: 0 };
        return { record: { kind: 'photo', id: photo.id }, field: 'profileId' };
    } },
    { label: 'a member left out because its profile isn\'t ready', code: 'assets.ready', breakIt: (context) => ({ ...left(context, 'not-ready', catalog.profileId), field: 'profileId' }) },
    { label: 'a malformed media URL', code: 'assets.url', breakIt: (context) => {
        first(context).variants.w1200.webp.url = '/media/../w1200.webp';
        return { record: { kind: 'photo', id: first(context).id }, field: 'variants.w1200.webp.url' };
    } },
    { label: 'a URL for another photo\'s derivative', code: 'assets.url', breakIt: (context) => {
        const [photo, other] = context.candidate.photos;
        photo.variants.w1920.avif.url = other.variants.w1920.avif.url;
        return { record: { kind: 'photo', id: photo.id }, field: 'variants.w1920.avif.url' };
    } },
    { label: 'a published photo on a revision the registry lacks', code: 'assets.revision', breakIt: (context) => {
        const photo = first(context);
        const registryPhoto = context.registry?.photos[photo.id];
        if (registryPhoto) registryPhoto.revisions = {};
        return { record: { kind: 'photo', id: photo.id }, field: 'assetRevision' };
    } },
    { label: 'a member left out for an unknown revision', code: 'assets.revision', breakIt: (context) => ({ ...left(context, 'unknown-revision', null), field: 'assetRevision' }) },
    { label: 'a member left out for a missing manifest', code: 'assets.manifest', breakIt: (context) => ({ ...left(context, 'no-manifest', catalog.profileId), field: 'profileId' }) },
];

describe('the asset rules', () => {
    it('find nothing wrong with a clean fixture', () => {
        expect(assetIssues(ctx)).toEqual([]);
    });

    it('are all registered once asset-rules.ts is imported, as render-gated integrity errors', () => {
        const registered = registeredRules().filter((rule) => rule.id.startsWith('assets.'));
        expect(registered.map((rule) => rule.id)).toEqual([...ASSET_RULE_IDS].sort());
        for (const rule of registered) expect(rule).toMatchObject({ severity: 'error', gate: 'render', rollbackClass: 'integrity', version: 1 });
    });

    it('have a row here for every rule', () => {
        expect([...new Set(rows.map((row) => row.code))].sort()).toEqual([...ASSET_RULE_IDS].sort());
    });

    it.each(rows)('$code: reports $label, naming the record and field', (row) => {
        const expected = row.breakIt(ctx);
        const issues = assetIssues(ctx);
        expect(issues.map(({ code, record, field }) => ({ code, record, field }))).toEqual([{ code: row.code, ...expected }]);
        for (const issue of issues) expect(`${issue.message} ${issue.hint ?? ''}`).not.toContain(catalog.root);
    });

    it.skipIf(isRoot)('reports a variant it can\'t stat as unreadable, not missing', () => {
        const photo = first(ctx);
        const dir = fileOf(photo, 'w400', 'webp').replace(/\/w400\.webp$/, '');
        fs.chmodSync(dir, 0o000);
        try {
            const issues = assetIssues(ctx);
            const variants = issues.filter((issue) => issue.code === 'assets.variant');
            expect(variants).toHaveLength(8);
            expect(variants.every((issue) => /can't be read \(EACCES\)/.test(issue.message))).toBe(true);
            // A stored revision's manifest is read too, and one that can't be is reported, never thrown.
            expect(issues.filter((issue) => issue.code !== 'assets.variant')).toEqual([
                expect.objectContaining({ code: 'assets.manifest', field: 'profileId', message: expect.stringContaining('has a manifest that can\'t be read (EACCES)') }),
            ]);
        } finally {
            fs.chmodSync(dir, 0o700);
        }
    });

    it('report a photo listed by two series once', () => {
        const { seriesId, ...member } = { seriesId: ctx.candidate.series[0].id, photoId: STRAY, assetRevision: null, profileId: null, reason: 'unknown-revision' as const };
        ctx.excluded = [{ seriesId, ...member }, { seriesId: 'ser_fixture-99', ...member }];
        expect(assetIssues(ctx).map((issue) => issue.record.id)).toEqual([STRAY]);
    });

    it('stat the files afresh on each run', () => {
        expect(assetIssues(ctx)).toEqual([]);
        fs.rmSync(fileOf(first(ctx), 'w400', 'avif'));
        expect(assetIssues(ctx).map((issue) => issue.field)).toEqual(['variants.w400.avif']);
    });

    it('check a stored revision\'s photos, with no working layer and nothing left out', () => {
        const stored: RuleContext = { ...ctx, authored: null, excluded: undefined };
        fs.rmSync(fileOf(first(stored), 'w1920', 'webp'));
        expect(assetIssues(stored).map(({ code, field }) => ({ code, field }))).toEqual([{ code: 'assets.variant', field: 'variants.w1920.webp' }]);
    });

    it('skip the registry checks without a registry, and the file checks without a data root', () => {
        const registryPhoto = ctx.registry?.photos[first(ctx).id];
        if (registryPhoto) registryPhoto.revisions = {};
        fs.rmSync(fileOf(first(ctx), 'w400', 'webp'));
        expect(assetIssues({ ...ctx, registry: null, roots: { dataRoot: null, libraryRoot: null } })).toEqual([]);
    });
});

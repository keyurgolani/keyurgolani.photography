// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../test/helpers/runTsx';
import { cameraSettingsCaption } from '../legacy-photos';
import { BAND_COLORS, registeredRules, registerRule, runRules, rulesetVersion } from '../rules';
import { createTestCatalog, ORDER_RULE_IDS, registerOrderRuleStandIns, type TestCatalog } from '../testing';
import type { Issue, RuleContext } from '../types';

let catalog: TestCatalog;
let clean: RuleContext;

beforeAll(async () => {
    catalog = await createTestCatalog({ seed: 13 });
    clean = await catalog.context({ roots: { dataRoot: catalog.root, libraryRoot: '/srv/photo-library' } });
});

afterAll(async () => {
    await catalog.cleanup();
});

/** A fresh copy of the clean context to break one thing in. */
function context(): RuleContext {
    return structuredClone(clean);
}

const photoAt = (ctx: RuleContext, index: number) => ctx.candidate.photos[index];
const authoredPhoto = (ctx: RuleContext, id: string) => {
    const found = ctx.authored?.photos.find((photo) => photo.id === id);
    if (!found) throw new Error(`No authored photo ${id}`);
    return found;
};
const describe0 = (ctx: RuleContext, text: string) => {
    photoAt(ctx, 0).alt = { kind: 'described', text };
    return { kind: 'photo' as const, id: photoAt(ctx, 0).id };
};

interface Row {
    code: string;
    gate: 'render' | 'publish';
    severity: 'error' | 'warning';
    rollbackClass: 'integrity' | 'editorial';
    /** Breaks one thing in `ctx` and returns the record and field the issue must name. */
    breakIt(ctx: RuleContext): { record: Issue['record']; field: string };
}

const rows: Row[] = [
    { code: 'structure.schema', gate: 'render', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        ctx.authored?.problems.push({ kind: 'photo', id: photoAt(ctx, 0).id, reason: 'invalid', issues: [{ path: 'crop', message: 'Invalid option' }] });
        return { record: { kind: 'photo', id: photoAt(ctx, 0).id }, field: 'crop' };
    } },
    { code: 'structure.schema-version', gate: 'render', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        ctx.authored?.problems.push({ kind: 'series', id: 'ser_fixture-09', reason: 'unknown-schema-version', issues: [{ path: 'schemaVersion', message: 'schemaVersion 9 is not one this build reads' }] });
        return { record: { kind: 'series', id: 'ser_fixture-09' }, field: 'schemaVersion' };
    } },
    { code: 'structure.file-name', gate: 'render', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        ctx.authored?.problems.push({ kind: 'photo', id: 'ph_00000000-0000-4000-8000-000000000999', reason: 'file-name', issues: [{ path: 'id', message: 'mismatch' }] });
        return { record: { kind: 'photo', id: 'ph_00000000-0000-4000-8000-000000000999' }, field: 'id' };
    } },
    { code: 'structure.series-id', gate: 'render', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        const series = ctx.authored?.series[1];
        if (series) series.id = 'Series 2';
        if (ctx.authored?.site) ctx.authored.site.seriesOrder = ['ser_fixture-01', 'Series 2'];
        return { record: { kind: 'series', id: 'Series 2' }, field: 'id' };
    } },
    { code: 'structure.chapter-id', gate: 'render', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        const series = ctx.authored?.series[0];
        if (series) series.chapters = [{ id: 'ch_one', title: 'Fixture chapter', startPhotoId: series.photoIds[0] }, { id: 'ch_one', title: 'Fixture chapter again', startPhotoId: series.photoIds[1] }];
        return { record: { kind: 'series', id: 'ser_fixture-01' }, field: 'chapters[1].id' };
    } },
    { code: 'refs.featured', gate: 'render', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        if (ctx.authored?.site) ctx.authored.site.featuredSeriesIds = ['ser_fixture-01', 'ser_fixture-01'];
        return { record: { kind: 'site', id: 'site' }, field: 'featuredSeriesIds[1]' };
    } },
    { code: 'refs.series-order', gate: 'render', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        if (ctx.authored?.site) ctx.authored.site.seriesOrder = ['ser_fixture-01'];
        return { record: { kind: 'site', id: 'site' }, field: 'seriesOrder' };
    } },
    { code: 'refs.non-empty', gate: 'publish', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        ctx.candidate.site.featuredSeriesIds = [];
        return { record: { kind: 'site', id: 'site' }, field: 'featuredSeriesIds' };
    } },
    { code: 'refs.membership', gate: 'render', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        const [first, second] = ctx.authored?.series ?? [];
        second.photoIds = [...second.photoIds, first.photoIds[0]];
        return { record: { kind: 'photo', id: first.photoIds[0] }, field: 'series' };
    } },
    { code: 'description.required', gate: 'publish', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        const photo = authoredPhoto(ctx, photoAt(ctx, 0).id);
        photo.alt = { kind: 'described', text: 'A suggested fixture description.', reviewed: false };
        return { record: { kind: 'photo', id: photo.id }, field: 'alt' };
    } },
    { code: 'description.empty', gate: 'publish', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => ({ record: describe0(ctx, '   '), field: 'alt.text' }) },
    { code: 'description.filename', gate: 'publish', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        const source = ctx.registry?.photos[photoAt(ctx, 0).id].source.path ?? '';
        return { record: describe0(ctx, source.replace(/\.jpg$/, '').toUpperCase()), field: 'alt.text' };
    } },
    { code: 'description.placeholder', gate: 'publish', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => ({ record: describe0(ctx, 'Gallery Image 3'), field: 'alt.text' }) },
    { code: 'description.camera-caption', gate: 'publish', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => ({
        record: describe0(ctx, cameraSettingsCaption(photoAt(ctx, 0).technical)),
        field: 'alt.text',
    }) },
    { code: 'description.camera-tokens', gate: 'publish', severity: 'warning', rollbackClass: 'integrity', breakIt: (ctx) => ({ record: describe0(ctx, 'A fixture street at dusk, shot at 35mm.'), field: 'alt.text' }) },
    { code: 'description.length', gate: 'publish', severity: 'warning', rollbackClass: 'integrity', breakIt: (ctx) => ({ record: describe0(ctx, `A fixture description ${'that runs on '.repeat(25)}`), field: 'alt.text' }) },
    { code: 'description.series-copy', gate: 'publish', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        const series = ctx.authored?.series[1];
        if (series) series.shortStatement = ' ';
        return { record: { kind: 'series', id: 'ser_fixture-02' }, field: 'shortStatement' };
    } },
    { code: 'route.slug-format', gate: 'render', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        const series = ctx.authored?.series[0];
        if (series) series.slugAliases = ['Fixture_One'];
        return { record: { kind: 'series', id: 'ser_fixture-01' }, field: 'slugAliases[0]' };
    } },
    { code: 'route.reserved', gate: 'render', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        const series = ctx.authored?.series[1];
        if (series) series.slug = 'work';
        return { record: { kind: 'series', id: 'ser_fixture-02' }, field: 'slug' };
    } },
    { code: 'route.collision', gate: 'render', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        const [first, second] = ctx.authored?.series ?? [];
        second.slugAliases = [first.slug];
        return { record: { kind: 'series', id: 'ser_fixture-02' }, field: 'slugAliases[0]' };
    } },
    { code: 'accent.format', gate: 'publish', severity: 'error', rollbackClass: 'editorial', breakIt: (ctx) => {
        ctx.candidate.series[0].accent = 'teal';
        return { record: { kind: 'series', id: 'ser_fixture-01' }, field: 'accent' };
    } },
    { code: 'accent.contrast', gate: 'publish', severity: 'error', rollbackClass: 'editorial', breakIt: (ctx) => {
        photoAt(ctx, 1).accent = '#2a2f2d';
        return { record: { kind: 'photo', id: photoAt(ctx, 1).id }, field: 'accent' };
    } },
    { code: 'privacy.path', gate: 'render', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        photoAt(ctx, 2).caption = 'Exported from /Users/someone/Pictures';
        return { record: { kind: 'photo', id: photoAt(ctx, 2).id }, field: 'caption' };
    } },
    { code: 'privacy.source-name', gate: 'render', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        const source = ctx.registry?.photos[photoAt(ctx, 0).id].source.path ?? '';
        ctx.candidate.series[0].statement = `Fixture statement that names ${source} in passing.`;
        return { record: { kind: 'series', id: ctx.candidate.series[0].id }, field: 'statement' };
    } },
    { code: 'privacy.private-key', gate: 'render', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        (photoAt(ctx, 0).technical as Record<string, string>).BodySerialNumber = '000';
        return { record: { kind: 'photo', id: photoAt(ctx, 0).id }, field: 'technical.BodySerialNumber' };
    } },
    { code: 'working.conflicts', gate: 'publish', severity: 'error', rollbackClass: 'integrity', breakIt: (ctx) => {
        const photo = authoredPhoto(ctx, photoAt(ctx, 0).id);
        photo.conflicts = [{ field: 'title', base: 'Fixture title A', active: 'Fixture title B' }];
        return { record: { kind: 'photo', id: photo.id }, field: 'title' };
    } },
];

describe('the slice A rules', () => {
    it('find nothing wrong with a clean fixture', () => {
        expect(runRules(clean)).toEqual([]);
    });

    it('have one row here per issue code, and no other rule is registered', () => {
        expect(registeredRules().map((rule) => rule.id)).toEqual(rows.map((row) => row.code).sort());
    });

    it.each(rows)('$code: reports the broken record and field, and only that', (row) => {
        const ctx = context();
        const { record, field } = row.breakIt(ctx);
        const rule = registeredRules().find((entry) => entry.id === row.code);
        expect(rule).toMatchObject({ gate: row.gate, severity: row.severity, rollbackClass: row.rollbackClass, version: 1 });

        const issues = runRules(ctx);
        expect(issues.filter((issue) => issue.code === row.code)).toContainEqual(expect.objectContaining({ code: row.code, severity: row.severity, record, field }));
        expect(issues.filter((issue) => issue.code !== row.code)).toEqual([]);
        for (const issue of issues) expect(issue.message.length).toBeGreaterThan(0);
    });

    it('never put a root, a source path, or a source file name in an issue', () => {
        const sources = Object.values(clean.registry?.photos ?? {}).map((photo) => photo.source.path);
        for (const row of rows) {
            const ctx = context();
            row.breakIt(ctx);
            const text = JSON.stringify(runRules(ctx));
            expect(text, row.code).not.toContain(catalog.root);
            expect(text, row.code).not.toContain('/srv/photo-library');
            for (const source of sources) expect(text.toLowerCase(), row.code).not.toContain(source.replace(/\.jpg$/, '').toLowerCase());
        }
    });

    it('run only the gates asked for', () => {
        const ctx = context();
        rows.find((row) => row.code === 'route.reserved')?.breakIt(ctx);
        rows.find((row) => row.code === 'description.placeholder')?.breakIt(ctx);
        expect(runRules(ctx, { gates: ['render'] }).map((issue) => issue.code)).toEqual(['route.reserved']);
        expect(runRules(ctx, { gates: ['publish'] }).map((issue) => issue.code)).toEqual(['description.placeholder']);
    });

    it('sort issues by record kind, record ID, field, and code', () => {
        const ctx = context();
        for (const code of ['working.conflicts', 'route.reserved', 'refs.non-empty', 'description.empty', 'accent.contrast']) {
            rows.find((row) => row.code === code)?.breakIt(ctx);
        }
        const issues = runRules(ctx);
        const keys = issues.map((issue) => [issue.record.kind, issue.record.id, issue.field, issue.code].join('\u0000'));
        expect(keys).toEqual([...keys].sort());
        expect(issues.length).toBeGreaterThanOrEqual(5);
    });
});

describe('the edges of the checks', () => {
    const codes = (ctx: RuleContext) => runRules(ctx).map((issue) => issue.code);

    it.each([
        ['the model and a setting', 'Fixture Model, 35mm', ['description.camera-caption']],
        ['the make alone', 'Fixture Make', ['description.camera-caption']],
        ['settings and a separator', 'f/2.8 | ISO 200', ['description.camera-caption']],
        ['a decade', 'A 1990s storefront', []],
        ['a race car', 'An F1 car on a wet track', []],
        ['a separator in a sentence', 'Sunset | Beach', ['description.camera-tokens']],
        ['the model in a sentence', 'Shot on a Fixture Model at dusk', ['description.camera-tokens']],
        ['a placeholder with a period', 'Photograph 3.', ['description.placeholder']],
    ])('description: %s', (_label, text, expected) => {
        const ctx = context();
        describe0(ctx, text);
        expect(codes(ctx)).toEqual(expected);
    });

    it.each(['2', '1.5'])('description: the settings of a photo taken at %s s are a camera caption', (exposure) => {
        const ctx = context();
        photoAt(ctx, 0).technical = { ...photoAt(ctx, 0).technical, ExposureTime: exposure };
        describe0(ctx, `35mm f/8 ${exposure}s ISO 200`);
        expect(codes(ctx)).toEqual(['description.camera-caption']);
    });

    it.each([
        ['a period', '.', ['description.empty']],
        ['an ellipsis', '...', ['description.empty']],
        ['a dash', '-', ['description.empty']],
        ['a zero-width space', '\u200b', ['description.empty']],
        ['an emoji', '\u{1F305}', []],
    ])('description: %s alone', (_label, text, expected) => {
        const ctx = context();
        describe0(ctx, text);
        expect(codes(ctx)).toEqual(expected);
    });

    it('description and privacy: alt text that is the whole source file name fails both', () => {
        const ctx = context();
        describe0(ctx, ctx.registry?.photos[photoAt(ctx, 0).id].source.path.toUpperCase() ?? '');
        expect(codes(ctx)).toEqual(['description.filename', 'privacy.source-name']);
    });

    it('privacy.source-name: matches across case and Unicode normalization', () => {
        const ctx = context();
        const record = ctx.registry?.photos[photoAt(ctx, 1).id];
        // Decomposed in the registry, as a macOS volume may store it, and composed in the title.
        if (record) record.source.path = 'series/cafe\u0301-0002.jpg';
        photoAt(ctx, 3).title = 'Fixture title naming CAF\u00c9-0002.JPG';
        expect(runRules(ctx)).toEqual([expect.objectContaining({ code: 'privacy.source-name', record: { kind: 'photo', id: photoAt(ctx, 3).id }, field: 'title' })]);
    });

    it('privacy.source-name: matches names a case-insensitive disk takes for one, such as Stra\u00dfe and STRASSE', () => {
        const ctx = context();
        const record = ctx.registry?.photos[photoAt(ctx, 1).id];
        if (record) record.source.path = 'series/Stra\u00dfe-0002.jpg';
        photoAt(ctx, 3).title = 'Fixture title naming STRASSE-0002.JPG';
        expect(runRules(ctx)).toEqual([expect.objectContaining({ code: 'privacy.source-name', record: { kind: 'photo', id: photoAt(ctx, 3).id }, field: 'title' })]);
    });

    it.each([
        ['a longer name that starts with the library root', 'See /srv/photo-library-archive', []],
        ['the library root', 'From /srv/photo-library.', ['privacy.path']],
        ['the library root in capitals', 'From /SRV/PHOTO-LIBRARY/x.jpg', ['privacy.path']],
        ['the library root with a doubled slash', 'From /srv//photo-library', ['privacy.path']],
        ['a macOS volume', 'Copied from /Volumes/Card/DCIM', ['privacy.path']],
        ['a mount point', 'Synced from /mnt/photos', ['privacy.path']],
        ['a home-relative path', 'Kept in ~/Pictures', ['privacy.path']],
        ['a Windows drive with a forward slash', 'Exported to C:/Exports', ['privacy.path']],
        ['a slash in a sentence', 'Ink/acrylic on paper', []],
        ['a word ending in file', 'Profile: a fixture portrait', []],
        ['a file URL', 'file:///tmp/fixture', ['privacy.path']],
        ['a parent segment', '../fixture', ['privacy.path']],
        ['an ellipsis', 'Fixture caption...', []],
    ])('privacy.path: %s', (_label, caption, expected) => {
        const ctx = context();
        photoAt(ctx, 2).caption = caption;
        expect(codes(ctx)).toEqual(expected);
    });

    it('privacy.path: checks a variant URL that is not a media URL', () => {
        const ctx = context();
        photoAt(ctx, 0).variants.w400.webp.url = 'file:///tmp/fixture/w400.webp';
        expect(runRules(ctx)).toEqual([expect.objectContaining({ code: 'privacy.path', field: 'variants.w400.webp.url' })]);
    });

    it('refs.series-order: reports every published series when there is no site record, and nothing when the site record is broken', () => {
        const missing = context();
        if (missing.authored) missing.authored.site = null;
        expect(runRules(missing)).toEqual([
            expect.objectContaining({ code: 'refs.series-order', field: 'seriesOrder', message: expect.stringContaining('ser_fixture-01') }),
            expect.objectContaining({ code: 'refs.series-order', field: 'seriesOrder', message: expect.stringContaining('ser_fixture-02') }),
        ]);

        const broken = context();
        if (broken.authored) {
            broken.authored.site = null;
            broken.authored.problems.push({ kind: 'site', id: 'site', reason: 'invalid-json', issues: [{ path: '', message: 'the file is not valid JSON' }] });
        }
        expect(codes(broken)).toEqual(['structure.schema']);
    });

    it('route.collision: reports a slug a series uses twice', () => {
        const ctx = context();
        const series = ctx.authored?.series[0];
        if (series) series.slugAliases = [series.slug];
        expect(runRules(ctx)).toEqual([
            expect.objectContaining({ code: 'route.collision', field: 'slug', message: 'The slug is used twice in this series.' }),
            expect.objectContaining({ code: 'route.collision', field: 'slugAliases[0]' }),
        ]);
    });

    it('work things out again on each run, so a changed context gets fresh results', () => {
        const ctx = context();
        expect(runRules(ctx)).toEqual([]);
        describe0(ctx, 'Slide 1');
        expect(codes(ctx)).toEqual(['description.placeholder']);
    });
});

describe('a stored revision, with no working layer', () => {
    it('skips the authored-record rules and the reviewed check, and still checks the rest', () => {
        const ctx = context();
        authoredPhoto(ctx, photoAt(ctx, 0).id).alt = { kind: 'described', text: 'A suggested fixture description.', reviewed: false };
        photoAt(ctx, 1).alt = { kind: 'described', text: 'Slide 2' };
        const stored: RuleContext = { ...ctx, authored: null };
        expect(runRules(stored).map((issue) => issue.code)).toEqual(['description.placeholder']);
    });

    it('still reports a pending alt from the candidate', () => {
        const ctx = context();
        photoAt(ctx, 0).alt = { kind: 'pending' };
        expect(runRules({ ...ctx, authored: null })).toEqual([expect.objectContaining({ code: 'description.required', field: 'alt' })]);
    });
});

describe('the rule registry', () => {
    it('throws on a duplicate rule ID, including one of its own', () => {
        expect(() => registerRule({ ...registeredRules()[0] })).toThrow(/already registered/);
    });

    it.each([
        ['an ID outside a group', { id: 'noGroup' }],
        ['a version of 0', { version: 0 }],
        ['an unknown gate', { gate: 'deploy' }],
    ])('refuses %s', (_label, change) => {
        const rule = { id: 'fixture.rule', version: 1, severity: 'error', rollbackClass: 'integrity', gate: 'render', check: () => [], ...change };
        expect(() => registerRule(rule as Parameters<typeof registerRule>[0])).toThrow(TypeError);
    });

    it('takes #8\'s order rules as stand-ins once, so the real ones fail loudly until the stand-ins go', () => {
        const before = rulesetVersion();
        registerOrderRuleStandIns();
        expect(registeredRules().filter((rule) => rule.id.startsWith('order.')).map((rule) => rule.id)).toEqual([...ORDER_RULE_IDS].sort());
        expect(rulesetVersion()).not.toBe(before);
        expect(() => registerOrderRuleStandIns()).toThrow(/already registered/);
        expect(runRules(context())).toEqual([]);
    });

    it('hashes rule IDs and versions into a ruleset version', () => {
        const rules = registeredRules();
        expect(rulesetVersion(rules)).toMatch(/^[0-9a-f]{64}$/);
        expect(rulesetVersion([...rules].reverse())).toBe(rulesetVersion(rules));
        expect(rulesetVersion([{ ...rules[0], version: 2 }, ...rules.slice(1)])).not.toBe(rulesetVersion(rules));
    });
});

describe('the accent contrast check', () => {
    it.skipIf(!fs.existsSync(path.join(REPO_ROOT, 'styles/surfaces/chromatic-chapters.css')))('uses the Viewer band colors #21 declares', () => {
        const css = fs.readFileSync(path.join(REPO_ROOT, 'styles/surfaces/chromatic-chapters.css'), 'utf8');
        const declared = (name: string) => css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1].toLowerCase();
        expect([declared('--cc-band-edge'), declared('--cc-band-mid')]).toEqual([...BAND_COLORS]);
    });

    it('measures against #101413 and #151918', () => {
        expect(BAND_COLORS).toEqual(['#101413', '#151918']);
    });
});

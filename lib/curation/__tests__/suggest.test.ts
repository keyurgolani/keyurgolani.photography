// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { eventIdOf, eventKey, fingerprintOf, parseEvent } from '../events';
import { filenameTokens, loadRules, suggestForNew, type SuggestInput } from '../suggest';
import { MAX_DESCRIPTION_LENGTH, MAX_REASON_LENGTH, ownerText } from '../text';

const AT = '2026-02-01T00:00:00.000Z';
const known = new Set(['ser_harbor', 'ser_city', 'ser_winter']);

function input(rules: unknown, extra: Partial<SuggestInput> = {}): SuggestInput {
    return { rules: loadRules(rules), sourcePath: 'trips/2024/harbor-dawn_02.jpg', folder: 'trips/2024', capturedDate: '2024-06-01', knownSeries: known, producedAt: AT, ...extra };
}

describe('series suggestions', () => {
    it('suggests a configured folder at high confidence, the end of it as the position, and no description', () => {
        const result = suggestForNew(input({ schemaVersion: 1, series: [{ seriesId: 'ser_harbor', folders: ['trips'] }] }));
        expect(result.series).toMatchObject({ value: 'ser_harbor', confidence: 'high', producedAt: AT });
        expect(result.placement).toMatchObject({ value: 'end', confidence: 'low', producedBy: 'placement@1' });
        expect(Object.keys(result)).toEqual(['series', 'placement']);
    });

    it('matches a folder by its key, and only at or under it', () => {
        const rules = { schemaVersion: 1, series: [{ seriesId: 'ser_harbor', folders: ['Trips/2024'] }] };
        expect(suggestForNew(input(rules)).series?.value).toBe('ser_harbor');
        expect(suggestForNew(input(rules, { folder: 'trips/2024-extra', sourcePath: 'trips/2024-extra/a.jpg' })).series?.value).toBeNull();
    });

    it('suggests a filename tag at medium confidence', () => {
        const result = suggestForNew(input({ schemaVersion: 1, series: [{ seriesId: 'ser_city', filenameTags: ['DAWN'] }] }));
        expect(result.series).toMatchObject({ value: 'ser_city', confidence: 'medium' });
        expect(filenameTokens('trips/2024/harbor-dawn_02.jpg')).toEqual(['harbor', 'dawn', '02']);
    });

    it('prefers a folder match over a tag match', () => {
        const result = suggestForNew(input({ schemaVersion: 1, series: [{ seriesId: 'ser_city', filenameTags: ['harbor'] }, { seriesId: 'ser_harbor', folders: ['trips'] }] }));
        expect(result.series?.value).toBe('ser_harbor');
    });

    it('lets the EXIF capture date narrow two matches to one', () => {
        const rules = {
            schemaVersion: 1,
            series: [
                { seriesId: 'ser_harbor', folders: ['trips'], capturedBetween: { from: '2024-05-01', to: '2024-08-31' } },
                { seriesId: 'ser_winter', folders: ['trips'], capturedBetween: { from: '2024-12-01' } },
            ],
        };
        const result = suggestForNew(input(rules));
        expect(result.series).toMatchObject({ value: 'ser_harbor', confidence: 'high' });
        expect(result.series?.evidence.join(' ')).toMatch(/capture date 2024-06-01 narrows it to ser_harbor/);
        // Undated, nothing narrows it, so two matches suggest none.
        expect(suggestForNew(input(rules, { capturedDate: null })).series).toMatchObject({ value: null, evidence: expect.arrayContaining([expect.stringMatching(/ser_harbor and ser_winter all match/)]) });
    });

    it('suggests none when two series match equally', () => {
        const result = suggestForNew(input({ schemaVersion: 1, series: [{ seriesId: 'ser_harbor', folders: ['trips'] }, { seriesId: 'ser_city', folders: ['trips/2024'] }] }));
        expect(result).toEqual({ series: expect.objectContaining({ value: null }), placement: null });
    });

    it('skips a rule naming a series the working layer lacks', () => {
        const result = suggestForNew(input({ schemaVersion: 1, series: [{ seriesId: 'ser_gone', folders: ['trips'] }] }));
        expect(result.series).toMatchObject({ value: null, evidence: expect.arrayContaining([expect.stringMatching(/ser_gone, which has no authored record/)]) });
    });

    it('suggests nothing without rules or with invalid ones, and says why', () => {
        expect(suggestForNew(input(null)).series).toMatchObject({ value: null, producedBy: 'rules@none' });
        for (const bad of [{ schemaVersion: 2, series: [] }, { schemaVersion: 1, series: [{ seriesId: 'harbor' }] }, { schemaVersion: 1, series: [{ seriesId: 'ser_x', folders: ['../up'] }] }, { schemaVersion: 1, series: [{ seriesId: 'ser_x', extra: true }] }]) {
            expect(suggestForNew(input(bad)).series, JSON.stringify(bad)).toMatchObject({ value: null, producedBy: 'rules@invalid' });
        }
    });

    it('names the rules it came from by a digest of their content', () => {
        const a = loadRules({ schemaVersion: 1, series: [{ seriesId: 'ser_harbor', folders: ['trips'] }] });
        const b = loadRules({ series: [{ folders: ['trips'], seriesId: 'ser_harbor' }], schemaVersion: 1 });
        const c = loadRules({ schemaVersion: 1, series: [{ seriesId: 'ser_harbor', folders: ['other'] }] });
        expect(a.state === 'valid' && b.state === 'valid' && a.producedBy === b.producedBy).toBe(true);
        expect(a.state === 'valid' && c.state === 'valid' && a.producedBy !== c.producedBy).toBe(true);
    });
});

describe('event keys', () => {
    const fact = { photoId: 'ph_00000000-0000-4000-8000-000000000001', assetRevision: `sha256-${'a'.repeat(64)}`, key: `new:ph_00000000-0000-4000-8000-000000000001:sha256-${'a'.repeat(64)}` };

    it('are stable for the same evidence and differ by type, identity, and revision', () => {
        expect(eventIdOf(eventKey('new', fact))).toBe(eventIdOf(eventKey('new', { ...fact })));
        expect(eventIdOf(eventKey('new', fact))).toMatch(/^evt_[0-9a-f]{24}$/);
        const others = [
            eventKey('missing', fact),
            eventKey('new', { ...fact, photoId: 'ph_00000000-0000-4000-8000-000000000002' }),
            eventKey('new', { ...fact, assetRevision: `sha256-${'b'.repeat(64)}` }),
        ];
        expect(new Set([eventKey('new', fact), ...others]).size).toBe(4);
    });

    it('use the source fingerprint when no photo ID settles the identity', () => {
        expect(fingerprintOf(fact.assetRevision)).toBe(`fp_${'a'.repeat(64)}`);
        expect(eventKey('ambiguous', fact).split('|')[1]).toBe(`fp_${'a'.repeat(64)}`);
        expect(eventKey('processing-failure', { ...fact, photoId: null }).split('|')[1]).toBe(`fp_${'a'.repeat(64)}`);
        expect(() => fingerprintOf('../../x')).toThrow(TypeError);
    });

    it('refuse a record from a newer build', () => {
        expect(parseEvent({ schemaVersion: 2 })).toMatchObject({ ok: false, reason: 'unknown-schema-version' });
        expect(parseEvent({ schemaVersion: 1 })).toMatchObject({ ok: false, reason: 'invalid' });
    });
});

describe('owner text', () => {
    it('is trimmed plain text with something in it, under #13\'s plain-text rules', () => {
        expect(ownerText('  A quiet harbor at dawn.  ', { field: 'd', max: 100 })).toEqual({ ok: true, text: 'A quiet harbor at dawn.' });
        for (const bad of ['', '   ', 'line\nbreak', 'tab\there', 'bidi\u202espoof', 'line\u2028sep', 'para\u2029sep', 'zero\u200bwidth', 'word\u2060joiner', 'bom\ufeffhere', 'soft\u00adhyphen', 'private\ue000use', '<b>bold</b>', 'x'.repeat(101)]) {
            expect(ownerText(bad, { field: 'd', max: 100 }).ok, JSON.stringify(bad)).toBe(false);
        }
    });

    it('takes what #13 allows, such as an emoji joined with ZWJ, and names a refused character', () => {
        expect(ownerText('A family \u{1F468}\u200d\u{1F469}\u200d\u{1F467} at the pier.', { field: 'd', max: 100 }).ok).toBe(true);
        expect(ownerText('ab\u202ecd', { field: '--reason', max: 100 })).toEqual({ ok: false, problem: "--reason can't hold a bidi embedding or override (U+202E at character 3)." });
        expect(ownerText('two\nlines', { field: '--reason', max: 100 })).toEqual({ ok: false, problem: "--reason can't hold a line break." });
    });

    it('keeps the inbox limits: a description takes alt\'s 1,000 characters, a reason 500', () => {
        expect(MAX_DESCRIPTION_LENGTH).toBe(1000);
        expect(MAX_REASON_LENGTH).toBe(500);
        expect(ownerText('x'.repeat(501), { field: '--reason', max: MAX_REASON_LENGTH })).toEqual({ ok: false, problem: '--reason is 501 characters, and the most is 500.' });
    });
});

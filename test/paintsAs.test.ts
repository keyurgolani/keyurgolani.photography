import { afterEach, describe, expect, it } from 'vitest';
import { LETTER_SPACING_SLACK_EM, paintsAs, readPaint } from './helpers/parityWalk';

// A state the base has no screen for (dark-parity.spec.ts's NEW_STATES): its new parts are read in the head, the base
// elements they're made from are read in the base, and each named property must be the same. readPaint runs in the
// page (page.evaluate sends it alone), so here it runs in jsdom, on inline styles.

afterEach(() => {
    document.body.innerHTML = '';
});

describe('readPaint', () => {
    it('reads each named computed property of the first element each selector finds, and null where none is there', () => {
        document.body.innerHTML = '<p data-a="" style="color: rgb(1, 2, 3); border-top-color: rgb(4, 5, 6)">a</p><p data-a="" style="color: rgb(9, 9, 9)">b</p>';
        expect(
            readPaint([
                { selector: '[data-a]', properties: ['color', 'border-top-color'] },
                { selector: '[data-missing]', properties: ['color'] },
            ]),
        ).toEqual([{ color: 'rgb(1, 2, 3)', 'border-top-color': 'rgb(4, 5, 6)' }, null]);
    });

    it('reads the font size along with letter-spacing, which paintsAs compares as a share of it', () => {
        document.body.innerHTML = '<h1 style="font-size: 28px; letter-spacing: -0.56px">a</h1>';
        expect(readPaint([{ selector: 'h1', properties: ['letter-spacing'] }])).toEqual([{ 'letter-spacing': '-0.56px', 'font-size': '28px' }]);
    });
});

// Tracking is set in em, so a heading at another size than its model has other px at the same tracking (the parity
// run: -0.56px at 28px against the header's -0.4px at 20px, both -0.02em). paintsAs holds the share of the font size.
describe('paintsAs, letter-spacing', () => {
    const at = (spacing: string, size: string) => ({ 'letter-spacing': spacing, 'font-size': size });

    it('passes the same tracking in em on a different font size, at every gate size the parity run read', () => {
        expect(paintsAs('h1', at('-0.56px', '28px'), 'header h1', at('-0.4px', '20px'), ['letter-spacing'])).toEqual([]);
        expect(paintsAs('h1', at('-0.49984px', '24.992px'), 'header h1', at('-0.3904px', '19.52px'), ['letter-spacing'])).toEqual([]);
        expect(paintsAs('h1', at('-0.4px', '20px'), 'header h1', at('-0.327px', '16.35px'), ['letter-spacing'])).toEqual([]);
        expect(paintsAs('p', at('normal', '16px'), 'p', at('normal', '14px'), ['letter-spacing'])).toEqual([]);
    });

    it(`fails other tracking, past ${LETTER_SPACING_SLACK_EM}em, with both values and their shares`, () => {
        expect(LETTER_SPACING_SLACK_EM).toBe(0.001);
        expect(paintsAs('h1', at('-0.84px', '28px'), 'header h1', at('-0.4px', '20px'), ['letter-spacing'])).toEqual([
            "h1 letter-spacing: -0.84px (-0.0300em of 28px), where the base's header h1 has -0.4px (-0.0200em of 20px)",
        ]);
        // Normal tracking is 0, so a heading tracked where its model isn't fails too.
        expect(paintsAs('h1', at('-0.56px', '28px'), 'header h1', at('normal', '20px'), ['letter-spacing'])).toHaveLength(1);
        // Just inside the slack passes; just past it fails.
        expect(paintsAs('h1', at('-0.5876px', '28px'), 'header h1', at('-0.4px', '20px'), ['letter-spacing'])).toEqual([]);
        expect(paintsAs('h1', at('-0.5908px', '28px'), 'header h1', at('-0.4px', '20px'), ['letter-spacing'])).toHaveLength(1);
    });

    it('fails a tracking or a font size it can\'t read as px', () => {
        expect(paintsAs('h1', { 'letter-spacing': '-0.56px' }, 'header h1', at('-0.4px', '20px'), ['letter-spacing'])).toEqual([
            "h1 letter-spacing: -0.56px of no font size read, where the base's header h1 has -0.4px of 20px",
        ]);
    });
});

describe('paintsAs', () => {
    const properties = ['color', 'border-top-color', 'font-size'];
    const model = { color: 'rgb(246, 244, 238)', 'border-top-color': 'rgba(255, 255, 255, 0.38)', 'font-size': '14px' };

    it('passes when the new part paints every named property as the base element does', () => {
        expect(paintsAs('[data-new]', { ...model }, '[data-old]', model, properties)).toEqual([]);
    });

    it('names each property that differs, with both values', () => {
        expect(paintsAs('[data-new]', { ...model, color: 'rgb(255, 0, 0)', 'font-size': '15px' }, '[data-old]', model, properties)).toEqual([
            '[data-new] color: rgb(255, 0, 0), where the base\'s [data-old] has rgb(246, 244, 238)',
            '[data-new] font-size: 15px, where the base\'s [data-old] has 14px',
        ]);
    });

    it('fails when the new part, or the base element, isn\'t on the page, or a value was never read', () => {
        expect(paintsAs('[data-new]', null, '[data-old]', model, properties)).toEqual(['[data-new]: not in the head']);
        expect(paintsAs('[data-new]', model, '[data-old]', null, properties)).toEqual(["[data-old]: not in the base"]);
        expect(paintsAs('[data-new]', { color: model.color, 'font-size': '14px' }, '[data-old]', model, properties)).toEqual([
            "[data-new] border-top-color: not read, where the base's [data-old] has rgba(255, 255, 255, 0.38)",
        ]);
    });

    it('refuses an empty list of properties, which would pass anything', () => {
        expect(() => paintsAs('[data-new]', model, '[data-old]', model, [])).toThrow(/no properties/);
    });
});
